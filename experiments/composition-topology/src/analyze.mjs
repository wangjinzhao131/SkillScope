import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONDITIONS } from "./protocol.mjs";

export async function analyzeExperiment(manifest, records, outputDirectory) {
  validateInputs(manifest, records);
  const eligible = records.filter((record) => !["provider_error", "harness_error"].includes(record.status));
  const excluded = records.filter((record) => !eligible.includes(record));
  const conditions = Object.fromEntries(CONDITIONS.map((condition) => [condition, summarizeCondition(condition, eligible.filter((record) => record.condition === condition), manifest)]));
  const strata = summarizeStrata(eligible);
  const mechanism = summarizeMechanism(eligible);
  const gates = evaluateGates(conditions, strata, mechanism, eligible);
  const report = renderReport(manifest, records, eligible, excluded, conditions, strata, mechanism, gates);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, "report.md"), report, "utf8");
  await writeFile(join(outputDirectory, "summary.json"), `${JSON.stringify({ manifestHash: manifest.manifestHash, conditions, strata, mechanism, gates, excluded: excluded.length }, null, 2)}\n`, "utf8");
  await writeFile(join(outputDirectory, "trials.csv"), trialsCsv(records), "utf8");
  return { conditions, strata, mechanism, gates, excluded: excluded.length, report };
}

function validateInputs(manifest, records) {
  if (!Array.isArray(records) || records.length !== manifest.jobs.length) throw new Error(`Expected ${manifest.jobs.length} results, received ${records.length}`);
  const jobs = new Map(manifest.jobs.map((job) => [job.jobId, job]));
  const seen = new Set();
  for (const record of records) {
    const job = jobs.get(record.jobId);
    if (!job || seen.has(record.jobId)) throw new Error(`${!job ? "Unknown" : "Duplicate"} result job ${record.jobId}`);
    seen.add(record.jobId);
    for (const key of ["protocolVersion", "blockId", "familyId", "repeat", "condition", "seed"]) if (record[key] !== job[key]) throw new Error(`${record.jobId} mismatches ${key}`);
    if (record.dependencyDirection !== job.family.dependencyDirection) throw new Error(`${record.jobId} mismatches dependencyDirection`);
    if (record.manifestHash !== manifest.manifestHash) throw new Error(`${record.jobId} mismatches manifestHash`);
  }
}

function summarizeCondition(condition, records, manifest) {
  const hardPasses = records.filter((record) => record.verification?.hardPass === true).length;
  const abstained = records.filter((record) => record.verification?.abstained === true).length;
  const confidentWrong = records.filter(confidentSemanticWrong).length;
  const consistency = familyConsistency(records);
  return {
    condition,
    planned: manifest.jobs.filter((job) => job.condition === condition).length,
    eligible: records.length,
    hardPasses,
    hardPassRate: rate(hardPasses, records.length),
    abstained,
    abstainRate: rate(abstained, records.length),
    confidentWrong,
    confidentWrongRate: rate(confidentWrong, records.length),
    topologyPasses: records.filter((record) => record.topology?.valid === true).length,
    lifecyclePasses: records.filter((record) => record.lifecycle?.valid === true).length,
    familyConsistencyRate: consistency.rate,
    consistentFamilies: consistency.consistent,
    completeFamilies: consistency.total,
    medianParentProviderContextTokens: median(numbers(records, "parentMetrics.parentProviderContextTokens")),
    medianParentEstimatedContextTokens: median(numbers(records, "parentMetrics.parentEstimatedContextTokens")),
    medianParentMessageBytes: median(numbers(records, "parentMetrics.parentMessageBytes")),
    medianParentToolResultBytes: median(numbers(records, "parentMetrics.parentToolResultBytes")),
    medianTreeTokens: median(numbers(records, "usage.tree.totalTokens")),
    medianLatencyMs: median(numbers(records, "wallTimeMs")),
    failureCodes: counts(records.filter((record) => !record.verification?.hardPass).map((record) => record.verification?.failureCode ?? record.status)),
  };
}

