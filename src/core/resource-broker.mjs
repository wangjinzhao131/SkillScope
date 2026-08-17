import { createHash } from "node:crypto";

/**
 * Canonical access modes. The aliases accepted by normalizeAccessMode are kept
 * out of this object so traces always contain one of these three values.
 */
export const ACCESS_MODES = Object.freeze({
  PROJECT: "PROJECT",
  SEALED: "SEALED",
  BOUNDED: "BOUNDED",
});

export const RESOURCE_OPERATIONS = Object.freeze(["read", "list", "search"]);

const OPERATION_ALIASES = Object.freeze({
  read: "read",
  list: "list",
  ls: "list",
  find: "list",
  search: "search",
  grep: "search",
});

const MODE_ALIASES = Object.freeze({
  PROJECT: ACCESS_MODES.PROJECT,
  PROJECT_READ_ONLY: ACCESS_MODES.PROJECT,
  SEALED: ACCESS_MODES.SEALED,
  BOUNDED: ACCESS_MODES.BOUNDED,
  BOUNDED_ORACLE: ACCESS_MODES.BOUNDED,
  BOUNDED_INFERRED: ACCESS_MODES.BOUNDED,
  BOUNDED_NEED_RESOURCE: ACCESS_MODES.BOUNDED,
  BOUNDED_DYNAMIC: ACCESS_MODES.BOUNDED,
});

const DEFAULT_LIMITS = Object.freeze({
  maxReadBytes: 64 * 1024,
  maxSearchResults: 100,
  maxListEntries: 1_000,
  maxSearchLineChars: 500,
});

const ROOT_GRANT = Object.freeze({
  path: ".",
  kind: "directory",
  operations: RESOURCE_OPERATIONS,
});

/** Error returned by the policy boundary. */
export class ResourceAccessError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "ResourceAccessError";
    this.code = code;
    this.operation = options.operation;
    this.rawPath = options.rawPath;
    this.path = options.path;
    this.details = options.details;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.operation === undefined ? {} : { operation: this.operation }),
      ...(this.rawPath === undefined ? {} : { rawPath: this.rawPath }),
      ...(this.path === undefined ? {} : { path: this.path }),
      ...(this.details === undefined ? {} : { details: cloneJson(this.details) }),
    };
  }
}

/**
 * Normalize a virtual-project path without ever resolving a parent segment.
 *
 * This is intentionally stricter than path.posix.normalize(): `a/../b` is
 * rejected rather than turned into `b`, because accepting it would erase the
 * evidence of a traversal attempt before policy evaluation.
 */
export function normalizeResourcePath(input, { allowRoot = true } = {}) {
  if (typeof input !== "string") {
    throw new ResourceAccessError("INVALID_PATH", "Resource path must be a string", {
      rawPath: input,
    });
  }
  if (input.includes("\0")) {
    throw new ResourceAccessError("INVALID_PATH", "Resource path contains a NUL byte", {
      rawPath: input,
    });
  }
  if (input.includes("\\")) {
    throw new ResourceAccessError(
      "INVALID_PATH",
      "Resource paths must use POSIX '/' separators",
      { rawPath: input },
    );
  }
  if (input.startsWith("/") || /^[A-Za-z]:/u.test(input)) {
    throw new ResourceAccessError("INVALID_PATH", "Absolute resource paths are forbidden", {
      rawPath: input,
    });
  }

  const segments = input.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new ResourceAccessError("INVALID_PATH", "Parent traversal segments are forbidden", {
      rawPath: input,
    });
  }

  const canonical = segments.filter((segment) => segment !== "" && segment !== ".").join("/") || ".";
  if (!allowRoot && canonical === ".") {
    throw new ResourceAccessError("INVALID_PATH", "A file path cannot name the project root", {
      rawPath: input,
    });
  }
  return canonical;
}

export function normalizeAccessMode(mode) {
  if (typeof mode !== "string") {
    throw new TypeError("mode must be a string");
  }
  const canonical = MODE_ALIASES[mode.toUpperCase()];
  if (!canonical) {
    throw new TypeError(`Unsupported resource access mode: ${mode}`);
  }
  return canonical;
}

/**
 * In-memory, read-only resource boundary shared by the experiment harness and
 * the Pi adapter. Tool methods are synchronous; callers may safely `await`
 * their results.
 */
