#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildManifest } from "../src/experiment-runner.mjs";
import { planInitialGrants } from "../src/grant-planner.mjs";
import { captureImplementationIdentity } from "../src/implementation-identity.mjs";
import { JsonlWriter, readJsonLines, writeJsonLines } from "../src/jsonl.mjs";
import { DEFAULT_API_BASE, DEFAULT_MODEL, ModelClientError, OpenAIChatClient, PROVIDER_PROTOCOL } from "../src/model-client.mjs";
import { grantContains, redactKnownSecrets, sha256 } from "../src/protocol.mjs";
import { buildEntropyTasks, loadEntropySuite } from "./executor.mjs";

export const PLANNER_PROBE_VERSION = "planner-budget.v1";
export const CATALOG_MODES = Object.freeze(["root", "sharded"]);
export const PLANNER_TOKEN_BUDGETS = Object.freeze([512, 1_024, 2_048]);

const probeDirectory = dirname(fileURLToPath(import.meta.url));
const experimentDirectory = resolve(probeDirectory, "..");
const projectRoot = resolve(experimentDirectory, "../..");
const preregistrationPath = resolve(projectRoot, "docs/research/Planner输出预算实验预注册_v1.md");
const defaults = Object.freeze({
  suite: join(probeDirectory, "entropy-frontier.v1.json"),
  descriptor: join(probeDirectory, "runs", "planner-budget-v1-descriptor.jsonl"),
  results: join(probeDirectory, "runs", "planner-budget-v1-results.jsonl"),
  summary: join(experimentDirectory, "reports", "planner-budget-v1-summary.jsonl"),
  report: join(experimentDirectory, "reports", "planner-budget-v1-report.md"),
});
const sourceFiles = Object.freeze([
  fileURLToPath(import.meta.url),
  defaults.suite,
  preregistrationPath,
  resolve(experimentDirectory, "src/grant-planner.mjs"),
]);

export async function buildPlannerProbePlan({
  suite,
  repeats = 2,
  seed = "skillscope-planner-budget-v1",
  model = DEFAULT_MODEL,
  apiBase = DEFAULT_API_BASE,
  providerProtocol = PROVIDER_PROTOCOL,
  implementationIdentity = captureImplementationIdentity({ allowDirty: true }),
}) {
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("repeats must be a positive integer");
  const tasksByMode = {};
  const seedRowsByMode = {};
  for (const catalogMode of CATALOG_MODES) {
    const tasks = buildEntropyTasks(suite, { catalogMode });
    const jobs = buildManifest({
      tasks,
      conditions: ["BOUNDED_INFERRED"],
      repeats,
      seed,
      model,
      apiBase,
      providerProtocol,
      implementationIdentity,
    });
    tasksByMode[catalogMode] = tasks;
    seedRowsByMode[catalogMode] = jobs.map((job) => ({ taskId: job.taskId, repeat: job.repeat, seed: job.seed, fixtureHash: job.fixtureHash }));
  }
  const sharedSeeds = new Map();
  for (const catalogMode of CATALOG_MODES) {
    for (const row of seedRowsByMode[catalogMode]) {
      const key = `${row.taskId}:${row.repeat}`;
      if (sharedSeeds.has(key) && sharedSeeds.get(key) !== row.seed) throw new Error(`${key}: catalog modes do not share a seed`);
      sharedSeeds.set(key, row.seed);
    }
  }
  const trials = CATALOG_MODES.flatMap((catalogMode) => PLANNER_TOKEN_BUDGETS.flatMap((plannerMaxTokens) =>
    seedRowsByMode[catalogMode].map((row) => {
      const identity = { catalogMode, plannerMaxTokens, ...row, model, apiBase, providerProtocol };
      return { trialId: `planner_${sha256(identity).slice("sha256:".length, "sha256:".length + 20)}`, ...identity };
    })));
  const descriptorCore = {
    schemaVersion: "1.0",
    plannerProbeVersion: PLANNER_PROBE_VERSION,
    suiteId: suite.suiteId,
    suiteHash: sha256(suite),
    sourceHash: await probeSourceHash(),
    repeats,
    seed,
    model,
    apiBase,
    providerProtocol,
    implementationRevision: implementationIdentity.implementationRevision,
    sourceTreeHash: implementationIdentity.sourceTreeHash,
    implementationDirty: implementationIdentity.implementationDirty,
    catalogModes: CATALOG_MODES,
    plannerTokenBudgets: PLANNER_TOKEN_BUDGETS,
    tasksByMode,
    trials,
    interpretationGuard: "Planner protocol/coverage probe only; a valid tool call is not a worker success or a natural planner-benefit estimate.",
  };
  return { ...descriptorCore, planHash: sha256(descriptorCore) };
}

