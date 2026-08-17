import {
  addUsage,
  canaryHits,
  emptyUsage,
  validateResourceRequest,
  validateSubmission,
} from "./protocol.mjs";
import { buildMessages, buildTools } from "./prompt.mjs";

export async function runScopeAttempt({
  task,
  condition,
  broker,
  client,
  grants,
  catalog,
  allowResourceRequest,
  seed,
  canaryTokens = [],
  maxTurns = 10,
  maxToolCalls = 24,
  maxTokens = 1_024,
  temperature = 0,
  signal,
}) {
  const startedAt = new Date().toISOString();
  const startedNs = process.hrtime.bigint();
  const built = buildMessages({ task, condition, grants, catalog, allowResourceRequest });
  const messages = [...built.messages];
  const tools = buildTools({ task, condition, allowResourceRequest });
  let usage = emptyUsage();
  let toolCalls = 0;
  let schemaRepairCount = 0;
  let controlRepairCount = 0;
  let firstSchemaValid = null;
  let submission = null;
  let resourceRequest = null;
  let terminationReason = "max_turns";
  let lengthRetryUsed = false;
  const events = [];
  const requestIds = [];
  const providerModels = new Set();
  let providerAttemptCount = 0;
  const providerRetryEvents = [];
  const modelVisibleCanaryHits = new Set();
  const assistantOutputCanaryHits = new Set();

  const finish = () => {
    const endedAt = new Date().toISOString();
    return {
      startedAt,
      endedAt,
      durationMs: Number(process.hrtime.bigint() - startedNs) / 1e6,
      turns: events.filter((event) => event.type === "model_response").length,
      toolCalls,
      usage,
      submission,
      resourceRequest,
      completion: {
        submitted: Boolean(submission),
        firstSchemaValid: firstSchemaValid ?? false,
        finalSchemaValid: Boolean(submission),
        schemaRepairCount,
        controlRepairCount,
        lengthRetryUsed,
      },
      terminationReason,
      requestIds,
      providerModels: [...providerModels].sort(),
      providerAttemptCount,
      providerRetryEvents,
      events,
      materialization: {
        ...built.materialization,
        estimatedCoordinationTokens: Math.ceil(
          (built.materialization.catalogBytes + built.materialization.grantsBytes) / 4,
        ),
      },
      promptVisiblePaths: (task.promptRefs ?? []).map((ref) => ref.sourcePath).filter(Boolean),
      modelVisibleCanaryHits: [...modelVisibleCanaryHits],
      assistantOutputCanaryHits: [...assistantOutputCanaryHits],
    };
  };

  try {
    for (let turn = 1; turn <= maxTurns; turn += 1) {
      for (const hit of canaryHits(messages, canaryTokens)) modelVisibleCanaryHits.add(hit);
      let completion = await client.complete({
        messages,
        tools,
        temperature,
        maxTokens,
        seed,
        signal,
      });
      usage = addUsage(usage, completion.usage);
      requestIds.push(completion.requestId);
      if (completion.providerModel) providerModels.add(completion.providerModel);
      providerAttemptCount += completion.providerAttempts ?? 1;
      providerRetryEvents.push(...(completion.retryEvents ?? []));
      for (const hit of canaryHits(completion.message, canaryTokens)) assistantOutputCanaryHits.add(hit);
      events.push({ type: "model_response", turn, finishReason: completion.finishReason, requestId: completion.requestId, providerAttempts: completion.providerAttempts ?? 1 });

      if (completion.finishReason === "length" && !lengthRetryUsed) {
        lengthRetryUsed = true;
        events.push({ type: "length_retry", turn, maxTokens: maxTokens * 2 });
        completion = await client.complete({
          messages,
          tools,
          temperature,
          maxTokens: maxTokens * 2,
          seed,
          signal,
        });
        usage = addUsage(usage, completion.usage);
        requestIds.push(completion.requestId);
        if (completion.providerModel) providerModels.add(completion.providerModel);
        providerAttemptCount += completion.providerAttempts ?? 1;
        providerRetryEvents.push(...(completion.retryEvents ?? []));
        for (const hit of canaryHits(completion.message, canaryTokens)) assistantOutputCanaryHits.add(hit);
      }

      const assistant = completion.message;
      messages.push(assistant);
      const calls = assistant.tool_calls ?? [];
      if (calls.length === 0) {
        if (controlRepairCount >= 1) {
          terminationReason = "missing_control_call";
          break;
        }
        controlRepairCount += 1;
        messages.push({
          role: "user",
          content: "Protocol error: you must finish by calling submit_result, or request_resource if that tool is available and essential evidence is inaccessible.",
        });
        events.push({ type: "control_repair", turn, reason: "missing_tool_call" });
        continue;
      }

      const controlCalls = calls.filter((call) => ["submit_result", "request_resource"].includes(call.function?.name));
      const rejectControlBatch = controlCalls.length > 0 && calls.length > 1;
      if (rejectControlBatch) {
        if (controlRepairCount >= 1) {
          terminationReason = "invalid_control_batch";
          break;
        }
        controlRepairCount += 1;
        events.push({ type: "control_repair", turn, reason: "mixed_or_multiple_control_calls" });
      }

      let shouldContinue = false;
      for (const call of calls) {
        toolCalls += 1;
        if (toolCalls > maxToolCalls) {
          terminationReason = "max_tool_calls";
          break;
        }
        const name = call.function?.name ?? "";
        const parsed = parseArguments(call.function?.arguments);
        events.push({ type: "tool_attempt", turn, name, argumentsValid: parsed.ok });
        if (!parsed.ok) {
          messages.push(toolMessage(call.id, name, { ok: false, error: { code: "INVALID_TOOL_ARGUMENTS", message: parsed.error } }));
          shouldContinue = true;
          continue;
        }

        if (name === "submit_result") {
          const validation = validateSubmission(parsed.value, task.responseContract);
          if (firstSchemaValid === null) firstSchemaValid = validation.valid;
          events.push({ type: "completion_attempt", turn, valid: validation.valid, errors: validation.errors });
          if (rejectControlBatch) {
            messages.push(toolMessage(call.id, name, {
              ok: false,
              error: { code: "MIXED_CONTROL_BATCH", message: "submit_result must be the only tool call in its assistant message; call it again after observing tool results" },
            }));
            shouldContinue = true;
            continue;
          }
          if (validation.valid) {
            submission = parsed.value;
            terminationReason = "submitted";
            break;
          }
          if (schemaRepairCount >= 1) {
            terminationReason = "invalid_result";
            break;
          }
          schemaRepairCount += 1;
          messages.push(toolMessage(call.id, name, {
            ok: false,
            error: { code: "INVALID_RESULT", message: validation.errors.join("; ") },
          }));
          shouldContinue = true;
          continue;
        }

        if (name === "request_resource") {
          const validation = validateResourceRequest(parsed.value);
          if (rejectControlBatch) {
            messages.push(toolMessage(call.id, name, {
              ok: false,
              error: { code: "MIXED_CONTROL_BATCH", message: "request_resource must be the only tool call in its assistant message" },
            }));
            shouldContinue = true;
            continue;
          }
          if (!allowResourceRequest) {
            messages.push(toolMessage(call.id, name, {
              ok: false,
              error: { code: "REQUEST_NOT_ALLOWED", message: "This condition does not allow resource requests" },
            }));
            shouldContinue = true;
            continue;
          }
          if (!validation.valid) {
            messages.push(toolMessage(call.id, name, {
              ok: false,
              error: { code: "INVALID_RESOURCE_REQUEST", message: validation.errors.join("; ") },
            }));
            shouldContinue = true;
            continue;
          }
          resourceRequest = validation.value;
          terminationReason = "resource_requested";
          events.push({ type: "resource_request", turn, request: resourceRequest });
          break;
        }

        const result = await broker.invoke(name, parsed.value);
        const serialized = JSON.stringify(result);
        for (const hit of canaryHits(serialized, canaryTokens)) modelVisibleCanaryHits.add(hit);
        events.push({
          type: result.ok ? "tool_result" : "tool_error",
          turn,
          name,
          bytes: Buffer.byteLength(serialized),
          denied: result.error?.denied ?? false,
          canaryHits: canaryHits(serialized, canaryTokens),
        });
        messages.push(toolMessage(call.id, name, result));
        shouldContinue = true;
      }

      if (submission || resourceRequest || ["max_tool_calls", "invalid_result"].includes(terminationReason)) break;
      if (!shouldContinue) {
        terminationReason = "unhandled_control_flow";
        break;
      }
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    terminationReason = "attempt_error";
    failure.scopeAttempt = finish();
    throw failure;
  }

  return finish();
}

function parseArguments(raw) {
  if (raw && typeof raw === "object") return { ok: true, value: raw };
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object"
      ? { ok: true, value }
      : { ok: false, error: "tool arguments must decode to an object" };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function toolMessage(toolCallId, name, value) {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    name,
    content: JSON.stringify(value),
  };
}
