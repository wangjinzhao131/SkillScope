import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const SENIOR_SWE_REPOSITORY_URL = "https://github.com/snorkel-ai/senior-swe-bench-v2026.06.git";
export const SENIOR_SWE_COMMIT = "1212f23a662d2e8d3f321b174735a80be1fdf2e2";
export const SELECTION_SEED = "skillscope-senior-v1";
export const PREPILOT_TASK_IDS = Object.freeze([
  "better-auth-fix-api-key-run",
  "posthog-fix-llm-gateway-add",
]);

const FORBIDDEN_OUTPUT = /solution|oracle|leaderboard/i;
const MAX_SAFE_TOML_PREFIX_BYTES = 128 * 1024;
const ALLOWED_FIELDS = new Map([
  ["task", new Set(["name"])],
  ["environment", new Set(["base_image", "build_timeout_sec", "cpus", "memory", "storage", "network_mode"])],
  ["verifier", new Set(["timeout_sec", "network_mode"])],
  ["agent", new Set(["timeout_sec", "network_mode"])],
  ["metadata", new Set(["family", "variant", "segment", "repo", "tags", "visibility", "version"])],
]);

/** Read and audit the pinned upstream dataset without exposing answer-bearing fields. */
export async function loadSeniorTasks(datasetDirectory) {
  const root = resolve(datasetDirectory);
  await assertPinnedSeniorDataset(root);
  const tasksDirectory = join(root, "tasks");
  const entries = await readdir(tasksDirectory, { withFileTypes: true });
  const tasks = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const taskId = entry.name;
    const source = await readSafeTaskTomlPrefix(join(tasksDirectory, taskId, "task.toml"));
    tasks.push(parseSeniorTaskToml(source, { taskId }));
  }
  if (tasks.length === 0) throw new Error(`No Senior SWE-Bench tasks found under ${tasksDirectory}`);
  assertLeakFree(tasks);
  return tasks;
}

export async function assertPinnedSeniorDataset(datasetDirectory) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("git", ["-C", resolve(datasetDirectory), "rev-parse", "HEAD"], { encoding: "utf8" }));
  }
  catch (error) {
    throw new Error(`Senior SWE-Bench dataset is not a readable git checkout: ${error.message}`);
  }
  const actual = stdout.trim().toLowerCase();
  if (actual !== SENIOR_SWE_COMMIT) {
    throw new Error(`Senior SWE-Bench commit mismatch: expected ${SENIOR_SWE_COMMIT}, got ${actual || "<empty>"}`);
  }
  const status = await execFileAsync("git", ["-C", resolve(datasetDirectory), "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" });
  if (status.stdout.trim()) throw new Error("Senior SWE-Bench checkout has tracked modifications; selection requires the pristine pinned commit");
  return actual;
}

