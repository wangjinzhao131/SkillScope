import { open, lstat, readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export const ENVIRONMENT_AUDIT_SCHEMA_VERSION = "skillscope.senior-swe.environment-audit.v1";

const MAX_DOCKERFILE_BYTES = 1024 * 1024;
const MAX_TOML_PREFIX_BYTES = 64 * 1024;
const ENVIRONMENT_FIELDS = new Set([
  "base_image",
  "build_timeout_sec",
  "cpus",
  "memory",
  "storage",
  "network_mode",
]);
const VERIFIER_FIELDS = new Set(["timeout_sec", "network_mode"]);

/**
 * Perform a read-only, content-minimizing audit of a Senior SWE-Bench checkout.
 *
 * The only file bodies this function reads are environment/Dockerfile and the
 * small task.toml prefix ending at the first section after [verifier]. Test
 * paths are inspected with lstat only. instruction.md, solution/, oracle files,
 * and every file below tests/ are never opened.
 */
export async function auditSeniorSweEnvironment({
  datasetRoot,
  taskIds,
  limits = {},
  requireValidation = false,
} = {}) {
  if (!datasetRoot) throw codedError("DATASET_ROOT_REQUIRED", "datasetRoot is required");

  const root = resolve(datasetRoot);
  const tasksRoot = join(root, "tasks");
  const taskDirectories = await listTaskDirectories(tasksRoot);
  const selected = selectTaskDirectories(taskDirectories, taskIds);
  const normalizedLimits = normalizeLimits(limits);

  const tasks = [];
  for (const taskId of selected) {
    tasks.push(await auditTask({
      tasksRoot,
      taskId,
      limits: normalizedLimits,
      requireValidation,
    }));
  }

  const summary = {
    total: tasks.length,
    native: tasks.filter((task) => task.architecture.classification === "native").length,
    armPort: tasks.filter((task) => task.architecture.classification === "ARM_PORT").length,
    verifierReady: tasks.filter((task) => task.validation.verifierReady).length,
    validationAvailable: tasks.filter((task) => task.validation.validationAvailable).length,
    staticEligible: tasks.filter((task) => task.qualification.staticEligible).length,
  };

  return {
    schemaVersion: ENVIRONMENT_AUDIT_SCHEMA_VERSION,
    auditMode: "read-only-static",
    datasetRoot: root,
    policy: {
      architectureClassifications: ["native", "ARM_PORT"],
      nativeMeans: "no amd64/x86_64 literal found by static Dockerfile audit; runtime proof is still required",
      requireValidation,
      limits: normalizedLimits,
      bodiesRead: ["tasks/<id>/environment/Dockerfile", "task.toml prefix through [verifier]"],
      existenceOnly: ["tasks/<id>/tests/**"],
      forbiddenBodies: ["instruction.md", "solution/**", "**/oracle*", "tests/**"],
    },
    summary,
    tasks,
  };
}

export async function auditTask({ tasksRoot, taskId, limits = {}, requireValidation = false }) {
  assertTaskId(taskId);
  const taskRoot = join(resolve(tasksRoot), taskId);
  const dockerfilePath = join(taskRoot, "environment", "Dockerfile");
  const taskTomlPath = join(taskRoot, "task.toml");

  const [dockerfileProbe, taskTomlProbe, validation] = await Promise.all([
    probePath(dockerfilePath),
    probePath(taskTomlPath),
    inspectValidationPaths(taskRoot),
  ]);

  let architecture = {
    classification: "ARM_PORT",
    fromImages: [],
    indicators: [{ code: "DOCKERFILE_MISSING", line: null }],
  };
  if (dockerfileProbe.kind === "file") architecture = await inspectDockerfile(dockerfilePath);

  let metadata = { environment: {}, verifier: {}, sourceBytesRead: 0, stoppedAtSection: null };
  let metadataError = null;
  if (taskTomlProbe.kind === "file") {
    try {
      metadata = await readTaskTomlResourcePrefix(taskTomlPath);
    } catch (error) {
      metadataError = { code: error.code ?? "TASK_TOML_READ_FAILED", message: error.message };
    }
  } else {
    metadataError = { code: "TASK_TOML_MISSING", message: "task.toml is not a regular file" };
  }

  const resources = normalizeResources(metadata.environment, metadata.verifier);
  const qualificationReasons = [];
  if (architecture.classification === "ARM_PORT") qualificationReasons.push("ARCHITECTURE_PORT_REQUIRED");
  if (metadataError) qualificationReasons.push(metadataError.code);
  for (const field of ["cpus", "memoryBytes", "storageBytes"]) {
    if (resources[field] === null) qualificationReasons.push(`RESOURCE_${resourceReasonName(field)}_MISSING`);
  }
  if (!validation.verifierReady) qualificationReasons.push("VERIFIER_FILES_MISSING");
  if (requireValidation && !validation.validationAvailable) qualificationReasons.push("VALIDATION_FILES_MISSING");
  appendLimitReasons(qualificationReasons, resources, limits);

  return {
    taskId,
    architecture,
    resources,
    validation,
    metadataInspection: {
      sourceBytesRead: metadata.sourceBytesRead,
      stoppedAtSection: metadata.stoppedAtSection,
      error: metadataError,
    },
    qualification: {
      staticEligible: qualificationReasons.length === 0,
      reasons: [...new Set(qualificationReasons)],
    },
  };
}

export async function inspectDockerfile(dockerfilePath) {
  const info = await lstat(dockerfilePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw codedError("DOCKERFILE_NOT_REGULAR", `${dockerfilePath} is not a regular file`);
  }
  if (info.size > MAX_DOCKERFILE_BYTES) {
    throw codedError("DOCKERFILE_TOO_LARGE", `${dockerfilePath} exceeds ${MAX_DOCKERFILE_BYTES} bytes`);
  }

  const content = await readFile(dockerfilePath, "utf8");
  const fromImages = [];
  const indicators = [];
  const lines = content.split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    if (/^\s*#/u.test(line)) continue;

    const from = /^\s*FROM\s+(?:(--platform=(\S+))\s+)?(\S+)/iu.exec(line);
    if (from) {
      fromImages.push({ line: lineNumber, image: from[3], platform: from[2] ?? null });
      if (from[2] && /(?:^|[/_-])(?:amd64|x86_64)(?:$|[/_.-])/iu.test(from[2])) {
        indicators.push({ code: "FORCED_AMD64_FROM_PLATFORM", line: lineNumber });
      }
    }

    // A literal in a complete runtime architecture dispatch is evidence of
    // portability, not an x86-only download. Keep flagging every literal
    // outside that narrow pattern (including a second hard-coded download in
    // the same Dockerfile).
    if (!isPortableArchitectureMapping(lines, index, line)) {
      if (/\bamd64\b/iu.test(line)) indicators.push({ code: "AMD64_LITERAL", line: lineNumber });
      if (/\bx86_64\b/iu.test(line)) indicators.push({ code: "X86_64_LITERAL", line: lineNumber });
    }
  }

  return {
    classification: indicators.length === 0 ? "native" : "ARM_PORT",
    fromImages,
    indicators: deduplicateIndicators(indicators),
  };
}

function isPortableArchitectureMapping(lines, index, line) {
  const mapping = /^\s*(?:amd64|x86_64)\)\s*([A-Za-z_][A-Za-z0-9_]*)=(?:amd64|x86_64)\s*;;/iu.exec(line);
  if (!mapping) return false;
  const variable = mapping[1];
  const window = lines.slice(Math.max(0, index - 8), Math.min(lines.length, index + 9)).join("\n");
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return /(?:dpkg\s+--print-architecture|uname\s+-m)/iu.test(window)
    && new RegExp(`^\\s*(?:arm64|aarch64)\\)\\s*${escaped}=(?:arm64|aarch64)\\s*;;`, "imu").test(window)
    && new RegExp(`\\$\\{?${escaped}\\}?`, "u").test(window);
}