export async function runPlannerProbe({ descriptor, suite, client, resultsPath = defaults.results, concurrency = 6, onProgress = () => {} }) {
  await validateProbeIdentity({ descriptor, suite, client });
  const previous = await readJsonLines(resultsPath, { allowMissing: true, recoverTruncatedTail: true });
  const completed = new Set(previous.map((row) => row.trialId));
  const pending = descriptor.trials.filter((trial) => !completed.has(trial.trialId));
  const writer = new JsonlWriter(resultsPath);
  let cursor = 0;
  let finished = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, pending.length || 1)) }, async () => {
    while (cursor < pending.length) {
      const trial = pending[cursor++];
      const task = descriptor.tasksByMode[trial.catalogMode].find((candidate) => candidate.id === trial.taskId);
      const startedNs = process.hrtime.bigint();
      let result;
      try {
        const plan = await planInitialGrants({
          task,
          client,
          seed: trial.seed,
          temperature: 0,
          maxTokens: trial.plannerMaxTokens,
        });
        result = {
          schemaVersion: "1.0",
          plannerProbeVersion: descriptor.plannerProbeVersion,
          planHash: descriptor.planHash,
          ...trial,
          status: "completed",
          source: plan.source,
          repairCount: plan.repairCount,
          selectedIndexes: plan.selectedIndexes,
          selectedCount: plan.selectedGrants.length,
          selectedCoversRequired: task.requiredEvidence.every((path) => plan.selectedGrants.some((grant) => grantContains(grant, { path, kind: "file", operations: ["read"] }))),
          attemptDiagnostics: plan.attemptDiagnostics,
          usage: plan.usage,
          durationMs: elapsedMs(startedNs),
        };
      } catch (error) {
        result = {
          schemaVersion: "1.0",
          plannerProbeVersion: descriptor.plannerProbeVersion,
          planHash: descriptor.planHash,
          ...trial,
          status: error instanceof ModelClientError ? "provider_error" : "harness_error",
          error: {
            code: error?.code ?? "PLANNER_PROBE_ERROR",
            message: redactKnownSecrets(String(error?.message ?? error), [client.apiKey]),
          },
          attemptDiagnostics: error?.partialGrantPlanning?.attemptDiagnostics ?? [],
          usage: error?.partialGrantPlanning?.usage ?? null,
          durationMs: elapsedMs(startedNs),
        };
      }
      await writer.append(result);
      finished += 1;
      onProgress({ finished, total: pending.length, trialId: trial.trialId, status: result.status, source: result.source ?? null });
    }
  });
  await Promise.all(workers);
  await writer.close();
  return { planned: descriptor.trials.length, skipped: descriptor.trials.length - pending.length, executed: pending.length };
}