export class ResourceBroker {
  #mode;
  #files;
  #directories;
  #declaredGrants;
  #grantedGrants;
  #attempted = new Map();
  #actualRead = new Map();
  #modelVisible = new Set();
  #modelVisibleSources = new Set();
  #canaries;
  #canaryHits = [];
  #events = [];
  #denials = [];
  #clock;
  #sequence = 0;
  #limits;
  #promptMaterials = [];

  constructor({
    files = {},
    mode = ACCESS_MODES.BOUNDED,
    declaredGrants,
    grants = [],
    canaries = [],
    promptRefs = [],
    limits = {},
    clock = () => Date.now(),
  } = {}) {
    this.#mode = normalizeAccessMode(mode);
    this.#clock = validateClock(clock);
    this.#limits = normalizeLimits(limits);
    this.#canaries = normalizeCanaries(canaries);
    this.#files = normalizeFiles(files);
    this.#directories = buildDirectorySet(this.#files);

    const normalizedConfiguredGrants = normalizeGrantList(grants, this.#files);
    const hasDeclaredGrants = declaredGrants !== undefined;
    const normalizedDeclared = hasDeclaredGrants
      ? normalizeGrantList(declaredGrants, this.#files)
      : undefined;

    if (this.#mode === ACCESS_MODES.PROJECT) {
      this.#declaredGrants = [cloneGrant(ROOT_GRANT)];
      this.#grantedGrants = [cloneGrant(ROOT_GRANT)];
    } else if (this.#mode === ACCESS_MODES.SEALED) {
      this.#declaredGrants = normalizedDeclared ?? normalizedConfiguredGrants;
      this.#grantedGrants = [];
    } else {
      this.#declaredGrants = normalizedDeclared ?? normalizedConfiguredGrants.map(cloneGrant);
      this.#grantedGrants = normalizedConfiguredGrants;
      assertGrantedSubset(this.#grantedGrants, this.#declaredGrants);
    }

    this.#event("broker_initialized", {
      mode: this.#mode,
      fileCount: this.#files.size,
      declaredGrantCount: this.#declaredGrants.length,
      grantedGrantCount: this.#grantedGrants.length,
    });

    this.#promptMaterials = this.#resolvePromptRefs(promptRefs);
  }

  get mode() {
    return this.#mode;
  }

  /** Immutable copies of prompt snapshots resolved at construction time. */
  getPromptMaterials() {
    return this.#promptMaterials.map((material) => cloneJson(material));
  }

  read(path, options = {}) {
    const canonicalPath = this.#authorize("read", path);
    const file = this.#files.get(canonicalPath);
    if (!file) {
      if (this.#directories.has(canonicalPath)) {
        this.#deny("NOT_A_FILE", "read", path, canonicalPath, "Resource is a directory");
      }
      this.#deny("NOT_FOUND", "read", path, canonicalPath, "Resource does not exist");
    }

    const lines = file.content.split("\n");
    const startLine = integerOption(options.startLine, 1, "startLine", { minimum: 1 });
    const endLine = integerOption(options.endLine, lines.length, "endLine", { minimum: 1 });
    if (endLine < startLine) {
      this.#deny(
        "INVALID_ARGUMENT",
        "read",
        path,
        canonicalPath,
        "endLine must be greater than or equal to startLine",
      );
    }

    const requestedMaxBytes = integerOption(
      options.maxBytes,
      this.#limits.maxReadBytes,
      "maxBytes",
      { minimum: 1, maximum: this.#limits.maxReadBytes },
    );
    const effectiveEndLine = Math.min(endLine, lines.length);
    const selected = startLine > lines.length ? "" : lines.slice(startLine - 1, effectiveEndLine).join("\n");
    const truncatedText = truncateUtf8(selected, requestedMaxBytes);
    const result = {
      path: canonicalPath,
      content: truncatedText.text,
      startLine,
      endLine: startLine > lines.length ? startLine - 1 : effectiveEndLine,
      totalLines: lines.length,
      bytes: utf8Bytes(truncatedText.text),
      truncated: truncatedText.truncated || endLine < lines.length,
    };

    this.#recordActualRead(canonicalPath, "read");
    this.#event("resource_read", {
      operation: "read",
      path: canonicalPath,
      bytes: result.bytes,
      contentHash: sha256(result.content),
      truncated: result.truncated,
    });
    this.#recordModelVisibility(result, {
      source: `tool:read:${canonicalPath}`,
      resourcePaths: [canonicalPath],
      kind: "tool_result",
    });
    return result;
  }

  list(path = ".", options = {}) {
    const canonicalPath = this.#authorize("list", path);
    if (this.#files.has(canonicalPath)) {
      this.#deny("NOT_A_DIRECTORY", "list", path, canonicalPath, "Resource is a file");
    }
    if (!this.#directories.has(canonicalPath)) {
      this.#deny("NOT_FOUND", "list", path, canonicalPath, "Directory does not exist");
    }

    const recursive = booleanOption(options.recursive, false, "recursive");
    const maxEntries = integerOption(
      options.maxEntries,
      this.#limits.maxListEntries,
      "maxEntries",
      { minimum: 1, maximum: this.#limits.maxListEntries },
    );
    const allEntries = collectDirectoryEntries(
      canonicalPath,
      recursive,
      this.#files,
      this.#directories,
    );
    const entries = allEntries.slice(0, maxEntries);
    const result = {
      path: canonicalPath,
      recursive,
      entries,
      totalEntries: allEntries.length,
      truncated: entries.length < allEntries.length,
    };

    for (const entry of entries) {
      this.#recordActualRead(entry.path, "list");
    }
    this.#event("resource_listed", {
      operation: "list",
      path: canonicalPath,
      recursive,
      returnedEntries: entries.length,
      totalEntries: allEntries.length,
      truncated: result.truncated,
    });
    this.#recordModelVisibility(result, {
      source: `tool:list:${canonicalPath}`,
      resourcePaths: entries.map((entry) => entry.path),
      kind: "tool_result",
    });
    return result;
  }

  search(query, options = {}) {
    const rawPath = options.path ?? ".";
    const canonicalPath = this.#authorize("search", rawPath);
    if (typeof query !== "string" || query.length === 0) {
      this.#deny(
        "INVALID_ARGUMENT",
        "search",
        rawPath,
        canonicalPath,
        "search query must be a non-empty string",
      );
    }
    const isFile = this.#files.has(canonicalPath);
    if (!isFile && !this.#directories.has(canonicalPath)) {
      this.#deny("NOT_FOUND", "search", rawPath, canonicalPath, "Search resource does not exist");
    }

    const caseSensitive = booleanOption(options.caseSensitive, true, "caseSensitive");
    const maxResults = integerOption(
      options.maxResults,
      this.#limits.maxSearchResults,
      "maxResults",
      { minimum: 1, maximum: this.#limits.maxSearchResults },
    );
    const candidates = isFile
      ? [canonicalPath]
      : [...this.#files.keys()].filter((candidate) => isSameOrDescendant(canonicalPath, candidate));
    candidates.sort(compareStrings);

    const needle = caseSensitive ? query : query.toLocaleLowerCase("en-US");
    const matches = [];
    let scannedFiles = 0;
    let truncated = false;
    outer: for (const candidate of candidates) {
      const content = this.#files.get(candidate).content;
      this.#recordActualRead(candidate, "search");
      scannedFiles += 1;
      const lines = content.split("\n");
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const haystack = caseSensitive ? lines[lineIndex] : lines[lineIndex].toLocaleLowerCase("en-US");
        let fromIndex = 0;
        while (fromIndex <= haystack.length) {
          const columnIndex = haystack.indexOf(needle, fromIndex);
          if (columnIndex === -1) break;
          const excerpt = excerptAround(lines[lineIndex], columnIndex, this.#limits.maxSearchLineChars);
          matches.push({
            path: candidate,
            line: lineIndex + 1,
            column: columnIndex + 1,
            text: excerpt.text,
            textStartColumn: excerpt.start + 1,
          });
          if (matches.length >= maxResults) {
            truncated = true;
            break outer;
          }
          fromIndex = columnIndex + Math.max(needle.length, 1);
        }
      }
    }

    const result = {
      path: canonicalPath,
      query,
      caseSensitive,
      matches,
      truncated,
    };
    const visiblePaths = [...new Set(matches.map((match) => match.path))];
    this.#event("resource_searched", {
      operation: "search",
      path: canonicalPath,
      queryHash: sha256(query),
      scannedFiles,
      returnedMatches: matches.length,
      truncated,
    });
    this.#recordModelVisibility(result, {
      source: `tool:search:${canonicalPath}`,
      resourcePaths: visiblePaths,
      kind: "tool_result",
    });
    return result;
  }

  /** Generic adapter entry point for tool routers. */
  execute(operation, args = {}) {
    const canonicalOperation = normalizeOperation(operation);
    if (!isPlainObject(args)) {
      throw new ResourceAccessError("INVALID_ARGUMENT", "Tool arguments must be an object", {
        operation: canonicalOperation,
      });
    }
    if (canonicalOperation === "read") {
      const { path, ...options } = args;
      return this.read(path, options);
    }
    if (canonicalOperation === "search") {
      const { query, ...options } = args;
      return this.search(query, options);
    }
    const { path = ".", ...options } = args;
    if (operation === "find") options.recursive ??= true;
    return this.list(path, options);
  }

  /**
   * Record any content that an adapter actually places in a model message.
   * Use this when an adapter transforms a broker result, or injects non-file
   * prompt material, so modelVisibleSet remains a boundary observation rather
   * than an inference from the final answer.
   */
  recordModelVisibility(content, options = {}) {
    return this.#recordModelVisibility(content, {
      source: options.source ?? "external",
      resourcePaths: options.resourcePaths ?? [],
      kind: options.kind ?? "external",
    });
  }

  snapshot() {
    const attemptedOperations = [...this.#attempted.values()]
      .map((attempt) => cloneJson(attempt))
      .sort(compareAttemptRecords);
    const actualReadOperations = [...this.#actualRead.entries()]
      .map(([path, operations]) => ({ path, operations: [...operations].sort(compareOperations) }))
      .sort((left, right) => compareStrings(left.path, right.path));
    const canaryVisibility = [...this.#canaries.values()]
      .map((canary) => {
        const hits = this.#canaryHits.filter((hit) => hit.id === canary.id);
        return {
          id: canary.id,
          visible: hits.length > 0,
          hitCount: hits.length,
          sources: [...new Set(hits.map((hit) => hit.source))].sort(compareStrings),
          resourcePaths: [...new Set(hits.flatMap((hit) => hit.resourcePaths))]
            .map((path) => this.#redact(path))
            .sort(compareStrings),
        };
      })
      .sort((left, right) => compareStrings(left.id, right.id));
    const result = {
      schemaVersion: "1.0",
      mode: this.#mode,
      declaredSet: this.#declaredGrants.map((grant) => this.#redactGrant(grant)),
      grantedSet: this.#grantedGrants.map((grant) => this.#redactGrant(grant)),
      attemptedSet: [...new Set(attemptedOperations.map((attempt) => attempt.path))].sort(compareStrings),
      attemptedOperations,
      actualReadSet: [...this.#actualRead.keys()].map((path) => this.#redact(path)).sort(compareStrings),
      actualReadOperations: actualReadOperations.map((record) => ({
        ...record,
        path: this.#redact(record.path),
      })),
      modelVisibleSet: [...this.#modelVisible].map((path) => this.#redact(path)).sort(compareStrings),
      modelVisibleSources: [...this.#modelVisibleSources].sort(compareStrings),
      canaryVisibility,
      events: this.#events.map((event) => cloneJson(event)),
      denials: this.#denials.map((denial) => cloneJson(denial)),
      counts: {
        attempts: attemptedOperations.length,
        denials: this.#denials.length,
        actualReadResources: this.#actualRead.size,
        modelVisibleResources: this.#modelVisible.size,
        canaryHits: this.#canaryHits.length,
      },
    };
    return cloneJson(result);
  }

  #resolvePromptRefs(promptRefs) {
    if (!Array.isArray(promptRefs)) {
      throw new TypeError("promptRefs must be an array");
    }
    return promptRefs.map((reference, index) => {
      let material;
      if (typeof reference === "string") {
        material = this.#materialFromProjectPath(reference, {});
      } else if (isPlainObject(reference) && typeof reference.content === "string") {
        const sourcePath = reference.sourcePath ?? reference.path;
        const resourcePaths = sourcePath === undefined
          ? []
          : [normalizeResourcePath(sourcePath, { allowRoot: false })];
        material = {
          name: reference.name ?? `prompt-ref-${index + 1}`,
          content: reference.content,
          ...(resourcePaths.length === 0 ? {} : { sourcePath: resourcePaths[0] }),
          ...(reference.purpose === undefined ? {} : { purpose: String(reference.purpose) }),
        };
      } else if (isPlainObject(reference) && typeof reference.path === "string") {
        material = this.#materialFromProjectPath(reference.path, reference);
      } else {
        throw new TypeError(`promptRefs[${index}] must contain path or string content`);
      }

      const resourcePaths = material.sourcePath ? [material.sourcePath] : [];
      this.#recordModelVisibility(material.content, {
        source: `prompt:${material.name}`,
        resourcePaths,
        kind: "prompt_ref",
      });
      return Object.freeze(material);
    });
  }

  #materialFromProjectPath(rawPath, options) {
    const path = normalizeResourcePath(rawPath, { allowRoot: false });
    const file = this.#files.get(path);
    if (!file) {
      throw new ResourceAccessError("NOT_FOUND", "Prompt reference does not exist", {
        operation: "prompt",
        rawPath,
        path,
      });
    }
    const lines = file.content.split("\n");
    const startLine = integerOption(options.startLine, 1, "startLine", { minimum: 1 });
    const endLine = integerOption(options.endLine, lines.length, "endLine", { minimum: 1 });
    if (endLine < startLine) {
      throw new ResourceAccessError("INVALID_ARGUMENT", "Prompt reference endLine precedes startLine", {
        operation: "prompt",
        rawPath,
        path,
      });
    }
    const effectiveEndLine = Math.min(endLine, lines.length);
    return {
      name: options.name ?? path,
      sourcePath: path,
      content: startLine > lines.length ? "" : lines.slice(startLine - 1, effectiveEndLine).join("\n"),
      startLine,
      endLine: startLine > lines.length ? startLine - 1 : effectiveEndLine,
      ...(options.purpose === undefined ? {} : { purpose: String(options.purpose) }),
    };
  }

  #authorize(operation, rawPath) {
    this.#sequence += 1;
    const attemptSequence = this.#sequence;
    let canonicalPath;
    try {
      canonicalPath = normalizeResourcePath(rawPath, { allowRoot: operation !== "read" });
    } catch (error) {
      const safeRawPath = this.#redact(printableRawPath(rawPath));
      this.#attempted.set(`${operation}\0${safeRawPath}\0${attemptSequence}`, {
        operation,
        path: safeRawPath,
        rawPath: safeRawPath,
        allowed: false,
        reason: "INVALID_PATH",
      });
      this.#event("tool_attempt", {
        operation,
        rawPath: safeRawPath,
        allowed: false,
        reason: "INVALID_PATH",
      }, attemptSequence);
      this.#deny(
        "INVALID_PATH",
        operation,
        safeRawPath,
        undefined,
        error instanceof Error ? error.message : "Invalid resource path",
        attemptSequence,
      );
    }

    if (this.#mode === ACCESS_MODES.SEALED) {
      this.#recordAttempt(operation, rawPath, canonicalPath, false, "SEALED", attemptSequence);
      this.#deny(
        "SEALED",
        operation,
        rawPath,
        canonicalPath,
        "SEALED scopes do not expose resource tools",
        attemptSequence,
      );
    }

    const allowed = this.#grantedGrants.some((grant) => grantAllows(grant, operation, canonicalPath));
    if (!allowed) {
      this.#recordAttempt(operation, rawPath, canonicalPath, false, "UNAUTHORIZED", attemptSequence);
      this.#deny(
        "UNAUTHORIZED",
        operation,
        rawPath,
        canonicalPath,
        "Resource is outside the effective grant",
        attemptSequence,
      );
    }

    this.#recordAttempt(operation, rawPath, canonicalPath, true, undefined, attemptSequence);
    return canonicalPath;
  }

  #recordAttempt(operation, rawPath, path, allowed, reason, sequence) {
    const safeRawPath = this.#redact(printableRawPath(rawPath));
    const safePath = this.#redact(path);
    const record = {
      operation,
      path: safePath,
      rawPath: safeRawPath,
      allowed,
      ...(reason === undefined ? {} : { reason }),
    };
    this.#attempted.set(`${operation}\0${safeRawPath}\0${sequence}`, record);
    this.#event("tool_attempt", record, sequence);
  }

  #deny(code, operation, rawPath, path, message, sequence) {
    const safeRawPath = this.#redact(printableRawPath(rawPath));
    const safePath = path === undefined ? undefined : this.#redact(path);
    const denial = {
      code,
      operation,
      rawPath: safeRawPath,
      ...(safePath === undefined ? {} : { path: safePath }),
      message,
    };
    this.#denials.push(denial);
    this.#event("policy_decision", { ...denial, blocked: true });
    throw new ResourceAccessError(code, message, {
      operation,
      rawPath: safeRawPath,
      path: safePath,
    });
  }

  #recordActualRead(path, operation) {
    const operations = this.#actualRead.get(path) ?? new Set();
    operations.add(operation);
    this.#actualRead.set(path, operations);
  }

  #recordModelVisibility(content, { source, resourcePaths, kind }) {
    const serialized = serializeVisibleContent(content);
    const normalizedPaths = resourcePaths.map((path) => normalizeResourcePath(path));
    for (const path of normalizedPaths) this.#modelVisible.add(path);
    const safeSource = this.#redact(String(source));
    this.#modelVisibleSources.add(safeSource);

    const hits = [];
    for (const canary of this.#canaries.values()) {
      if (serialized.includes(canary.value)) {
        const hit = {
          id: canary.id,
          source: safeSource,
          resourcePaths: [...normalizedPaths],
          kind,
        };
        this.#canaryHits.push(hit);
        hits.push(canary.id);
      }
    }
    this.#event("model_visible", {
      source: safeSource,
      kind,
      resourcePaths: normalizedPaths,
      bytes: utf8Bytes(serialized),
      contentHash: sha256(serialized),
      canaryIds: hits,
    });
    return { canaryIds: hits, contentHash: sha256(serialized) };
  }

  #event(type, payload = {}, forcedSequence) {
    const sequence = forcedSequence ?? ++this.#sequence;
    this.#sequence = Math.max(this.#sequence, sequence);
    this.#events.push({
      sequence,
      timestamp: this.#clock(),
      type,
      ...this.#redactJson(cloneJson(payload)),
    });
  }

  #redact(value) {
    let redacted = value;
    for (const canary of this.#canaries.values()) {
      redacted = redacted.split(canary.value).join(`[CANARY:${canary.id}]`);
    }
    return redacted;
  }

  #redactGrant(grant) {
    return { ...cloneGrant(grant), path: this.#redact(grant.path) };
  }

  #redactJson(value) {
    if (typeof value === "string") return this.#redact(value);
    if (Array.isArray(value)) return value.map((item) => this.#redactJson(item));
    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.#redactJson(item)]),
      );
    }
    return value;
  }
}

