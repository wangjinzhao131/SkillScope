import assert from "node:assert/strict";
import test from "node:test";

import {
  promptRefCoversAssertion,
  validatePromptRefProvenance,
} from "./prompt-provenance.mjs";

const source = "line one\nline two\nROOT_CAUSE=A\nlimit=20\n";
const ref = {
  name: "excerpt",
  sourcePath: "logs/app.log",
  sourceStartLine: 3,
  sourceEndLine: 4,
  content: "ROOT_CAUSE=A\nlimit=20\n",
};

test("accepts an exact non-leading source span", () => {
  assert.deepEqual(validatePromptRefProvenance(ref, source), []);
  assert.equal(promptRefCoversAssertion(ref, {
    path: "logs/app.log",
    startLine: 3,
    endLine: 3,
    contains: "ROOT_CAUSE=A",
  }), true);
});

test("rejects the historical false L1-L2 provenance", () => {
  const wrong = { ...ref, sourceStartLine: 1, sourceEndLine: 2 };
  assert.match(validatePromptRefProvenance(wrong, source).join("\n"), /exactly equal/);
  assert.equal(promptRefCoversAssertion(wrong, {
    path: "logs/app.log",
    startLine: 3,
    endLine: 3,
    contains: "ROOT_CAUSE=A",
  }), false);
});

test("requires both source bounds and rejects inverted or out-of-range spans", () => {
  assert.match(validatePromptRefProvenance({ ...ref, sourceEndLine: undefined }, source).join("\n"), /sourceEndLine/);
  assert.match(validatePromptRefProvenance({ ...ref, sourceStartLine: 4, sourceEndLine: 3 }, source).join("\n"), /cannot exceed/);
  assert.match(validatePromptRefProvenance({ ...ref, sourceEndLine: 9 }, source).join("\n"), /exceeds source length/);
});