export function summarizePlannerProbe({ descriptor, results }) {
  const latest = new Map(results.map((row) => [row.trialId, row]));
  const rows = descriptor.trials.map((trial) => latest.get(trial.trialId) ?? { ...trial, status: "missing" });
  const cells = CATALOG_MODES.flatMap((catalogMode) => PLANNER_TOKEN_BUDGETS.map((plannerMaxTokens) => {
    const cellRows = rows.filter((row) => row.catalogMode === catalogMode && row.plannerMaxTokens === plannerMaxTokens);
    const eligible = cellRows.filter((row) => row.status === "completed");
    const valid = eligible.filter((row) => row.source === "model_planner");
    return {
      catalogMode,
      plannerMaxTokens,
      planned: cellRows.length,
      observed: cellRows.filter((row) => row.status !== "missing").length,
      eligible: eligible.length,
      excluded: cellRows.filter((row) => !new Set(["missing", "completed"]).has(row.status)).length,
      validPlanCount: valid.length,
      validPlanRate: rate(valid.length, eligible.length),
      firstAttemptValidCount: valid.filter((row) => row.repairCount === 0).length,
      repairedValidCount: valid.filter((row) => row.repairCount === 1).length,
      fallbackAllCount: eligible.filter((row) => row.source === "planner_fallback_all").length,
      coverageCount: valid.filter((row) => row.selectedCoversRequired).length,
      coverageN: valid.length,
      medianSelectedCount: median(valid.map((row) => row.selectedCount)),
      medianCompletionTokens: median(eligible.map((row) => row.usage?.completionTokens)),
      finishReasonCounts: countBy(eligible.flatMap((row) => row.attemptDiagnostics?.map((attempt) => attempt.finishReason ?? "null") ?? [])),
      toolCallAttemptCount: eligible.flatMap((row) => row.attemptDiagnostics ?? []).filter((attempt) => attempt.toolCallPresent).length,
      attemptCount: eligible.reduce((sum, row) => sum + (row.attemptDiagnostics?.length ?? 0), 0),
    };
  }));
  return {
    schemaVersion: "1.0",
    plannerProbeVersion: descriptor.plannerProbeVersion,
    planHash: descriptor.planHash,
    suiteHash: descriptor.suiteHash,
    sourceHash: descriptor.sourceHash,
    implementationRevision: descriptor.implementationRevision,
    plannedTrials: descriptor.trials.length,
    observedTrials: rows.filter((row) => row.status !== "missing").length,
    cells,
    rows,
    interpretationGuard: descriptor.interpretationGuard,
  };
}

export function renderPlannerProbeReport(summary) {
  const lines = [
    "# Planner output-budget probe",
    "",
    `Baseline: \`${summary.implementationRevision}\``,
    "",
    `Plan hash: \`${summary.planHash}\``,
    "",
    `> ${summary.interpretationGuard}`,
    "",
    "| Catalog | max tokens | Eligible | Valid plan | First / repaired | Fallback-all | Coverage among valid | Median selected | Median completion tokens | Finish reasons | Tool-call attempts |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |",
  ];
  for (const cell of summary.cells) {
    lines.push(`| ${cell.catalogMode} | ${cell.plannerMaxTokens} | ${cell.eligible}/${cell.planned} | ${cell.validPlanCount}/${cell.eligible} | ${cell.firstAttemptValidCount}/${cell.repairedValidCount} | ${cell.fallbackAllCount}/${cell.eligible} | ${cell.coverageCount}/${cell.coverageN} | ${format(cell.medianSelectedCount)} | ${format(cell.medianCompletionTokens)} | ${formatCounts(cell.finishReasonCounts)} | ${cell.toolCallAttemptCount}/${cell.attemptCount} |`);
  }
  lines.push("", "A valid `select_grants` call only establishes protocol completion. Coverage is evaluated separately, and neither metric is a worker Hard Pass.", "");
  return `${lines.join("\n")}\n`;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(helpText());
    return;
  }
  const command = args._[0] ?? "all";
  if (!new Set(["plan", "run", "all", "summarize"]).has(command)) throw new Error(`Unknown command: ${command}`);
  const suite = await loadEntropySuite(resolve(args.suite ?? defaults.suite));
  const descriptorPath = resolve(args.descriptor ?? defaults.descriptor);
  const resultsPath = resolve(args.results ?? defaults.results);
  let descriptor;
  if (command === "plan" || command === "all") {
    descriptor = await buildPlannerProbePlan({
      suite,
      repeats: integerArg(args.repeats, 2, "repeats", 1),
      seed: args.seed ?? "skillscope-planner-budget-v1",
      model: args.model ?? DEFAULT_MODEL,
      apiBase: args["api-base"] ?? DEFAULT_API_BASE,
      implementationIdentity: captureImplementationIdentity({ allowDirty: Boolean(args["allow-dirty"]) }),
    });
    await writeJsonLines(descriptorPath, [descriptor]);
    if (command === "plan") {
      process.stdout.write(`${JSON.stringify({ ok: true, trials: descriptor.trials.length, planHash: descriptor.planHash })}\n`);
      return;
    }
  }
  descriptor ??= (await readJsonLines(descriptorPath))[0];
  if (!descriptor) throw new Error("Planner probe descriptor is missing");
  if (command !== "summarize") {
    const client = OpenAIChatClient.fromEnv({
      model: args.model ?? descriptor.model,
      apiBase: args["api-base"] ?? descriptor.apiBase,
      timeoutMs: integerArg(args["request-timeout-ms"], 120_000, "request-timeout-ms", 1),
      maxRetries: integerArg(args.retries, 3, "retries", 0),
    });
    await runPlannerProbe({
      descriptor,
      suite,
      client,
      resultsPath,
      concurrency: integerArg(args.concurrency, 6, "concurrency", 1),
      onProgress: progressLine,
    });
  }
  const results = await readJsonLines(resultsPath, { allowMissing: true });
  const summary = summarizePlannerProbe({ descriptor, results });
  const summaryPath = resolve(args.summary ?? defaults.summary);
  const reportPath = resolve(args.report ?? defaults.report);
  await writeJsonLines(summaryPath, [summary]);
  await writeFile(reportPath, renderPlannerProbeReport(summary), "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, observed: summary.observedTrials, planned: summary.plannedTrials, summaryPath, reportPath })}\n`);
}

