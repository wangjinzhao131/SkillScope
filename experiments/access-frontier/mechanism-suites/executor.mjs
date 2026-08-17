#!/usr/bin/env node

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildManifest, runManifest, saveManifest } from "../src/experiment-runner.mjs";
import { captureImplementationIdentity } from "../src/implementation-identity.mjs";
import { loadTasks, readJsonLines, writeJsonLines } from "../src/jsonl.mjs";
import { DEFAULT_API_BASE, DEFAULT_MODEL, OpenAIChatClient, PROVIDER_PROTOCOL } from "../src/model-client.mjs";
import { normalizeGrants, PROTOCOL_VERSION, sha256, stableStringify } from "../src/protocol.mjs";

export const MECHANISM_PROTOCOL_VERSION = "forced-undergrant.v1";
export const CONTROL_CONDITION = "BOUNDED_INFERRED";
export const TREATMENT_CONDITION = "BOUNDED_NEED_RESOURCE";

const suiteDirectory = dirname(fileURLToPath(import.meta.url));
const experimentDirectory = resolve(suiteDirectory, "..");
const defaults = Object.freeze({
  suite: join(suiteDirectory, "forced-undergrant.v1.json"),
  tasks: join(experimentDirectory, "tasks", "cases"),
  manifest: join(suiteDirectory, "runs", "forced-undergrant-r1-manifest.jsonl"),
  descriptor: join(suiteDirectory, "runs", "forced-undergrant-r1-descriptor.jsonl"),
  results: join(suiteDirectory, "runs", "forced-undergrant-r1-results.jsonl"),
  summary: join(experimentDirectory, "reports", "forced-undergrant-r1-summary.jsonl"),
});

const mechanismSourceFiles = Object.freeze([
  join(suiteDirectory, "executor.mjs"),
  join(suiteDirectory, "forced-undergrant.v1.json"),
  join(suiteDirectory, "forced-undergrant.schema.json"),
]);

export async function loadForcedUndergrantSuite(path = defaults.suite) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function buildForcedUndergrantPlan({
  suite,
  tasks,
  repeats = 1,
  seed = "skillscope-forced-undergrant-r1",
  model = DEFAULT_MODEL,
  apiBase = DEFAULT_API_BASE,
  providerProtocol = PROVIDER_PROTOCOL,
  temperature = 0,
  maxTurns = 10,
  maxToolCalls = 24,
  maxTokens = 1_024,
  timeoutMs = 300_000,
  requestTimeoutMs = 120_000,
  maxRetries = 3,
  implementationIdentity = captureImplementationIdentity({ allowDirty: true }),
}) {
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("repeats must be a positive integer");
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  validateSuiteShape(suite);
  const derivedTasks = [];
  const initialGrantOverrides = {};
  const probeDescriptors = [];
  for (const probe of suite.probes) {
    const sourceTask = taskMap.get(probe.taskId);
    if (!sourceTask) throw new Error(`Suite probe references unknown task: ${probe.taskId}`);
    validateProbe(probe, sourceTask);
    const task = deriveMechanismTask(sourceTask, probe);
    derivedTasks.push(task);
    initialGrantOverrides[task.id] = probe.initialGrants;
    probeDescriptors.push({
      sourceTaskId: sourceTask.id,
      derivedTaskId: task.id,
      sourceFixtureHash: sha256({ schemaVersion: sourceTask.fixtureSchemaVersion, task: sourceTask }),
      derivedFixtureHash: sha256({ schemaVersion: task.fixtureSchemaVersion, task }),
      initialGrantHash: sha256(normalizeGrants(probe.initialGrants)),
      requestEnvelopeHash: sha256(normalizeGrants(probe.requestEnvelope)),
      withheldRequiredEvidence: [...probe.withheldRequiredEvidence].sort(),
    });
  }

  const jobs = buildManifest({
    tasks: derivedTasks,
    conditions: [CONTROL_CONDITION, TREATMENT_CONDITION],
    repeats,
    seed,
    model,
    apiBase,
    providerProtocol,
    temperature,
    maxTurns,
    maxToolCalls,
    maxTokens,
    timeoutMs,
    requestTimeoutMs,
    maxRetries,
    initialGrantOverrides,
    implementationIdentity,
  });
  const descriptor = {
    schemaVersion: "1.0",
    mechanismProtocolVersion: MECHANISM_PROTOCOL_VERSION,
    runnerProtocolVersion: PROTOCOL_VERSION,
    suiteId: suite.suiteId,
    suiteHash: sha256(suite),
    mechanismSourceHash: await mechanismSourceHash(),
    manifestHash: jobs[0]?.manifestHash ?? null,
    batchId: jobs[0]?.batchId ?? null,
    jobCount: jobs.length,
    repeats,
    seed,
    model,
    apiBase: jobs[0]?.apiBase ?? apiBase,
    providerProtocol,
    config: jobs[0]?.config ?? null,
    arms: {
      [CONTROL_CONDITION]: "FORCED_UNDERGRANT_NO_EXPANSION",
      [TREATMENT_CONDITION]: "FORCED_UNDERGRANT_NEED_RESOURCE",
    },
    probes: probeDescriptors,
    analysisPolicy: "Independent mechanism estimate; never merge with the natural five-condition access-frontier matrix.",
  };
  validatePlannedJobs(jobs, descriptor);
  return { jobs, descriptor, derivedTasks };
}

