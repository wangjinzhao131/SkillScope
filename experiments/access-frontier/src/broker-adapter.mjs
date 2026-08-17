import { access } from "node:fs/promises";
import {
  grantContains,
  modeForCondition,
  normalizeGrant,
  normalizeGrants,
  normalizePath,
  sha256,
  strictNormalizeResourcePath,
} from "./protocol.mjs";

let brokerModulePromise;

async function loadBrokerModule() {
  if (brokerModulePromise) return brokerModulePromise;
  brokerModulePromise = (async () => {
    const candidates = [
      new URL("../../../src/core/index.js", import.meta.url),
      new URL("../../../src/core/index.mjs", import.meta.url),
      new URL("../../../src/core/resource-broker.mjs", import.meta.url),
    ];
    const errors = [];
    for (const candidate of candidates) {
      try {
        await access(candidate);
        const module = await import(candidate.href);
        if (typeof module.ResourceBroker === "function") return module;
        errors.push(`${candidate.pathname}: ResourceBroker export missing`);
      } catch (error) {
        errors.push(`${candidate.pathname}: ${error.message}`);
      }
    }
    throw new Error(`Unable to load ResourceBroker:\n${errors.join("\n")}`);
  })();
  return brokerModulePromise;
}

export class BrokerAdapter {
  static async create({ task, condition, declaredGrants, grants, canaryTokens = [] }) {
    const module = await loadBrokerModule();
    const normalizedDeclared = normalizeGrants(declaredGrants);
    const normalizedGrants = normalizeGrants(grants);
    const files = task.virtualProject?.files ?? [];
    const broker = new module.ResourceBroker({
      files,
      mode: modeForCondition(condition),
      declaredGrants: normalizedDeclared,
      grants: normalizedGrants,
      canaries: canaryTokens,
      promptRefs: task.promptRefs ?? [],
    });
    return new BrokerAdapter({
      broker,
      module,
      task,
      condition,
      declaredGrants: normalizedDeclared,
      grants: normalizedGrants,
    });
  }

  constructor({ broker, module, task, condition, declaredGrants, grants }) {
    this.broker = broker;
    this.module = module;
    this.task = task;
    this.condition = condition;
    this.declaredGrants = declaredGrants;
    this.grants = grants;
    this.visibleEvidenceSpans = (task.promptRefs ?? [])
      .filter((ref) => ref.sourcePath && typeof ref.content === "string")
      .map((ref) => {
        const startLine = ref.sourceStartLine ?? 1;
        return {
          path: normalizePath(ref.sourcePath),
          startLine,
          endLine: ref.sourceEndLine ?? (startLine + logicalLineCount(ref.content) - 1),
          content: ref.content,
          source: "prompt_ref",
        };
      });
  }

  async invoke(name, args) {
    try {
      if (name === "scope_read") {
        const value = await Promise.resolve(this.broker.read(args.path, {
          startLine: args.startLine,
          endLine: args.endLine,
        }));
        this.#recordVisibleSpans(name, value);
        return ok(value);
      }
      if (name === "scope_list") {
        const method = this.broker.list ?? this.broker.find ?? this.broker.ls;
        if (typeof method !== "function") throw new Error("ResourceBroker does not implement list()");
        return ok(await Promise.resolve(method.call(this.broker, args.path ?? ".", {
          recursive: Boolean(args.recursive),
          maxEntries: args.maxResults,
        })));
      }
      if (name === "scope_search") {
        const method = this.broker.search ?? this.broker.grep;
        if (typeof method !== "function") throw new Error("ResourceBroker does not implement search()");
        const value = await Promise.resolve(method.call(
          this.broker,
          String(args.query ?? ""),
          { path: args.path ?? ".", maxResults: args.maxResults },
        ));
        this.#recordVisibleSpans(name, value);
        return ok(value);
      }
      return failure("UNKNOWN_TOOL", `Unknown resource tool: ${name}`, false);
    } catch (error) {
      const isAccessError =
        (this.module.ResourceAccessError && error instanceof this.module.ResourceAccessError)
        || /^RESOURCE_|DENIED|OUT_OF_SCOPE|INVALID_PATH/.test(String(error?.code ?? ""));
      if (!isAccessError) throw error;
      return failure(error.code ?? "RESOURCE_DENIED", error?.message ?? String(error), true);
    }
  }