function normalizeFiles(files) {
  let entries;
  if (files instanceof Map) {
    entries = [...files.entries()].map(([path, value]) =>
      typeof value === "string" ? { path, content: value } : { path, ...value },
    );
  } else if (Array.isArray(files)) {
    entries = files;
  } else if (isPlainObject(files)) {
    entries = Object.entries(files).map(([path, value]) =>
      typeof value === "string" ? { path, content: value } : { path, ...value },
    );
  } else {
    throw new TypeError("files must be a record, Map, or array");
  }

  const result = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isPlainObject(entry) || typeof entry.content !== "string") {
      throw new TypeError(`files[${index}] must contain string path and content`);
    }
    const path = normalizeResourcePath(entry.path, { allowRoot: false });
    if (result.has(path)) {
      throw new TypeError(`Duplicate file after path normalization: ${path}`);
    }
    const metadata = {};
    for (const [key, value] of Object.entries(entry)) {
      if (key !== "path" && key !== "content") metadata[key] = cloneJson(value);
    }
    result.set(path, Object.freeze({ path, content: entry.content, metadata: Object.freeze(metadata) }));
  }

  const paths = [...result.keys()].sort(compareStrings);
  for (let leftIndex = 0; leftIndex < paths.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < paths.length; rightIndex += 1) {
      if (isSameOrDescendant(paths[leftIndex], paths[rightIndex])) {
        throw new TypeError(
          `A virtual file cannot also be an ancestor directory: ${paths[leftIndex]}`,
        );
      }
    }
  }
  return result;
}

