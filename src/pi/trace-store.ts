import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface TraceEvent {
  at: string;
  type: string;
  data?: unknown;
  typeHash?: string;
}

export interface TraceStoreOptions {
  now?: () => Date;
}

const TRACE_FORMAT = "metadata-only-v1";
const KNOWN_RESULT_STATUSES = new Set([
  "SUCCESS",
  "PARTIAL",
  "NEED_CONTEXT",
  "BLOCKED",
  "INVALID_INPUT",
  "INVALID_RESULT",
  "FAILED",
  "TIMEOUT",
  "BUDGET_EXCEEDED",
  "CANCELLED",
]);
const KNOWN_ERROR_CODES = new Set([
  "ACCESS_MODE_NOT_ALLOWED",
  "BUDGET_EXCEEDED",
  "CANCELLED",
  "CHILD_ACCESS_EXPANSION",
  "CHILD_CONCURRENCY_LIMIT",
  "CHILD_GRANT_EXPANSION",
  "CHILD_SCOPE_LIMIT",
  "CHILD_SKILL_NOT_ALLOWED",
  "COMPLETION_SCHEMA_INVALID",
  "COMPLETION_HAS_SIBLING_TOOL",
  "DUPLICATE_COMPLETION",
  "EVIDENCE_NOT_VISIBLE",
  "EVIDENCE_ID_NOT_FOUND",
  "FAILED",
  "INVALID_INPUT",
  "INVALID_MANIFEST",
  "INVALID_PROMPT_FILE",
  "INVALID_RESOURCE_GRANT",
  "INVALID_RESULT",
  "INVALID_SKILL_NAME",
  "INVALID_ARGUMENT",
  "INVALID_PATH",
  "MISSING_COMPLETION",
  "NOT_A_DIRECTORY",
  "NOT_A_FILE",
  "NOT_FOUND",
  "OUTPUT_SCHEMA_INVALID",
  "PATH_ESCAPE",
  "PROMPT_REFS_TOO_LARGE",
  "RESULT_TOO_LARGE",
  "REQUESTED_RESOURCE_INVALID",
  "SEALED",
  "SKILL_NAME_MISMATCH",
  "SKILL_NOT_FOUND",
  "SCOPE_DEPTH_EXCEEDED",
  "TIMEOUT",
  "UNAUTHORIZED",
]);
const KNOWN_TRACE_EVENTS = new Set([
  "scope_started",
  "skill_loaded",
  "child_tool_attempt",
  "child_scope_started",
  "child_scope_finished",
  "tool_attempt",
  "turn_start",
  "tool_start",
  "tool_end",
  "completion_rejected",
  "completion_batch_rejected",
  "completion_accepted",
  "scope_finished",
]);
const RESOURCE_OPERATIONS = new Set(["read", "list", "search"]);
const BUDGET_FIELDS = ["maxTurns", "maxToolCalls", "timeoutMs", "maxPromptBytes", "maxResultBytes"] as const;
const USAGE_FIELDS = [
  "turns",
  "toolCalls",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "totalTokens",
  "cost",
  "wallTimeMs",
] as const;
const TREE_USAGE_FIELDS = ["scopes", ...USAGE_FIELDS.filter((field) => field !== "wallTimeMs")] as const;
const AUDIT_COUNT_FIELDS = ["attempts", "denials", "actualReadResources", "modelVisibleResources", "canaryHits"] as const;

export class TraceStore {
  readonly traceRoot: string;
  private readonly now: () => Date;

  constructor(traceRoot: string, options: TraceStoreOptions = {}) {
    if (!isAbsolute(traceRoot)) throw new Error("traceRoot must be an absolute path outside the project");
    this.traceRoot = resolve(traceRoot);
    this.now = options.now ?? (() => new Date());
  }

