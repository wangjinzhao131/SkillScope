import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import "../../../tests/pi/register-typescript.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadFamilies, materializePackets } from "./corpus.mjs";
import { runCompositionJob } from "./live-harness.mjs";
import { MODEL, PARENT_BUDGET, PROTOCOL_VERSION } from "./protocol.mjs";

const piAi = await import(new URL("../../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.url));

test("real Pi faux sessions execute parallel and typed sequential composition with the same atomic Skill", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "skillscope-composition-faux-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const faux = piAi.fauxProvider({
    provider: "skillscope-composition-faux",
    tokensPerSecond: 2_000,
    models: [{ id: "composition-model", name: "Composition Model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 2_048 }],
  });
  const responder = createResponder(piAi);
  faux.setResponses(Array.from({ length: 48 }, () => responder));
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ providers: ["skillscope-composition-faux"], allowNetwork: false });
  const environment = {
    apiKey: "faux-composition-key",
    modelRuntime,
    modelRegistry: {},
    catalogModel: faux.getModel(),
    skillsRoot: resolve("skills"),
    traceRoot: join(base, "traces"),
    createChildModelRuntime: async () => modelRuntime,
  };
  const family = (await loadFamilies()).find((candidate) => candidate.id === "rollout-lane");
  const parallel = await runCompositionJob(jobFor(family, "PARALLEL_JOIN", 101), environment);
  const sequential = await runCompositionJob(jobFor(family, "CONSTRAINT_FIRST", 102), environment);

  assert.equal(parallel.verification.hardPass, false);
  assert.equal(parallel.verification.abstained, true);
  assert.equal(parallel.topology.valid, true);
  assert.equal(parallel.topology.childIntervalsOverlap, true);
  assert.equal(parallel.scopes.filter((scope) => scope.depth === 1).every((scope) => scope.skill === "inspect-contextual-evidence"), true);
  assert.equal(sequential.verification.hardPass, true);
  assert.equal(sequential.parentResult.decision, "ALLOW");
  assert.equal(sequential.topology.valid, true);
  assert.equal(sequential.topology.childIntervalsOverlap, false);
  assert.equal(sequential.topology.upstreamPassedToSecond, true);
  assert.deepEqual(sequential.lifecycle.runtime, { activeScopeIds: [], startedScopes: 3, disposedScopes: 3 });
  assert.equal(sequential.scopes.filter((scope) => scope.depth === 1).every((scope) => scope.status === "SUCCESS"), true);
});

function jobFor(family, condition, seed) {
  const sentinel = `COMPOSITION_SENTINEL_${String(seed).padStart(16, "0")}`;
  return {
    protocolVersion: PROTOCOL_VERSION,
    jobId: `faux-${condition}-${seed}`,
    blockId: `${family.id}:faux-${seed}`,
    familyId: family.id,
    family,
    condition,
    repeat: 1,
    seed,
    memoryCode: `MEMORY_${seed}`,
    sentinel,
    packets: materializePackets(family, sentinel),
    model: { ...MODEL, provider: "skillscope-composition-faux", id: "composition-model", apiBase: "faux://local", piTransport: "faux" },
    parentBudget: PARENT_BUDGET,
  };
}

