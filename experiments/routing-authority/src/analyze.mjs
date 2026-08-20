import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONDITIONS } from "./protocol.mjs";

export async function analyzeExperiment(manifest, records, outputDirectory) {
  validateInputs(manifest, records);
  const eligible = records.filter((record) => !["provider_error", "harness_error"].includes(record.status));
  const excluded = records.filter((record) => !eligible.includes(record));
  const conditions = Object.fromEntries(CONDITIONS.map((condition) => [condition, summarize(condition, eligible.filter((record) => record.condition === condition), manifest)]));
  const pairs = pairedSummary(eligible);
  const gates = evaluateGates(conditions, eligible);
  const report = renderReport(manifest, records, eligible, excluded, conditions, pairs, gates);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, "report.md"), report, "utf8");
  await writeFile(join(outputDirectory, "summary.json"), `${JSON.stringify({ manifestHash: manifest.manifestHash, conditions, pairs, gates, excluded: excluded.length }, null, 2)}\n`, "utf8");
  await writeFile(join(outputDirectory, "trials.csv"), trialsCsv(records), "utf8");
  return { conditions, pairs, gates, excluded: excluded.length, report };
}

function validateInputs(manifest, records) {
  if (!Array.isArray(records) || records.length !== manifest.jobs.length) throw new Error(`Expected ${manifest.jobs.length} results, received ${records.length}`);
  const jobs = new Map(manifest.jobs.map((job) => [job.jobId, job])); const seen = new Set();
  for (const record of records) {
    const job = jobs.get(record.jobId);
    if (!job || seen.has(record.jobId)) throw new Error(`${!job ? "Unknown" : "Duplicate"} result job ${record.jobId}`); seen.add(record.jobId);
    for (const key of ["protocolVersion", "blockId", "familyId", "repeat", "condition", "seed", "compositionMode"]) if (record[key] !== job[key]) throw new Error(`${record.jobId} mismatches ${key}`);
    if (record.dependencyDirection !== job.family.dependencyDirection || record.manifestHash !== manifest.manifestHash) throw new Error(`${record.jobId} mismatches frozen identity`);
  }
}

function summarize(condition, records, manifest) {
  const hardPasses = count(records, (record) => record.verification?.hardPass === true);
  const routePasses = count(records, (record) => record.topology?.valid === true);
  const canonicalBindingPasses = count(records, canonicalEvidenceBound);
  const consistency = familyConsistency(records);
  return {
    condition,
    planned: manifest.jobs.filter((job) => job.condition === condition).length,
    eligible: records.length,
    hardPasses,
    hardPassRate: rate(hardPasses, records.length),
    routePasses,
    routePassRate: rate(routePasses, records.length),
    canonicalBindingPasses,
    canonicalBindingRate: rate(canonicalBindingPasses, records.length),
    abstained: count(records, (record) => record.verification?.abstained === true),
    confidentWrong: count(records, confidentSemanticWrong),
    consistentFamilies: consistency.consistent,
    completeFamilies: consistency.total,
    familyConsistencyRate: consistency.rate,
    lifecyclePasses: count(records, (record) => record.lifecycle?.valid === true),
    medianParentProviderContextTokens: median(numbers(records, "parentMetrics.parentProviderContextTokens")),
    medianParentMessageBytes: median(numbers(records, "parentMetrics.parentMessageBytes")),
    medianTreeTokens: median(numbers(records, "usage.tree.totalTokens")),
    medianLatencyMs: median(numbers(records, "wallTimeMs")),
    failureCodes: counts(records.filter((record) => !record.verification?.hardPass).map((record) => record.verification?.failureCode ?? record.status)),
  };
}

function pairedSummary(records) {
  const blocks = Map.groupBy(records, (record) => record.blockId); const complete = [...blocks.values()].filter((cells) => cells.length === 2);
  const model = (cells) => cells.find((cell) => cell.condition === "MODEL_ROUTED");
  const runtime = (cells) => cells.find((cell) => cell.condition === "RUNTIME_ROUTED");
  return {
    completeBlocks: complete.length,
    hardPassDifference: mean(complete.map((cells) => Number(runtime(cells).verification?.hardPass === true) - Number(model(cells).verification?.hardPass === true))),
    routePassDifference: mean(complete.map((cells) => Number(runtime(cells).topology?.valid === true) - Number(model(cells).topology?.valid === true))),
    treeTokenDifference: mean(complete.map((cells) => numericDifference(runtime(cells).usage?.tree?.totalTokens, model(cells).usage?.tree?.totalTokens)).filter(finiteNumber)),
    latencyDifferenceMs: mean(complete.map((cells) => numericDifference(runtime(cells).wallTimeMs, model(cells).wallTimeMs)).filter(finiteNumber)),
  };
}