async function validateProbeIdentity({ descriptor, suite, client }) {
  const { planHash, ...core } = descriptor;
  if (descriptor.plannerProbeVersion !== PLANNER_PROBE_VERSION || planHash !== sha256(core)) throw new Error("Planner probe descriptor identity mismatch");
  if (descriptor.suiteId !== suite.suiteId || descriptor.suiteHash !== sha256(suite)) throw new Error("Planner probe suite mismatch");
  if (descriptor.sourceHash !== await probeSourceHash()) throw new Error("Planner probe source differs from the frozen descriptor");
  const current = captureImplementationIdentity({ allowDirty: true });
  for (const field of ["implementationRevision", "sourceTreeHash", "implementationDirty"]) {
    if (descriptor[field] !== current[field]) throw new Error(`Planner probe implementation ${field} drift`);
  }
  const publicConfig = client.publicConfig();
  if (descriptor.model !== client.model || descriptor.apiBase !== publicConfig.apiBase || descriptor.providerProtocol !== publicConfig.protocol) throw new Error("Planner probe runtime provider identity mismatch");
}

async function probeSourceHash() {
  const entries = [];
  for (const path of sourceFiles) {
    const bytes = await readFile(path);
    entries.push({ path: path.slice(projectRoot.length + 1), bytes: bytes.length, hash: sha256(bytes.toString("base64")) });
  }
  return sha256(entries);
}

function elapsedMs(startedNs) {
  return Number(process.hrtime.bigint() - startedNs) / 1_000_000;
}

function countBy(values) {
  const result = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

function rate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function median(values) {
  const finite = values.filter((value) => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 === 0 ? (finite[middle - 1] + finite[middle]) / 2 : finite[middle];
}

function format(value) {
  if (value === null || value === undefined) return "NA";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatCounts(counts) {
  return Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join("; ") || "none";
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
    } else result[key] = true;
  }
  return result;
}

function numberArg(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be numeric`);
  return parsed;
}

function integerArg(value, fallback, name, minimum) {
  const parsed = numberArg(value, fallback, name);
  if (!Number.isInteger(parsed) || parsed < minimum) throw new Error(`--${name} must be an integer >= ${minimum}`);
  return parsed;
}

function progressLine(event) {
  process.stderr.write(`[${event.finished}/${event.total}] ${event.trialId} ${event.status} ${event.source ?? ""}\n`);
}

function helpText() {
  return `SkillScope planner output-budget probe\n\nUsage:\n  node planner-budget-probe.mjs plan [options]\n  node planner-budget-probe.mjs run [options]\n  node planner-budget-probe.mjs all [options]\n  node planner-budget-probe.mjs summarize [options]\n\nOptions:\n  --suite PATH\n  --descriptor PATH\n  --results PATH\n  --summary PATH\n  --report PATH\n  --repeats N\n  --seed VALUE\n  --concurrency N\n  --model NAME\n  --api-base URL\n  --request-timeout-ms N\n  --retries N\n  --allow-dirty\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
