import assert from "node:assert/strict";
import { test } from "node:test";

import {
  validateResourceRequest,
  validateSubmission,
} from "../../experiments/access-frontier/src/protocol.mjs";

const RESPONSE_CONTRACT = {
  answerCode: { type: "string", enum: ["BAD", "INSUFFICIENT_EVIDENCE", "OK"] },
  facts: {
    type: "object",
    additionalProperties: false,
    required: ["outcome"],
    properties: { outcome: { type: "string", enum: ["bad", "ok"] } },
  },
  abstention: { answerCode: "INSUFFICIENT_EVIDENCE", factsMode: "all-null" },
};

function validSubmission() {
  return {
    answerCode: "OK",
    summary: "valid",
    facts: { outcome: "ok" },
    evidence: [{ path: "evidence.txt", startLine: 1, endLine: 1 }],
    confidence: 1,
  };
}

test("completion validator rejects fields and evidence shapes outside the advertised schema", () => {
  assert.equal(validateSubmission(validSubmission(), RESPONSE_CONTRACT).valid, true);
  assert.equal(validateSubmission({ ...validSubmission(), hidden: "extra" }, RESPONSE_CONTRACT).valid, false);
  assert.equal(validateSubmission({ ...validSubmission(), evidence: ["evidence.txt"] }, RESPONSE_CONTRACT).valid, false);
  assert.equal(validateSubmission({
    ...validSubmission(),
    evidence: [{ path: "evidence.txt", startLine: 1, endLine: 1, extra: true }],
  }, RESPONSE_CONTRACT).valid, false);
  assert.equal(validateSubmission({
    ...validSubmission(),
    evidence: [{ path: "../evidence.txt", startLine: 1, endLine: 1 }],
  }, RESPONSE_CONTRACT).valid, false);
  assert.equal(validateSubmission({
    ...validSubmission(),
    answerCode: "FREE_FORM_GUESS",
  }, RESPONSE_CONTRACT).valid, false);
  assert.equal(validateSubmission({
    ...validSubmission(),
    facts: { outcome: "forged" },
  }, RESPONSE_CONTRACT).valid, false);
  assert.equal(validateSubmission({
    ...validSubmission(),
    answerCode: "INSUFFICIENT_EVIDENCE",
    facts: { outcome: null },
  }, RESPONSE_CONTRACT).valid, true);
  assert.equal(validateSubmission({
    ...validSubmission(),
    answerCode: "INSUFFICIENT_EVIDENCE",
    facts: { outcome: "ok" },
  }, RESPONSE_CONTRACT).valid, false);
});

test("resource request validator rejects unknown operations, duplicates, extra keys, and traversal", () => {
  const valid = { path: "logs/", kind: "directory", operations: ["read", "search"], reason: "Need logs." };
  assert.equal(validateResourceRequest(valid).valid, true);
  assert.equal(validateResourceRequest({ ...valid, operations: ["read", "execute"] }).valid, false);
  assert.equal(validateResourceRequest({ ...valid, operations: ["read", "read"] }).valid, false);
  assert.equal(validateResourceRequest({ ...valid, surprise: true }).valid, false);
  assert.equal(validateResourceRequest({ ...valid, path: "../logs" }).valid, false);
});