export async function saveForcedUndergrantPlan({ jobs, descriptor, manifestPath, descriptorPath }) {
  await saveManifest(manifestPath, jobs);
  await writeJsonLines(descriptorPath, [descriptor]);
}

export async function runForcedUndergrant({
  jobs,
  descriptor,
  suite,
  client,
  resultsPath,
  concurrency = 1,
  rerunFailed = false,
  onProgress = () => {},
}) {
  await validateRunIdentity({ jobs, descriptor, suite });
  return runManifest({
    jobs,
    client,
    resultsPath,
    concurrency,
    rerunFailed,
    onProgress,
  });
}

export function summarizeForcedUndergrant({ jobs, results, descriptor }) {
  validatePlannedJobs(jobs, descriptor);
  const latest = new Map();
  for (const result of results) latest.set(result.jobId, result);
  const groups = Map.groupBy(jobs, (job) => `${job.taskId}:${job.repeat}:${job.seed}`);
  const rows = [];
  for (const [pairKey, pairJobs] of groups) {
    const controlJob = pairJobs.find((job) => job.condition === CONTROL_CONDITION);
    const treatmentJob = pairJobs.find((job) => job.condition === TREATMENT_CONDITION);
    const control = controlJob ? latest.get(controlJob.jobId) : null;
    const treatment = treatmentJob ? latest.get(treatmentJob.jobId) : null;
    const controlEligible = isCapabilityResult(control);
    const treatmentEligible = isCapabilityResult(treatment);
    const pairedEligible = controlEligible && treatmentEligible;
    rows.push({
      pairKey,
      taskId: controlJob?.taskId ?? treatmentJob?.taskId ?? null,
      repeat: controlJob?.repeat ?? treatmentJob?.repeat ?? null,
      seed: controlJob?.seed ?? treatmentJob?.seed ?? null,
      controlJobId: controlJob?.jobId ?? null,
      treatmentJobId: treatmentJob?.jobId ?? null,
      controlStatus: control?.status ?? "missing",
      treatmentStatus: treatment?.status ?? "missing",
      pairedEligible,
      controlSemanticPass: pairedEligible ? Boolean(control.verification?.semanticPass) : null,
      treatmentSemanticPass: pairedEligible ? Boolean(treatment.verification?.semanticPass) : null,
      treatmentRequested: treatmentEligible ? Boolean(treatment.resourceRequest?.requested) : null,
      treatmentApproved: treatmentEligible ? Boolean(treatment.resourceRequest?.approved) : null,
      treatmentFreshRerun: treatmentEligible ? (treatment.attempts?.length === 2) : null,
      recovered: pairedEligible
        ? !Boolean(control.verification?.semanticPass) && Boolean(treatment.verification?.semanticPass)
        : null,
      policyPass: pairedEligible
        ? combinedPolicy(control.verification?.policyPass, treatment.verification?.policyPass)
        : null,
    });
  }
  const eligible = rows.filter((row) => row.pairedEligible);
  const treatments = rows.filter((row) => row.treatmentRequested !== null);
  return {
    schemaVersion: "1.0",
    mechanismProtocolVersion: descriptor.mechanismProtocolVersion,
    runnerProtocolVersion: descriptor.runnerProtocolVersion,
    suiteId: descriptor.suiteId,
    suiteHash: descriptor.suiteHash,
    mechanismSourceHash: descriptor.mechanismSourceHash,
    manifestHash: descriptor.manifestHash,
    batchId: descriptor.batchId,
    plannedPairs: rows.length,
    eligiblePairs: eligible.length,
    excludedPairs: rows.length - eligible.length,
    treatmentRequestCount: treatments.filter((row) => row.treatmentRequested).length,
    treatmentApprovalCount: treatments.filter((row) => row.treatmentApproved).length,
    treatmentFreshRerunCount: treatments.filter((row) => row.treatmentFreshRerun).length,
    recoveredPairCount: eligible.filter((row) => row.recovered).length,
    controlSemanticPassCount: eligible.filter((row) => row.controlSemanticPass).length,
    treatmentSemanticPassCount: eligible.filter((row) => row.treatmentSemanticPass).length,
    policyFailurePairCount: eligible.filter((row) => row.policyPass === false).length,
    requestRate: rate(treatments.filter((row) => row.treatmentRequested).length, treatments.length),
    recoveryRate: rate(eligible.filter((row) => row.recovered).length, eligible.length),
    rows,
    interpretationGuard: "Forced-undergrant estimates mechanism recovery conditional on a deterministic missing-evidence grant; it is not the natural planner/request effect.",
  };
}

