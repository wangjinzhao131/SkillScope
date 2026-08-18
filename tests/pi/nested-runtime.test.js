import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import "./register-typescript.js";

const { SkillScopeRuntime } = await import("../../src/pi/runtime.ts");
const { SkillRegistry } = await import("../../src/pi/skill-registry.ts");
const { TraceStore } = await import("../../src/pi/trace-store.ts");

test("main Skill invokes two fresh child Scopes and aggregates only typed results", async (t) => {
  const root = await nestedFixture(t);
  const requests = [];
  const backend = {
    async run(request) {
      requests.push(request);
      if (request.skill.name === "workflow-main") {
        const childResults = await Promise.all([
          request.invokeChild({
            skill: "inspect-constraint",
            input: { question: "constraint" },
            accessMode: "BOUNDED",
            resourceGrants: [{ path: "constraint.txt", kind: "file", operations: ["read"] }],
          }),
          request.invokeChild({
            skill: "inspect-observation",
            input: { question: "observation" },
            accessMode: "BOUNDED",
            resourceGrants: [{ path: "observation.txt", kind: "file", operations: ["read"] }],
          }),
        ]);
        assert.equal(childResults.every((result) => result.status === "SUCCESS"), true);
        return completed({
          decision: "ALLOW",
          constraint: childResults[0].data.value,
          observation: childResults[1].data.value,
        }, 5, childResults.map((child, index) => ({
          id: `child-${index + 1}`,
          resource: `scope://${child.scopeId}`,
        })), childResults);
      }
      assert.equal(request.invokeChild, undefined, "depth-1 child must not receive a grandchild tool");
      const value = request.skill.name === "inspect-constraint" ? "enabled" : "healthy";
      const path = request.skill.name === "inspect-constraint" ? "constraint.txt" : "observation.txt";
      return {
        ...completed({ value }, request.skill.name === "inspect-constraint" ? 2 : 3, [{ id: "source", resource: path }]),
        completionResourceAudit: { modelVisibleSet: [path] },
      };
    },
  };
  const runtime = new SkillScopeRuntime({
    registry: new SkillRegistry(root.skills),
    backend,
    traceStore: new TraceStore(root.traces),
    maxScopeDepth: 1,
  });

  const result = await runtime.invoke({
    skill: "workflow-main",
    input: { question: "may deploy" },
    accessMode: "BOUNDED",
    resourceGrants: [
      { path: "constraint.txt", kind: "file", operations: ["read"] },
      { path: "observation.txt", kind: "file", operations: ["read"] },
    ],
  }, { cwd: root.project, parentSessionId: "parent-session" });

  assert.equal(result.schemaVersion, "1.1");
  assert.equal(result.status, "SUCCESS");
  assert.deepEqual(result.data, { decision: "ALLOW", constraint: "enabled", observation: "healthy" });
  assert.equal(result.depth, 0);
  assert.equal(result.rootScopeId, result.scopeId);
  assert.equal(result.childScopes.length, 2);
  assert.equal(new Set(result.childScopes.map((child) => child.scopeId)).size, 2);
  assert.equal(result.childScopes.every((child) => child.parentScopeId === result.scopeId), true);
  assert.equal(result.childScopes.every((child) => child.rootScopeId === result.scopeId && child.depth === 1), true);
  assert.deepEqual(result.childScopes.map((child) => child.skill.name).sort(), ["inspect-constraint", "inspect-observation"]);
  assert.equal(result.treeUsage.scopes, 3);
  assert.equal(result.treeUsage.totalTokens, 10);
  assert.equal(requests.length, 3);
  assert.deepEqual(runtime.getLifecycleSnapshot(), { activeScopeIds: [], startedScopes: 3, disposedScopes: 3 });
  const persisted = JSON.parse(await readFile(join(root.traces, result.scopeId, "result.json"), "utf8"));
  assert.equal(persisted.childScopeCount, 2);
  assert.equal(persisted.treeUsage.scopes, 3);
  assert.equal(JSON.stringify(persisted).includes("enabled"), false, "metadata-only trace must not retain child business data");
});

