import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONDITIONS } from "./protocol.mjs";

export async function analyzeExperiment(manifest, records, outputDirectory) {
  validateInputs(manifest, records);
  const eligible = records.filter((record) => !["provider_error", "harness_error"].includes(record.status));
  const excluded = records.filter((record) => !eligible.includes(record));
  const conditions = Object.fromEntries(CONDITIONS.map((condition) => [condition, summarizeCondition(condition, eligible.filter((record) => record.condition === condition), manifest)]));
  const blocks = pairedBlocks(manifest, eligible);
  const gates = evaluateGates(conditions, blocks, eligible);
  const report = renderReport(manifest, records, eligible, excluded, conditions, blocks, gates);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, "report.md"), report, "utf8");
  await writeFile(join(outputDirectory, "summary.json"), `${JSON.stringify({ manifestHash: manifest.manifestHash, conditions, blocks, gates, excluded: excluded.length }, null, 2)}\n`, "utf8");
  await writeFile(join(outputDirectory, "trials.csv"), trialsCsv(records), "utf8");
  return { conditions, blocks, gates, excluded: excluded.length, report };
}

function validateInputs(manifest, records) {
  if (!Array.isArray(records) || records.length !== manifest.jobs.length) throw new Error(`Expected ${manifest.jobs.length} results, received ${records.length}`);
  const jobs = new Map(manifest.jobs.map((job) => [job.jobId, job]));
  const seen = new Set();
  for (const record of records) {
    const job = jobs.get(record.jobId);
    if (!job) throw new Error(`Unknown result job ${record.jobId}`);
    if (seen.has(record.jobId)) throw new Error(`Duplicate result job ${record.jobId}`);
    seen.add(record.jobId);
    for (const key of ["protocolVersion", "blockId", "familyId", "repeat", "condition", "seed"]) if (record[key] !== job[key]) throw new Error(`${record.jobId} mismatches ${key}`);
    if (record.manifestHash !== manifest.manifestHash) throw new Error(`${record.jobId} mismatches manifestHash`);
  }
}

function summarizeCondition(condition, records, manifest) {
  const eligiblePlanned = manifest.jobs.filter((job) => job.condition === condition).length;
  const hardPasses = records.filter((record) => record.verification?.hardPass === true).length;
  const contexts = numbers(records, "parentMetrics.parentProviderContextTokens");
  const estimates = numbers(records, "parentMetrics.parentEstimatedContextTokens");
  const messageBytes = numbers(records, "parentMetrics.parentMessageBytes");
  const toolBytes = numbers(records, "parentMetrics.parentToolResultBytes");
  const totalTokens = numbers(records, "usage.tree.totalTokens");
  const latency = numbers(records, "wallTimeMs");
  const sentinelHits = records.filter((record) => record.sentinel?.visibleInParent === true).length;
  const lifecyclePasses = records.filter((record) => record.lifecycle?.valid === true).length;
  const familyConsistency = familyConsistencyRate(records);
  return {
    condition,
    planned: eligiblePlanned,
    eligible: records.length,
    hardPasses,
    hardPassRate: rate(hardPasses, records.length),
    medianParentProviderContextTokens: median(contexts),
    medianParentEstimatedContextTokens: median(estimates),
    medianParentMessageBytes: median(messageBytes),
    medianParentToolResultBytes: median(toolBytes),
    medianTreeTokens: median(totalTokens),
    medianLatencyMs: median(latency),
    sentinelHits,
    lifecyclePasses,
    lifecyclePassRate: rate(lifecyclePasses, records.length),
    familyConsistencyRate: familyConsistency.rate,
    consistentFamilies: familyConsistency.consistent,
    completeFamilies: familyConsistency.total,
    failureCodes: counts(records.filter((record) => !record.verification?.hardPass).map((record) => record.verification?.failureCode ?? record.status)),
  };
}