export async function runScriptedMechanismSmoke() {
  const suite = await loadForcedUndergrantSuite();
  const tasks = await loadTasks(defaults.tasks);
  const smokeSuite = { ...suite, probes: [suite.probes[0]] };
  const client = new ScriptedMechanismClient();
  const { jobs, descriptor } = await buildForcedUndergrantPlan({
    suite: smokeSuite,
    tasks,
    repeats: 1,
    seed: "forced-undergrant-smoke",
    model: client.model,
    apiBase: client.apiBase,
    providerProtocol: "scripted",
    maxRetries: 0,
    implementationIdentity: captureImplementationIdentity({ allowDirty: true }),
  });
  const temporary = await mkdtemp(join(tmpdir(), "skillscope-forced-undergrant-"));
  const resultsPath = join(temporary, "results.jsonl");
  await runForcedUndergrant({ jobs, descriptor, suite: smokeSuite, client, resultsPath, concurrency: 1 });
  const results = await readJsonLines(resultsPath);
  const summary = summarizeForcedUndergrant({ jobs, results, descriptor });
  const control = results.find((result) => result.condition === CONTROL_CONDITION);
  const treatment = results.find((result) => result.condition === TREATMENT_CONDITION);
  const checks = {
    exactlyOnePair: jobs.length === 2 && summary.plannedPairs === 1,
    sharedSeed: new Set(jobs.map((job) => job.seed)).size === 1,
    sameForcedInitialGrant: new Set(jobs.map((job) => stableStringify(job.initialGrantOverride))).size === 1,
    plannerBypassed: results.every((result) => result.grantPlanning?.source === "manifest_override") && client.plannerCalls === 0,
    controlCannotRecover: control?.verification?.semanticPass === false && control?.result?.abstained === true,
    treatmentRequested: treatment?.resourceRequest?.requested === true && treatment?.resourceRequest?.approved === true,
    treatmentFreshRerun: treatment?.attempts?.length === 2,
    treatmentRecovered: treatment?.verification?.semanticPass === true && summary.recoveredPairCount === 1,
    policyPreserved: summary.policyFailurePairCount === 0,
  };
  if (Object.values(checks).some((value) => !value)) {
    throw new Error(`Forced-undergrant smoke failed: ${JSON.stringify({ checks, summary })}`);
  }
  return { ok: true, checks, summary };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(helpText());
    return;
  }
  if (args.smoke) {
    const smoke = await runScriptedMechanismSmoke();
    process.stdout.write(`${JSON.stringify(smoke, null, 2)}\n`);
    return;
  }
  const command = args._[0] ?? "all";
  if (command === "summarize") {
    const summary = await summarizeCommand(args);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  if (!["plan", "run", "all"].includes(command)) throw new Error(`Unknown command: ${command}`);
  let planned;
  if (command === "plan" || command === "all") planned = await planCommand(args);
  if (command === "plan") {
    process.stdout.write(`${JSON.stringify({ ok: true, jobs: planned.jobs.length, manifestHash: planned.descriptor.manifestHash })}\n`);
    return;
  }
  const run = await runCommand(args, planned);
  process.stdout.write(`${JSON.stringify({ ok: true, executed: run.run.executed, skipped: run.run.skipped, summary: run.summary })}\n`);
}

