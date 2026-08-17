import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import "../pi/register-typescript.js";

const { SkillScopeRuntime } = await import("../../src/pi/runtime.ts");
const { SkillRegistry } = await import("../../src/pi/skill-registry.ts");
const { TraceStore } = await import("../../src/pi/trace-store.ts");
const { CoreResourceGatewayFactory } = await import("../../src/pi/core-resource-gateway.ts");
const { createCompletionTool } = await import("../../src/pi/completion-tool.ts");

test("PROJECT filters search when SkillSpec allowedOperations contains only read", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root.project, "fact.txt"), "alpha\n");
  const request = {
    scopeId: "scope",
    invocationId: "invocation",
    cwd: root.project,
    skill: {
      name: "audit-skill",
      version: "1.0.0",
      description: "audit fixture",
      promptFile: "SKILL.md",
      inputSchema: {},
      outputSchema: {},
      allowedTools: ["scope_read", "scope_search"],
      resourcePolicy: {
        defaultAccessMode: "PROJECT",
        allowedAccessModes: ["PROJECT"],
        allowedOperations: ["read"],
      },
      budget: {
        maxTurns: 4,
        maxToolCalls: 4,
        timeoutMs: 1_000,
        maxPromptBytes: 10_000,
        maxResultBytes: 10_000,
      },
      directory: root.skills,
      instructions: "Return a scoped result.",
    },
    input: {},
    promptRefs: [],
    resourceGrants: [],
    accessMode: "PROJECT",
    budget: {
      maxTurns: 4,
      maxToolCalls: 4,
      timeoutMs: 1_000,
      maxPromptBytes: 10_000,
      maxResultBytes: 10_000,
    },
  };

  const gateway = await new CoreResourceGatewayFactory().create(request);
  const search = gateway.tools.find((tool) => tool.name === "scope_search");

  assert.equal(search, undefined);
  // The broker's PROJECT snapshot is intentionally broader than the effective
  // Pi tool surface, so audit consumers must not interpret this field alone as
  // evidence that an operation was model-callable.
  assert.deepEqual(gateway.snapshot().grantedSet[0].operations, ["read", "list", "search"]);
});

test("NEED_CONTEXT without business data is accepted by the current runtime", async (t) => {
  const root = await fixture(t);
  const runtime = makeRuntime(root, {
    status: "NEED_CONTEXT",
    summary: "One more file is required.",
    evidenceRefs: [],
    requestedResources: [{ path: "missing.txt", operations: ["read"], reason: "Needed to answer" }],
  });

  const result = await invoke(runtime, root);

  assert.equal(result.status, "NEED_CONTEXT");
  assert.equal(result.error, undefined);
});

test("SUCCESS without required business data is rejected", async (t) => {
  const root = await fixture(t);
  const runtime = makeRuntime(root, {
    status: "SUCCESS",
    summary: "claims success without output data",
    evidenceRefs: [],
  });

  const result = await invoke(runtime, root);

  assert.equal(result.status, "INVALID_RESULT");
  assert.equal(result.error?.code, "OUTPUT_SCHEMA_INVALID");
  assert.equal(result.data, undefined);
});