function evaluateGates(conditions, eligible) {
  const model = conditions.MODEL_ROUTED; const runtime = conditions.RUNTIME_ROUTED;
  const contextLimit = 1846.5;
  const checks = {
    p0EvidenceRejectionsZero: eligible.every((record) => record.error?.code !== "EVIDENCE_NOT_VISIBLE"),
    p0CanonicalEvidenceAll: eligible.length > 0 && eligible.every(canonicalEvidenceBound),
    h1RuntimeRoutePerfect: runtime.eligible > 0 && runtime.routePassRate === 1,
    h1RuntimeHardPassNotWorse: finiteNumber(runtime.hardPassRate) && finiteNumber(model.hardPassRate) && runtime.hardPassRate >= model.hardPassRate,
    h1RuntimeConsistencyNotWorse: finiteNumber(runtime.familyConsistencyRate) && finiteNumber(model.familyConsistencyRate) && runtime.familyConsistencyRate >= model.familyConsistencyRate,
    h3ParentContextBounded: CONDITIONS.every((condition) => finiteNumber(conditions[condition].medianParentProviderContextTokens) && conditions[condition].medianParentProviderContextTokens <= contextLimit),
    h3SentinelZero: eligible.every((record) => record.sentinel?.visibleInParent === false),
    h4LifecycleAll: eligible.length > 0 && eligible.every((record) => record.lifecycle?.valid === true),
    h4SameSkillAndTwoChildren: eligible.length > 0 && eligible.every((record) => record.topology?.sameAtomicSkill === true && record.scopes?.filter((scope) => scope.depth === 1).length === 2),
  };
  return { supported: Object.values(checks).every(Boolean), contextLimit, checks };
}

export function canonicalEvidenceBound(record) {
  const childIds = (record.scopes ?? []).filter((scope) => scope.depth === 1).map((scope) => scope.scopeId).sort();
  const refs = record.mainEvidenceRefs;
  if (childIds.length !== 2 || !Array.isArray(refs) || refs.length !== 2) return false;
  const resources = refs.map((ref) => ref?.resource).sort();
  const ids = refs.map((ref) => ref?.id).sort();
  return JSON.stringify(resources) === JSON.stringify(childIds.map((id) => `scope://${id}`).sort()) && JSON.stringify(ids) === JSON.stringify(["runtime-child-1", "runtime-child-2"]);
}

