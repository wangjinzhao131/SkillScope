import assert from "node:assert/strict";
import { test } from "node:test";

import { planInitialGrants } from "../../experiments/access-frontier/src/grant-planner.mjs";
import { DEFAULT_MODEL } from "../../experiments/access-frontier/src/model-client.mjs";
import { buildMessages, buildTools } from "../../experiments/access-frontier/src/prompt.mjs";

const HIDDEN_SENTINEL = "AUDIT_HIDDEN_TRUTH_MUST_NOT_REACH_MODEL";

function auditTask() {
  return {
    fixtureSchemaVersion: "2.0",
    id: "af-audit",
    goal: "Find the active region from the supplied evidence.",
    virtualProject: {
      files: [
        {
          path: "tickets/question.txt",
          content: "question=which region is active?\n",
          sensitivity: "public",
        },
        {
          path: "config/active.txt",
          content: `active_region=${HIDDEN_SENTINEL}\n`,
          sensitivity: "public",
        },
      ],
    },
    promptRefs: [{
      name: "question",
      sourcePath: "tickets/question.txt",
      sourceStartLine: 1,
      sourceEndLine: 1,
      content: "question=which region is active?\n",
    }],
    inferredCatalog: [
      { path: "config/active.txt", kind: "file", operations: ["read"] },
      { path: "noise/", kind: "directory", operations: ["read", "list", "search"] },
    ],
    responseContract: {
      answerCode: {
        type: "string",
        enum: ["INSUFFICIENT_EVIDENCE", "REGION_EAST", "REGION_WEST"],
      },
      facts: {
        type: "object",
        additionalProperties: false,
        required: ["region"],
        properties: { region: { type: "string", pattern: "^[A-Z_]+$" } },
      },
      abstention: { answerCode: "INSUFFICIENT_EVIDENCE", factsMode: "all-null" },
    },
    expectedAnswer: { code: "REGION_EAST", facts: { region: HIDDEN_SENTINEL } },
    requiredEvidence: ["config/active.txt"],
    evidenceAssertions: [{
      id: "E1",
      path: "config/active.txt",
      startLine: 1,
      endLine: 1,
      contains: HIDDEN_SENTINEL,
      claim: "The active-region record contains the hidden expected value.",
    }],
    canary: {},
  };
}

function serializedMessages(messages) {
  return JSON.stringify(messages);
}

function catalogSection(messages) {
  const content = messages.find((message) => message.role === "user")?.content ?? "";
  const marker = "# Declared resource catalog (metadata only; no file contents)\n";
  const start = content.indexOf(marker);
  assert.notEqual(start, -1, "catalog section must be visible in both inferred conditions");
  return content.slice(start + marker.length);
}

test("worker prompt excludes hidden expected answer and validator truth", () => {
  const task = auditTask();
  const { messages } = buildMessages({
    task,
    condition: "BOUNDED_INFERRED",
    grants: [task.inferredCatalog[0]],
    catalog: task.inferredCatalog,
    allowResourceRequest: false,
  });

  assert.equal(serializedMessages(messages).includes(HIDDEN_SENTINEL), false);
  assert.match(serializedMessages(messages), /which region is active/);
  assert.match(serializedMessages(messages), /Public response contract/);
  const submit = buildTools({
    task,
    condition: "BOUNDED_INFERRED",
    allowResourceRequest: false,
  }).find((tool) => tool.function.name === "submit_result");
  assert.deepEqual(
    submit.function.parameters.properties.answerCode.enum,
    task.responseContract.answerCode.enum,
  );
  assert.equal(JSON.stringify(submit).includes(HIDDEN_SENTINEL), false);
});

test("planner prompt excludes hidden expected answer and preserves the supplied paired seed", async () => {
  const task = auditTask();
  const calls = [];
  const client = {
    async complete(request) {
      calls.push(request);
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "audit-call",
            type: "function",
            function: {
              name: "select_grants",
              arguments: JSON.stringify({ catalogIndexes: [0], reason: "goal-aligned path" }),
            },
          }],
        },
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        requestId: "audit-request",
      };
    },
  };

  const result = await planInitialGrants({ task, client, seed: 731 });
  assert.deepEqual(result.selectedIndexes, [0]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].seed, 731);
  assert.equal(serializedMessages(calls[0].messages).includes(HIDDEN_SENTINEL), false);
});

test("BOUNDED_INFERRED and BOUNDED_NEED_RESOURCE expose identical catalog metadata", () => {
  const task = auditTask();
  const grants = [task.inferredCatalog[0]];
  const inferred = buildMessages({
    task,
    condition: "BOUNDED_INFERRED",
    grants,
    catalog: task.inferredCatalog,
    allowResourceRequest: false,
  });
  const need = buildMessages({
    task,
    condition: "BOUNDED_NEED_RESOURCE",
    grants,
    catalog: task.inferredCatalog,
    allowResourceRequest: true,
  });

  assert.equal(catalogSection(inferred.messages), catalogSection(need.messages));
  assert.equal(inferred.materialization.catalogBytes, need.materialization.catalogBytes);
});

test("the frozen real-experiment model default is deepseek-v4-flash", () => {
  assert.equal(DEFAULT_MODEL, "deepseek-v4-flash");
});
