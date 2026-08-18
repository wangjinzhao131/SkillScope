import {
  addUsage,
  canaryHits,
  collectCanaryTokens,
  emptyUsage,
  normalizeGrants,
} from "./protocol.mjs";
import { grantPlannerTools } from "./prompt.mjs";

export async function planInitialGrants({ task, client, seed, temperature = 0, maxTokens = 512, signal }) {
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error("grant planner maxTokens must be a positive integer");
  const catalog = normalizeGrants(task.inferredCatalog ?? []);
  const canaryTokens = collectCanaryTokens(task);
  if (catalog.length === 0) {
    return {
      source: "empty_catalog",
      selectedIndexes: [],
      selectedGrants: [],
      reason: "Fixture contains no inferred catalog entries",
      usage: emptyUsage(),
      requestIds: [],
      providerModels: [],
      modelVisibleCanaryHits: [],
      assistantOutputCanaryHits: [],
      attemptDiagnostics: [],
      repairCount: 0,
    };
  }
  const promptRefs = (task.promptRefs ?? []).map((ref) => ({
    name: ref.name,
    sourcePath: ref.sourcePath ?? null,
    sourceStartLine: ref.sourceStartLine ?? null,
    sourceEndLine: ref.sourceEndLine ?? null,
    content: ref.content ?? "",
  }));
  const coordination = {
    promptRefsBytes: Buffer.byteLength(JSON.stringify(promptRefs)),
    catalogBytes: Buffer.byteLength(JSON.stringify(catalog)),
  };
  coordination.estimatedTokens = Math.ceil((coordination.promptRefsBytes + coordination.catalogBytes) / 4);
  const messages = [
    {
      role: "system",
      content: [
        "You are the parent-side grant planner in a controlled experiment.",
        "Select the smallest catalog subset that is likely sufficient for the worker to solve the goal.",
        "Catalog entries are metadata only. Do not invent paths or inspect hidden expected answers.",
        "Finish only by calling select_grants.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `# Goal\n${task.goal}`,
        `# Prompt snapshots available to the worker\n${JSON.stringify(promptRefs, null, 2)}`,
        `# Catalog (index is the selection id)\n${JSON.stringify(catalog.map((grant, index) => ({ index, ...grant })), null, 2)}`,
      ].join("\n\n"),
    },
  ];
  const tools = grantPlannerTools(catalog);
  let usage = emptyUsage();
  const requestIds = [];
  const providerModels = new Set();
  let providerAttemptCount = 0;
  const providerRetryEvents = [];
  const modelVisibleCanaryHits = new Set(canaryHits(messages, canaryTokens));
  const assistantOutputCanaryHits = new Set();
  const attemptDiagnostics = [];

  for (let repairCount = 0; repairCount <= 1; repairCount += 1) {
    let completion;
    try {
      completion = await client.complete({
        messages,
        tools,
        toolChoice: { type: "function", function: { name: "select_grants" } },
        temperature,
        maxTokens,
        seed,
        signal,
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      failure.partialGrantPlanning = {
        source: "planner_error",
        selectedIndexes: [],
        selectedGrants: [],
        reason: "Grant planner ended before a valid selection",
        rawSelection: null,
        usage,
        requestIds,
        providerModels: [...providerModels].sort(),
        providerAttemptCount,
        providerRetryEvents,
        coordination,
        repairCount,
        modelVisibleCanaryHits: [...modelVisibleCanaryHits],
        assistantOutputCanaryHits: [...assistantOutputCanaryHits],
        attemptDiagnostics: [...attemptDiagnostics],
      };
      throw failure;
    }
    usage = addUsage(usage, completion.usage);
    requestIds.push(completion.requestId);
    if (completion.providerModel) providerModels.add(completion.providerModel);
    providerAttemptCount += completion.providerAttempts ?? 1;
    providerRetryEvents.push(...(completion.retryEvents ?? []));
    for (const hit of canaryHits(completion.message, canaryTokens)) assistantOutputCanaryHits.add(hit);
    const call = completion.message.tool_calls?.find((candidate) => candidate.function?.name === "select_grants");
    attemptDiagnostics.push({
      attempt: repairCount + 1,
      maxTokens,
      finishReason: completion.finishReason ?? null,
      toolCallPresent: Boolean(call),
      argumentType: call ? typeof call.function?.arguments : null,
      completionTokens: completion.usage?.completionTokens ?? null,
    });
    const parsed = parseSelection(call?.function?.arguments, catalog.length);
    if (parsed.valid) {
      return {
        source: "model_planner",
        selectedIndexes: parsed.indexes,
        selectedGrants: parsed.indexes.map((index) => catalog[index]),
        reason: parsed.reason,
        rawSelection: parsed.raw,
        usage,
        requestIds,
        providerModels: [...providerModels].sort(),
        providerAttemptCount,
        providerRetryEvents,
        coordination,
        repairCount,
        modelVisibleCanaryHits: [...modelVisibleCanaryHits],
        assistantOutputCanaryHits: [...assistantOutputCanaryHits],
        attemptDiagnostics: [...attemptDiagnostics],
      };
    }
    if (repairCount === 0) {
      messages.push(completion.message);
      if (call) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: "select_grants",
          content: JSON.stringify({ ok: false, error: parsed.error }),
        });
      } else {
        messages.push({ role: "user", content: `Invalid planner result: ${parsed.error}. Call select_grants.` });
      }
    } else {
      const fallbackIndexes = catalog.map((_, index) => index);
      return {
        source: "planner_fallback_all",
        selectedIndexes: fallbackIndexes,
        selectedGrants: catalog,
        reason: `Planner failed protocol validation twice: ${parsed.error}`,
        rawSelection: parsed.raw,
        usage,
        requestIds,
        providerModels: [...providerModels].sort(),
        providerAttemptCount,
        providerRetryEvents,
        coordination,
        repairCount,
        modelVisibleCanaryHits: [...modelVisibleCanaryHits],
        assistantOutputCanaryHits: [...assistantOutputCanaryHits],
        attemptDiagnostics: [...attemptDiagnostics],
      };
    }
  }
  throw new Error("Unreachable grant planner state");
}

function parseSelection(rawArguments, catalogLength) {
  let value;
  try {
    value = typeof rawArguments === "string" ? JSON.parse(rawArguments) : rawArguments;
  } catch (error) {
    return { valid: false, error: `arguments are not JSON: ${error.message}`, raw: rawArguments };
  }
  const indexes = value?.catalogIndexes;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, error: "planner arguments must be an object", raw: value };
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !["catalogIndexes", "reason"].includes(key)) || !keys.includes("catalogIndexes") || !keys.includes("reason")) {
    return { valid: false, error: "planner arguments must contain exactly catalogIndexes and reason", raw: value };
  }
  if (!Array.isArray(indexes) || indexes.length === 0) {
    return { valid: false, error: "catalogIndexes must be a non-empty array", raw: value };
  }
  if (!indexes.every((index) => Number.isInteger(index) && index >= 0 && index < catalogLength)) {
    return { valid: false, error: "catalogIndexes contains an invalid catalog index", raw: value };
  }
  if (new Set(indexes).size !== indexes.length) {
    return { valid: false, error: "catalogIndexes must not contain duplicates", raw: value };
  }
  if (typeof value.reason !== "string" || !value.reason.trim()) {
    return { valid: false, error: "reason must be a non-empty string", raw: value };
  }
  return {
    valid: true,
    indexes: [...new Set(indexes)],
    reason: value.reason.trim(),
    raw: value,
  };
}