function createResponder(api) {
  return (context) => {
    const prompt = firstUserText(context);
    const toolResults = context.messages.filter((message) => message.role === "toolResult").map(toolResultText);
    if (prompt.includes("parent controller for a frozen SkillScope composition experiment")) {
      if (toolResults.length === 0) return api.fauxAssistantMessage(api.fauxToolCall("run_composed_workflow", {}, { id: unique("run") }), { stopReason: "toolUse" });
      const main = parseJsonText(toolResults.at(-1));
      return api.fauxAssistantMessage(api.fauxToolCall("parent_complete", { decision: main.data.decision, constraintFact: main.data.constraintFact, observationFact: main.data.observationFact, memoryCode: invocationMemory(prompt) }, { id: unique("parent-complete") }), { stopReason: "toolUse" });
    }
    const input = invocationInput(prompt);
    if (prompt.includes("# Compose Contextual Evidence")) {
      const results = toolResults.map(parseJsonText);
      if (results.length === 0) {
        if (input.compositionMode === "PARALLEL_JOIN") return api.fauxAssistantMessage([
          api.fauxToolCall("scope_invoke_skill", childArgs(input, "constraint"), { id: unique("constraint") }),
          api.fauxToolCall("scope_invoke_skill", childArgs(input, "observation"), { id: unique("observation") }),
        ], { stopReason: "toolUse" });
        const firstRole = input.compositionMode === "OBSERVATION_FIRST" ? "observation" : "constraint";
        return api.fauxAssistantMessage(api.fauxToolCall("scope_invoke_skill", childArgs(input, firstRole), { id: unique(firstRole) }), { stopReason: "toolUse" });
      }
      if (results.length === 1) {
        const first = results[0];
        const secondRole = first.data.role === "constraint" ? "observation" : "constraint";
        return api.fauxAssistantMessage(api.fauxToolCall("scope_invoke_skill", childArgs(input, secondRole, first.data), { id: unique(secondRole) }), { stopReason: "toolUse" });
      }
      const byRole = Object.fromEntries(results.map((result) => [result.data.role, result]));
      const resolved = byRole.constraint.data.resolution === "RESOLVED" && byRole.observation.data.resolution === "RESOLVED";
      const firstRole = input.compositionMode === "PARALLEL_JOIN" ? "parallel" : results[0].data.role;
      const payload = {
        status: "SUCCESS",
        summary: resolved ? "both evidence packets resolved" : "one evidence packet remained ambiguous",
        data: {
          decision: resolved && byRole.constraint.data.value === "gate_enabled" && byRole.observation.data.value === "health_green" ? "ALLOW" : resolved ? "BLOCK" : "ABSTAIN",
          constraintFact: byRole.constraint.data.value,
          observationFact: byRole.observation.data.value,
          observedFirstRole: firstRole,
          upstreamPassedToSecond: input.compositionMode !== "PARALLEL_JOIN",
        },
        evidenceRefs: results.map((result, index) => ({ id: `child-${index + 1}`, resource: `scope://${result.scopeId}` })),
      };
      return api.fauxAssistantMessage(api.fauxToolCall("scope_complete", payload, { id: unique("main-complete") }), { stopReason: "toolUse" });
    }
    if (prompt.includes("# Inspect Contextual Evidence")) {
      if (toolResults.length === 0) return api.fauxAssistantMessage(api.fauxToolCall("scope_read", { path: input.path }, { id: unique("read") }), { stopReason: "toolUse" });
      const upstreamPassed = input.upstream !== undefined;
      const resolved = input.role === "constraint" || (input.upstream?.role === "constraint" && input.upstream?.resolution === "RESOLVED");
      const data = input.role === "constraint"
        ? { role: "constraint", resolution: "RESOLVED", key: "canary", value: "gate_enabled", upstreamPassed }
        : resolved
          ? { role: "observation", resolution: "RESOLVED", key: "canary", value: "health_green", upstreamPassed }
          : { role: "observation", resolution: "AMBIGUOUS", key: "UNKNOWN", value: "UNKNOWN", upstreamPassed };
      return api.fauxAssistantMessage(api.fauxToolCall("scope_complete", { status: "SUCCESS", summary: data.resolution === "RESOLVED" ? "resolved" : "ambiguous without upstream", data, evidenceRefs: [{ id: "source", resource: input.path }] }, { id: unique("leaf-complete") }), { stopReason: "toolUse" });
    }
    throw new Error(`Unexpected faux prompt: ${prompt.slice(0, 120)}`);
  };
}

function childArgs(input, role, upstream) {
  const path = role === "constraint" ? input.constraintPath : input.observationPath;
  return { skill: "inspect-contextual-evidence", input: { question: input.question, role, path, ...(upstream ? { upstream: { role: upstream.role, resolution: upstream.resolution, key: upstream.key, value: upstream.value } } : {}) }, accessMode: "BOUNDED", resourceGrants: [{ path, kind: "file", operations: ["read"] }] };
}
function firstUserText(context) { const message = context.messages.find((candidate) => candidate.role === "user"); return contentText(message?.content); }
function toolResultText(message) { return contentText(message?.content); }
function contentText(content) { if (typeof content === "string") return content; if (!Array.isArray(content)) return ""; return content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n"); }
function invocationInput(prompt) { const match = prompt.match(/# Invocation input\s+```json\n([\s\S]*?)\n```/u); if (!match) throw new Error("Missing invocation JSON"); return JSON.parse(match[1]); }
function invocationMemory(prompt) { const match = prompt.match(/Memory code: ([A-Z0-9_]+)/u); if (!match) throw new Error("Missing memory code"); return match[1]; }
function parseJsonText(text) { try { return JSON.parse(text); } catch { const match = text.match(/\{[\s\S]*\}/u); if (!match) throw new Error(`No JSON in tool result: ${text}`); return JSON.parse(match[0]); } }
let id = 0;
function unique(prefix) { id += 1; return `${prefix}-${id}`; }
