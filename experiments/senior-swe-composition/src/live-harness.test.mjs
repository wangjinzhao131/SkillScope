import assert from "node:assert/strict";
import test from "node:test";

import { buildStagePrompt } from "./live-harness.mjs";

test("stage prompt does not forbid its required Runtime completion tool", () => {
  const prompt = buildStagePrompt({
    stageName: "investigate",
    instruction: "Find the real defect.",
    priorResults: [],
  });

  assert.match(prompt, /only other allowed tool is investigate_complete/u);
  assert.match(prompt, /final action must call investigate_complete exactly once/u);
  assert.doesNotMatch(prompt, /Use only container_exec and container_apply_patch/u);
});
