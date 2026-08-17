import assert from "node:assert/strict";
import test from "node:test";
import "./register-typescript.js";

const { createCompletionTool } = await import("../../src/pi/completion-tool.ts");

const budget = {
  maxTurns: 4,
  maxToolCalls: 4,
  timeoutMs: 1_000,
  maxPromptBytes: 10_000,
  maxResultBytes: 10_000,
};
const outputSchema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};

test("scope_complete is first-valid-wins and duplicate completion fails closed", async () => {
  const completion = createCompletionTool(outputSchema, budget);
  const first = {
    status: "SUCCESS",
    summary: "first",
    data: { answer: "alpha" },
    evidenceRefs: [],
  };
  const second = {
    status: "SUCCESS",
    summary: "second",
    data: { answer: "beta" },
    evidenceRefs: [],
  };

  const accepted = await completion.tool.execute("call-1", first);
  const rejected = await completion.tool.execute("call-2", second);

  assert.equal(accepted.details.accepted, true);
  assert.equal(rejected.details.accepted, false);
  assert.equal(rejected.details.code, "DUPLICATE_COMPLETION");
  assert.equal(rejected.terminate, true);
  assert.deepEqual(completion.getCompletion(), first, "the later call must never overwrite the first payload");
  assert.equal(completion.getProtocolIssue().code, "DUPLICATE_COMPLETION");
});

test("a nonfatal batch-policy rejection may be repaired on the next turn", async () => {
  const decisions = new Map([
    ["mixed", { accept: false, code: "COMPLETION_HAS_SIBLING_TOOL", message: "wait for tool results" }],
  ]);
  const completion = createCompletionTool(outputSchema, budget, undefined, {
    beforeAccept(toolCallId) {
      return decisions.get(toolCallId) ?? { accept: true };
    },
  });
  const payload = {
    status: "SUCCESS",
    summary: "done",
    data: { answer: "alpha" },
    evidenceRefs: [],
  };

  const mixed = await completion.tool.execute("mixed", payload);
  assert.equal(mixed.details.accepted, false);
  assert.equal(mixed.terminate, undefined);
  assert.equal(completion.getCompletion(), undefined);
  assert.equal(completion.getProtocolIssue(), undefined);

  const later = await completion.tool.execute("next-turn", payload);
  assert.equal(later.details.accepted, true);
  assert.deepEqual(completion.getCompletion(), payload);
});