function buildDirectorySet(files) {
  const directories = new Set(["."]);
  for (const path of files.keys()) {
    const segments = path.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      directories.add(segments.slice(0, length).join("/"));
    }
  }
  return directories;
}

function normalizeGrantList(grants, files) {
  if (!Array.isArray(grants)) throw new TypeError("grants must be an array");
  const normalized = grants.map((grant, index) => normalizeGrant(grant, files, index));
  const deduplicated = new Map();
  for (const grant of normalized) {
    const key = `${grant.kind}\0${grant.path}\0${grant.operations.join(",")}`;
    deduplicated.set(key, grant);
  }
  return [...deduplicated.values()].sort(compareGrants);
}

function normalizeGrant(grant, files, index) {
  const candidate = typeof grant === "string" ? { path: grant } : grant;
  if (!isPlainObject(candidate) || typeof candidate.path !== "string") {
    throw new TypeError(`grants[${index}] must be a path string or grant object`);
  }
  const path = normalizeResourcePath(candidate.path);
  let kind = candidate.kind;
  if (kind === undefined) kind = files.has(path) ? "file" : "directory";
  if (kind === "dir" || kind === "tree") kind = "directory";
  if (kind !== "file" && kind !== "directory") {
    throw new TypeError(`grants[${index}].kind must be 'file' or 'directory'`);
  }
  if (kind === "file" && path === ".") {
    throw new TypeError(`grants[${index}] cannot grant the project root as a file`);
  }

  const defaultOperations = kind === "file" ? ["read", "search"] : RESOURCE_OPERATIONS;
  const rawOperations = candidate.operations ?? defaultOperations;
  if (!Array.isArray(rawOperations) || rawOperations.length === 0) {
    throw new TypeError(`grants[${index}].operations must be a non-empty array`);
  }
  const operations = [...new Set(rawOperations.map(normalizeOperation))].sort(compareOperations);
  if (kind === "file" && operations.includes("list")) {
    throw new TypeError(`grants[${index}] cannot grant list on a file`);
  }
  return { path, kind, operations };
}

