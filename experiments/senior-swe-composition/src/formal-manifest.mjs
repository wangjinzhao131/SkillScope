#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { CONDITIONS, DEFAULT_STAGE_BUDGET, PROTOCOL_VERSION, RUNTIME_CHECKPOINT_BUDGET, STAGES } from "./protocol.mjs";
import { buildSelectionRecord, loadSeniorTasks, SENIOR_SWE_COMMIT, SENIOR_SWE_REPOSITORY_URL } from "./selector.mjs";

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "../../..");
const ORDER_PREFIX = "skillscope-senior-formal-v1";
const TASK_ARM_TIMEOUT_MS = 2_700_000;
const REPEATS = 2;

export const FROZEN_CANDIDATE_ORDER = Object.freeze([
  "prefect-fix-resolve-race-condition",
  "firezone-fix-connlib-align-device",
  "better-auth-fix-resolve-dynamic-baseurl",
  "electric-perf-array-filter-eval",
  "paperless-ngx-perf-document-counts",
  "prefect-fix-task-run-recorder",
  "paperless-ngx-perf-workflow-queries",
  "better-auth-fix-oauth-provider-return",
  "electric-fix-resolve-pending-shapes",
  "better-auth-fix-api-return-response",
  "gitea-fix-codeql-code-scanning",
  "gitea-fix-force-push-timeline",
  "gitea-fix-diff-highlight-overlap",
]);

export const TASK_CONFIG = Object.freeze({
  "prefect-fix-resolve-race-condition": taskConfig("prefect-fix-resolve-race-condition", "prefect", "python", "/repo/prefect", "ENV_BUILD_PORT"),
  "firezone-fix-connlib-align-device": taskConfig("firezone-fix-connlib-align-device", "firezone", "rust", "/repo/firezone", "NATIVE_ARM"),
  "better-auth-fix-resolve-dynamic-baseurl": taskConfig("better-auth-fix-resolve-dynamic-baseurl", "better-auth", "typescript", "/repo/better-auth", "ENV_BUILD_PORT"),
  "electric-perf-array-filter-eval": taskConfig("electric-perf-array-filter-eval", "electric", "elixir", "/repo/electric", "ENV_BUILD_PORT"),
});

function taskConfig(taskId, repo, language, repoPath, environmentClass) {
  return Object.freeze({
    repo,
    language,
    repoPath,
    environmentClass,
    solverImage: `skillscope-senior:${taskId}-solver`,
    verifierImage: `skillscope-senior:${taskId}-verifier`,
  });
}

export function pairedSeed(taskId, repeat) {
  if (!Number.isSafeInteger(repeat) || repeat < 0) throw new Error("repeat must be a non-negative safe integer");
  return Number.parseInt(sha256(`${ORDER_PREFIX}:${taskId}:${repeat}`).slice(0, 13), 16);
}

export function buildFormalJobs(taskIds) {
  const jobs = [];
  for (const taskId of taskIds) {
    for (let repeat = 0; repeat < REPEATS; repeat += 1) {
      const seed = pairedSeed(taskId, repeat);
      for (const arm of CONDITIONS) {
        const identity = `${taskId}:${repeat}:${arm}:${seed}`;
        const orderKey = sha256(`${ORDER_PREFIX}:job:${identity}`);
        jobs.push({ jobId: `job_${orderKey.slice(0, 20)}`, taskId, repeat, arm, seed, orderKey });
      }
    }
  }
  return jobs.sort((left, right) => left.orderKey.localeCompare(right.orderKey));
}

