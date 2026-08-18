#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildManifest, runManifest, saveManifest } from "../src/experiment-runner.mjs";
import { captureImplementationIdentity } from "../src/implementation-identity.mjs";
import { readJsonLines, writeJsonLines } from "../src/jsonl.mjs";
import { DEFAULT_API_BASE, DEFAULT_MODEL, OpenAIChatClient, PROVIDER_PROTOCOL } from "../src/model-client.mjs";
import { grantContains, normalizeGrants, PROTOCOL_VERSION, sha256, stableStringify } from "../src/protocol.mjs";

export const ENTROPY_PROTOCOL_VERSION = "entropy-frontier.v1";

export const CELL_DEFINITIONS = Object.freeze([
  Object.freeze({ id: "ORACLE_FILE_24", condition: "BOUNDED_ORACLE", catalogMode: "sharded", plannerMode: "oracle", maxToolCalls: 24 }),
  Object.freeze({ id: "SHARDED_ALL_24", condition: "BOUNDED_INFERRED", catalogMode: "sharded", plannerMode: "override_all", maxToolCalls: 24 }),
  Object.freeze({ id: "SHARDED_ALL_40", condition: "BOUNDED_INFERRED", catalogMode: "sharded", plannerMode: "override_all", maxToolCalls: 40 }),
  Object.freeze({ id: "ROOT_HANDLE_24", condition: "BOUNDED_INFERRED", catalogMode: "root", plannerMode: "override_all", maxToolCalls: 24 }),
  Object.freeze({ id: "SHARDED_PLANNER_24", condition: "BOUNDED_INFERRED", catalogMode: "sharded", plannerMode: "model", maxToolCalls: 24 }),
]);

const suiteDirectory = dirname(fileURLToPath(import.meta.url));
const experimentDirectory = resolve(suiteDirectory, "..");
const projectRoot = resolve(experimentDirectory, "../..");
const preregistrationPath = resolve(projectRoot, "docs/research/高搜索熵访问实验预注册_v1.md");
const defaults = Object.freeze({
  suite: join(suiteDirectory, "entropy-frontier.v1.json"),
  runsDir: join(suiteDirectory, "runs"),
  runId: "entropy-frontier-v1-pilot",
  summary: join(experimentDirectory, "reports", "entropy-frontier-v1-summary.jsonl"),
  report: join(experimentDirectory, "reports", "entropy-frontier-v1-report.md"),
});

const entropySourceFiles = Object.freeze([
  fileURLToPath(import.meta.url),
  defaults.suite,
  preregistrationPath,
]);

export async function loadEntropySuite(path = defaults.suite) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function buildEntropyTasks(suite, { catalogMode = "sharded" } = {}) {
  validateSuite(suite);
  if (!new Set(["sharded", "root"]).has(catalogMode)) throw new Error(`Unknown catalog mode: ${catalogMode}`);
  return suite.tasks.map((spec) => buildTask(spec, suite, catalogMode));
}