function normalizeOperation(operation) {
  if (typeof operation !== "string" || !OPERATION_ALIASES[operation]) {
    throw new ResourceAccessError("INVALID_ARGUMENT", `Unsupported resource operation: ${operation}`, {
      operation,
    });
  }
  return OPERATION_ALIASES[operation];
}

function assertGrantedSubset(granted, declared) {
  for (const grant of granted) {
    const covered = declared.some((declaration) => grantCoveredByDeclaration(grant, declaration));
    if (!covered) {
      throw new TypeError(
        `Granted capability is outside declared policy: ${grant.operations.join(",")} ${grant.path}`,
      );
    }
  }
}

function grantCoveredByDeclaration(grant, declaration) {
  if (!grant.operations.every((operation) => declaration.operations.includes(operation))) return false;
  if (declaration.kind === "file") {
    return grant.kind === "file" && grant.path === declaration.path;
  }
  return isSameOrDescendant(declaration.path, grant.path);
}

function grantAllows(grant, operation, path) {
  if (!grant.operations.includes(operation)) return false;
  if (grant.kind === "file") return grant.path === path;
  return isSameOrDescendant(grant.path, path);
}

function isSameOrDescendant(root, candidate) {
  return root === "." || candidate === root || candidate.startsWith(`${root}/`);
}

