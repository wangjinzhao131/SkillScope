import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import "./register-typescript.js";

const { createSkillScopeExtension } = await import("../../src/pi/index.ts");

test("extension registers scoped_skill_run and returns Runtime-owned SkillResult", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "skillscope-extension-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, "project");
  await mkdir(project);
  let registered;
  const handlers = new Map();
  const pi = {
    registerTool(tool) { registered = tool; },
    on(event, handler) { handlers.set(event, handler); },
  };
  const backend = {
    async run() {
      return {
        completion: { status: "SUCCESS", summary: "done", data: { answer: "a", confidence: "high", findings: [], gaps: [] }, evidenceRefs: [] },
        usage: { turns: 1, toolCalls: 0, inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 3, cost: 0 },
        terminationReason: "completed",
      };
    },
  };
  createSkillScopeExtension({
    skillsRoot: resolve("skills"),
    traceRoot: join(base, "traces"),
    backend,
  })(pi);
  assert.equal(registered.name, "scoped_skill_run");
  assert.equal(typeof handlers.get("session_shutdown"), "function");
  const response = await registered.execute("call", {
    skill: "analyze-evidence",
    input: { question: "q" },
    promptRefs: [{ kind: "inline", name: "fact", content: "a" }],
    accessMode: "SEALED",
  }, undefined, undefined, {
    cwd: project,
    signal: undefined,
    model: { provider: "ignored", id: "ignored" },
    modelRegistry: {},
    thinkingLevel: "off",
    sessionManager: { getSessionId: () => "parent-session" },
  });
  assert.equal(response.details.status, "SUCCESS");
  assert.equal(response.details.parentSessionId, "parent-session");
  assert.notEqual(response.details.scopeId, undefined);
});

test("scoped_skill_run schema separates promptRefs and resourceGrants", () => {
  let registered;
  createSkillScopeExtension({ backend: { async run() { throw new Error("unused"); } } })({
    registerTool(tool) { registered = tool; },
    on() {},
  });
  assert.ok(registered.parameters.properties.promptRefs);
  assert.ok(registered.parameters.properties.resourceGrants);
  assert.equal(registered.parameters.properties.contextRefs, undefined);
});
