import assert from "node:assert/strict";
import test from "node:test";

import { activeToolsForStage, buildRuntimeCheckpointPrompt, buildStagePrompt } from "./live-harness.mjs";

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

test("Runtime checkpoint exposes only the current typed completion tool", () => {
  assert.deepEqual(activeToolsForStage("investigate"), ["container_exec", "investigate_complete"]);
  assert.deepEqual(activeToolsForStage("implement"), ["container_exec", "container_apply_patch", "implement_complete"]);
  const prompt = buildRuntimeCheckpointPrompt("review");
  assert.match(prompt, /disabled every tool except review_complete/u);
  assert.match(prompt, /evidence already present in this session/u);
  assert.doesNotMatch(prompt, /container_exec|container_apply_patch/u);
  assert.throws(() => buildRuntimeCheckpointPrompt("unknown"), /unknown stage/u);
});