function collectDirectoryEntries(root, recursive, files, directories) {
  const result = new Map();
  const prefix = root === "." ? "" : `${root}/`;
  const candidates = [...directories].filter((path) => path !== ".").map((path) => ({ path, type: "directory" }));
  candidates.push(...[...files.keys()].map((path) => ({ path, type: "file" })));

  for (const candidate of candidates) {
    if (!candidate.path.startsWith(prefix) || candidate.path === root) continue;
    const relative = candidate.path.slice(prefix.length);
    if (!recursive && relative.includes("/")) continue;
    const name = recursive ? relative : relative.split("/")[0];
    const path = root === "." ? name : `${root}/${name}`;
    const type = recursive
      ? candidate.type
      : directories.has(path)
        ? "directory"
        : "file";
    result.set(path, { path, name, type });
  }
  return [...result.values()].sort((left, right) => compareStrings(left.path, right.path));
}

function normalizeCanaries(canaries) {
  let entries;
  if (Array.isArray(canaries)) {
    entries = canaries.map((canary, index) =>
      typeof canary === "string" ? { id: `canary-${index + 1}`, value: canary } : canary,
    );
  } else if (
    isPlainObject(canaries)
    && ("value" in canaries || "token" in canaries || "tokenPlaceholder" in canaries)
  ) {
    entries = [{ id: canaries.id ?? "canary-1", ...canaries }];
  } else if (isPlainObject(canaries)) {
    entries = Object.entries(canaries).map(([id, value]) => ({ id, value }));
  } else {
    throw new TypeError("canaries must be an array or id-to-value record");
  }
  const result = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const value = entry?.value ?? entry?.token ?? entry?.tokenPlaceholder;
    if (!isPlainObject(entry) || typeof entry.id !== "string" || entry.id.length === 0) {
      throw new TypeError(`canaries[${index}].id must be a non-empty string`);
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`canaries[${index}] must contain a non-empty value or token`);
    }
    if (result.has(entry.id)) throw new TypeError(`Duplicate canary id: ${entry.id}`);
    result.set(entry.id, Object.freeze({ id: entry.id, value }));
  }
  return result;
}