  async begin(scopeId: string, cwd: string, manifest: unknown): Promise<ScopeTrace> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(scopeId)) {
      throw new Error("scopeId may contain only letters, digits, underscore, and hyphen");
    }
    const canonicalProject = await realpath(cwd);
    // Check the nearest existing ancestor before mkdir so an outside-looking
    // symlink cannot create a directory inside the project as a side effect.
    const prospectiveTraceRoot = await canonicalizeProspectivePath(this.traceRoot);
    assertOutsideProject(prospectiveTraceRoot, canonicalProject);
    await mkdir(this.traceRoot, { recursive: true, mode: 0o700 });
    const canonicalTraceRoot = await realpath(this.traceRoot);
    assertOutsideProject(canonicalTraceRoot, canonicalProject);
    const directory = join(this.traceRoot, scopeId);
    let preexisting = false;
    try {
      await lstat(directory);
      preexisting = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (preexisting) {
      let canonicalExisting: string;
      try {
        canonicalExisting = await realpath(directory);
      } catch {
        throw new Error("Trace scope directory escapes traceRoot or is a broken symbolic link");
      }
      assertDescendant(canonicalTraceRoot, canonicalExisting, "Trace scope directory escapes traceRoot");
      throw new Error(`Trace scope already exists: ${scopeId}`);
    }
    // Refuse collisions rather than overwriting an earlier trace or following
    // a pre-created scope-directory symlink.
    await mkdir(directory, { mode: 0o700 });
    const canonicalDirectory = await realpath(directory);
    assertDescendant(canonicalTraceRoot, canonicalDirectory, "Trace scope directory escapes traceRoot");
    assertOutsideProject(canonicalDirectory, canonicalProject);
    await writeJsonAtomic(join(canonicalDirectory, "manifest.json"), projectManifest(manifest));
    return new ScopeTrace(scopeId, canonicalDirectory, this.now);
  }
}

export class ScopeTrace {
  private readonly events: TraceEvent[] = [];
  private readonly now: () => Date;
  readonly traceId: string;
  readonly directory: string;

  constructor(traceId: string, directory: string, now: () => Date = () => new Date()) {
    this.traceId = traceId;
    this.directory = directory;
    this.now = now;
  }

  event(type: string, data?: unknown): void {
    const safeType = KNOWN_TRACE_EVENTS.has(type) ? type : "unclassified_event";
    this.events.push({
      at: this.now().toISOString(),
      type: safeType,
      ...(safeType === type ? {} : { typeHash: fingerprint(type).sha256 }),
      ...(data === undefined ? {} : { data: projectEventData(safeType, data) }),
    });
  }

  async finish(result: unknown): Promise<void> {
    const jsonl = this.events.map((event) => JSON.stringify(event)).join("\n");
    await writeFile(join(this.directory, "events.jsonl"), jsonl.length > 0 ? `${jsonl}\n` : "", { encoding: "utf8", mode: 0o600 });
    await writeJsonAtomic(join(this.directory, "result.json"), projectResult(result));
  }
}

function projectManifest(value: unknown): Record<string, unknown> {
  const source = asRecord(value);
  const digest = fingerprint(value);
  const projected: Record<string, unknown> = {
    traceFormat: TRACE_FORMAT,
    manifestHash: digest.sha256,
    manifestBytes: digest.bytes,
  };
  if (!source) return projected;

  copyString(source, projected, "schemaVersion");
  copyString(source, projected, "scopeId");
  copyString(source, projected, "invocationId");
  copyString(source, projected, "parentSessionId");
  copyString(source, projected, "parentScopeId");
  copyString(source, projected, "rootScopeId");
  copyInteger(source, projected, "depth");
  copyString(source, projected, "requestedSkill");
  copyString(source, projected, "requestedAccessMode");
  copyString(source, projected, "accessMode");
  copyString(source, projected, "startedAt");
  if (Array.isArray(source.promptRefs)) {
    projected.promptRefs = source.promptRefs.map(projectPromptRef);
  }
  if (Array.isArray(source.resourceGrants)) {
    projected.resourceGrants = source.resourceGrants.map(projectGrant).filter(isPresent);
  }
  const budget = projectNumericRecord(source.budget, BUDGET_FIELDS);
  if (budget) projected.budget = budget;
  const delegation = asRecord(source.delegationPolicy);
  if (delegation) {
    const projectedDelegation: Record<string, unknown> = {};
    if (Array.isArray(delegation.allowedSkills)) {
      const allowedSkillHashes = delegation.allowedSkills
        .filter((skill): skill is string => typeof skill === "string")
        .map((skill) => fingerprintText(skill).sha256);
      projectedDelegation.allowedSkillHashes = allowedSkillHashes;
      projectedDelegation.allowedSkillCount = allowedSkillHashes.length;
    }
    copyInteger(delegation, projectedDelegation, "maxChildScopes");
    copyInteger(delegation, projectedDelegation, "maxConcurrency");
    copyString(delegation, projectedDelegation, "childEvidenceBinding");
    if (Object.keys(projectedDelegation).length > 0) projected.delegationPolicy = projectedDelegation;
  }
  if (Object.hasOwn(source, "input")) {
    const input = fingerprint(source.input);
    projected.inputHash = input.sha256;
    projected.inputBytes = input.bytes;
  }
  return projected;
}