export function validateQualification(record, { taskId, verifierImage }) {
  if (record?.schemaVersion !== "skillscope.senior-swe.qualification.v1") throw new Error(`${taskId}: qualification schema mismatch`);
  if (record.taskId !== taskId || record.image !== verifierImage || record.quickGatePass !== true) throw new Error(`${taskId}: qualification identity or gate mismatch`);
  if (!Array.isArray(record.attempts) || record.attempts.length !== 3) throw new Error(`${taskId}: qualification must contain exactly three repeats`);
  for (const [index, attempt] of record.attempts.entries()) {
    for (const [label, expectedPass] of [["noop", false], ["gold", true]]) {
      const result = attempt?.[label]?.result;
      if (!result?.infrastructureValid || result.nativeVerifierPass !== expectedPass || result.runnerErrors !== null) {
        throw new Error(`${taskId}: invalid ${label} result at repeat ${index}`);
      }
      if (!Number.isSafeInteger(result.passed) || !Number.isSafeInteger(result.total) || result.total < 1 || result.passed < 0 || result.passed > result.total) {
        throw new Error(`${taskId}: malformed ${label} score at repeat ${index}`);
      }
    }
  }
  return {
    repeats: 3,
    noopScores: record.attempts.map(({ noop }) => `${noop.result.passed}/${noop.result.total}`),
    goldScores: record.attempts.map(({ gold }) => `${gold.result.passed}/${gold.result.total}`),
    infrastructureValid: true,
    stablePolarity: true,
  };
}

export async function createFormalManifest({ datasetRoot, qualificationRoot, implementationCommit }) {
  const tasks = await loadSeniorTasks(datasetRoot);
  const qualificationRecords = new Map();
  for (const [taskId, config] of Object.entries(TASK_CONFIG)) {
    const path = join(qualificationRoot, `${taskId}.json`);
    const raw = await readFile(path);
    const record = JSON.parse(raw);
    qualificationRecords.set(taskId, { path, raw, record, summary: validateQualification(record, { taskId, verifierImage: config.verifierImage }) });
  }

  const qualifiedTaskIds = [...qualificationRecords.keys()];
  const selection = buildSelectionRecord(tasks, {
    qualifiedTaskIds,
    formalCount: 4,
    armPortTaskIds: FROZEN_CANDIDATE_ORDER.filter((taskId) => taskId.startsWith("gitea-")),
  });
  if (selection.candidateOrder.join("\n") !== FROZEN_CANDIDATE_ORDER.join("\n")) throw new Error("candidate order drifted from preregistration");
  const selectedIds = selection.formal.map(({ id }) => id);
  if (selectedIds.join("\n") !== Object.keys(TASK_CONFIG).join("\n")) throw new Error("formal task selection drifted from the first four qualified repo-distinct candidates");

  const taskEntries = {};
  for (const taskId of selectedIds) {
    const config = TASK_CONFIG[taskId];
    const qualification = qualificationRecords.get(taskId);
    const solver = await inspectImage(config.solverImage);
    const verifier = await inspectImage(config.verifierImage);
    if (solver.architecture !== "arm64" || verifier.architecture !== "arm64") throw new Error(`${taskId}: formal images must be arm64`);
    const instructionPath = join(datasetRoot, "tasks", taskId, "instruction.md");
    const environmentPort = config.environmentClass === "ENV_BUILD_PORT"
      ? await inspectEnvironmentPort({ datasetRoot, taskId, image: config.solverImage })
      : null;
    taskEntries[taskId] = {
      repo: config.repo,
      language: config.language,
      repoPath: config.repoPath,
      instructionSha256: sha256(await readFile(instructionPath)),
      environmentClass: config.environmentClass,
      environmentPort,
      solverImage: config.solverImage,
      solverImageId: solver.id,
      verifierImage: config.verifierImage,
      verifierImageId: verifier.id,
      qualificationRecordSha256: sha256(qualification.raw),
      qualification: qualification.summary,
    };
  }

  const jobs = buildFormalJobs(selectedIds);
  return {
    schemaVersion: "skillscope.senior-swe.formal-manifest.v1",
    protocolVersion: PROTOCOL_VERSION,
    implementationCommit,
    implementationDirty: false,
    createdAt: new Date().toISOString(),
    dataset: { repository: SENIOR_SWE_REPOSITORY_URL, version: "v2026.06.2", commit: SENIOR_SWE_COMMIT },
    model: { provider: "opencode-go", id: "deepseek-v4-flash", api: "openai-completions", baseUrl: "https://opencode.ai/zen/go/v1", temperature: 0 },
    repeats: REPEATS,
    stageOrder: STAGES,
    stageBudget: {
      totalTimeoutMs: DEFAULT_STAGE_BUDGET.timeoutMs,
      work: { maxTurns: DEFAULT_STAGE_BUDGET.maxTurns, maxToolCalls: DEFAULT_STAGE_BUDGET.maxToolCalls, timeoutMs: DEFAULT_STAGE_BUDGET.timeoutMs - RUNTIME_CHECKPOINT_BUDGET.timeoutMs },
      checkpoint: RUNTIME_CHECKPOINT_BUDGET,
      maxResultBytes: DEFAULT_STAGE_BUDGET.maxResultBytes,
      taskArmTimeoutMs: TASK_ARM_TIMEOUT_MS,
    },
    sourceHashes: await sourceHashes(),
    selection: {
      rule: "first four qualification-passing, repo-distinct tasks in the preregistered candidate order",
      candidateOrder: FROZEN_CANDIDATE_ORDER,
      candidateOrderHash: sha256(FROZEN_CANDIDATE_ORDER.join("\n")),
      selectedTaskIds: selectedIds,
    },
    tasks: taskEntries,
    seedRule: `first 52 bits of sha256(${ORDER_PREFIX}:<taskId>:<repeat>)`,
    orderRule: `ascending sha256(${ORDER_PREFIX}:job:<taskId>:<repeat>:<arm>:<seed>)`,
    orderHash: sha256(jobs.map(({ orderKey }) => orderKey).join("\n")),
    jobs,
  };
}