function summarizeStrata(records) {
  const result = {};
  for (const direction of ["constraint-first", "observation-first", "independent"]) {
    result[direction] = {};
    for (const condition of CONDITIONS) {
      const cells = records.filter((record) => record.dependencyDirection === direction && record.condition === condition);
      const passes = cells.filter((record) => record.verification?.hardPass === true).length;
      result[direction][condition] = { eligible: cells.length, hardPasses: passes, hardPassRate: rate(passes, cells.length), abstained: cells.filter((record) => record.verification?.abstained === true).length, confidentWrong: cells.filter(confidentSemanticWrong).length };
    }
  }
  return result;
}

function summarizeMechanism(records) {
  const directional = records.filter((record) => record.dependencyDirection !== "independent");
  const groups = {
    parallel: directional.filter((record) => record.condition === "PARALLEL_JOIN"),
    matched: directional.filter((record) => isMatchedFixed(record)),
    wrongDirection: directional.filter((record) => isWrongFixed(record)),
    adaptive: directional.filter((record) => record.condition === "ADAPTIVE_ORDER"),
  };
  const summary = Object.fromEntries(Object.entries(groups).map(([name, cells]) => [name, passSummary(cells)]));
  const adaptiveCells = groups.adaptive;
  const adaptiveDirectionHits = adaptiveCells.filter((record) => record.topology?.observedFirstRole === expectedDirectionRole(record.dependencyDirection)).length;
  const independentRates = CONDITIONS.map((condition) => passSummary(records.filter((record) => record.dependencyDirection === "independent" && record.condition === condition)).hardPassRate).filter(finiteRate);
  return {
    ...summary,
    adaptiveDirectionHits,
    adaptiveDirectionEligible: adaptiveCells.length,
    adaptiveDirectionRate: rate(adaptiveDirectionHits, adaptiveCells.length),
    independentHardPassSpread: independentRates.length > 0 ? Math.max(...independentRates) - Math.min(...independentRates) : null,
    runtimeEvidenceRejections: records.filter((record) => record.error?.code === "EVIDENCE_NOT_VISIBLE").length,
    confirmedWrongTopologyExecutions: records.filter((record) => record.topology?.valid !== true && record.mainResult && !record.error).length,
    topologyUnverifiableAfterMainRejection: records.filter((record) => record.topology?.valid !== true && !record.mainResult).length,
  };
}

function evaluateGates(conditions, strata, mechanism, eligible) {
  const contextLimit = 1231 * 1.5;
  const checks = {
    h1MatchedAboveParallel: finiteRate(mechanism.matched.hardPassRate) && finiteRate(mechanism.parallel.hardPassRate) && mechanism.matched.hardPassRate > mechanism.parallel.hardPassRate,
    h1MatchedAboveWrongDirection: finiteRate(mechanism.matched.hardPassRate) && finiteRate(mechanism.wrongDirection.hardPassRate) && mechanism.matched.hardPassRate > mechanism.wrongDirection.hardPassRate,
    h2AdaptiveDirection75: finiteRate(mechanism.adaptiveDirectionRate) && mechanism.adaptiveDirectionRate >= 0.75,
    h2AdaptiveWithin10ppMatched: finiteRate(mechanism.adaptive.hardPassRate) && finiteRate(mechanism.matched.hardPassRate) && mechanism.adaptive.hardPassRate >= mechanism.matched.hardPassRate - 0.10,
    h3IndependentSpread20pp: finiteRate(mechanism.independentHardPassSpread) && mechanism.independentHardPassSpread <= 0.20,
    h4ParentContextBounded: CONDITIONS.every((condition) => finiteNumber(conditions[condition].medianParentProviderContextTokens) && conditions[condition].medianParentProviderContextTokens <= contextLimit),
    h4SentinelZero: eligible.every((record) => record.sentinel?.visibleInParent === false),
    h5TopologyAllValid: eligible.length > 0 && eligible.every((record) => record.topology?.valid === true),
    h5LifecycleAllValid: eligible.length > 0 && eligible.every((record) => record.lifecycle?.valid === true),
  };
  return { supported: checks.h1MatchedAboveParallel && checks.h1MatchedAboveWrongDirection && checks.h4ParentContextBounded && checks.h4SentinelZero && checks.h5TopologyAllValid && checks.h5LifecycleAllValid, adaptiveSupported: checks.h2AdaptiveDirection75 && checks.h2AdaptiveWithin10ppMatched, checks, contextLimit };
}