async function planCommand(args) {
  const suite = await loadForcedUndergrantSuite(resolve(args.suite ?? defaults.suite));
  const tasks = await loadTasks(resolve(args.tasks ?? defaults.tasks));
  const planned = await buildForcedUndergrantPlan({
    suite,
    tasks,
    repeats: integerArg(args.repeats, 1, "repeats", { minimum: 1 }),
    seed: args.seed ?? "skillscope-forced-undergrant-r1",
    model: args.model ?? DEFAULT_MODEL,
    apiBase: args["api-base"] ?? DEFAULT_API_BASE,
    temperature: numberArg(args.temperature, 0, "temperature"),
    maxTurns: integerArg(args["max-turns"], 10, "max-turns", { minimum: 1 }),
    maxToolCalls: integerArg(args["max-tool-calls"], 24, "max-tool-calls", { minimum: 1 }),
    maxTokens: integerArg(args["max-tokens"], 1_024, "max-tokens", { minimum: 1 }),
    timeoutMs: integerArg(args["job-timeout-ms"], 300_000, "job-timeout-ms", { minimum: 1 }),
    requestTimeoutMs: integerArg(args["request-timeout-ms"], 120_000, "request-timeout-ms", { minimum: 1 }),
    maxRetries: integerArg(args.retries, 3, "retries", { minimum: 0 }),
    implementationIdentity: captureImplementationIdentity({ allowDirty: Boolean(args["allow-dirty"]) }),
  });
  await saveForcedUndergrantPlan({
    ...planned,
    manifestPath: resolve(args.manifest ?? defaults.manifest),
    descriptorPath: resolve(args.descriptor ?? defaults.descriptor),
  });
  return { ...planned, suite };
}

async function runCommand(args, planned) {
  const jobs = planned?.jobs ?? await readJsonLines(resolve(args.manifest ?? defaults.manifest));
  const descriptor = planned?.descriptor ?? (await readJsonLines(resolve(args.descriptor ?? defaults.descriptor)))[0];
  const suite = planned?.suite ?? await loadForcedUndergrantSuite(resolve(args.suite ?? defaults.suite));
  if (!descriptor) throw new Error("Mechanism descriptor is missing");
  const client = OpenAIChatClient.fromEnv({
    model: args.model ?? jobs[0]?.model,
    apiBase: args["api-base"] ?? jobs[0]?.apiBase,
    timeoutMs: integerArg(args["request-timeout-ms"], jobs[0]?.config?.requestTimeoutMs ?? 120_000, "request-timeout-ms", { minimum: 1 }),
    maxRetries: integerArg(args.retries, jobs[0]?.config?.maxRetries ?? 3, "retries", { minimum: 0 }),
  });
  const resultsPath = resolve(args.results ?? defaults.results);
  const run = await runForcedUndergrant({
    jobs,
    descriptor,
    suite,
    client,
    resultsPath,
    concurrency: integerArg(args.concurrency, 1, "concurrency", { minimum: 1 }),
    rerunFailed: Boolean(args["rerun-external-failures"]),
    onProgress: progressLine,
  });
  const results = await readJsonLines(resultsPath);
  const summary = summarizeForcedUndergrant({ jobs, results, descriptor });
  if (args.summary) await writeJsonLines(resolve(args.summary === true ? defaults.summary : args.summary), [summary]);
  return { run, summary };
}