function projectPromptRef(value: unknown): Record<string, unknown> {
  const source = asRecord(value);
  const digest = fingerprint(value);
  if (!source) return { referenceHash: digest.sha256, referenceBytes: digest.bytes };
  const projected: Record<string, unknown> = {
    referenceHash: digest.sha256,
    referenceBytes: digest.bytes,
  };
  copyString(source, projected, "kind");
  copySensitiveString(source, projected, "name");
  copySensitiveString(source, projected, "path");
  copyInteger(source, projected, "startLine");
  copyInteger(source, projected, "endLine");
  copyInteger(source, projected, "bytes");
  if (typeof source.content === "string") {
    const content = fingerprintText(source.content);
    projected.contentHash = content.sha256;
    projected.contentBytes = content.bytes;
  }
  return projected;
}

function projectEventData(type: string, value: unknown): Record<string, unknown> {
  const source = asRecord(value);
  const digest = fingerprint(value);
  const projected: Record<string, unknown> = { dataHash: digest.sha256, dataBytes: digest.bytes };
  if (!source) return projected;

  if (type === "skill_loaded") {
    copyString(source, projected, "name");
    copyString(source, projected, "version");
  } else if (type === "tool_attempt" || type === "tool_start" || type === "tool_end" || type === "child_tool_attempt") {
    copyString(source, projected, "tool");
    copySensitiveString(source, projected, "skill");
    copyInteger(source, projected, "ordinal");
    copyBoolean(source, projected, "isError");
    if (typeof source.toolCallId === "string") projected.toolCallIdHash = fingerprintText(source.toolCallId).sha256;
  } else if (type === "turn_start") {
    copyInteger(source, projected, "ordinal");
  } else if (type === "completion_rejected" || type === "completion_batch_rejected") {
    projected.code = safeErrorCode(source.code).code;
    copyInteger(source, projected, "bytes");
    copyInteger(source, projected, "limit");
    copyInteger(source, projected, "completionCalls");
    copyInteger(source, projected, "siblingCalls");
    copyBoolean(source, projected, "fatal");
  } else if (type === "completion_accepted") {
    copyKnownStatus(source, projected, "status");
    copyInteger(source, projected, "bytes");
  } else if (type === "child_scope_started" || type === "child_scope_finished") {
    copyInteger(source, projected, "ordinal");
    copyInteger(source, projected, "depth");
    copySensitiveString(source, projected, "skill");
    copySensitiveString(source, projected, "scopeId");
    copyKnownStatus(source, projected, "status");
    const usage = projectNumericRecord(source.usage, TREE_USAGE_FIELDS);
    if (usage) projected.treeUsage = usage;
  } else if (type === "scope_finished") {
    copyKnownStatus(source, projected, "status");
    const usage = projectNumericRecord(source.usage, USAGE_FIELDS);
    if (usage) projected.usage = usage;
  }
  return projected;
}

function projectResult(value: unknown): Record<string, unknown> {
  const source = asRecord(value);
  const digest = fingerprint(value);
  const projected: Record<string, unknown> = {
    traceFormat: TRACE_FORMAT,
    resultHash: digest.sha256,
    resultBytes: digest.bytes,
  };
  if (!source) return projected;

  copyString(source, projected, "schemaVersion");
  copyString(source, projected, "scopeId");
  copyString(source, projected, "invocationId");
  copyString(source, projected, "parentSessionId");
  copyString(source, projected, "parentScopeId");
  copyString(source, projected, "rootScopeId");
  copyInteger(source, projected, "depth");
  copyString(source, projected, "traceId");
  copyString(source, projected, "startedAt");
  copyString(source, projected, "endedAt");
  copyKnownStatus(source, projected, "status");

  const skill = asRecord(source.skill);
  if (skill) {
    const projectedSkill: Record<string, unknown> = {};
    copyString(skill, projectedSkill, "name");
    copyString(skill, projectedSkill, "version");
    if (Object.keys(projectedSkill).length > 0) projected.skill = projectedSkill;
  }
  if (typeof source.summary === "string") {
    const summary = fingerprintText(source.summary);
    projected.summaryHash = summary.sha256;
    projected.summaryBytes = summary.bytes;
  }
  if (Object.hasOwn(source, "data")) {
    const data = fingerprint(source.data);
    projected.dataHash = data.sha256;
    projected.dataBytes = data.bytes;
  }
  projectCollectionDigest(source, projected, "evidenceRefs", "evidenceRefCount");
  projectCollectionDigest(source, projected, "requestedResources", "requestedResourceCount");
  projectCollectionDigest(source, projected, "warnings", "warningCount");

  const usage = projectNumericRecord(source.usage, USAGE_FIELDS);
  if (usage) projected.usage = usage;
  const treeUsage = projectNumericRecord(source.treeUsage, TREE_USAGE_FIELDS);
  if (treeUsage) projected.treeUsage = treeUsage;
  projectCollectionDigest(source, projected, "childScopes", "childScopeCount");
  const resourceAudit = projectResourceAudit(source.resourceAudit);
  if (resourceAudit) projected.resourceAudit = resourceAudit;
  const error = projectError(source.status, source.error);
  if (error) projected.error = error;
  return projected;
}