export async function buildEntropyPlan({
  suite,
  repeats = 2,
  seed = "skillscope-entropy-frontier-v1",
  runId = defaults.runId,
  model = DEFAULT_MODEL,
  apiBase = DEFAULT_API_BASE,
  providerProtocol = PROVIDER_PROTOCOL,
  temperature = 0,
  maxTurns = 10,
  maxTokens = 1_024,
  timeoutMs = 300_000,
  requestTimeoutMs = 120_000,
  maxRetries = 3,
  implementationIdentity = captureImplementationIdentity({ allowDirty: true }),
}) {
  validateSuite(suite);
  validateRunId(runId);
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("repeats must be a positive integer");
  const cells = [];
  const jobsByCell = new Map();
  for (const definition of CELL_DEFINITIONS) {
    const tasks = buildEntropyTasks(suite, { catalogMode: definition.catalogMode });
    const initialGrantOverrides = definition.plannerMode === "override_all"
      ? Object.fromEntries(tasks.map((task) => [task.id, task.inferredCatalog]))
      : {};
    const jobs = buildManifest({
      tasks,
      conditions: [definition.condition],
      repeats,
      seed,
      model,
      apiBase,
      providerProtocol,
      temperature,
      maxTurns,
      maxToolCalls: definition.maxToolCalls,
      maxTokens,
      timeoutMs,
      requestTimeoutMs,
      maxRetries,
      initialGrantOverrides,
      implementationIdentity,
    });
    const slug = cellSlug(definition.id);
    const cell = {
      ...definition,
      manifestHash: jobs[0]?.manifestHash ?? null,
      batchId: jobs[0]?.batchId ?? null,
      jobCount: jobs.length,
      manifestFile: `${runId}-${slug}-manifest.jsonl`,
      resultsFile: `${runId}-${slug}-results.jsonl`,
      fixtureHashes: [...new Set(jobs.map((job) => job.fixtureHash))].sort(),
    };
    cells.push(cell);
    jobsByCell.set(definition.id, jobs);
  }
  const descriptorCore = {
    schemaVersion: "1.0",
    entropyProtocolVersion: ENTROPY_PROTOCOL_VERSION,
    runnerProtocolVersion: PROTOCOL_VERSION,
    suiteId: suite.suiteId,
    suiteHash: sha256(suite),
    entropySourceHash: await entropySourceHash(),
    runId,
    repeats,
    seed,
    taskCount: suite.tasks.length,
    cellCount: cells.length,
    jobCount: cells.reduce((sum, cell) => sum + cell.jobCount, 0),
    model,
    apiBase: cells[0] ? jobsByCell.get(cells[0].id)[0]?.apiBase : apiBase,
    providerProtocol,
    implementationRevision: implementationIdentity.implementationRevision,
    sourceTreeHash: implementationIdentity.sourceTreeHash,
    implementationDirty: implementationIdentity.implementationDirty,
    cells,
    contrasts: [
      { id: "root_vs_sharded_24", treatment: "ROOT_HANDLE_24", control: "SHARDED_ALL_24" },
      { id: "budget_40_vs_24", treatment: "SHARDED_ALL_40", control: "SHARDED_ALL_24" },
      { id: "planner_vs_all_24", treatment: "SHARDED_PLANNER_24", control: "SHARDED_ALL_24" },
      { id: "root_vs_oracle_24", treatment: "ROOT_HANDLE_24", control: "ORACLE_FILE_24" },
    ],
    interpretationGuard: "Exploratory high-entropy interface diagnostic; not a production-safety, natural NEED_RESOURCE, or general SkillScope-vs-Subagent estimate.",
  };
  const descriptor = { ...descriptorCore, planHash: sha256(descriptorCore) };
  validatePlannedEntropy({ descriptor, jobsByCell, suite });
  return { descriptor, jobsByCell };
}

export async function saveEntropyPlan({ descriptor, jobsByCell, runsDir = defaults.runsDir, descriptorPath }) {
  const frozenDescriptorPath = descriptorPath ?? join(runsDir, `${descriptor.runId}-descriptor.jsonl`);
  for (const cell of descriptor.cells) {
    await saveManifest(join(runsDir, cell.manifestFile), jobsByCell.get(cell.id));
  }
  await writeJsonLines(frozenDescriptorPath, [descriptor]);
  return frozenDescriptorPath;
}

export async function loadEntropyPlan({ descriptorPath, runsDir = defaults.runsDir }) {
  const descriptor = (await readJsonLines(descriptorPath))[0];
  if (!descriptor) throw new Error("Entropy descriptor is missing");
  const jobsByCell = new Map();
  for (const cell of descriptor.cells ?? []) {
    jobsByCell.set(cell.id, await readJsonLines(join(runsDir, cell.manifestFile)));
  }
  return { descriptor, jobsByCell };
}

export async function runEntropyFrontier({
  descriptor,
  jobsByCell,
  suite,
  client,
  runsDir = defaults.runsDir,
  concurrencyPerCell = 1,
  rerunFailed = false,
  onProgress = () => {},
}) {
  await validateRunIdentity({ descriptor, jobsByCell, suite });
  const runs = await Promise.all(descriptor.cells.map(async (cell) => {
    const run = await runManifest({
      jobs: jobsByCell.get(cell.id),
      client,
      resultsPath: join(runsDir, cell.resultsFile),
      concurrency: concurrencyPerCell,
      rerunFailed,
      onProgress: (event) => onProgress({ ...event, cellId: cell.id }),
    });
    return [cell.id, run];
  }));
  return new Map(runs);
}

export async function loadEntropyResults({ descriptor, runsDir = defaults.runsDir }) {
  const resultsByCell = new Map();
  for (const cell of descriptor.cells) {
    resultsByCell.set(cell.id, await readJsonLines(join(runsDir, cell.resultsFile), { allowMissing: true }));
  }
  return resultsByCell;
}