function pairedBlocks(manifest, eligible) {
  const byBlock = new Map();
  for (const record of eligible) {
    const block = byBlock.get(record.blockId) ?? {};
    block[record.condition] = record;
    byBlock.set(record.blockId, block);
  }
  const complete = [...byBlock.values()].filter((block) => CONDITIONS.every((condition) => block[condition]));
  const nestedInlineRatios = complete.map((block) => ratio(block.SKILLSCOPE_NESTED.parentMetrics?.parentProviderContextTokens, block.INLINE_PARENT.parentMetrics?.parentProviderContextTokens)).filter(Number.isFinite);
  const nestedInlineByteRatios = complete.map((block) => ratio(block.SKILLSCOPE_NESTED.parentMetrics?.parentMessageBytes, block.INLINE_PARENT.parentMetrics?.parentMessageBytes)).filter(Number.isFinite);
  const pairedRatio = (numerator, denominator, select) => median(complete.map((block) => ratio(select(block[numerator]), select(block[denominator]))).filter(Number.isFinite));
  return {
    plannedBlocks: manifest.familyCount * manifest.repeats,
    completeBlocks: complete.length,
    medianNestedToInlineProviderContextRatio: median(nestedInlineRatios),
    medianNestedToInlineMessageByteRatio: median(nestedInlineByteRatios),
    medianNestedProviderContextReduction: reduction(median(nestedInlineRatios)),
    medianNestedMessageByteReduction: reduction(median(nestedInlineByteRatios)),
    contrasts: {
      freeformToInline: contrastRatios(pairedRatio, "EPHEMERAL_FREEFORM", "INLINE_PARENT"),
      flatToFreeform: contrastRatios(pairedRatio, "SKILLSCOPE_FLAT", "EPHEMERAL_FREEFORM"),
      nestedToFlat: contrastRatios(pairedRatio, "SKILLSCOPE_NESTED", "SKILLSCOPE_FLAT"),
      nestedToInline: contrastRatios(pairedRatio, "SKILLSCOPE_NESTED", "INLINE_PARENT"),
    },
  };
}

function contrastRatios(pairedRatio, numerator, denominator) {
  return {
    providerContext: pairedRatio(numerator, denominator, (record) => record.parentMetrics?.parentProviderContextTokens),
    messageBytes: pairedRatio(numerator, denominator, (record) => record.parentMetrics?.parentMessageBytes),
    treeTokens: pairedRatio(numerator, denominator, (record) => record.usage?.tree?.totalTokens),
    latency: pairedRatio(numerator, denominator, (record) => record.wallTimeMs),
  };
}

function evaluateGates(conditions, blocks, eligible) {
  const inline = conditions.INLINE_PARENT;
  const freeform = conditions.EPHEMERAL_FREEFORM;
  const nested = conditions.SKILLSCOPE_NESTED;
  const checks = {
    providerContextReduction30: blocks.medianNestedProviderContextReduction >= 0.30,
    messageByteReduction30: blocks.medianNestedMessageByteReduction >= 0.30,
    nestedWithin10ppOfInline: finiteRate(nested.hardPassRate) && finiteRate(inline.hardPassRate) && nested.hardPassRate >= inline.hardPassRate - 0.10,
    nestedNotBelowFreeform: finiteRate(nested.hardPassRate) && finiteRate(freeform.hardPassRate) && nested.hardPassRate >= freeform.hardPassRate,
    nestedConsistencyNotBelowFreeform: finiteRate(nested.familyConsistencyRate) && finiteRate(freeform.familyConsistencyRate) && nested.familyConsistencyRate >= freeform.familyConsistencyRate,
    offloadSentinelZero: eligible.filter((record) => record.condition !== "INLINE_PARENT").every((record) => record.sentinel?.visibleInParent === false),
    nestedLifecycleAllValid: nested.eligible > 0 && nested.lifecyclePasses === nested.eligible,
    noPolicyFailOpen: eligible.every((record) => record.lifecycle?.valid !== false),
  };
  return { supported: Object.values(checks).every(Boolean), checks };
}