/**
 * Read only enough of task.toml to collect [environment] and [verifier].
 * Byte-at-a-time reads deliberately avoid read-ahead into later solution or
 * narrative fields. The first subsequent section header is observed, but its
 * body is not read.
 */
export async function readTaskTomlResourcePrefix(taskTomlPath, { openFile = open } = {}) {
  const handle = await openFile(taskTomlPath, "r");
  const state = {
    section: null,
    seenEnvironment: false,
    seenVerifier: false,
    environment: {},
    verifier: {},
    stoppedAtSection: null,
  };
  const byte = Buffer.allocUnsafe(1);
  let lineBytes = [];
  let sourceBytesRead = 0;

  try {
    while (sourceBytesRead < MAX_TOML_PREFIX_BYTES) {
      const result = await handle.read(byte, 0, 1, sourceBytesRead);
      if (result.bytesRead === 0) break;
      sourceBytesRead += 1;
      if (byte[0] === 0x0a) {
        const stop = consumeTomlLine(Buffer.from(lineBytes).toString("utf8"), state);
        lineBytes = [];
        if (stop) break;
      } else {
        lineBytes.push(byte[0]);
      }
    }
    if (lineBytes.length > 0 && state.stoppedAtSection === null) {
      consumeTomlLine(Buffer.from(lineBytes).toString("utf8"), state);
    }
  } finally {
    await handle.close();
  }

  if (!state.seenEnvironment) {
    throw codedError("ENVIRONMENT_SECTION_MISSING", `${basename(taskTomlPath)} has no readable [environment] section before the safety boundary`);
  }
  if (sourceBytesRead >= MAX_TOML_PREFIX_BYTES && state.stoppedAtSection === null) {
    throw codedError("TASK_TOML_PREFIX_TOO_LARGE", `${basename(taskTomlPath)} did not reach a safe boundary within ${MAX_TOML_PREFIX_BYTES} bytes`);
  }

  return {
    environment: state.environment,
    verifier: state.verifier,
    sourceBytesRead,
    stoppedAtSection: state.stoppedAtSection,
  };
}