async function sourceHashes() {
  const paths = {
    liveHarnessSha256: "experiments/senior-swe-composition/src/live-harness.mjs",
    protocolSha256: "experiments/senior-swe-composition/src/protocol.mjs",
    selectorSha256: "experiments/senior-swe-composition/src/selector.mjs",
    formalManifestGeneratorSha256: "experiments/senior-swe-composition/src/formal-manifest.mjs",
    environmentPortBuilderSha256: "scripts/senior-swe-build-port.mjs",
    verifierImageBuilderSha256: "scripts/senior-swe-build-verifier-image.mjs",
    preregistrationSha256: "docs/research/SeniorSWE正式Pilot预注册_v1.md",
  };
  return Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, sha256(await readFile(join(ROOT, path)))])));
}

async function inspectImage(image) {
  const { stdout } = await execFileAsync("docker", ["image", "inspect", image, "--format", "{{.Id}}|{{.Architecture}}"], { encoding: "utf8" });
  const [id, architecture] = stdout.trim().split("|");
  if (!id?.startsWith("sha256:") || !architecture) throw new Error(`cannot inspect image ${image}`);
  return { id, architecture };
}

async function inspectEnvironmentPort({ datasetRoot, taskId, image }) {
  const { stdout } = await execFileAsync(process.execPath, [
    join(ROOT, "scripts/senior-swe-build-port.mjs"), "--dataset", datasetRoot, "--task", taskId, "--image", image, "--print-identity", "true",
  ], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  const identity = JSON.parse(stdout);
  delete identity.datasetRoot;
  return identity;
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const datasetRoot = resolve(required(args, "dataset"));
  const qualificationRoot = resolve(required(args, "qualification-root"));
  const output = resolve(required(args, "output"));
  const { stdout: commitOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  const implementationCommit = commitOutput.trim();
  const { stdout: status } = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: ROOT, encoding: "utf8" });
  if (status.trim()) throw new Error("formal manifest generation requires a clean implementation worktree");
  const manifest = await createFormalManifest({ datasetRoot, qualificationRoot, implementationCommit });
  await mkdir(dirname(output), { recursive: true });
  const handle = await open(output, "wx");
  try { await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"); }
  finally { await handle.close(); }
  process.stdout.write(`${JSON.stringify({ output, implementationCommit, tasks: Object.keys(manifest.tasks), jobs: manifest.jobs.length, orderHash: manifest.orderHash }, null, 2)}\n`);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("Arguments must be --key value pairs");
    result[key.slice(2)] = value;
  }
  return result;
}
function required(object, key) { if (!object[key]) throw new Error(`--${key} is required`); return object[key]; }

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