function normalizeLimits(limits) {
  if (!isPlainObject(limits)) throw new TypeError("limits must be an object");
  const result = {};
  for (const [name, fallback] of Object.entries(DEFAULT_LIMITS)) {
    result[name] = integerOption(limits[name], fallback, name, { minimum: 1 });
  }
  return Object.freeze(result);
}

function integerOption(value, fallback, name, { minimum, maximum = Number.MAX_SAFE_INTEGER }) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new ResourceAccessError(
      "INVALID_ARGUMENT",
      `${name} must be an integer from ${minimum} through ${maximum}`,
    );
  }
  return result;
}

function booleanOption(value, fallback, name) {
  const result = value === undefined ? fallback : value;
  if (typeof result !== "boolean") {
    throw new ResourceAccessError("INVALID_ARGUMENT", `${name} must be a boolean`);
  }
  return result;
}

function validateClock(clock) {
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  return clock;
}

function truncateUtf8(value, limit) {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= limit) return { text: value, truncated: false };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = limit; end >= 0; end -= 1) {
    try {
      return { text: decoder.decode(encoded.slice(0, end)), truncated: true };
    } catch {
      // Valid UTF-8 needs at most three continuation bytes removed.
    }
  }
  return { text: "", truncated: true };
}

function excerptAround(line, matchIndex, limit) {
  if (line.length <= limit) return { text: line, start: 0 };
  const half = Math.floor(limit / 2);
  const start = Math.max(0, Math.min(matchIndex - half, line.length - limit));
  return { text: line.slice(start, start + limit), start };
}

function serializeVisibleContent(content) {
  if (typeof content === "string") return content;
  try {
    const serialized = JSON.stringify(content);
    if (serialized === undefined) throw new TypeError("Visible content is not JSON serializable");
    return serialized;
  } catch (error) {
    throw new TypeError(`Visible content is not JSON serializable: ${error.message}`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function utf8Bytes(value) {
  return new TextEncoder().encode(value).byteLength;
}

function cloneGrant(grant) {
  return { path: grant.path, kind: grant.kind, operations: [...grant.operations] };
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function printableRawPath(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareOperations(left, right) {
  return RESOURCE_OPERATIONS.indexOf(left) - RESOURCE_OPERATIONS.indexOf(right);
}

function compareGrants(left, right) {
  return compareStrings(left.path, right.path)
    || compareStrings(left.kind, right.kind)
    || compareStrings(left.operations.join(","), right.operations.join(","));
}

function compareAttemptRecords(left, right) {
  return compareStrings(left.path, right.path) || compareStrings(left.operation, right.operation);
}