  #recordVisibleSpans(name, value) {
    if (name === "scope_read" && value?.path && typeof value.content === "string") {
      this.visibleEvidenceSpans.push({
        path: normalizePath(value.path),
        startLine: value.startLine,
        endLine: value.endLine,
        content: value.content,
        source: "read",
      });
    }
    if (name === "scope_search") {
      for (const match of value?.matches ?? []) {
        if (!match?.path || !Number.isInteger(match.line) || typeof match.text !== "string") continue;
        this.visibleEvidenceSpans.push({
          path: normalizePath(match.path),
          startLine: match.line,
          endLine: match.line,
          content: match.text,
          source: "search_match",
        });
      }
    }
  }

  getVisibleEvidenceSpans({ includeContent = false } = {}) {
    return this.visibleEvidenceSpans.map((span) => ({
      path: span.path,
      startLine: span.startLine,
      endLine: span.endLine,
      source: span.source,
      contentHash: sha256(span.content),
      ...(includeContent ? { content: span.content } : {}),
    }));
  }

  snapshot(retainedSet = []) {
    const raw = typeof this.broker.snapshot === "function" ? this.broker.snapshot() : {};
    const attemptedSet = pathsFrom(raw.attempted ?? raw.attemptedSet);
    const actualReadSet = pathsFrom(raw.actualRead ?? raw.actualReadSet);
    const modelVisibleSet = pathsFrom(raw.modelVisible ?? raw.modelVisibleSet);
    const declaredSet = grantsFrom(raw.declared ?? raw.declaredSet, this.declaredGrants);
    const grantedSet = grantsFrom(raw.granted ?? raw.grantedSet, this.grants);
    return {
      declaredSet,
      grantedSet,
      attemptedSet,
      actualReadSet,
      modelVisibleSet,
      retainedSet: [...new Set(retainedSet.map(normalizePath).filter(Boolean))].sort(),
      denials: arrayFrom(raw.denials),
      events: arrayFrom(raw.events),
      raw,
    };
  }

  surface(actualReadSet = []) {
    const files = this.task.virtualProject?.files ?? [];
    const grantedPaths = this.condition === "PROJECT_READ_ONLY"
      ? files.map((file) => normalizePath(file.path))
      : files
          .filter((file) => this.grants.some((grant) => pathCovered(grant, file.path)))
          .map((file) => normalizePath(file.path));
    const readPaths = [...new Set(actualReadSet.map(normalizePath))];
    return {
      grantFiles: grantedPaths.length,
      grantBytes: sumBytes(files, grantedPaths),
      actualReadFiles: readPaths.length,
      actualReadBytes: sumBytes(files, readPaths),
      sensitiveGrantFiles: countSensitive(files, grantedPaths),
      sensitiveReadFiles: countSensitive(files, readPaths),
    };
  }

  policyViolations(actualReadSet = []) {
    if (this.condition === "PROJECT_READ_ONLY") return [];
    if (this.condition === "SEALED") return actualReadSet.map((path) => ({ path, reason: "SEALED_READ" }));
    return actualReadSet
      .filter((path) => !this.grants.some((grant) => pathCovered(grant, path)))
      .map((path) => ({ path, reason: "OUTSIDE_GRANT" }));
  }
}

export function requestWithinEnvelope(request, catalog) {
  try {
    const requested = normalizeGrant({ ...request, path: strictNormalizeResourcePath(request?.path) });
    return normalizeGrants(catalog).some((grant) => grantContains(grant, requested));
  } catch {
    return false;
  }
}

export function expandRequestFromCatalog(request, catalog) {
  let requested;
  try {
    requested = normalizeGrant({ ...request, path: strictNormalizeResourcePath(request?.path) });
  } catch {
    return null;
  }
  const candidates = normalizeGrants(catalog).filter((grant) => grantContains(grant, requested));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const aExact = a.path === requested.path ? 0 : 1;
    const bExact = b.path === requested.path ? 0 : 1;
    return aExact - bExact || a.path.length - b.path.length;
  });
  return requested;
}

function ok(value) {
  return { ok: true, value };
}

function failure(code, message, denied) {
  return { ok: false, error: { code, message, denied } };
}

function arrayFrom(value) {
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return [...value];
  return value === undefined || value === null ? [] : [value];
}

function pathsFrom(value) {
  return [...new Set(arrayFrom(value)
    .map((item) => typeof item === "string" ? item : item?.path ?? item?.resource ?? item?.target)
    .filter((item) => item !== undefined && item !== null && item !== "")
    .map(normalizePath)
  )].sort();
}

function grantsFrom(value, fallback) {
  const values = arrayFrom(value);
  try {
    return values.length ? normalizeGrants(values) : normalizeGrants(fallback);
  } catch {
    return normalizeGrants(fallback);
  }
}

function pathCovered(grant, path) {
  const normalized = normalizeGrant(grant);
  const target = normalizePath(path);
  return normalized.kind === "directory"
    ? normalized.path === "." || target === normalized.path || target.startsWith(`${normalized.path}/`)
    : target === normalized.path;
}

function sumBytes(files, selectedPaths) {
  const selected = new Set(selectedPaths);
  return files.reduce((sum, file) => sum + (selected.has(normalizePath(file.path)) ? Buffer.byteLength(file.content ?? "") : 0), 0);
}

function countSensitive(files, selectedPaths) {
  const selected = new Set(selectedPaths);
  return files.filter((file) => selected.has(normalizePath(file.path)) && file.sensitivity !== "public").length;
}

function logicalLineCount(content) {
  const text = String(content ?? "");
  const withoutTrailingNewline = text.endsWith("\n") ? text.slice(0, -1) : text;
  return withoutTrailingNewline === "" ? 0 : withoutTrailingNewline.split("\n").length;
}