async function summarizeCommand(args) {
  const jobs = await readJsonLines(resolve(args.manifest ?? defaults.manifest));
  const descriptor = (await readJsonLines(resolve(args.descriptor ?? defaults.descriptor)))[0];
  const results = await readJsonLines(resolve(args.results ?? defaults.results));
  if (!descriptor) throw new Error("Mechanism descriptor is missing");
  const summary = summarizeForcedUndergrant({ jobs, results, descriptor });
  if (args.summary) await writeJsonLines(resolve(args.summary === true ? defaults.summary : args.summary), [summary]);
  return summary;
}

function deriveMechanismTask(sourceTask, probe) {
  const task = structuredClone(sourceTask);
  const suffix = sourceTask.id.replace(/^af-/, "");
  task.id = `af-forced-undergrant-${suffix}`;
  task.pairId = `pair-forced-undergrant-${suffix}`;
  task.variant = "forced-undergrant-mechanism";
  task.title = `Forced-undergrant mechanism probe: ${sourceTask.title}`;
  task.inferredCatalog = normalizeGrants([...probe.initialGrants, ...probe.requestEnvelope]);
  Object.defineProperty(task, "fixtureSchemaVersion", {
    value: "2.0",
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return task;
}

function validateSuiteShape(suite) {
  if (suite?.schemaVersion !== "1.0" || suite?.suiteId !== "forced-undergrant-r1") {
    throw new Error("Unsupported forced-undergrant suite identity");
  }
  if (!Array.isArray(suite.probes) || suite.probes.length === 0) throw new Error("Suite needs at least one probe");
  const arms = new Map((suite.arms ?? []).map((arm) => [arm.id, arm]));
  if (arms.get("FORCED_UNDERGRANT_NO_EXPANSION")?.allowResourceRequest !== false
    || arms.get("FORCED_UNDERGRANT_NEED_RESOURCE")?.allowResourceRequest !== true
    || arms.get("FORCED_UNDERGRANT_NEED_RESOURCE")?.freshRerunAfterApproval !== true) {
    throw new Error("Suite arms do not encode no-expansion versus one request plus fresh rerun");
  }
  if (new Set(suite.probes.map((probe) => probe.taskId)).size !== suite.probes.length) {
    throw new Error("Suite probe task ids must be unique");
  }
}

function validateProbe(probe, task) {
  const required = new Set(task.requiredEvidence ?? []);
  if (!Array.isArray(probe.initialGrants) || probe.initialGrants.length === 0) throw new Error(`${probe.taskId}: initialGrants is empty`);
  if (!Array.isArray(probe.requestEnvelope) || probe.requestEnvelope.length === 0) throw new Error(`${probe.taskId}: requestEnvelope is empty`);
  for (const withheld of probe.withheldRequiredEvidence ?? []) {
    if (!required.has(withheld)) throw new Error(`${probe.taskId}: withheld path is not required evidence: ${withheld}`);
    if (probe.initialGrants.some((grant) => grantCovers(grant, withheld))) {
      throw new Error(`${probe.taskId}: initial grant covers withheld evidence: ${withheld}`);
    }
    if (!probe.requestEnvelope.some((grant) => grantCovers(grant, withheld))) {
      throw new Error(`${probe.taskId}: request envelope cannot recover withheld evidence: ${withheld}`);
    }
  }
  const accessibleRequired = [...required].filter((path) => probe.initialGrants.some((grant) => grantCovers(grant, path)));
  if (accessibleRequired.length === 0 || accessibleRequired.length === required.size) {
    throw new Error(`${probe.taskId}: initial grant must expose some but not all required evidence`);
  }
}

function validatePlannedJobs(jobs, descriptor) {
  if (!Array.isArray(jobs) || jobs.length === 0) throw new Error("Mechanism manifest is empty");
  if (descriptor.mechanismProtocolVersion !== MECHANISM_PROTOCOL_VERSION
    || descriptor.runnerProtocolVersion !== PROTOCOL_VERSION) {
    throw new Error("Mechanism descriptor protocol mismatch");
  }
  if (descriptor.jobCount !== jobs.length) throw new Error("Mechanism descriptor job count mismatch");
  if (new Set(jobs.map((job) => job.manifestHash)).size !== 1
    || jobs[0].manifestHash !== descriptor.manifestHash) {
    throw new Error("Mechanism descriptor manifest hash mismatch");
  }
  if (new Set(jobs.map((job) => job.batchId)).size !== 1 || jobs[0].batchId !== descriptor.batchId) {
    throw new Error("Mechanism descriptor batch id mismatch");
  }
  const probeMap = new Map((descriptor.probes ?? []).map((probe) => [probe.derivedTaskId, probe]));
  const groups = Map.groupBy(jobs, (job) => `${job.taskId}:${job.repeat}`);
  if (groups.size !== descriptor.probes.length * descriptor.repeats) {
    throw new Error("Mechanism manifest does not contain every frozen probe-repeat pair");
  }
  for (const pairJobs of groups.values()) {
    if (pairJobs.length !== 2
      || new Set(pairJobs.map((job) => job.condition)).size !== 2
      || !pairJobs.some((job) => job.condition === CONTROL_CONDITION)
      || !pairJobs.some((job) => job.condition === TREATMENT_CONDITION)) {
      throw new Error("Every forced-undergrant task-repeat needs exactly the two declared arms");
    }
    if (new Set(pairJobs.map((job) => job.seed)).size !== 1
      || new Set(pairJobs.map((job) => stableStringify(job.initialGrantOverride))).size !== 1) {
      throw new Error("Forced-undergrant arms must share seed and initial grant");
    }
    if (pairJobs.some((job) => !Array.isArray(job.initialGrantOverride) || job.initialGrantOverride.length === 0)) {
      throw new Error("Forced-undergrant jobs need a non-empty manifest initial-grant override");
    }
    const probe = probeMap.get(pairJobs[0].taskId);
    if (!probe
      || pairJobs.some((job) => job.fixtureHash !== probe.derivedFixtureHash)
      || sha256(pairJobs[0].initialGrantOverride) !== probe.initialGrantHash) {
      throw new Error("Mechanism job identity differs from its frozen probe descriptor");
    }
  }
}

async function validateRunIdentity({ jobs, descriptor, suite }) {
  validatePlannedJobs(jobs, descriptor);
  if (descriptor.suiteId !== suite.suiteId || descriptor.suiteHash !== sha256(suite)) {
    throw new Error("Current forced-undergrant suite differs from the frozen descriptor");
  }
  if (descriptor.mechanismSourceHash !== await mechanismSourceHash()) {
    throw new Error("Current mechanism executor differs from the frozen descriptor; rebuild the plan");
  }
}

async function mechanismSourceHash() {
  const entries = [];
  for (const path of mechanismSourceFiles) {
    const bytes = await readFile(path);
    entries.push({ path: path.slice(suiteDirectory.length + 1), bytes: bytes.length, hash: sha256(bytes.toString("base64")) });
  }
  return sha256(entries);
}

function grantCovers(grant, path) {
  const [normalized] = normalizeGrants([grant]);
  return normalized.kind === "file"
    ? normalized.path === path
    : path === normalized.path || path.startsWith(`${normalized.path}/`);
}

function isCapabilityResult(result) {
  return ["completed", "failed", "timeout"].includes(result?.status);
}

function rate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function combinedPolicy(control, treatment) {
  if (control === false || treatment === false) return false;
  if (control === true && treatment === true) return true;
  return null;
}

class ScriptedMechanismClient {
  constructor() {
    this.model = "scripted-forced-undergrant";
    this.apiBase = "local://forced-undergrant";
    this.counter = 0;
    this.plannerCalls = 0;
  }

  publicConfig() {
    return { apiBase: this.apiBase, model: this.model, protocol: "scripted", timeoutMs: 120_000, maxRetries: 0 };
  }

  async complete({ messages, tools, toolChoice }) {
    this.counter += 1;
    if (toolChoice?.function?.name === "select_grants") {
      this.plannerCalls += 1;
      throw new Error("Forced-undergrant smoke must bypass the model grant planner");
    }
    const id = `forced_call_${this.counter}`;
    const toolNames = new Set((tools ?? []).map((tool) => tool.function.name));
    const user = messages.find((message) => message.role === "user")?.content ?? "";
    const grantSection = user.split("# Current resource grants")[1]?.split("# Injected prompt snapshots")[0] ?? "";
    const last = messages.at(-1);
    if (last?.role !== "tool") {
      return scriptedCompletion(id, "scope_read", { path: "logs/jobs/job-204.log" });
    }
    if (last.name === "scope_read" && last.content.includes("observed_attempts=1")) {
      if (grantSection.includes("config/workers/retry.conf")) {
        return scriptedCompletion(id, "scope_read", { path: "config/workers/retry.conf" });
      }
      if (toolNames.has("request_resource")) {
        return scriptedCompletion(id, "request_resource", {
          path: "config/workers/retry.conf",
          kind: "file",
          operations: ["read"],
          reason: "The retry configuration is required to distinguish disabled retries from exhaustion",
        });
      }
      return scriptedCompletion(id, "submit_result", {
        answerCode: "INSUFFICIENT_EVIDENCE",
        summary: "The job log alone does not expose the retry configuration.",
        facts: { jobId: null, observedAttempts: null, retryLimit: null },
        evidence: [{ path: "logs/jobs/job-204.log", startLine: 2, endLine: 2 }],
        confidence: 0,
      });
    }
    if (last.name === "scope_read" && last.content.includes("retry_limit=0")) {
      return scriptedCompletion(id, "submit_result", {
        answerCode: "RETRY_DISABLED",
        summary: "The job stopped after one timeout because retry_limit is zero.",
        facts: { jobId: "job-204", observedAttempts: 1, retryLimit: 0 },
        evidence: [
          { path: "logs/jobs/job-204.log", startLine: 2, endLine: 2 },
          { path: "config/workers/retry.conf", startLine: 2, endLine: 2 },
        ],
        confidence: 1,
      });
    }
    throw new Error(`Unexpected scripted mechanism state: ${last?.name ?? "none"}`);
  }
}

function scriptedCompletion(id, name, args) {
  return {
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    },
    finishReason: "tool_calls",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, apiCalls: 1 },
    requestId: id,
    providerModel: "scripted-forced-undergrant",
  };
}

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      result._.push(value);
      continue;
    }
    const equals = value.indexOf("=");
    if (equals >= 0) {
      result[value.slice(2, equals)] = value.slice(equals + 1);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

function numberArg(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be numeric`);
  return parsed;
}

function integerArg(value, fallback, name, { minimum }) {
  const parsed = numberArg(value, fallback, name);
  if (!Number.isInteger(parsed) || parsed < minimum) throw new Error(`--${name} must be an integer >= ${minimum}`);
  return parsed;
}

function progressLine(event) {
  if (event.type === "job_finished") {
    process.stderr.write(`[${event.completed}/${event.total}] ${event.jobId} ${event.status}\n`);
  }
}

function helpText() {
  return `SkillScope forced-undergrant mechanism executor\n\nUsage:\n  node mechanism-suites/executor.mjs plan [options]\n  node mechanism-suites/executor.mjs run [options]\n  node mechanism-suites/executor.mjs all [options]\n  node mechanism-suites/executor.mjs summarize [options]\n  node mechanism-suites/executor.mjs --smoke\n\nThe executor always runs exactly ${CONTROL_CONDITION} and ${TREATMENT_CONDITION} with the same manifest-frozen initial grant. Raw artifacts use a mechanism-specific runs/ directory and must not be passed to the natural five-arm analyzer.\n\nOptions:\n  --suite PATH\n  --tasks PATH\n  --manifest PATH\n  --descriptor PATH\n  --results PATH\n  --summary PATH             optional reviewed aggregate JSONL\n  --repeats N\n  --seed VALUE\n  --concurrency N\n  --model NAME              default ${DEFAULT_MODEL}\n  --api-base URL            default ${DEFAULT_API_BASE}\n  --temperature N\n  --max-turns N\n  --max-tool-calls N\n  --max-tokens N\n  --job-timeout-ms N\n  --request-timeout-ms N\n  --retries N\n  --allow-dirty             engineering-only plan\n  --rerun-external-failures\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
