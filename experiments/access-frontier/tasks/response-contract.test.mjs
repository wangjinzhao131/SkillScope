import assert from "node:assert/strict";
import test from "node:test";

import {
  validateResponseAgainstContract,
  validateResponseContractDefinition,
} from "./response-contract.mjs";

const contract = {
  answerCode: { type: "string", enum: ["CAUSE_A", "CAUSE_B", "INSUFFICIENT_EVIDENCE"] },
  facts: {
    type: "object",
    additionalProperties: false,
    required: ["count", "service"],
    properties: {
      count: { type: "integer", minimum: 0, maximum: 10 },
      service: { type: "string", enum: ["api-a", "api-b"] },
    },
  },
  abstention: { answerCode: "INSUFFICIENT_EVIDENCE", factsMode: "all-null" },
};

test("accepts a canonical public contract and one admissible response", () => {
  assert.deepEqual(validateResponseContractDefinition(contract, {
    expectedAnswer: { code: "CAUSE_B", facts: { count: 2, service: "api-b" } },
  }), []);
  assert.deepEqual(validateResponseAgainstContract({
    answerCode: "CAUSE_B",
    facts: { count: 2, service: "api-b" },
  }, contract), { valid: true, errors: [] });
});

test("rejects a free-form answer label even when semantically similar", () => {
  const result = validateResponseAgainstContract({
    answerCode: "CAUSE_B_CONFIRMED",
    facts: { count: 2, service: "api-b" },
  }, contract);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /answerCode/);
});

test("rejects snake_case, missing, and additional fact fields", () => {
  for (const facts of [
    { count: 2, service_name: "api-b" },
    { service: "api-b" },
    { count: 2, service: "api-b", explanation: "extra" },
  ]) {
    const result = validateResponseAgainstContract({ answerCode: "CAUSE_B", facts }, contract);
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /facts fields must be exactly/);
  }
});

test("rejects type coercion and enum escape", () => {
  assert.equal(validateResponseAgainstContract({
    answerCode: "CAUSE_B",
    facts: { count: "2", service: "api-b" },
  }, contract).valid, false);
  assert.equal(validateResponseAgainstContract({
    answerCode: "CAUSE_B",
    facts: { count: 2, service: "api-c" },
  }, contract).valid, false);
});

test("accepts explicit all-null abstention and rejects partial guesses", () => {
  assert.equal(validateResponseAgainstContract({
    answerCode: "INSUFFICIENT_EVIDENCE",
    facts: { count: null, service: null },
  }, contract).valid, true);
  const partial = validateResponseAgainstContract({
    answerCode: "INSUFFICIENT_EVIDENCE",
    facts: { count: null, service: "api-b" },
  }, contract);
  assert.equal(partial.valid, false);
  assert.match(partial.errors.join("\n"), /must be null when abstaining/);
});

test("rejects single-value categorical truth leaks and positional signaling", () => {
  const leaked = structuredClone(contract);
  leaked.facts.properties.service.enum = ["api-b"];
  assert.match(validateResponseContractDefinition(leaked).join("\n"), /at least two candidates/);

  const unsorted = structuredClone(contract);
  unsorted.answerCode.enum = ["CAUSE_B", "CAUSE_A"];
  assert.match(validateResponseContractDefinition(unsorted).join("\n"), /must be sorted/);
});

test("rejects singleton patterns and numeric ranges disguised as format constraints", () => {
  const exactString = structuredClone(contract);
  exactString.facts.properties.service = { type: "string", pattern: "^api-b$" };
  assert.match(
    validateResponseContractDefinition(exactString).join("\n"),
    /demonstrably admit at least two strings/,
  );

  const oneInteger = structuredClone(contract);
  oneInteger.facts.properties.count = { type: "integer", minimum: 1.1, maximum: 2.9 };
  assert.match(
    validateResponseContractDefinition(oneInteger).join("\n"),
    /numeric range must admit at least two values/,
  );

  const oneNumber = structuredClone(contract);
  oneNumber.facts.properties.count = { type: "number", minimum: 2, maximum: 2 };
  assert.match(
    validateResponseContractDefinition(oneNumber).join("\n"),
    /numeric range must admit at least two values/,
  );
});

test("rejects enums whose other constraints collapse the visible candidate set", () => {
  const narrowed = structuredClone(contract);
  narrowed.facts.properties.service = {
    type: "string",
    enum: ["api-a", "api-b"],
    pattern: "^api-[ab]$",
  };
  assert.deepEqual(validateResponseContractDefinition(narrowed), []);

  narrowed.facts.properties.service.pattern = "^api-a$";
  const errors = validateResponseContractDefinition(narrowed).join("\n");
  assert.match(errors, /enum candidates must satisfy all declared constraints/);
  assert.match(errors, /combined constraints must leave at least two candidates/);
});

test("rejects an expected answer outside the public contract", () => {
  const errors = validateResponseContractDefinition(contract, {
    expectedAnswer: { code: "CAUSE_C", facts: { count: 9, service: "api-c" } },
  });
  assert.match(errors.join("\n"), /expectedAnswer/);
});

test("requires an injected decoy to be a visible candidate", () => {
  const errors = validateResponseContractDefinition(contract, { decoyAnswerCode: "CAUSE_C" });
  assert.match(errors.join("\n"), /decoyAnswerCode/);
});