function consumeTomlLine(rawLine, state) {
  const line = rawLine.replace(/\r$/u, "");
  const sectionMatch = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u.exec(line);
  if (sectionMatch) {
    const nextSection = sectionMatch[1].trim();
    if (state.seenVerifier && nextSection !== "verifier") {
      state.stoppedAtSection = nextSection;
      return true;
    }
    if (state.seenEnvironment && !state.seenVerifier && !["environment", "verifier"].includes(nextSection)) {
      state.stoppedAtSection = nextSection;
      return true;
    }
    if (/^(?:solution|metadata(?:\.|$))/u.test(nextSection) && !state.seenEnvironment) {
      state.stoppedAtSection = nextSection;
      return true;
    }
    state.section = nextSection;
    if (nextSection === "environment") state.seenEnvironment = true;
    if (nextSection === "verifier") state.seenVerifier = true;
    return false;
  }

  const fields = state.section === "environment" ? ENVIRONMENT_FIELDS
    : state.section === "verifier" ? VERIFIER_FIELDS
      : null;
  if (!fields) return false;

  const assignment = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*(?:#.*)?$/u.exec(line);
  if (!assignment || !fields.has(assignment[1])) return false;
  const target = state.section === "environment" ? state.environment : state.verifier;
  target[assignment[1]] = parseTomlScalar(assignment[2]);
  return false;
}

async function inspectValidationPaths(taskRoot) {
  const paths = {
    testSetup: ["tests/test-setup.sh", "file"],
    testEntrypoint: ["tests/test.sh", "file"],
    runVerify: ["tests/run_verify.py", "file"],
    verifyDirectory: ["tests/verify", "directory"],
    runValidate: ["tests/run_validate.py", "file"],
    validateDirectory: ["tests/validate", "directory"],
    validationSpec: ["tests/validate/validation_spec.toml", "file"],
  };
  const inspected = {};
  for (const [name, [relativePath, requiredKind]] of Object.entries(paths)) {
    const probe = await probePath(join(taskRoot, relativePath));
    inspected[name] = { path: relativePath, exists: probe.kind === requiredKind, kind: probe.kind };
  }
  return {
    paths: inspected,
    verifierReady: ["testSetup", "testEntrypoint", "runVerify", "verifyDirectory"]
      .every((name) => inspected[name].exists),
    validationAvailable: ["runValidate", "validateDirectory", "validationSpec"]
      .every((name) => inspected[name].exists),
    inspectionMode: "lstat-only-no-test-body-read",
  };
}

async function listTaskDirectories(tasksRoot) {
  let entries;
  try {
    entries = await readdir(tasksRoot, { withFileTypes: true });
  } catch (error) {
    throw codedError("TASKS_DIRECTORY_UNREADABLE", `Cannot enumerate ${tasksRoot}: ${error.message}`);
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
}

function selectTaskDirectories(available, requested) {
  if (requested === undefined || requested === null) return available;
  const wanted = [...new Set(requested)].sort();
  for (const taskId of wanted) {
    assertTaskId(taskId);
    if (!available.includes(taskId)) throw codedError("TASK_NOT_FOUND", `Task ${taskId} is not a regular directory below tasks/`);
  }
  return wanted;
}

async function probePath(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return { kind: "symlink" };
    if (info.isFile()) return { kind: "file" };
    if (info.isDirectory()) return { kind: "directory" };
    return { kind: "other" };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { kind: "missing" };
    throw error;
  }
}

function normalizeResources(environment, verifier) {
  return {
    baseImage: stringOrNull(environment.base_image),
    cpus: finiteNumberOrNull(environment.cpus),
    memory: stringOrNull(environment.memory),
    memoryBytes: parseByteSize(environment.memory),
    storage: stringOrNull(environment.storage),
    storageBytes: parseByteSize(environment.storage),
    buildTimeoutSec: finiteNumberOrNull(environment.build_timeout_sec),
    environmentNetworkMode: stringOrNull(environment.network_mode),
    verifierTimeoutSec: finiteNumberOrNull(verifier.timeout_sec),
    verifierNetworkMode: stringOrNull(verifier.network_mode),
  };
}

function normalizeLimits(limits) {
  const cpus = limits.cpus === undefined ? null : finiteNumberOrNull(limits.cpus);
  const memoryBytes = limits.memory === undefined && limits.memoryBytes === undefined
    ? null
    : limits.memoryBytes ?? parseByteSize(limits.memory);
  const storageBytes = limits.storage === undefined && limits.storageBytes === undefined
    ? null
    : limits.storageBytes ?? parseByteSize(limits.storage);
  if (limits.cpus !== undefined && cpus === null) throw codedError("INVALID_CPU_LIMIT", `Invalid CPU limit: ${limits.cpus}`);
  if ((limits.memory !== undefined || limits.memoryBytes !== undefined) && !Number.isFinite(memoryBytes)) {
    throw codedError("INVALID_MEMORY_LIMIT", `Invalid memory limit: ${limits.memory ?? limits.memoryBytes}`);
  }
  if ((limits.storage !== undefined || limits.storageBytes !== undefined) && !Number.isFinite(storageBytes)) {
    throw codedError("INVALID_STORAGE_LIMIT", `Invalid storage limit: ${limits.storage ?? limits.storageBytes}`);
  }
  return { cpus, memoryBytes, storageBytes };
}

function appendLimitReasons(reasons, resources, limits) {
  if (limits.cpus !== null && resources.cpus !== null && resources.cpus > limits.cpus) reasons.push("CPU_LIMIT_EXCEEDED");
  if (limits.memoryBytes !== null && resources.memoryBytes !== null && resources.memoryBytes > limits.memoryBytes) reasons.push("MEMORY_LIMIT_EXCEEDED");
  if (limits.storageBytes !== null && resources.storageBytes !== null && resources.storageBytes > limits.storageBytes) reasons.push("STORAGE_LIMIT_EXCEEDED");
}

function parseTomlScalar(raw) {
  const value = raw.trim();
  if (/^"(?:[^"\\]|\\.)*"$/u.test(value)) {
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  }
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value)) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

export function parseByteSize(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== "string") return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*([KMGT]?i?B?|B)?\s*$/iu.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "B").toUpperCase();
  const powers = { B: 0, K: 1, KB: 1, KIB: 1, M: 2, MB: 2, MIB: 2, G: 3, GB: 3, GIB: 3, T: 4, TB: 4, TIB: 4 };
  if (!(unit in powers)) return null;
  return Math.round(amount * (1024 ** powers[unit]));
}

function deduplicateIndicators(indicators) {
  const seen = new Set();
  return indicators.filter((indicator) => {
    const key = `${indicator.code}:${indicator.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function finiteNumberOrNull(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function stringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function resourceReasonName(field) {
  if (field === "memoryBytes") return "MEMORY";
  if (field === "storageBytes") return "STORAGE";
  return "CPUS";
}

function assertTaskId(taskId) {
  if (typeof taskId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(taskId)) {
    throw codedError("INVALID_TASK_ID", `Unsafe task id: ${String(taskId)}`);
  }
}

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}
