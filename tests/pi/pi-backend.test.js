import assert from "node:assert/strict";
import test from "node:test";
import "./register-typescript.js";

const { PiInProcessBackend } = await import("../../src/pi/pi-backend.ts");

test("timeout starts before gateway materialization and aborts the full invocation lifecycle", async () => {
  let runtimeStarted = false;
  const backend = new PiInProcessBackend({
    gatewayFactory: {
      async create(request) {
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
        });
      },
    },
    async createModelRuntime() {
      runtimeStarted = true;
      return {};
    },
    async createSession() {
      throw new Error("session must not start");
    },
  });

  const startedAt = Date.now();
  const result = await backend.run(request({ budget: { ...budget(), timeoutMs: 20 } }));
  assert.equal(result.terminationReason, "timeout");
  assert.equal(runtimeStarted, false);
  assert.ok(Date.now() - startedAt < 500, "timeout must not wait for an unbounded gateway operation");
});

test("completion sharing a tool batch is rejected until results are visible on a later turn", async () => {
  const visible = new Set();
  const traces = [];
  const gateway = {
    tools: [{
      name: "scope_read",
      label: "read",
      description: "read",
      parameters: {},
      async execute() {
        visible.add("evidence.txt");
        return { content: [{ type: "text", text: "alpha" }], details: {} };
      },
    }],
    async materializePromptRefs() { return []; },
    snapshot() { return { modelVisibleSet: [...visible] }; },
  };
  const backend = new PiInProcessBackend({
    gatewayFactory: { async create() { return gateway; } },
    async createModelRuntime() { return {}; },
    async createSession(options) {
      const listeners = new Set();
      const tools = new Map(options.customTools.map((tool) => [tool.name, tool]));
      const session = {
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        async prompt() {
          emit(listeners, assistantMessage([
            { id: "read-1", name: "scope_read" },
            { id: "complete-mixed", name: "scope_complete" },
          ]));
          const mixedPayload = completionPayload();
          const [, rejected] = await Promise.all([
            tools.get("scope_read").execute("read-1", { path: "evidence.txt" }),
            tools.get("scope_complete").execute("complete-mixed", mixedPayload),
          ]);
          assert.equal(rejected.details.accepted, false);
          assert.equal(rejected.details.code, "COMPLETION_HAS_SIBLING_TOOL");

          emit(listeners, assistantMessage([{ id: "complete-later", name: "scope_complete" }]));
          const accepted = await tools.get("scope_complete").execute("complete-later", completionPayload());
          assert.equal(accepted.details.accepted, true);
        },
        async abort() {},
        dispose() {},
        getSessionStats() {
          return { tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 }, cost: 0 };
        },
      };
      return { session };
    },
  });

  const result = await backend.run(request({
    onTrace(type, data) { traces.push({ type, data }); },
  }));
  assert.equal(result.terminationReason, "completed");
  assert.equal(result.completion.status, "SUCCESS");
  assert.deepEqual(result.completionResourceAudit.modelVisibleSet, ["evidence.txt"]);
  assert.ok(traces.some((event) => event.type === "completion_batch_rejected"));
});