test("repeated scope_complete calls preserve the first result and record a fatal protocol issue", async () => {
  const handle = createCompletionTool(
    { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
    { maxTurns: 4, maxToolCalls: 4, timeoutMs: 1_000, maxPromptBytes: 10_000, maxResultBytes: 10_000 },
  );
  const first = successCompletion();
  const second = successCompletion();
  second.summary = "second completion";

  const firstResult = await handle.tool.execute("first", first);
  const secondResult = await handle.tool.execute("second", second);

  assert.equal(firstResult.details.accepted, true);
  assert.equal(secondResult.details.accepted, false);
  assert.equal(handle.getCompletion()?.summary, "done");
  assert.equal(handle.getProtocolIssue()?.code, "DUPLICATE_COMPLETION");
});

test("timeout wins when a backend also reports a completion", async (t) => {
  const root = await fixture(t);
  const runtime = makeRuntime(root, successCompletion(), "timeout");

  const result = await invoke(runtime, root);

  assert.equal(result.status, "TIMEOUT");
  assert.equal(result.error?.code, "TIMEOUT");
});

test("evidence refs are checked against resources visible before completion", async (t) => {
  const root = await fixture(t);
  const completion = successCompletion();
  completion.evidenceRefs = [{ id: "invented", resource: "ungranted/secret.txt" }];
  const runtime = makeRuntime(root, completion, "completed", { modelVisibleSet: [], actualReadSet: [] });

  const result = await invoke(runtime, root);

  assert.equal(result.status, "INVALID_RESULT");
  assert.equal(result.error?.code, "EVIDENCE_NOT_VISIBLE");
  assert.equal(result.evidenceRefs.length, 0);
});

test("metadata-only Trace omits inline prompt and result payload content", async (t) => {
  const root = await fixture(t);
  const marker = "AUDIT-SENSITIVE-MARKER-DO-NOT-USE-AS-A-REAL-SECRET";
  const completion = successCompletion();
  completion.summary = marker;
  completion.data = { answer: marker };
  const runtime = makeRuntime(root, completion);

  const result = await runtime.invoke({
    skill: "audit-skill",
    input: { question: "q" },
    promptRefs: [{ kind: "inline", name: "fact", content: marker }],
    accessMode: "SEALED",
  }, { cwd: root.project, parentSessionId: "parent" });

  const directory = join(root.traces, result.scopeId);
  const manifest = await readFile(join(directory, "manifest.json"), "utf8");
  const persistedResult = await readFile(join(directory, "result.json"), "utf8");
  assert.equal(manifest.includes(marker), false);
  assert.equal(persistedResult.includes(marker), false);
  const traceResult = JSON.parse(persistedResult);
  assert.equal(traceResult.traceFormat, "metadata-only-v1");
  assert.match(traceResult.summaryHash, /^sha256:/);
  assert.match(traceResult.dataHash, /^sha256:/);
});

function makeRuntime(root, completion, terminationReason = "completed", resourceAudit) {
  return new SkillScopeRuntime({
    registry: new SkillRegistry(root.skills),
    backend: {
      async run() {
        return {
          completion,
          usage: {
            turns: 1,
            toolCalls: 0,
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 2,
            cost: 0,
          },
          resourceAudit,
          terminationReason,
        };
      },
    },
    traceStore: new TraceStore(root.traces),
  });
}

function successCompletion() {
  return {
    status: "SUCCESS",
    summary: "done",
    data: { answer: "alpha" },
    evidenceRefs: [],
  };
}

function invoke(runtime, root) {
  return runtime.invoke({
    skill: "audit-skill",
    input: { question: "q" },
    accessMode: "SEALED",
  }, { cwd: root.project, parentSessionId: "parent" });
}

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "skillscope-plugin-audit-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, "project");
  const skills = join(base, "skills");
  const traces = join(base, "traces");
  await mkdir(project, { recursive: true });
  await mkdir(join(skills, "audit-skill"), { recursive: true });
  await writeFile(join(skills, "audit-skill", "SKILL.md"), "Return a scoped result.");
  await writeFile(join(skills, "audit-skill", "scope.json"), JSON.stringify({
    name: "audit-skill",
    version: "1.0.0",
    description: "audit fixture",
    promptFile: "SKILL.md",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    },
    allowedTools: ["scope_read", "scope_list", "scope_search"],
    resourcePolicy: {
      defaultAccessMode: "BOUNDED",
      allowedAccessModes: ["SEALED", "BOUNDED", "PROJECT"],
      allowedOperations: ["read", "list", "search"],
    },
    budget: {
      maxTurns: 4,
      maxToolCalls: 4,
      timeoutMs: 1_000,
      maxPromptBytes: 10_000,
      maxResultBytes: 10_000,
    },
  }));
  return { project, skills, traces };
}