function projectCollectionDigest(
  source: Record<string, unknown>,
  projected: Record<string, unknown>,
  key: string,
  countKey: string,
): void {
  if (!Object.hasOwn(source, key)) return;
  const digest = fingerprint(source[key]);
  projected[`${key}Hash`] = digest.sha256;
  projected[`${key}Bytes`] = digest.bytes;
  if (Array.isArray(source[key])) projected[countKey] = source[key].length;
}

function projectError(status: unknown, value: unknown): Record<string, unknown> | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const projected: Record<string, unknown> = {
    classification: classifyError(status),
  };
  const safeCode = safeErrorCode(source.code);
  projected.code = safeCode.code;
  if (safeCode.hash) projected.codeHash = safeCode.hash;
  copyBoolean(source, projected, "retryable");
  if (typeof source.message === "string") {
    const message = fingerprintText(source.message);
    projected.messageHash = message.sha256;
    projected.messageBytes = message.bytes;
  }
  return projected;
}

function classifyError(status: unknown): string {
  if (status === "INVALID_INPUT") return "input_validation";
  if (status === "INVALID_RESULT") return "result_protocol";
  if (status === "TIMEOUT") return "timeout";
  if (status === "BUDGET_EXCEEDED") return "budget";
  if (status === "CANCELLED") return "cancelled";
  if (status === "BLOCKED") return "resource_policy";
  if (status === "FAILED") return "upstream_failure";
  return "unclassified";
}

function safeErrorCode(value: unknown): { code: string; hash?: string } {
  if (typeof value === "string" && KNOWN_ERROR_CODES.has(value)) return { code: value };
  return typeof value === "string"
    ? { code: "UNCLASSIFIED", hash: fingerprintText(value).sha256 }
    : { code: "UNCLASSIFIED" };
}

function projectResourceAudit(value: unknown): Record<string, unknown> | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const projected: Record<string, unknown> = {};
  copyString(source, projected, "schemaVersion");
  copyString(source, projected, "mode");

  for (const key of ["declaredSet", "grantedSet", "declared", "granted"]) {
    if (Array.isArray(source[key])) projected[key] = source[key].map(projectGrant).filter(isPresent);
  }
  for (const key of ["attemptedSet", "actualReadSet", "modelVisibleSet", "physicalMaterializedSet", "attempted", "actualRead", "modelVisible", "modelVisibleSources"]) {
    const set = projectStringSet(source[key]);
    if (set) {
      projected[key] = set;
      projected[`${key}Count`] = set.length;
    }
  }
  for (const key of ["attemptedOperations", "actualReadOperations"]) {
    if (Array.isArray(source[key])) projected[key] = source[key].map(projectAuditOperation).filter(isPresent);
  }
  if (Array.isArray(source.denials)) projected.denials = source.denials.map(projectDenial).filter(isPresent);
  if (Array.isArray(source.canaryVisibility)) {
    projected.canaryVisibility = source.canaryVisibility.map(projectCanaryVisibility).filter(isPresent);
  }
  const counts = projectNumericRecord(source.counts, AUDIT_COUNT_FIELDS);
  if (counts) projected.counts = counts;
  return projected;
}