test("child skill tool returns only the structured child result and records the child Scope", async () => {
  let disposed = false;
  const childResult = {
    schemaVersion: "1.1",
    scopeId: "child-scope",
    invocationId: "child-invocation",
    parentSessionId: "parent-session",
    parentScopeId: "scope",
    rootScopeId: "scope",
    depth: 1,
    skill: { name: "inspect-constraint", version: "1.0.0" },
    status: "SUCCESS",
    summary: "constraint extracted",
    data: { value: "enabled" },
    evidenceRefs: [],
    requestedResources: [],
    warnings: [],
    usage: { turns: 1, toolCalls: 1, inputTokens: 8, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 10, cost: 0, wallTimeMs: 5 },
    treeUsage: { scopes: 1, turns: 1, toolCalls: 1, inputTokens: 8, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 10, cost: 0 },
    childScopes: [],
    traceId: "child-scope",
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(1).toISOString(),
    childTranscriptForAuditOnly: "CHILD_CONTEXT_SENTINEL_MUST_NOT_RETURN",
  };
  const backend = new PiInProcessBackend({
    gatewayFactory: {
      async create() {
        return { tools: [], async materializePromptRefs() { return []; }, snapshot() { return {}; } };
      },
    },
    async createModelRuntime() { return {}; },
    async createSession(options) {
      const listeners = new Set();
      const tools = new Map(options.customTools.map((tool) => [tool.name, tool]));
      assert.ok(tools.has("scope_invoke_skill"));
      return {
        session: {
          subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
          async prompt() {
            emit(listeners, assistantMessage([{ id: "child-1", name: "scope_invoke_skill" }]));
            const child = await tools.get("scope_invoke_skill").execute("child-1", {
              skill: "inspect-constraint",
              input: { question: "q" },
              accessMode: "BOUNDED",
              resourceGrants: [{ path: "evidence.txt", kind: "file", operations: ["read"] }],
            });
            assert.equal(child.content[0].text.includes("CHILD_CONTEXT_SENTINEL"), false);
            assert.equal(child.content[0].text.includes('"value":"enabled"'), true);
            emit(listeners, assistantMessage([{ id: "complete", name: "scope_complete" }]));
            await tools.get("scope_complete").execute("complete", completionPayload("scope://child-scope"));
          },
          async abort() {},
          dispose() { disposed = true; },
          getSessionStats() {
            return { tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 }, cost: 0 };
          },
        },
      };
    },
  });
  const result = await backend.run(request({
    skill: {
      ...request().skill,
      delegationPolicy: { allowedSkills: ["inspect-constraint"], maxChildScopes: 1, maxConcurrency: 1 },
    },
    async invokeChild(invocation) {
      assert.equal(invocation.skill, "inspect-constraint");
      return childResult;
    },
  }));
  assert.equal(result.terminationReason, "completed");
  assert.equal(result.childResults.length, 1);
  assert.equal(result.childResults[0].scopeId, "child-scope");
  assert.equal(disposed, true);
});

function request(overrides = {}) {
  const selectedModel = {
    provider: "fake-provider",
    id: "fake-model",
    name: "Fake Model",
    api: "openai-completions",
    baseUrl: "https://example.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 1024,
  };
  return {
    scopeId: "scope",
    invocationId: "invocation",
    cwd: process.cwd(),
    skill: {
      name: "test-skill",
      version: "1.0.0",
      description: "test",
      promptFile: "SKILL.md",
      inputSchema: {},
      outputSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
      allowedTools: ["scope_read"],
      resourcePolicy: {
        defaultAccessMode: "BOUNDED",
        allowedAccessModes: ["BOUNDED"],
        allowedOperations: ["read"],
      },
      delegationPolicy: { allowedSkills: [], maxChildScopes: 0, maxConcurrency: 1 },
      budget: budget(),
      directory: "",
      instructions: "Complete the task.",
    },
    input: {},
    promptRefs: [],
    resourceGrants: [{ path: "evidence.txt", kind: "file", operations: ["read"] }],
    accessMode: "BOUNDED",
    budget: budget(),
    hostContext: { model: selectedModel, modelRegistry: {} },
    ...overrides,
  };
}

function budget() {
  return { maxTurns: 4, maxToolCalls: 4, timeoutMs: 1_000, maxPromptBytes: 10_000, maxResultBytes: 10_000 };
}

function assistantMessage(calls) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: calls.map((call) => ({ type: "toolCall", ...call, arguments: {} })),
    },
  };
}

function emit(listeners, event) {
  for (const listener of listeners) listener(event);
}

function completionPayload(resource = "evidence.txt") {
  return {
    status: "SUCCESS",
    summary: "Evidence supports alpha.",
    data: { answer: "alpha" },
    evidenceRefs: [{ id: "e1", resource }],
  };
}