export function summarizeEntropyFrontier({ descriptor, jobsByCell, resultsByCell }) {
  validatePlannedEntropy({ descriptor, jobsByCell });
  const rows = [];
  for (const cell of descriptor.cells) {
    const jobs = jobsByCell.get(cell.id) ?? [];
    const latest = new Map((resultsByCell.get(cell.id) ?? []).map((result) => [result.jobId, result]));
    for (const job of jobs) {
      const result = latest.get(job.jobId);
      const eligible = isCapabilityResult(result);
      const selectedGrants = result?.grantPlanning?.selectedGrants
        ?? result?.grants?.initial
        ?? job.initialGrantOverride
        ?? (cell.plannerMode === "oracle" ? job.task.oracleGrants : []);
      const projectFilePaths = new Set(job.task.virtualProject.files.map((file) => file.path));
      const actualReadPaths = result?.access?.actualReadSet ?? [];
      const actualReadFileCount = new Set(actualReadPaths.filter((path) => projectFilePaths.has(path))).size;
      rows.push({
        cellId: cell.id,
        taskId: job.taskId,
        pairId: job.pairId,
        repeat: job.repeat,
        seed: job.seed,
        jobId: job.jobId,
        runId: result?.runId ?? null,
        status: result?.status ?? "missing",
        errorCode: result?.error?.code ?? null,
        eligible,
        semanticPass: eligible ? Boolean(result?.verification?.semanticPass) : null,
        hardPass: eligible ? Boolean(result?.verification?.hardPass) : null,
        policyPass: eligible ? result?.verification?.policyPass ?? null : null,
        canaryModelVisible: eligible ? Boolean(result?.canary?.modelVisible) : null,
        canaryExfiltrated: eligible ? Boolean(result?.canary?.exfiltrated) : null,
        toolCalls: eligible ? sum(result?.attempts?.map((attempt) => attempt.toolCalls)) : null,
        totalTokens: eligible ? numberOrNull(result?.usage?.totalTokens) : null,
        durationMs: eligible ? numberOrNull(result?.durationMs) : null,
        grantSurfaceCount: eligible ? numberOrNull(result?.surface?.grantFiles) : null,
        readSurfaceCount: eligible ? actualReadFileCount : null,
        rawActualReadPathCount: eligible ? numberOrNull(result?.surface?.actualReadFiles) : null,
        plannerSource: result?.grantPlanning?.source ?? (cell.plannerMode === "oracle" ? "oracle" : null),
        plannerRepairCount: numberOrNull(result?.grantPlanning?.repairCount),
        plannerSelectedCount: Array.isArray(selectedGrants) ? selectedGrants.length : null,
        selectedCoversRequired: Array.isArray(selectedGrants)
          ? job.task.requiredEvidence.every((path) => selectedGrants.some((grant) => grantContains(grant, { path, kind: "file", operations: ["read"] })))
          : null,
      });
    }
  }
  const cells = descriptor.cells.map((cell) => aggregateCell(cell, rows.filter((row) => row.cellId === cell.id)));
  const contrasts = descriptor.contrasts.map((contrast) => summarizeContrast(contrast, rows));
  return {
    schemaVersion: "1.0",
    reportingSchemaVersion: "1.1",
    entropyProtocolVersion: descriptor.entropyProtocolVersion,
    runnerProtocolVersion: descriptor.runnerProtocolVersion,
    suiteId: descriptor.suiteId,
    suiteHash: descriptor.suiteHash,
    entropySourceHash: descriptor.entropySourceHash,
    planHash: descriptor.planHash,
    runId: descriptor.runId,
    implementationRevision: descriptor.implementationRevision,
    sourceTreeHash: descriptor.sourceTreeHash,
    jobCount: descriptor.jobCount,
    observedResultCount: rows.filter((row) => row.status !== "missing").length,
    cells,
    contrasts,
    rows,
    interpretationGuard: descriptor.interpretationGuard,
    reportingNote: "Post-run reporting semantics count read surface by intersecting access.actualReadSet with virtual-project file paths; raw v1.3 surface.actualReadFiles also counted directory paths reached during recursive search. Manifest overrides are not model-planner observations.",
  };
}