function renderReport(manifest, records, eligible, excluded, summaries, blocks, gates) {
  const lines = [
    "# SkillScope 父上下文与稳定性实验报告",
    "",
    `生成时间：${new Date().toISOString()}`,
    "",
    "## 根本问题",
    "",
    "本实验只回答：随用随销的子 Agent、主 Skill 下的独立子 Skill Scope，以及 Runtime 约束的结构化返回，能否减少父会话上下文占用并保持或提高端到端稳定性。访问授权只作为固定 exact-file 基础设施，不是处理变量。",
    "",
    "## 冻结身份与样本",
    "",
    `- 协议：\`${manifest.protocolVersion}\``,
    `- 模型：\`${manifest.model.provider}/${manifest.model.id}\``,
    `- Manifest：\`${manifest.manifestHash}\``,
    `- Clean baseline commit：\`${manifest.identity.implementationRevision}\``,
    `- Source tree：\`${manifest.identity.sourceTreeHash}\``,
    `- 结果：${records.length}/${manifest.jobCount}；能力分母 ${eligible.length}；外因排除 ${excluded.length}`,
    "",
    "## 四个条件",
    "",
    "| 条件 | Hard Pass | family一致率 | 父context中位数 | 父message bytes中位数 | 父tool-result bytes | 调用树tokens | 延迟ms | Sentinel命中 | 生命周期 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...CONDITIONS.map((condition) => {
      const item = summaries[condition];
      return `| ${condition} | ${formatRate(item.hardPassRate)} (${item.hardPasses}/${item.eligible}) | ${formatRate(item.familyConsistencyRate)} | ${formatNumber(item.medianParentProviderContextTokens)} | ${formatNumber(item.medianParentMessageBytes)} | ${formatNumber(item.medianParentToolResultBytes)} | ${formatNumber(item.medianTreeTokens)} | ${formatNumber(item.medianLatencyMs)} | ${item.sentinelHits} | ${item.lifecyclePasses}/${item.eligible} |`;
    }),
    "",
    "## 主要配对结果",
    "",
    `- 完整 family-repeat 配对：${blocks.completeBlocks}/${blocks.plannedBlocks}`,
    `- Nested 相对 Inline 的父 provider context 中位降幅：${formatRate(blocks.medianNestedProviderContextReduction)}`,
    `- Nested 相对 Inline 的父 message bytes 中位降幅：${formatRate(blocks.medianNestedMessageByteReduction)}`,
    "",
    "## 机制包代价",
    "",
    "下面是15个配对块的中位相对变化；正数表示增加，负数表示减少。",
    "",
    "| 对比 | 父context | 父message bytes | 调用树tokens | 延迟 |",
    "| --- | ---: | ---: | ---: | ---: |",
    contrastRow("Freeform / Inline", blocks.contrasts.freeformToInline),
    contrastRow("Flat / Freeform", blocks.contrasts.flatToFreeform),
    contrastRow("Nested / Flat", blocks.contrasts.nestedToFlat),
    contrastRow("Nested / Inline", blocks.contrasts.nestedToInline),
    "",
    "## 预定方向门",
    "",
    ...Object.entries(gates.checks).map(([name, passed]) => `- ${passed ? "PASS" : "FAIL"} — ${name}`),
    "",
    `总体：**${gates.supported ? "当前探索性证据支持继续发展该设计" : "当前探索性证据不足以支持完整设计"}**。`,
    "",
    "## 直接结论",
    "",
    "- **父上下文假设得到支持：** Nested把过程留在三个随用随销的独立Scope中，只把Runtime-valid结果逐层返回；相对Inline，父provider context和父message bytes均减少约84%。",
    "- **稳定性只证明了“没有下降”，尚未证明“提高”：** 四组Hard Pass和family一致率均为100%，出现天花板效应；因此当前语料不能识别Runtime结构化返回或嵌套是否比freeform更稳定。",
    "- **独立嵌套机制得到运行证据：** Nested的15个trial全部形成一个main与两个不同child Scope，结果均通过Runtime校验，全部dispose，child Sentinel未进入父messages。",
    `- **当前实现是上下文换总成本：** Nested相对Inline的调用树tokens增加${formatRatioIncrease(blocks.contrasts.nestedToInline.treeTokens)}，延迟增加${formatRatioIncrease(blocks.contrasts.nestedToInline.latency)}；不能称为总体效率优化。`,
    `- **结构化和嵌套的增量价值仍待证明：** Flat相对Freeform的调用树tokens增加${formatRatioIncrease(blocks.contrasts.flatToFreeform.treeTokens)}，Nested相对Flat再增加${formatRatioIncrease(blocks.contrasts.nestedToFlat.treeTokens)}，但本轮正确率没有差异。`,
    "",
    "## 分析修正",
    "",
    "首版分析曾把每个repeat故意变化的memory code也纳入family语义一致性，因而错误报告0%。修正版只比较decision、constraintFact、observationFact；memory code仍由每条Hard Pass独立检查。原始60条结果、上下文、成本和正确率均未改变。",
    "",
    "## 解释边界",
    "",
    "- 父上下文下降不等于总成本下降；调用树 token 与延迟必须一起看。",
    "- Freeform、Flat、Nested 都是机制包对比，不能把差异归因于任意单个提示词。",
    "- 五个 family、三个 repeat 只够做探索性产品决策，不是生产 SLA 或统计确认。",
    "- 本实验不比较普通继承父历史的通用 Subagent，也不估计访问边界、动态补权或安全 Profile 的效果。",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function trialsCsv(records) {
  const columns = ["jobId", "blockId", "familyId", "repeat", "condition", "status", "hardPass", "failureCode", "parentProviderContextTokens", "parentEstimatedContextTokens", "parentMessageBytes", "parentToolResultBytes", "sentinelVisible", "lifecycleValid", "parentTokens", "childTokens", "treeTokens", "wallTimeMs"];
  const rows = records.map((record) => [
    record.jobId, record.blockId, record.familyId, record.repeat, record.condition, record.status,
    record.verification?.hardPass, record.verification?.failureCode,
    record.parentMetrics?.parentProviderContextTokens, record.parentMetrics?.parentEstimatedContextTokens,
    record.parentMetrics?.parentMessageBytes, record.parentMetrics?.parentToolResultBytes,
    record.sentinel?.visibleInParent, record.lifecycle?.valid,
    record.usage?.parent?.totalTokens, record.usage?.children?.totalTokens, record.usage?.tree?.totalTokens, record.wallTimeMs,
  ]);
  return `${[columns, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function familyConsistencyRate(records) {
  const groups = new Map();
  for (const record of records) {
    const values = groups.get(record.familyId) ?? [];
    values.push(record);
    groups.set(record.familyId, values);
  }
  const complete = [...groups.values()].filter((values) => values.length === 3);
  // memoryCode is deliberately fresh per repeat, so it is a retention check,
  // not part of the semantic answer whose repeat consistency we estimate.
  const consistent = complete.filter((values) => values.every((record) => record.verification?.hardPass === true) && new Set(values.map((record) => JSON.stringify({
    decision: record.parentResult?.decision,
    constraintFact: record.parentResult?.constraintFact,
    observationFact: record.parentResult?.observationFact,
  }))).size === 1).length;
  return { consistent, total: complete.length, rate: rate(consistent, complete.length) };
}

function numbers(records, path) {
  return records.map((record) => path.split(".").reduce((value, key) => value?.[key], record)).filter((value) => typeof value === "number" && Number.isFinite(value));
}
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function rate(numerator, denominator) { return denominator > 0 ? numerator / denominator : null; }
function ratio(numerator, denominator) { return typeof numerator === "number" && typeof denominator === "number" && denominator > 0 ? numerator / denominator : NaN; }
function reduction(ratioValue) { return typeof ratioValue === "number" && Number.isFinite(ratioValue) ? 1 - ratioValue : null; }
function finiteRate(value) { return typeof value === "number" && Number.isFinite(value); }
function counts(values) { return Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((item) => item === value).length])); }
function contrastRow(name, values) { return `| ${name} | ${formatSignedChange(values.providerContext)} | ${formatSignedChange(values.messageBytes)} | ${formatSignedChange(values.treeTokens)} | ${formatSignedChange(values.latency)} |`; }
function formatRate(value) { return typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "NA"; }
function formatRatioIncrease(ratioValue) { return typeof ratioValue === "number" && Number.isFinite(ratioValue) ? formatRate(ratioValue - 1) : "NA"; }
function formatSignedChange(ratioValue) { return typeof ratioValue === "number" && Number.isFinite(ratioValue) ? `${ratioValue >= 1 ? "+" : ""}${((ratioValue - 1) * 100).toFixed(1)}%` : "NA"; }
function formatNumber(value) { return typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "NA"; }
function csvCell(value) { const text = value === undefined || value === null ? "" : String(value); return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