function renderReport(manifest, records, eligible, excluded, conditions, pairs, gates) {
  return `${[
    "# SkillScope 路由权责实验报告", "", `生成时间：${new Date().toISOString()}`, "",
    "## 问题", "", "同样的main Skill、leaf Skill、两次调用、证据、模型和预算，只比较由模型从提示判断组合方式，还是由工作流作者声明依赖并由Runtime侧给出具体组合方式。两组都由Runtime绑定真实child evidence。", "",
    "## 冻结身份", "", `- 协议：\`${manifest.protocolVersion}\``, `- 模型：\`${manifest.model.provider}/${manifest.model.id}\``, `- Manifest：\`${manifest.manifestHash}\``, `- Clean baseline：\`${manifest.identity.implementationRevision}\``, `- Source tree：\`${manifest.identity.sourceTreeHash}\``, `- 结果：${records.length}/${manifest.jobCount}；能力分母 ${eligible.length}；外因排除 ${excluded.length}`, "",
    "## 两组结果", "", "| 条件 | Hard Pass | 路由正确 | Runtime证据绑定 | family一致 | 拒答 | confident wrong | 父context | tree tokens | 延迟ms |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...CONDITIONS.map((condition) => row(conditions[condition])), "",
    "## 配对差值（Runtime − Model）", "", `- 完整配对块：${pairs.completeBlocks}`, `- Hard Pass：${formatSignedRate(pairs.hardPassDifference)}`, `- 路由正确：${formatSignedRate(pairs.routePassDifference)}`, `- Tree tokens：${formatSigned(pairs.treeTokenDifference)}`, `- 延迟：${formatSigned(pairs.latencyDifferenceMs)} ms`, "",
    "## 预定门", "", `父context冻结上限：${gates.contextLimit} tokens。`, "", ...Object.entries(gates.checks).map(([name, passed]) => `- ${passed ? "PASS" : "FAIL"} — ${name}`), "", `总体：**${gates.supported ? "SUPPORTED FOR CONTINUED DEVELOPMENT" : "NOT SUPPORTED"}**。`, "",
    "## 解释边界", "", "- Runtime组使用作者已知的依赖声明，是声明式工作流上界；不是Runtime自动理解自然语言并发现依赖。", "- Runtime child-evidence binding是两组共同基础设施；它修复上一轮provenance混杂，但本实验不估计它本身的因果收益。", "- 六个构造family、三个repeat、单一模型只支持探索性产品决策。", "",
  ].join("\n")}\n`;
}

function trialsCsv(records) {
  const columns = ["jobId", "blockId", "familyId", "dependencyDirection", "repeat", "condition", "compositionMode", "status", "hardPass", "routeValid", "canonicalEvidence", "abstained", "confidentWrong", "lifecycleValid", "parentContextTokens", "treeTokens", "wallTimeMs"];
  const rows = records.map((record) => [record.jobId, record.blockId, record.familyId, record.dependencyDirection, record.repeat, record.condition, record.compositionMode, record.status, record.verification?.hardPass, record.topology?.valid, canonicalEvidenceBound(record), record.verification?.abstained, confidentSemanticWrong(record), record.lifecycle?.valid, record.parentMetrics?.parentProviderContextTokens, record.usage?.tree?.totalTokens, record.wallTimeMs]);
  return `${[columns, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function familyConsistency(records) { const groups = Map.groupBy(records, (record) => record.familyId); const complete = [...groups.values()].filter((values) => values.length === 3); const consistent = complete.filter((values) => new Set(values.map((record) => JSON.stringify({ decision: record.parentResult?.decision, constraintFact: record.parentResult?.constraintFact, observationFact: record.parentResult?.observationFact }))).size === 1).length; return { consistent, total: complete.length, rate: rate(consistent, complete.length) }; }
function confidentSemanticWrong(record) { if (!["ALLOW", "BLOCK"].includes(record.parentResult?.decision)) return false; const checks = record.verification?.checks; return checks ? checks.decision === false || checks.constraintFact === false || checks.observationFact === false : record.verification?.confidentWrong === true; }
function row(item) { return `| ${item.condition} | ${item.hardPasses}/${item.eligible} (${formatRate(item.hardPassRate)}) | ${item.routePasses}/${item.eligible} (${formatRate(item.routePassRate)}) | ${item.canonicalBindingPasses}/${item.eligible} | ${item.consistentFamilies}/${item.completeFamilies} | ${item.abstained} | ${item.confidentWrong} | ${formatNumber(item.medianParentProviderContextTokens)} | ${formatNumber(item.medianTreeTokens)} | ${formatNumber(item.medianLatencyMs)} |`; }
function numbers(records, path) { return records.map((record) => path.split(".").reduce((value, key) => value?.[key], record)).filter(finiteNumber); }
function count(values, predicate) { return values.filter(predicate).length; }
function counts(values) { return Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((item) => item === value).length])); }
function median(values) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function numericDifference(left, right) { return finiteNumber(left) && finiteNumber(right) ? left - right : null; }
function rate(numerator, denominator) { return denominator ? numerator / denominator : null; }
function finiteNumber(value) { return typeof value === "number" && Number.isFinite(value); }
function formatRate(value) { return finiteNumber(value) ? `${(value * 100).toFixed(1)}%` : "NA"; }
function formatNumber(value) { return finiteNumber(value) ? value.toFixed(1) : "NA"; }
function formatSignedRate(value) { return finiteNumber(value) ? `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}pp` : "NA"; }
function formatSigned(value) { return finiteNumber(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(1)}` : "NA"; }
function csvCell(value) { const text = value === undefined || value === null ? "" : String(value); return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