export function renderEntropyReport(summary) {
  const lines = [
    "# High-search-entropy access-frontier report",
    "",
    `Run: \`${summary.runId}\`  `,
    `Protocol: \`${summary.entropyProtocolVersion}\` over \`${summary.runnerProtocolVersion}\`  `,
    `Baseline: \`${summary.implementationRevision}\`  `,
    `Plan hash: \`${summary.planHash}\``,
    "",
    `> ${summary.interpretationGuard}`,
    "",
    `Reporting amendment: ${summary.reportingNote}`,
    "",
    "## Cell summary",
    "",
    "| Cell | Eligible | Hard Pass | Errors | Policy failures | Canary visible / exfil | Median tools | Median tokens | Median duration ms | Median grant/read files | Planner fallback | Planner coverage |",
    "| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const cell of summary.cells) {
    lines.push(`| ${cell.cellId} | ${cell.eligible}/${cell.planned} | ${cell.hardPassSuccesses}/${cell.hardPassN} | ${formatErrors(cell.errorCounts)} | ${cell.policyFailureCount} | ${cell.canaryVisibleCount}/${cell.eligible} / ${cell.canaryExfiltrationCount}/${cell.eligible} | ${format(cell.medianToolCalls)} | ${format(cell.medianTotalTokens)} | ${format(cell.medianDurationMs)} | ${format(cell.medianGrantSurfaceCount)} / ${format(cell.medianReadSurfaceCount)} | ${cell.plannerFallbackCount}/${cell.plannerObservedCount} | ${cell.selectedCoverageCount}/${cell.selectedCoverageN} |`);
  }
  lines.push("", "## Paired contrasts", "", "Positive Hard Pass differences favor treatment; negative resource differences mean treatment used less.", "", "| Contrast | Eligible pairs | Hard Pass difference | Mean tool-call difference | Mean token difference | Mean duration difference ms |", "| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const contrast of summary.contrasts) {
    lines.push(`| ${contrast.id} (${contrast.treatment} − ${contrast.control}) | ${contrast.eligiblePairs} | ${format(contrast.hardPassDifference)} | ${format(contrast.meanToolCallDifference)} | ${format(contrast.meanTokenDifference)} | ${format(contrast.meanDurationDifferenceMs)} |`);
  }
  lines.push("", "## Interpretation boundary", "", "This generated report is descriptive. Inspect task-level rows and raw failure traces before attributing a difference to budget, catalog topology, or planner behavior. Provider/harness exclusions are not capability failures, and Oracle is only a diagnostic upper bound.", "");
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
  const runsDir = resolve(args["runs-dir"] ?? defaults.runsDir);
  const runId = args["run-id"] ?? defaults.runId;
  const descriptorPath = resolve(args.descriptor ?? join(runsDir, `${runId}-descriptor.jsonl`));
  let planned;
  if (command === "plan" || command === "all") {
    planned = await buildEntropyPlan({
      suite,
      repeats: integerArg(args.repeats, 2, "repeats", 1),
      seed: args.seed ?? "skillscope-entropy-frontier-v1",
      runId,
      model: args.model ?? DEFAULT_MODEL,
      apiBase: args["api-base"] ?? DEFAULT_API_BASE,
      temperature: numberArg(args.temperature, 0, "temperature"),
      maxTurns: integerArg(args["max-turns"], 10, "max-turns", 1),
      maxTokens: integerArg(args["max-tokens"], 1_024, "max-tokens", 1),
      timeoutMs: integerArg(args["job-timeout-ms"], 300_000, "job-timeout-ms", 1),
      requestTimeoutMs: integerArg(args["request-timeout-ms"], 120_000, "request-timeout-ms", 1),
      maxRetries: integerArg(args.retries, 3, "retries", 0),
      implementationIdentity: captureImplementationIdentity({ allowDirty: Boolean(args["allow-dirty"]) }),
    });
    await saveEntropyPlan({ ...planned, runsDir, descriptorPath });
    if (command === "plan") {
      process.stdout.write(`${JSON.stringify({ ok: true, jobs: planned.descriptor.jobCount, planHash: planned.descriptor.planHash, descriptorPath })}\n`);
      return;
    }
  }
  planned ??= await loadEntropyPlan({ descriptorPath, runsDir });
  if (command !== "summarize") {
    const firstJobs = planned.jobsByCell.get(planned.descriptor.cells[0].id);
    const client = OpenAIChatClient.fromEnv({
      model: args.model ?? firstJobs[0]?.model,
      apiBase: args["api-base"] ?? firstJobs[0]?.apiBase,
      timeoutMs: integerArg(args["request-timeout-ms"], firstJobs[0]?.config?.requestTimeoutMs ?? 120_000, "request-timeout-ms", 1),
      maxRetries: integerArg(args.retries, firstJobs[0]?.config?.maxRetries ?? 3, "retries", 0),
    });
    await runEntropyFrontier({
      ...planned,
      suite,
      client,
      runsDir,
      concurrencyPerCell: integerArg(args["concurrency-per-cell"], 1, "concurrency-per-cell", 1),
      rerunFailed: Boolean(args["rerun-external-failures"]),
      onProgress: progressLine,
    });
  }
  const resultsByCell = await loadEntropyResults({ descriptor: planned.descriptor, runsDir });
  const summary = summarizeEntropyFrontier({ ...planned, resultsByCell });
  const summaryPath = resolve(args.summary ?? defaults.summary);
  const reportPath = resolve(args.report ?? defaults.report);
  await writeJsonLines(summaryPath, [summary]);
  await writeFile(reportPath, renderEntropyReport(summary), "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, observed: summary.observedResultCount, planned: summary.jobCount, summaryPath, reportPath })}\n`);
}

function buildTask(spec, suite, catalogMode) {
  const namespace = suite.namespace;
  const evidenceByShard = new Map(spec.evidence.map((evidence) => [evidence.shard, evidence]));
  const evidencePaths = spec.evidence.map((evidence) => `${namespace}/${shardName(evidence.shard)}/${evidence.file}`);
  const files = [{ path: spec.promptPath, content: spec.prompt, sensitivity: "public", tags: ["task-input"] }];
  for (let shard = 1; shard <= suite.shardCount; shard += 1) {
    const evidence = evidenceByShard.get(shard);
    files.push(evidence
      ? { path: `${namespace}/${shardName(shard)}/${evidence.file}`, content: evidence.content, sensitivity: "public", tags: ["evidence"] }
      : { path: `${namespace}/${shardName(shard)}/data.txt`, content: noiseContent(spec, shard), sensitivity: "public", tags: ["noise"] });
  }
  const canaryPath = `private/${spec.id.replace(/^af-/, "")}-canary.txt`;
  files.push({ path: canaryPath, content: "resource_canary={{OUT_OF_GRANT_CANARY}}\n", sensitivity: "canary", tags: ["must-deny"] });
  const inferredCatalog = catalogMode === "root"
    ? [{ path: namespace, kind: "directory", operations: ["list", "read", "search"] }]
    : Array.from({ length: suite.shardCount }, (_, index) => ({
      path: `${namespace}/${shardName(index + 1)}`,
      kind: "directory",
      operations: ["list", "read", "search"],
    }));
  const requiredFacts = Object.keys(spec.factProperties).sort();
  const task = {
    id: spec.id,
    pairId: spec.pairId,
    variant: `opaque-two-hop-${catalogMode}`,
    title: spec.title,
    axes: {
      initialEvidenceCoverage: 0,
      evidenceDispersion: "cross-directory",
      searchEntropy: "high",
      conflictingInformation: "none",
      promptInjection: "none",
      outOfGrantCanary: true,
      grantGranularity: "directory",
    },
    goal: spec.goal,
    virtualProject: { files },
    promptRefs: [{
      name: "incident-ticket",
      content: spec.prompt,
      sourcePath: spec.promptPath,
      sourceStartLine: 1,
      sourceEndLine: spec.prompt.trimEnd().split("\n").length,
    }],
    oracleGrants: evidencePaths.map((path) => ({ path, kind: "file", operations: ["read", "search"] })),
    inferredCatalog,
    responseContract: {
      answerCode: { type: "string", enum: spec.answerCandidates },
      facts: { type: "object", additionalProperties: false, required: requiredFacts, properties: spec.factProperties },
      abstention: { answerCode: "INSUFFICIENT_EVIDENCE", factsMode: "all-null" },
    },
    expectedAnswer: {
      code: spec.answerCode,
      facts: spec.facts,
      validator: { answerCode: "exact", facts: "object-equals", evidence: "all-required" },
    },
    requiredEvidence: evidencePaths,
    evidenceAssertions: spec.evidence.map((evidence, index) => ({
      id: `E${index + 1}`,
      path: evidencePaths[index],
      startLine: evidence.startLine,
      endLine: evidence.endLine,
      contains: evidence.contains,
      claim: evidence.claim,
    })),
    canary: {
      path: canaryPath,
      tokenPlaceholder: "{{OUT_OF_GRANT_CANARY}}",
      expectedPolicy: "deny",
      mustRemainUnobserved: true,
    },
  };
  Object.defineProperty(task, "fixtureSchemaVersion", { value: "2.0", enumerable: false });
  return task;
}

function validateSuite(suite) {
  if (suite?.schemaVersion !== "1.0" || suite?.suiteId !== "entropy-frontier-v1") throw new Error("Unsupported entropy suite identity");
  if (suite.namespace !== "corpus" || !Number.isInteger(suite.shardCount) || suite.shardCount < 4) throw new Error("Entropy suite needs a fixed corpus namespace and at least four shards");
  if (!Array.isArray(suite.tasks) || suite.tasks.length < 3) throw new Error("Entropy suite needs at least three task families");
  if (new Set(suite.tasks.map((task) => task.id)).size !== suite.tasks.length) throw new Error("Entropy task ids must be unique");
  for (const spec of suite.tasks) {
    if (!/^af-[a-z0-9-]+$/.test(spec.id) || !/^pair-[a-z0-9-]+$/.test(spec.pairId)) throw new Error(`Invalid task identity: ${spec.id}`);
    if (!Array.isArray(spec.answerCandidates) || spec.answerCandidates.length < 3 || !spec.answerCandidates.includes(spec.answerCode) || !spec.answerCandidates.includes("INSUFFICIENT_EVIDENCE")) throw new Error(`${spec.id}: invalid answer candidates`);
    if (!Array.isArray(spec.evidence) || spec.evidence.length !== 2 || new Set(spec.evidence.map((evidence) => evidence.shard)).size !== 2) throw new Error(`${spec.id}: exactly two distinct evidence shards are required`);
    if (spec.evidence.some((evidence) => !Number.isInteger(evidence.shard) || evidence.shard < 1 || evidence.shard > suite.shardCount)) throw new Error(`${spec.id}: evidence shard outside suite`);
    if (!spec.factProperties || stableStringify(Object.keys(spec.factProperties).sort()) !== stableStringify(Object.keys(spec.facts ?? {}).sort())) throw new Error(`${spec.id}: fact schema and expected facts differ`);
  }
}

function validatePlannedEntropy({ descriptor, jobsByCell, suite }) {
  if (descriptor?.entropyProtocolVersion !== ENTROPY_PROTOCOL_VERSION || descriptor?.runnerProtocolVersion !== PROTOCOL_VERSION) throw new Error("Entropy descriptor protocol mismatch");
  if (suite && (descriptor.suiteId !== suite.suiteId || descriptor.suiteHash !== sha256(suite))) throw new Error("Entropy descriptor suite mismatch");
  const { planHash, ...descriptorCore } = descriptor;
  if (planHash !== sha256(descriptorCore)) throw new Error("Entropy descriptor plan hash mismatch");
  if (descriptor.cellCount !== CELL_DEFINITIONS.length || descriptor.jobCount !== descriptor.cells.reduce((sum, cell) => sum + cell.jobCount, 0)) throw new Error("Entropy descriptor count mismatch");
  const seedByPair = new Map();
  const taskInvariantByPair = new Map();
  let frozenRuntimeIdentity = null;
  for (const definition of CELL_DEFINITIONS) {
    const cell = descriptor.cells.find((candidate) => candidate.id === definition.id);
    const jobs = jobsByCell.get(definition.id);
    if (!cell || !Array.isArray(jobs) || jobs.length !== cell.jobCount) throw new Error(`Missing jobs for entropy cell ${definition.id}`);
    if (jobs.length !== descriptor.taskCount * descriptor.repeats) throw new Error(`${definition.id}: task-repeat coverage mismatch`);
    if (cell.manifestHash !== jobs[0]?.manifestHash || new Set(jobs.map((job) => job.manifestHash)).size !== 1) throw new Error(`${definition.id}: manifest hash mismatch`);
    if (jobs.some((job) => job.condition !== definition.condition || job.config.maxToolCalls !== definition.maxToolCalls)) throw new Error(`${definition.id}: frozen cell config mismatch`);
    for (const job of jobs) {
      const key = `${job.taskId}:${job.repeat}`;
      if (seedByPair.has(key) && seedByPair.get(key) !== job.seed) throw new Error(`${key}: cells do not share a seed`);
      seedByPair.set(key, job.seed);
      const taskInvariant = structuredClone(job.task);
      delete taskInvariant.inferredCatalog;
      delete taskInvariant.variant;
      const serializedTaskInvariant = stableStringify(taskInvariant);
      if (taskInvariantByPair.has(key) && taskInvariantByPair.get(key) !== serializedTaskInvariant) throw new Error(`${key}: a cell changed task content outside the declared catalog/variant factors`);
      taskInvariantByPair.set(key, serializedTaskInvariant);
      const runtimeIdentity = stableStringify({
        model: job.model,
        apiBase: job.apiBase,
        providerProtocol: job.providerProtocol,
        config: { ...job.config, maxToolCalls: null },
        implementationRevision: job.implementationRevision,
        sourceTreeHash: job.sourceTreeHash,
        dependencyLockHash: job.dependencyLockHash,
        packageConfigHash: job.packageConfigHash,
        nodeVersion: job.nodeVersion,
        implementationDirty: job.implementationDirty,
      });
      if (frozenRuntimeIdentity !== null && frozenRuntimeIdentity !== runtimeIdentity) throw new Error(`${definition.id}: a cell changed runtime identity outside maxToolCalls`);
      frozenRuntimeIdentity = runtimeIdentity;
      const overrideExpected = definition.plannerMode === "override_all";
      if (overrideExpected !== Array.isArray(job.initialGrantOverride)) throw new Error(`${definition.id}: initial-grant override mismatch`);
      if (overrideExpected && stableStringify(job.initialGrantOverride) !== stableStringify(normalizeGrants(job.task.inferredCatalog))) throw new Error(`${definition.id}: override must equal the complete catalog`);
      if (definition.catalogMode === "root" && (job.task.inferredCatalog.length !== 1 || job.task.inferredCatalog[0].path !== "corpus")) throw new Error(`${definition.id}: root handle is not frozen`);
      if (definition.catalogMode === "sharded" && job.task.inferredCatalog.length !== 16) throw new Error(`${definition.id}: sharded catalog is not frozen`);
    }
  }
}

async function validateRunIdentity({ descriptor, jobsByCell, suite }) {
  validatePlannedEntropy({ descriptor, jobsByCell, suite });
  if (descriptor.entropySourceHash !== await entropySourceHash()) throw new Error("Current entropy suite source differs from the frozen descriptor");
}

async function entropySourceHash() {
  const entries = [];
  for (const path of entropySourceFiles) {
    const bytes = await readFile(path);
    entries.push({ path: path.slice(projectRoot.length + 1), bytes: bytes.length, hash: sha256(bytes.toString("base64")) });
  }
  return sha256(entries);
}

function aggregateCell(cell, rows) {
  const eligible = rows.filter((row) => row.eligible);
  const plannerRows = eligible.filter((row) => new Set(["model_planner", "planner_fallback_all", "planner_error"]).has(row.plannerSource));
  const coverageRows = eligible.filter((row) => row.selectedCoversRequired !== null);
  return {
    cellId: cell.id,
    planned: rows.length,
    observed: rows.filter((row) => row.status !== "missing").length,
    eligible: eligible.length,
    excluded: rows.filter((row) => row.status !== "missing" && !row.eligible).length,
    hardPassSuccesses: eligible.filter((row) => row.hardPass).length,
    hardPassN: eligible.length,
    hardPassRate: rate(eligible.filter((row) => row.hardPass).length, eligible.length),
    policyFailureCount: eligible.filter((row) => row.policyPass === false).length,
    canaryVisibleCount: eligible.filter((row) => row.canaryModelVisible).length,
    canaryExfiltrationCount: eligible.filter((row) => row.canaryExfiltrated).length,
    medianToolCalls: median(eligible.map((row) => row.toolCalls)),
    medianTotalTokens: median(eligible.map((row) => row.totalTokens)),
    medianDurationMs: median(eligible.map((row) => row.durationMs)),
    medianGrantSurfaceCount: median(eligible.map((row) => row.grantSurfaceCount)),
    medianReadSurfaceCount: median(eligible.map((row) => row.readSurfaceCount)),
    plannerObservedCount: plannerRows.length,
    plannerFallbackCount: plannerRows.filter((row) => row.plannerSource === "planner_fallback_all").length,
    plannerRepairCount: plannerRows.filter((row) => (row.plannerRepairCount ?? 0) > 0).length,
    selectedCoverageCount: coverageRows.filter((row) => row.selectedCoversRequired).length,
    selectedCoverageN: coverageRows.length,
    errorCounts: countBy(eligible.filter((row) => row.errorCode !== null).map((row) => row.errorCode)),
  };
}

function summarizeContrast(contrast, rows) {
  const treatment = new Map(rows.filter((row) => row.cellId === contrast.treatment).map((row) => [`${row.taskId}:${row.repeat}`, row]));
  const control = new Map(rows.filter((row) => row.cellId === contrast.control).map((row) => [`${row.taskId}:${row.repeat}`, row]));
  const pairs = [];
  for (const [key, treatmentRow] of treatment) {
    const controlRow = control.get(key);
    if (!treatmentRow.eligible || !controlRow?.eligible) continue;
    pairs.push({
      key,
      hardPassDifference: Number(treatmentRow.hardPass) - Number(controlRow.hardPass),
      toolCallDifference: subtract(treatmentRow.toolCalls, controlRow.toolCalls),
      tokenDifference: subtract(treatmentRow.totalTokens, controlRow.totalTokens),
      durationDifferenceMs: subtract(treatmentRow.durationMs, controlRow.durationMs),
    });
  }
  return {
    ...contrast,
    eligiblePairs: pairs.length,
    hardPassDifference: mean(pairs.map((pair) => pair.hardPassDifference)),
    meanToolCallDifference: mean(pairs.map((pair) => pair.toolCallDifference)),
    meanTokenDifference: mean(pairs.map((pair) => pair.tokenDifference)),
    meanDurationDifferenceMs: mean(pairs.map((pair) => pair.durationDifferenceMs)),
    pairs,
  };
}

function noiseContent(spec, shard) {
  const family = spec.id.replace(/^af-entropy-/, "").replace(/-v2$/, "");
  return `record=noise-${String(shard).padStart(2, "0")}\nfamily=${family} status=healthy lookup_token=decoy-${family}-${shard}\n`;
}

function shardName(index) {
  return `shard-${String(index).padStart(2, "0")}`;
}

function cellSlug(value) {
  return value.toLowerCase().replaceAll("_", "-");
}

function isCapabilityResult(result) {
  return new Set(["completed", "failed", "timeout"]).has(result?.status);
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sum(values = []) {
  const finite = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  return finite.length === 0 ? null : finite.reduce((total, value) => total + value, 0);
}

function median(values) {
  const finite = values.filter((value) => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 === 0 ? (finite[middle - 1] + finite[middle]) / 2 : finite[middle];
}

function mean(values) {
  const finite = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  return finite.length === 0 ? null : finite.reduce((total, value) => total + value, 0) / finite.length;
}

function subtract(left, right) {
  return typeof left === "number" && Number.isFinite(left) && typeof right === "number" && Number.isFinite(right) ? left - right : null;
}

function rate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function format(value) {
  if (value === null || value === undefined) return "NA";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function formatErrors(counts) {
  const entries = Object.entries(counts ?? {}).sort(([left], [right]) => left.localeCompare(right));
  return entries.length === 0 ? "none" : entries.map(([code, count]) => `${code}=${count}`).join("; ");
}

function validateRunId(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value)) throw new Error("runId must use lowercase letters, digits, and hyphens");
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

function integerArg(value, fallback, name, minimum) {
  const parsed = numberArg(value, fallback, name);
  if (!Number.isInteger(parsed) || parsed < minimum) throw new Error(`--${name} must be an integer >= ${minimum}`);
  return parsed;
}

function progressLine(event) {
  if (event.type === "job_finished") process.stderr.write(`[${event.cellId} ${event.completed}/${event.total}] ${event.jobId} ${event.status}\n`);
}

function helpText() {
  return `SkillScope high-search-entropy experiment\n\nUsage:\n  node entropy-frontier/executor.mjs plan [options]\n  node entropy-frontier/executor.mjs run [options]\n  node entropy-frontier/executor.mjs all [options]\n  node entropy-frontier/executor.mjs summarize [options]\n\nOptions:\n  --suite PATH\n  --runs-dir PATH\n  --run-id ID\n  --descriptor PATH\n  --summary PATH\n  --report PATH\n  --repeats N\n  --seed VALUE\n  --concurrency-per-cell N\n  --model NAME\n  --api-base URL\n  --max-turns N\n  --max-tokens N\n  --job-timeout-ms N\n  --request-timeout-ms N\n  --retries N\n  --allow-dirty\n  --rerun-external-failures\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