function renderReport(manifest, records, eligible, excluded, conditions, strata, mechanism, gates) {
  const lines = [
    "# SkillScope 组合拓扑实验报告",
    "",
    `生成时间：${new Date().toISOString()}`,
    "",
    "## 根本问题",
    "",
    "本实验固定同一个main Skill、同一个原子Skill、两次叶子调用、模型、证据和预算，只改变并行/串行方向以及Runtime-valid结果的流向，观察任务表现、稳定性、父上下文与总成本。",
    "",
    "## 冻结身份",
    "",
    `- 协议：\`${manifest.protocolVersion}\``,
    `- 模型：\`${manifest.model.provider}/${manifest.model.id}\``,
    `- Manifest：\`${manifest.manifestHash}\``,
    `- Clean baseline：\`${manifest.identity.implementationRevision}\``,
    `- Source tree：\`${manifest.identity.sourceTreeHash}\``,
    `- 结果：${records.length}/${manifest.jobCount}；能力分母 ${eligible.length}；外因排除 ${excluded.length}`,
    "",
    "## 条件结果",
    "",
    "| 条件 | Hard Pass | Abstain | Confident wrong | family一致率 | 父context | 父message bytes | tree tokens | 延迟ms | 拓扑 | 生命周期 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...CONDITIONS.map((condition) => conditionRow(conditions[condition])),
    "",
    "## 依赖方向分层",
    "",
    "| 依赖方向 | Parallel | Constraint-first | Observation-first | Adaptive |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...["constraint-first", "observation-first", "independent"].map((direction) => `| ${direction} | ${cellRate(strata[direction].PARALLEL_JOIN)} | ${cellRate(strata[direction].CONSTRAINT_FIRST)} | ${cellRate(strata[direction].OBSERVATION_FIRST)} | ${cellRate(strata[direction].ADAPTIVE_ORDER)} |`),
    "",
    "## 组合机制",
    "",
    `- 方向依赖任务 matched serial：${countRate(mechanism.matched)}`,
    `- 方向依赖任务 parallel：${countRate(mechanism.parallel)}`,
    `- 方向依赖任务 wrong-direction serial：${countRate(mechanism.wrongDirection)}`,
    `- 方向依赖任务 adaptive：${countRate(mechanism.adaptive)}`,
    `- Adaptive首调用方向命中：${mechanism.adaptiveDirectionHits}/${mechanism.adaptiveDirectionEligible} (${formatRate(mechanism.adaptiveDirectionRate)})`,
    `- Independent四条件Hard Pass spread：${formatRate(mechanism.independentHardPassSpread)}`,
    `- Runtime evidence visibility拒绝：${mechanism.runtimeEvidenceRejections}/${eligible.length}`,
    `- 已确认执行了错误拓扑：${mechanism.confirmedWrongTopologyExecutions}/${eligible.length}`,
    `- main被Runtime拒绝后无法核验完整拓扑：${mechanism.topologyUnverifiableAfterMainRejection}/${eligible.length}`,
    "",
    "## 预定成功门",
    "",
    ...Object.entries(gates.checks).map(([name, passed]) => `- ${passed ? "PASS" : "FAIL"} — ${name}`),
    "",
    `组合方向总体：**${gates.supported ? "SUPPORTED FOR CONTINUED DEVELOPMENT" : "NOT SUPPORTED"}**。`,
    `构造性方向依赖任务的自适应方向门：**${gates.adaptiveSupported ? "PASSED" : "FAILED"}**。`,
    "",
    "## 解释边界",
    "",
    "- 方向依赖任务是构造性机制测试；matched提升证明typed information flow有用，不估计自然任务中这种依赖的发生率。",
    "- 四个条件固定相同Skill和调用数；实际token与延迟差是组合结果，不是额外调用造成。",
    "- 父上下文受控不等于整棵Scope tree成本下降；必须结合表中的tree tokens和延迟。",
    "- 六个family、三个repeat和单一模型只支持探索性产品决策，不是生产SLA或统计确认。",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function trialsCsv(records) {
  const columns = ["jobId", "blockId", "familyId", "dependencyDirection", "repeat", "condition", "status", "hardPass", "failureCode", "abstained", "confidentWrong", "topologyValid", "observedFirstRole", "upstreamPassedToSecond", "lifecycleValid", "parentProviderContextTokens", "parentMessageBytes", "treeTokens", "wallTimeMs"];
  const rows = records.map((record) => [record.jobId, record.blockId, record.familyId, record.dependencyDirection, record.repeat, record.condition, record.status, record.verification?.hardPass, record.verification?.failureCode, record.verification?.abstained, confidentSemanticWrong(record), record.topology?.valid, record.topology?.observedFirstRole, record.topology?.upstreamPassedToSecond, record.lifecycle?.valid, record.parentMetrics?.parentProviderContextTokens, record.parentMetrics?.parentMessageBytes, record.usage?.tree?.totalTokens, record.wallTimeMs]);
  return `${[columns, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function familyConsistency(records) {
  const groups = Map.groupBy(records, (record) => record.familyId);
  const complete = [...groups.values()].filter((values) => values.length === 3);
  const consistent = complete.filter((values) => new Set(values.map((record) => JSON.stringify({ decision: record.parentResult?.decision, constraintFact: record.parentResult?.constraintFact, observationFact: record.parentResult?.observationFact }))).size === 1).length;
  return { consistent, total: complete.length, rate: rate(consistent, complete.length) };
}
function passSummary(cells) { const hardPasses = cells.filter((record) => record.verification?.hardPass === true).length; return { eligible: cells.length, hardPasses, hardPassRate: rate(hardPasses, cells.length), abstained: cells.filter((record) => record.verification?.abstained === true).length, confidentWrong: cells.filter(confidentSemanticWrong).length }; }
function isMatchedFixed(record) { return (record.dependencyDirection === "constraint-first" && record.condition === "CONSTRAINT_FIRST") || (record.dependencyDirection === "observation-first" && record.condition === "OBSERVATION_FIRST"); }
function isWrongFixed(record) { return (record.dependencyDirection === "constraint-first" && record.condition === "OBSERVATION_FIRST") || (record.dependencyDirection === "observation-first" && record.condition === "CONSTRAINT_FIRST"); }
function expectedDirectionRole(direction) { return direction === "observation-first" ? "observation" : "constraint"; }
function conditionRow(item) { return `| ${item.condition} | ${item.hardPasses}/${item.eligible} (${formatRate(item.hardPassRate)}) | ${item.abstained} | ${item.confidentWrong} | ${formatRate(item.familyConsistencyRate)} | ${formatNumber(item.medianParentProviderContextTokens)} | ${formatNumber(item.medianParentMessageBytes)} | ${formatNumber(item.medianTreeTokens)} | ${formatNumber(item.medianLatencyMs)} | ${item.topologyPasses}/${item.eligible} | ${item.lifecyclePasses}/${item.eligible} |`; }
function cellRate(cell) { return `${cell.hardPasses}/${cell.eligible} (${formatRate(cell.hardPassRate)})`; }
function countRate(cell) { return `${cell.hardPasses}/${cell.eligible} (${formatRate(cell.hardPassRate)})`; }
function numbers(records, path) { return records.map((record) => path.split(".").reduce((value, key) => value?.[key], record)).filter(finiteNumber); }
function median(values) { if (values.length === 0) return null; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function rate(numerator, denominator) { return denominator > 0 ? numerator / denominator : null; }
function finiteNumber(value) { return typeof value === "number" && Number.isFinite(value); }
function finiteRate(value) { return finiteNumber(value); }
function counts(values) { return Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((item) => item === value).length])); }
function confidentSemanticWrong(record) {
  if (!["ALLOW", "BLOCK"].includes(record.parentResult?.decision)) return false;
  const checks = record.verification?.checks;
  if (checks && typeof checks === "object") {
    return checks.decision === false || checks.constraintFact === false || checks.observationFact === false;
  }
  return record.verification?.confidentWrong === true;
}
function formatRate(value) { return finiteNumber(value) ? `${(value * 100).toFixed(1)}%` : "NA"; }
function formatNumber(value) { return finiteNumber(value) ? value.toFixed(1) : "NA"; }
function csvCell(value) { const text = value === undefined || value === null ? "" : String(value); return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