test("nested delegation fails closed on disallowed skills, grant expansion, and concurrency", async (t) => {
  const root = await nestedFixture(t, { maxConcurrency: 1 });
  let barrierResolve;
  const barrier = new Promise((resolve) => { barrierResolve = resolve; });
  const backend = {
    async run(request) {
      if (request.skill.name !== "workflow-main") {
        await barrier;
        return {
          ...completed({ value: "enabled" }, 1, [{ id: "source", resource: "constraint.txt" }]),
          completionResourceAudit: { modelVisibleSet: ["constraint.txt"] },
        };
      }
      await assert.rejects(
        request.invokeChild({ skill: "unknown-skill", input: {}, accessMode: "SEALED" }),
        (error) => error.code === "CHILD_SKILL_NOT_ALLOWED",
      );
      await assert.rejects(
        request.invokeChild({
          skill: "inspect-constraint",
          input: { question: "q" },
          accessMode: "BOUNDED",
          resourceGrants: [{ path: "outside.txt", kind: "file", operations: ["read"] }],
        }),
        (error) => error.code === "CHILD_GRANT_EXPANSION",
      );
      const first = request.invokeChild({
        skill: "inspect-constraint",
        input: { question: "q" },
        accessMode: "BOUNDED",
        resourceGrants: [{ path: "constraint.txt", kind: "file", operations: ["read"] }],
      });
      await assert.rejects(
        request.invokeChild({
          skill: "inspect-observation",
          input: { question: "q" },
          accessMode: "BOUNDED",
          resourceGrants: [{ path: "observation.txt", kind: "file", operations: ["read"] }],
        }),
        (error) => error.code === "CHILD_CONCURRENCY_LIMIT",
      );
      barrierResolve();
      const child = await first;
      return completed({ decision: "ALLOW", constraint: child.data.value, observation: "healthy" }, 1, [{ id: "child", resource: `scope://${child.scopeId}` }], [child]);
    },
  };
  const runtime = new SkillScopeRuntime({
    registry: new SkillRegistry(root.skills),
    backend,
    traceStore: new TraceStore(root.traces),
    maxScopeDepth: 1,
  });
  const result = await runtime.invoke({
    skill: "workflow-main",
    input: { question: "q" },
    accessMode: "BOUNDED",
    resourceGrants: [
      { path: "constraint.txt", kind: "file", operations: ["read"] },
      { path: "observation.txt", kind: "file", operations: ["read"] },
    ],
  }, { cwd: root.project, parentSessionId: "p" });
  assert.equal(result.status, "SUCCESS");
  assert.deepEqual(runtime.getLifecycleSnapshot(), { activeScopeIds: [], startedScopes: 2, disposedScopes: 2 });
});

test("parent cancellation propagates through the child Scope and both Scopes dispose", async (t) => {
  const root = await nestedFixture(t);
  const controller = new AbortController();
  let childStartedResolve;
  const childStarted = new Promise((resolve) => { childStartedResolve = resolve; });
  const backend = {
    async run(request) {
      if (request.skill.name === "workflow-main") {
        await request.invokeChild({
          skill: "inspect-constraint",
          input: { question: "q" },
          accessMode: "BOUNDED",
          resourceGrants: [{ path: "constraint.txt", kind: "file", operations: ["read"] }],
        });
        return { ...completed({}, 0), terminationReason: request.signal.aborted ? "cancelled" : "completed" };
      }
      childStartedResolve();
      await new Promise((resolve) => request.signal.addEventListener("abort", resolve, { once: true }));
      return { usage: completed({}, 0).usage, terminationReason: "cancelled", error: new Error("cancelled") };
    },
  };
  const runtime = new SkillScopeRuntime({
    registry: new SkillRegistry(root.skills),
    backend,
    traceStore: new TraceStore(root.traces),
    maxScopeDepth: 1,
  });
  const pending = runtime.invoke({
    skill: "workflow-main",
    input: { question: "q" },
    accessMode: "BOUNDED",
    resourceGrants: [{ path: "constraint.txt", kind: "file", operations: ["read"] }],
  }, { cwd: root.project, parentSessionId: "p", signal: controller.signal });
  await childStarted;
  controller.abort(new Error("parent cancelled"));
  const result = await pending;
  assert.equal(result.status, "CANCELLED");
  assert.deepEqual(runtime.getLifecycleSnapshot(), { activeScopeIds: [], startedScopes: 2, disposedScopes: 2 });
});

function completed(data, totalTokens, evidenceRefs = [], childResults = undefined) {
  return {
    completion: { status: "SUCCESS", summary: "done", data, evidenceRefs },
    usage: {
      turns: 1,
      toolCalls: 0,
      inputTokens: Math.max(0, totalTokens - 1),
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens,
      cost: 0,
    },
    childResults,
    terminationReason: "completed",
  };
}

async function nestedFixture(t, options = {}) {
  const base = await mkdtemp(join(tmpdir(), "skillscope-nested-runtime-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, "project");
  const skills = join(base, "skills");
  const traces = join(base, "traces");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "constraint.txt"), "enabled\n");
  await writeFile(join(project, "observation.txt"), "healthy\n");

  await writeSkill(skills, "workflow-main", {
    outputSchema: {
      type: "object",
      properties: {
        decision: { type: "string" },
        constraint: { type: "string" },
        observation: { type: "string" },
      },
      required: ["decision", "constraint", "observation"],
      additionalProperties: false,
    },
    delegationPolicy: {
      allowedSkills: ["inspect-constraint", "inspect-observation"],
      maxChildScopes: 4,
      maxConcurrency: options.maxConcurrency ?? 2,
    },
  });
  for (const name of ["inspect-constraint", "inspect-observation"]) {
    await writeSkill(skills, name, {
      outputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    });
  }
  return { base, project, skills, traces };
}

async function writeSkill(skills, name, overrides = {}) {
  const directory = join(skills, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `${name} instructions`);
  await writeFile(join(directory, "scope.json"), JSON.stringify({
    name,
    version: "1.0.0",
    description: name,
    promptFile: "SKILL.md",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
      additionalProperties: false,
    },
    outputSchema: overrides.outputSchema,
    allowedTools: ["scope_read", "scope_search"],
    resourcePolicy: {
      defaultAccessMode: "BOUNDED",
      allowedAccessModes: ["SEALED", "BOUNDED"],
      allowedOperations: ["read", "search"],
    },
    delegationPolicy: overrides.delegationPolicy ?? {
      allowedSkills: [],
      maxChildScopes: 0,
      maxConcurrency: 1,
    },
    budget: { maxTurns: 6, maxToolCalls: 8, timeoutMs: 2_000, maxPromptBytes: 20_000, maxResultBytes: 20_000 },
  }));
}
