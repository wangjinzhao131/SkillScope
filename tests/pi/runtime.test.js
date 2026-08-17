import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import "./register-typescript.js";

const { SkillScopeRuntime } = await import("../../src/pi/runtime.ts");
const { SkillRegistry } = await import("../../src/pi/skill-registry.ts");
const { TraceStore } = await import("../../src/pi/trace-store.ts");

test("Runtime owns SkillResult metadata and only accepts CompletionPayload business fields", async (t) => {
  const root = await fixture(t);
  let backendRequest;
  const backend = {
    async run(request) {
      backendRequest = request;
      return {
        completion: {
          status: "SUCCESS",
          summary: "Evidence supports alpha.",
          data: { answer: "alpha" },
          evidenceRefs: [{ id: "e1", resource: "inline://fact" }],
          warnings: [],
        },
        usage: usage(17),
        resourceAudit: { actualReadSet: [] },
        terminationReason: "completed",
      };
    },
  };
  const ids = ["invocation-fixed", "scope-fixed"];
  const runtime = new SkillScopeRuntime({
    registry: new SkillRegistry(root.skills),
    backend,
    traceStore: new TraceStore(root.traces),
    id: () => ids.shift(),
  });

  const result = await runtime.invoke({
    skill: "test-skill",
    input: { question: "which?" },
    promptRefs: [{ kind: "inline", name: "fact", content: "alpha" }],
    accessMode: "SEALED",
    budgetOverride: { maxTurns: 999, maxToolCalls: 2 },
  }, { cwd: root.project, parentSessionId: "parent-1" });

  assert.equal(result.status, "SUCCESS");
  assert.equal(result.scopeId, "scope-fixed");
  assert.equal(result.traceId, "scope-fixed");
  assert.equal(result.usage.totalTokens, 17);
  assert.equal(result.skill.version, "1.2.3");
  assert.equal(backendRequest.budget.maxTurns, 4, "override cannot increase the SkillSpec maximum");
  assert.equal(backendRequest.budget.maxToolCalls, 2, "override may narrow a budget");
  const persisted = JSON.parse(await readFile(join(root.traces, "scope-fixed", "result.json"), "utf8"));
  assert.equal(persisted.scopeId, "scope-fixed");
  const manifest = JSON.parse(await readFile(join(root.traces, "scope-fixed", "manifest.json"), "utf8"));
  assert.equal(manifest.accessMode, "SEALED");
  assert.deepEqual(manifest.budget, {
    maxTurns: 4,
    maxToolCalls: 2,
    timeoutMs: 1000,
    maxPromptBytes: 10000,
    maxResultBytes: 10000,
  });
  assert.match(manifest.inputHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(manifest.input, undefined);
});

test("Runtime rejects a backend payload that attempts to submit Runtime-owned fields", async (t) => {
  const root = await fixture(t);
  const runtime = new SkillScopeRuntime({
    registry: new SkillRegistry(root.skills),
    backend: {
      async run() {
        return {
          completion: {
            status: "SUCCESS",
            summary: "forged",
            data: { answer: "alpha" },
            evidenceRefs: [],
            scopeId: "model-owned",
            usage: { totalTokens: 999 },
          },
          usage: usage(1),
          terminationReason: "completed",
        };
      },
    },
    traceStore: new TraceStore(root.traces),
  });
  const result = await runtime.invoke({ skill: "test-skill", input: { question: "q" }, accessMode: "SEALED" }, { cwd: root.project, parentSessionId: "p" });
  assert.equal(result.status, "INVALID_RESULT");
  assert.equal(result.error.code, "COMPLETION_SCHEMA_INVALID");
  assert.match(result.error.message, /scopeId|usage/);
});

test("invalid input is rejected before starting a child backend", async (t) => {
  const root = await fixture(t);
  let calls = 0;
  const runtime = new SkillScopeRuntime({
    registry: new SkillRegistry(root.skills),
    backend: { async run() { calls += 1; throw new Error("must not run"); } },
    traceStore: new TraceStore(root.traces),
  });
  const result = await runtime.invoke({ skill: "test-skill", input: {} }, { cwd: root.project, parentSessionId: "p" });
  assert.equal(result.status, "INVALID_INPUT");
  assert.equal(result.error.code, "INVALID_INPUT");
  assert.equal(calls, 0);
});

test("normal child exit without scope_complete is INVALID_RESULT", async (t) => {
  const root = await fixture(t);
  const runtime = new SkillScopeRuntime({
    registry: new SkillRegistry(root.skills),
    backend: { async run() { return { usage: usage(3), terminationReason: "completed" }; } },
    traceStore: new TraceStore(root.traces),
  });
  const result = await runtime.invoke({ skill: "test-skill", input: { question: "q" }, accessMode: "SEALED" }, { cwd: root.project, parentSessionId: "p" });
  assert.equal(result.status, "INVALID_RESULT");
  assert.equal(result.error.code, "MISSING_COMPLETION");
});

test("backend termination reason takes precedence over an accepted completion", async (t) => {
  const root = await fixture(t);
  const runtime = new SkillScopeRuntime({
    registry: new SkillRegistry(root.skills),
    backend: {
      async run() {
        return {
          completion: {
            status: "SUCCESS",
            summary: "too late",
            data: { answer: "alpha" },
            evidenceRefs: [],
          },
          usage: usage(3),
          terminationReason: "timeout",
          error: new Error("deadline reached"),
        };
      },
    },
    traceStore: new TraceStore(root.traces),
  });
  const result = await runtime.invoke({ skill: "test-skill", input: { question: "q" }, accessMode: "SEALED" }, { cwd: root.project, parentSessionId: "p" });
  assert.equal(result.status, "TIMEOUT");
  assert.equal(result.error.code, "TIMEOUT");
  assert.equal(result.summary, "deadline reached");
});

test("NEED_CONTEXT may omit data while requesting additional resources", async (t) => {
  const root = await fixture(t);
  const runtime = new SkillScopeRuntime({
    registry: new SkillRegistry(root.skills),
    backend: {
      async run() {
        return {
          completion: {
            status: "NEED_CONTEXT",
            summary: "The bounded evidence is insufficient.",
            evidenceRefs: [],
            requestedResources: [{ path: "more.txt", operations: ["read"], reason: "Needed to resolve the question" }],
          },
          usage: usage(2),
          terminationReason: "completed",
        };
      },
    },
    traceStore: new TraceStore(root.traces),
  });
  const result = await runtime.invoke({ skill: "test-skill", input: { question: "q" }, accessMode: "SEALED" }, { cwd: root.project, parentSessionId: "p" });
  assert.equal(result.status, "NEED_CONTEXT");
  assert.equal(result.data, undefined);
  assert.deepEqual(result.requestedResources, [{ path: "more.txt", operations: ["read"], reason: "Needed to resolve the question" }]);
});

test("SUCCESS and PARTIAL require data even though context-failure statuses do not", async (t) => {
  const root = await fixture(t);
  const runtime = new SkillScopeRuntime({
    registry: new SkillRegistry(root.skills),
    backend: {
      async run() {
        return {
          completion: { status: "PARTIAL", summary: "Some evidence found.", evidenceRefs: [] },
          usage: usage(2),
          terminationReason: "completed",
        };
      },
    },
    traceStore: new TraceStore(root.traces),
  });
  const result = await runtime.invoke({ skill: "test-skill", input: { question: "q" }, accessMode: "SEALED" }, { cwd: root.project, parentSessionId: "p" });
  assert.equal(result.status, "INVALID_RESULT");
  assert.equal(result.error.code, "OUTPUT_SCHEMA_INVALID");
  assert.match(result.error.message, /data.*required for PARTIAL/);
});

test("evidence must be visible in the ledger captured before completion", async (t) => {
  const root = await fixture(t);
  const makeRuntime = (completionResourceAudit) => new SkillScopeRuntime({
    registry: new SkillRegistry(root.skills),
    backend: {
      async run() {
        return {
          completion: {
            status: "SUCCESS",
            summary: "Evidence supports alpha.",
            data: { answer: "alpha" },
            evidenceRefs: [{ id: "e1", resource: "evidence.txt" }],
          },
          usage: usage(2),
          completionResourceAudit,
          resourceAudit: { modelVisibleSet: ["evidence.txt"] },
          terminationReason: "completed",
        };
      },
    },
    traceStore: new TraceStore(root.traces),
  });

  const rejected = await makeRuntime({ modelVisibleSet: [] }).invoke(
    { skill: "test-skill", input: { question: "q" }, accessMode: "SEALED" },
    { cwd: root.project, parentSessionId: "p" },
  );
  assert.equal(rejected.status, "INVALID_RESULT");
  assert.equal(rejected.error.code, "EVIDENCE_NOT_VISIBLE");

  const accepted = await makeRuntime({ modelVisibleSet: ["evidence.txt"] }).invoke(
    { skill: "test-skill", input: { question: "q" }, accessMode: "SEALED" },
    { cwd: root.project, parentSessionId: "p" },
  );
  assert.equal(accepted.status, "SUCCESS");
});

test("skill manifests fail closed on unsupported JSON Schema keywords", async (t) => {
  const root = await fixture(t);
  const manifestPath = join(root.skills, "test-skill", "scope.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.inputSchema.properties.question.pattern = "^[a-z]+$";
  await writeFile(manifestPath, JSON.stringify(manifest));
  let calls = 0;
  const runtime = new SkillScopeRuntime({
    registry: new SkillRegistry(root.skills),
    backend: { async run() { calls += 1; throw new Error("must not run"); } },
    traceStore: new TraceStore(root.traces),
  });
  const result = await runtime.invoke({ skill: "test-skill", input: { question: "q" } }, { cwd: root.project, parentSessionId: "p" });
  assert.equal(result.status, "INVALID_INPUT");
  assert.equal(result.error.code, "INVALID_MANIFEST");
  assert.match(result.error.message, /pattern.*unsupported JSON Schema keyword/);
  assert.equal(calls, 0);
});

test("every recursive data.evidenceIds entry must reference a top-level evidence ref", async (t) => {
  const root = await fixture(t);
  const manifestPath = join(root.skills, "test-skill", "scope.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.outputSchema = {};
  await writeFile(manifestPath, JSON.stringify(manifest));
  const runtime = new SkillScopeRuntime({
    registry: new SkillRegistry(root.skills),
    backend: {
      async run() {
        return {
          completion: {
            status: "SUCCESS",
            summary: "contains a ghost citation",
            data: { findings: [{ claim: "alpha", evidenceIds: ["ghost-id"] }] },
            evidenceRefs: [{ id: "e1", resource: "inline://fact" }],
          },
          usage: usage(2),
          terminationReason: "completed",
        };
      },
    },
    traceStore: new TraceStore(root.traces),
  });
  const result = await runtime.invoke({
    skill: "test-skill",
    input: { question: "q" },
    promptRefs: [{ kind: "inline", name: "fact", content: "alpha" }],
    accessMode: "SEALED",
  }, { cwd: root.project, parentSessionId: "p" });
  assert.equal(result.status, "INVALID_RESULT");
  assert.equal(result.error.code, "EVIDENCE_ID_NOT_FOUND");
  assert.match(result.error.message, /ghost-id/);
});

test("requestedResources follows a fail-closed status, path, and operation matrix", async (t) => {
  const root = await fixture(t);
  const cases = [
    {
      name: "NEED_CONTEXT requires a request",
      completion: { status: "NEED_CONTEXT", summary: "need more", evidenceRefs: [] },
    },
    {
      name: "traversal is rejected",
      completion: {
        status: "NEED_CONTEXT",
        summary: "need more",
        evidenceRefs: [],
        requestedResources: [{ path: "../secret", operations: ["read"], reason: "need it" }],
      },
    },
    {
      name: "undeclared operation is rejected",
      completion: {
        status: "NEED_CONTEXT",
        summary: "need more",
        evidenceRefs: [],
        requestedResources: [{ path: "more.txt", operations: ["delete"], reason: "need it" }],
      },
    },
    {
      name: "success cannot request expansion",
      completion: {
        status: "SUCCESS",
        summary: "done",
        data: { answer: "alpha" },
        evidenceRefs: [],
        requestedResources: [{ path: "more.txt", operations: ["read"], reason: "extra" }],
      },
    },
  ];

  for (const scenario of cases) {
    const runtime = new SkillScopeRuntime({
      registry: new SkillRegistry(root.skills),
      backend: { async run() { return { completion: scenario.completion, usage: usage(1), terminationReason: "completed" }; } },
      traceStore: new TraceStore(root.traces),
    });
    const result = await runtime.invoke(
      { skill: "test-skill", input: { question: "q" }, accessMode: "SEALED" },
      { cwd: root.project, parentSessionId: "p" },
    );
    assert.equal(result.status, "INVALID_RESULT", scenario.name);
    assert.equal(result.error.code, "REQUESTED_RESOURCE_INVALID", scenario.name);
  }
});

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "skillscope-pi-runtime-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, "project");
  const skills = join(base, "skills");
  const traces = join(base, "traces");
  await mkdir(join(skills, "test-skill"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(skills, "test-skill", "SKILL.md"), "Analyze the evidence and call scope_complete.");
  await writeFile(join(skills, "test-skill", "scope.json"), JSON.stringify({
    name: "test-skill",
    version: "1.2.3",
    description: "test",
    promptFile: "SKILL.md",
    inputSchema: { type: "object", properties: { question: { type: "string" } }, required: ["question"], additionalProperties: false },
    outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
    allowedTools: ["scope_read", "scope_list", "scope_search"],
    resourcePolicy: { defaultAccessMode: "BOUNDED", allowedAccessModes: ["SEALED", "BOUNDED", "PROJECT"], allowedOperations: ["read", "list", "search"] },
    budget: { maxTurns: 4, maxToolCalls: 6, timeoutMs: 1000, maxPromptBytes: 10000, maxResultBytes: 10000 },
  }));
  return { base, project, skills, traces };
}

function usage(totalTokens) {
  return { turns: 1, toolCalls: 0, inputTokens: totalTokens - 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens, cost: 0 };
}
