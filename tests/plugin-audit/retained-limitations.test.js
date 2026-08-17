import assert from "node:assert/strict";
import { link, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import "../pi/register-typescript.js";

const { CoreResourceGatewayFactory } = await import("../../src/pi/core-resource-gateway.ts");
const { SkillScopeRuntime } = await import("../../src/pi/runtime.ts");
const { SkillRegistry } = await import("../../src/pi/skill-registry.ts");
const { TraceStore } = await import("../../src/pi/trace-store.ts");

test("NEED_CONTEXT resource requests fail closed outside Skill policy", async (t) => {
  const root = await runtimeFixture(t, {
    outputSchema: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    },
    allowedTools: ["scope_read"],
    allowedOperations: ["read"],
  });
  const requested = {
    path: "/outside/project",
    operations: ["search"],
    reason: "This intentionally exceeds the current skill policy.",
  };
  const runtime = fakeRuntime(root, {
    status: "NEED_CONTEXT",
    summary: "More context requested.",
    evidenceRefs: [],
    requestedResources: [requested],
  });

  const result = await invoke(runtime, root);

  assert.equal(result.status, "INVALID_RESULT");
  assert.equal(result.error?.code, "REQUESTED_RESOURCE_INVALID");
  assert.deepEqual(result.requestedResources, []);
});

test("business evidence IDs must reference top-level evidence refs", async (t) => {
  const root = await runtimeFixture(t, {
    outputSchema: {
      type: "object",
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              claim: { type: "string" },
              evidenceIds: { type: "array", items: { type: "string" } },
            },
            required: ["claim", "evidenceIds"],
            additionalProperties: false,
          },
        },
      },
      required: ["findings"],
      additionalProperties: false,
    },
    allowedTools: [],
    allowedOperations: [],
  });
  const runtime = fakeRuntime(root, {
    status: "SUCCESS",
    summary: "Schema-valid but semantically dangling provenance.",
    data: { findings: [{ claim: "alpha", evidenceIds: ["ghost-id"] }] },
    evidenceRefs: [],
  });

  const result = await invoke(runtime, root);

  assert.equal(result.status, "INVALID_RESULT");
  assert.equal(result.error?.code, "EVIDENCE_ID_NOT_FOUND");
  assert.equal(result.data, undefined);
});

test("retained limitation: path containment cannot distinguish an in-project hardlink alias", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "skillscope-hardlink-audit-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, "project");
  await mkdir(project);
  const outside = join(base, "outside.txt");
  const insideAlias = join(project, "inside-alias.txt");
  await writeFile(outside, "outside-inode-content\n");
  try {
    await link(outside, insideAlias);
  } catch (error) {
    if (["EPERM", "ENOTSUP", "EXDEV"].includes(error?.code)) {
      t.skip(`hardlinks unavailable in this test environment: ${error.code}`);
      return;
    }
    throw error;
  }

  const request = gatewayRequest(project);
  const gateway = await new CoreResourceGatewayFactory().create(request);
  const read = gateway.tools.find((tool) => tool.name === "scope_read");
  const result = await read.execute("hardlink-read", { path: "inside-alias.txt" });

  assert.equal(result.details.content, "outside-inode-content\n");
  assert.deepEqual(gateway.snapshot().physicalMaterializedSet, ["inside-alias.txt"]);
});

function fakeRuntime(root, completion) {
  return new SkillScopeRuntime({
    registry: new SkillRegistry(root.skills),
    backend: {
      async run() {
        return {
          completion,
          completionResourceAudit: { modelVisibleSet: [] },
          resourceAudit: { modelVisibleSet: [] },
          usage: usage(),
          terminationReason: "completed",
        };
      },
    },
    traceStore: new TraceStore(root.traces),
  });
}

function invoke(runtime, root) {
  return runtime.invoke(
    { skill: "audit-skill", input: {}, accessMode: "SEALED" },
    { cwd: root.project, parentSessionId: "parent" },
  );
}

async function runtimeFixture(t, { outputSchema, allowedTools, allowedOperations }) {
  const base = await mkdtemp(join(tmpdir(), "skillscope-retained-audit-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, "project");
  const skills = join(base, "skills");
  const traces = join(base, "traces");
  await mkdir(project);
  await mkdir(join(skills, "audit-skill"), { recursive: true });
  await writeFile(join(skills, "audit-skill", "SKILL.md"), "Return a typed result.");
  await writeFile(join(skills, "audit-skill", "scope.json"), JSON.stringify({
    name: "audit-skill",
    version: "1.0.0",
    description: "audit fixture",
    promptFile: "SKILL.md",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema,
    allowedTools,
    resourcePolicy: {
      defaultAccessMode: "SEALED",
      allowedAccessModes: ["SEALED"],
      allowedOperations,
    },
    budget: {
      maxTurns: 2,
      maxToolCalls: 2,
      timeoutMs: 1_000,
      maxPromptBytes: 10_000,
      maxResultBytes: 10_000,
    },
  }));
  return { project, skills, traces };
}

function gatewayRequest(cwd) {
  const budget = {
    maxTurns: 2,
    maxToolCalls: 2,
    timeoutMs: 1_000,
    maxPromptBytes: 10_000,
    maxResultBytes: 10_000,
  };
  return {
    scopeId: "scope",
    invocationId: "invocation",
    cwd,
    skill: {
      name: "audit-skill",
      version: "1.0.0",
      description: "audit fixture",
      promptFile: "SKILL.md",
      inputSchema: {},
      outputSchema: {},
      allowedTools: ["scope_read"],
      resourcePolicy: {
        defaultAccessMode: "BOUNDED",
        allowedAccessModes: ["BOUNDED"],
        allowedOperations: ["read"],
      },
      budget,
      directory: "",
      instructions: "Read the granted file.",
    },
    input: {},
    promptRefs: [],
    resourceGrants: [{ path: "inside-alias.txt", kind: "file", operations: ["read"] }],
    accessMode: "BOUNDED",
    budget,
  };
}

function usage() {
  return {
    turns: 1,
    toolCalls: 0,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 2,
    cost: 0,
  };
}