/** Stop before the narrative section that contains the answer text. */
export async function readSafeTaskTomlPrefix(taskTomlPath, { openFile = open } = {}) {
  const info = await lstat(taskTomlPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${taskTomlPath} is not a regular task.toml file`);
  const handle = await openFile(taskTomlPath, "r");
  const byte = Buffer.allocUnsafe(1);
  const bytes = [];
  let lineBytes = [];
  let stopped = false;
  try {
    while (bytes.length < MAX_SAFE_TOML_PREFIX_BYTES) {
      const result = await handle.read(byte, 0, 1, bytes.length);
      if (result.bytesRead === 0) break;
      bytes.push(byte[0]);
      lineBytes.push(byte[0]);
      if (byte[0] !== 0x0a) continue;
      const line = Buffer.from(lineBytes).toString("utf8");
      lineBytes = [];
      const section = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/u)?.[1]?.trim();
      if (section === "metadata.narrative" || section === "leaderboard" || section === "oracle" || (section?.startsWith("solution") && section !== "solution.env")) {
        stopped = true;
        break;
      }
    }
  }
  finally {
    await handle.close();
  }
  if (!stopped) throw new Error(`task.toml did not reach the answer-safety boundary within ${MAX_SAFE_TOML_PREFIX_BYTES} bytes`);
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Parse only fields used by the pre-registered selector. Multiline narrative,
 * solution, origin, verifier env, and every other TOML section are never retained.
 */
export function parseSeniorTaskToml(source, { taskId } = {}) {
  if (typeof source !== "string") throw new TypeError("task.toml source must be a string");
  if (!taskId || basename(taskId) !== taskId) throw new Error("taskId must be one task directory name");

  const retained = new Map();
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  let section = "";
  let multilineDelimiter = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (multilineDelimiter) {
      if (line.includes(multilineDelimiter)) multilineDelimiter = null;
      continue;
    }

    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/u);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }

    const assignment = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/u);
    if (!assignment) continue;
    const [, key, rawStart] = assignment;
    const trimmedStart = rawStart.trimStart();
    const delimiter = trimmedStart.startsWith('"""') ? '"""' : trimmedStart.startsWith("'''") ? "'''" : null;
    if (delimiter && trimmedStart.indexOf(delimiter, 3) === -1) {
      multilineDelimiter = delimiter;
      continue;
    }

    if (!ALLOWED_FIELDS.get(section)?.has(key)) continue;
    let rawValue = rawStart.trim();
    if (rawValue.startsWith("[") && !arrayIsComplete(rawValue)) {
      while (++index < lines.length) {
        rawValue += `\n${lines[index]}`;
        if (arrayIsComplete(rawValue)) break;
      }
      if (!arrayIsComplete(rawValue)) throw new Error(`Unterminated array at [${section}].${key}`);
    }
    retained.set(`${section}.${key}`, parseTomlValue(rawValue, `${section}.${key}`));
  }

  const taskName = requiredString(retained, "task.name");
  if (taskName.split("/").at(-1) !== taskId) throw new Error(`Task directory ${taskId} does not match task.name ${taskName}`);
  const tags = requiredStringArray(retained, "metadata.tags");
  const task = {
    id: taskId,
    taskName,
    repo: requiredString(retained, "metadata.repo"),
    segment: requiredString(retained, "metadata.segment"),
    language: primaryLanguage(tags),
    variant: requiredString(retained, "metadata.variant"),
    visibility: requiredString(retained, "metadata.visibility"),
    datasetVersion: requiredString(retained, "metadata.version"),
    tags,
    environment: {
      baseImage: requiredString(retained, "environment.base_image"),
      buildTimeoutSec: requiredPositiveNumber(retained, "environment.build_timeout_sec"),
      cpus: requiredPositiveNumber(retained, "environment.cpus"),
      memory: requiredString(retained, "environment.memory"),
      storage: requiredString(retained, "environment.storage"),
      networkMode: requiredString(retained, "environment.network_mode"),
    },
    verifier: {
      timeoutSec: requiredPositiveNumber(retained, "verifier.timeout_sec"),
      networkMode: requiredString(retained, "verifier.network_mode"),
    },
    agent: {
      timeoutSec: requiredPositiveNumber(retained, "agent.timeout_sec"),
      networkMode: requiredString(retained, "agent.network_mode"),
    },
  };
  assertLeakFree(task);
  return deepFreeze(task);
}

export function selectPrepilotTasks(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const selected = PREPILOT_TASK_IDS.map((id) => {
    const task = byId.get(id);
    if (!task) throw new Error(`Pinned prepilot task is missing: ${id}`);
    if (task.segment !== "investigate" || task.visibility !== "public" || task.verifier.timeoutSec > 600) {
      throw new Error(`Pinned prepilot task is no longer eligible: ${id}`);
    }
    return task;
  });
  if (new Set(selected.map((task) => task.repo)).size !== selected.length) throw new Error("Prepilot tasks must cover distinct repositories");
  if (new Set(selected.map((task) => task.language)).size !== selected.length) throw new Error("Prepilot tasks must cover distinct primary languages");
  assertLeakFree(selected);
  return Object.freeze(selected);
}

/** Freeze a candidate order before any formal gold/no-op outcome exists. */
export function rankFormalCandidates(tasks, { armPortTaskIds = [] } = {}) {
  const knownIds = new Set(tasks.map((task) => task.id));
  for (const id of armPortTaskIds) if (!knownIds.has(id)) throw new Error(`ARM_PORT task is absent from the pinned dataset: ${id}`);
  const armPort = new Set(armPortTaskIds);
  const eligible = tasks.filter((task) => !PREPILOT_TASK_IDS.includes(task.id)
    && task.segment === "investigate"
    && task.visibility === "public"
    && task.verifier.timeoutSec <= 600);
  const nativeOrder = rankPool(eligible.filter((task) => !armPort.has(task.id)));
  const portOrder = rankPool(eligible.filter((task) => armPort.has(task.id)));
  const ranked = [...nativeOrder, ...portOrder];
  assertLeakFree(ranked);
  return Object.freeze(ranked);
}

function rankPool(pool) {
  const remaining = [...pool];
  const ranked = [];
  const representedRepos = new Set();
  const representedLanguages = new Set();
  while (remaining.length > 0) {
    const freshRepo = remaining.filter((task) => !representedRepos.has(task.repo));
    const repoPool = freshRepo.length > 0 ? freshRepo : remaining;
    const freshLanguage = repoPool.filter((task) => !representedLanguages.has(task.language));
    const pool = freshLanguage.length > 0 ? freshLanguage : repoPool;
    pool.sort((left, right) => declaredSeconds(left) - declaredSeconds(right)
      || selectionHash(left.id).localeCompare(selectionHash(right.id)));
    const selected = pool[0];
    ranked.push(selected);
    representedRepos.add(selected.repo);
    representedLanguages.add(selected.language);
    remaining.splice(remaining.indexOf(selected), 1);
  }
  return ranked;
}

/** Select the first qualified, repo-distinct tasks from the frozen order. */
export function selectFormalTasks(tasks, { qualifiedTaskIds, count, armPortTaskIds = [] }) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("count must be a positive integer");
  if (!Array.isArray(qualifiedTaskIds) || qualifiedTaskIds.length === 0) {
    throw new Error("qualifiedTaskIds must be a non-empty array produced by environment qualification");
  }
  const qualified = new Set(qualifiedTaskIds);
  if (qualified.size !== qualifiedTaskIds.length) throw new Error("qualifiedTaskIds contains duplicates");
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const id of qualified) if (!byId.has(id)) throw new Error(`Qualified task is absent from the pinned dataset: ${id}`);

  const selected = [];
  const selectedRepos = new Set();
  for (const task of rankFormalCandidates(tasks, { armPortTaskIds })) {
    if (!qualified.has(task.id) || selectedRepos.has(task.repo)) continue;
    selected.push(task);
    selectedRepos.add(task.repo);
    if (selected.length === count) break;
  }
  if (selected.length !== count) throw new Error(`Only ${selected.length} repo-distinct tasks passed qualification; cannot select ${count}`);
  assertLeakFree(selected);
  return Object.freeze(selected);
}

export function buildSelectionRecord(tasks, { qualifiedTaskIds, formalCount, armPortTaskIds = [] }) {
  const candidateOrder = rankFormalCandidates(tasks, { armPortTaskIds });
  const record = {
    schemaVersion: "senior-swe-composition.selection.v1",
    dataset: {
      repository: SENIOR_SWE_REPOSITORY_URL,
      commit: SENIOR_SWE_COMMIT,
    },
    rules: {
      seed: SELECTION_SEED,
      segment: "investigate",
      visibility: "public",
      maximumVerifierTimeoutSec: 600,
      maximumTasksPerRepo: 1,
      architectureOrder: ["native-static-candidate", "ARM_PORT"],
      priority: ["unrepresented-repository", "unrepresented-primary-language", "declared-build-plus-verifier-time", "seeded-sha256"],
    },
    prepilot: selectPrepilotTasks(tasks),
    candidateOrder: candidateOrder.map((task) => task.id),
    candidateOrderHash: createHash("sha256").update(candidateOrder.map((task) => task.id).join("\n")).digest("hex"),
    formal: selectFormalTasks(tasks, { qualifiedTaskIds, count: formalCount, armPortTaskIds }),
  };
  assertLeakFree(record);
  return deepFreeze(record);
}

export function selectionHash(taskId) {
  return createHash("sha256").update(`${SELECTION_SEED}:${taskId}`).digest("hex");
}

export function assertLeakFree(value) {
  visit(value, []);
  return true;

  function visit(current, path) {
    if (typeof current === "string") {
      if (FORBIDDEN_OUTPUT.test(current)) throw new Error(`Forbidden answer-bearing text in selection output at ${path.join(".") || "<root>"}`);
      return;
    }
    if (!current || typeof current !== "object") return;
    for (const [key, nested] of Object.entries(current)) {
      if (FORBIDDEN_OUTPUT.test(key)) throw new Error(`Forbidden answer-bearing key in selection output at ${[...path, key].join(".")}`);
      visit(nested, [...path, key]);
    }
  }
}

function declaredSeconds(task) {
  return task.environment.buildTimeoutSec + task.verifier.timeoutSec;
}

function primaryLanguage(tags) {
  for (const language of ["typescript", "python", "rust", "go", "elixir", "java", "javascript", "csharp", "cpp", "c"]) {
    if (tags.some((tag) => tag.toLowerCase() === language || tag.toLowerCase().startsWith(`${language}-`))) return language;
  }
  throw new Error("metadata.tags must include a recognized primary language");
}

function parseTomlValue(raw, label) {
  const withoutComment = stripTomlComment(raw).trim();
  if (withoutComment.startsWith('"')) {
    try { return JSON.parse(withoutComment); }
    catch { throw new Error(`Unsupported string value at ${label}`); }
  }
  if (withoutComment.startsWith("'")) {
    if (!withoutComment.endsWith("'")) throw new Error(`Unterminated literal string at ${label}`);
    return withoutComment.slice(1, -1);
  }
  if (withoutComment.startsWith("[")) {
    const inner = withoutComment.slice(1, -1);
    return splitTomlArray(inner).map((value) => parseTomlValue(value, label));
  }
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(withoutComment)) return Number(withoutComment);
  if (withoutComment === "true") return true;
  if (withoutComment === "false") return false;
  throw new Error(`Unsupported TOML value at ${label}`);
}

function stripTomlComment(raw) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && character === "\\") { escaped = true; continue; }
    if (character === '"' || character === "'") quote = quote === character ? null : quote ?? character;
    else if (character === "#" && !quote) return raw.slice(0, index);
  }
  return raw;
}

function arrayIsComplete(raw) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (const character of raw) {
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && character === "\\") { escaped = true; continue; }
    if (character === '"' || character === "'") { quote = quote === character ? null : quote ?? character; continue; }
    if (quote) continue;
    if (character === "[") depth += 1;
    if (character === "]") depth -= 1;
  }
  return depth === 0;
}

function splitTomlArray(inner) {
  const values = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && character === "\\") { escaped = true; continue; }
    if (character === '"' || character === "'") { quote = quote === character ? null : quote ?? character; continue; }
    if (character === "," && !quote) { values.push(inner.slice(start, index)); start = index + 1; }
  }
  values.push(inner.slice(start));
  return values.map((value) => value.trim()).filter(Boolean);
}

function requiredString(map, key) {
  const value = map.get(key);
  if (typeof value !== "string" || !value) throw new Error(`Missing or invalid ${key}`);
  return value;
}

function requiredStringArray(map, key) {
  const value = map.get(key);
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || !entry)) throw new Error(`Missing or invalid ${key}`);
  return value;
}

function requiredPositiveNumber(map, key) {
  const value = map.get(key);
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`Missing or invalid ${key}`);
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