function projectGrant(value: unknown): Record<string, unknown> | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const projected: Record<string, unknown> = {};
  copySensitiveString(source, projected, "path");
  if (source.kind === "file" || source.kind === "directory") projected.kind = source.kind;
  const operations = projectOperations(source.operations);
  if (operations) projected.operations = operations;
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectAuditOperation(value: unknown): Record<string, unknown> | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const projected: Record<string, unknown> = {};
  copySensitiveString(source, projected, "path");
  if (typeof source.operation === "string" && RESOURCE_OPERATIONS.has(source.operation)) projected.operation = source.operation;
  const operations = projectOperations(source.operations);
  if (operations) projected.operations = operations;
  copyBoolean(source, projected, "allowed");
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectDenial(value: unknown): Record<string, unknown> | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const projected: Record<string, unknown> = {};
  const safeCode = safeErrorCode(source.code);
  projected.code = safeCode.code;
  if (safeCode.hash) projected.codeHash = safeCode.hash;
  if (typeof source.operation === "string" && RESOURCE_OPERATIONS.has(source.operation)) projected.operation = source.operation;
  return projected;
}

function projectCanaryVisibility(value: unknown): Record<string, unknown> | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const projected: Record<string, unknown> = {};
  copySensitiveString(source, projected, "id");
  copyBoolean(source, projected, "visible");
  copyInteger(source, projected, "hitCount");
  const sources = projectStringSet(source.sources);
  if (sources) projected.sources = sources;
  const resourcePaths = projectStringSet(source.resourcePaths);
  if (resourcePaths) projected.resourcePaths = resourcePaths;
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectStringSet(value: unknown): Array<{ sha256: string; bytes: number }> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => fingerprintText(item));
}

function projectOperations(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && RESOURCE_OPERATIONS.has(item));
}

function projectNumericRecord(value: unknown, fields: readonly string[]): Record<string, number> | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const projected: Record<string, number> = {};
  for (const key of fields) {
    const item = source[key];
    if (typeof item === "number" && Number.isFinite(item)) projected[key] = item;
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function copyString(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  if (typeof source[key] === "string") target[key] = source[key];
}

function copySensitiveString(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  const value = source[key];
  if (typeof value !== "string") return;
  const digest = fingerprintText(value);
  target[`${key}Hash`] = digest.sha256;
  target[`${key}Bytes`] = digest.bytes;
}

function copyBoolean(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  if (typeof source[key] === "boolean") target[key] = source[key];
}

function copyInteger(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  if (Number.isSafeInteger(source[key])) target[key] = source[key];
}

function copyKnownStatus(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  const value = source[key];
  target[key] = typeof value === "string" && KNOWN_RESULT_STATUSES.has(value) ? value : "UNCLASSIFIED";
  if (typeof value === "string" && !KNOWN_RESULT_STATUSES.has(value)) target[`${key}Hash`] = fingerprintText(value).sha256;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function fingerprintText(value: string): { sha256: string; bytes: number } {
  return digest(value);
}

function fingerprint(value: unknown): { sha256: string; bytes: number } {
  return digest(stableSerialize(value));
}

function digest(serialized: string): { sha256: string; bytes: number } {
  return {
    sha256: `sha256:${createHash("sha256").update(serialized, "utf8").digest("hex")}`,
    bytes: Buffer.byteLength(serialized, "utf8"),
  };
}

function stableSerialize(value: unknown): string {
  const seen = new Map<object, string>();
  const normalized = canonicalize(value, "$", seen);
  return JSON.stringify(normalized);
}

function canonicalize(value: unknown, path: string, seen: Map<object, string>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return { $type: "bigint", value: value.toString() };
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return { $type: typeof value };
  }
  if (seen.has(value)) return { $ref: seen.get(value) };
  seen.set(value, path);
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${path}[${index}]`, seen));

  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    try {
      output[key] = canonicalize((value as Record<string, unknown>)[key], `${path}.${key}`, seen);
    } catch {
      output[key] = { $type: "unreadable" };
    }
  }
  return output;
}

export function assertOutsideProject(traceRoot: string, cwd: string): void {
  const project = resolve(cwd);
  const trace = resolve(traceRoot);
  const child = relative(project, trace);
  if (!isOutsideRelative(child)) {
    throw new Error(`traceRoot must be outside the scoped project: ${trace}`);
  }
}

function assertDescendant(root: string, candidate: string, message: string): void {
  const child = relative(resolve(root), resolve(candidate));
  if (!isOutsideRelative(child)) return;
  throw new Error(message);
}

function isOutsideRelative(child: string): boolean {
  return child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function canonicalizeProspectivePath(path: string): Promise<string> {
  let cursor = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      const existing = await realpath(cursor);
      return resolve(existing, ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}
