import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import "../pi/register-typescript.js";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const piAi = await import(new URL(
  "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js",
  import.meta.url,
));
const { PiInProcessBackend } = await import("../../src/pi/pi-backend.ts");
const { CoreResourceGatewayFactory } = await import("../../src/pi/core-resource-gateway.ts");

test("same-batch read plus completion is rejected until a later model turn", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "skillscope-batch-audit-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, "project");
  await mkdir(project);
  await writeFile(join(project, "fact.txt"), "alpha\n");

  const faux = piAi.fauxProvider({
    provider: "skillscope-audit-faux",
    models: [{
      id: "audit-model",
      name: "Audit Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4_096,
      maxTokens: 1_024,
    }],
  });
  const completionPayload = {
    status: "SUCCESS",
    summary: "alpha is supported",
    data: { answer: "alpha" },
    evidenceRefs: [{ id: "e1", resource: "fact.txt" }],
  };
  faux.setResponses([
    piAi.fauxAssistantMessage([
      piAi.fauxToolCall("scope_read", { path: "fact.txt" }, { id: "read-same-batch" }),
      piAi.fauxToolCall("scope_complete", completionPayload, { id: "complete-too-early" }),
    ], { stopReason: "toolUse" }),
    piAi.fauxAssistantMessage(
      piAi.fauxToolCall("scope_complete", completionPayload, { id: "complete-after-observation" }),
      { stopReason: "toolUse" },
    ),
  ]);

  const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ providers: ["skillscope-audit-faux"], allowNetwork: false });
  const budget = {
    maxTurns: 4,
    maxToolCalls: 4,
    timeoutMs: 5_000,
    maxPromptBytes: 10_000,
    maxResultBytes: 10_000,
  };
  const skill = {
    name: "audit-skill",
    version: "1.0.0",
    description: "audit fixture",
    promptFile: "SKILL.md",
    inputSchema: {},
    outputSchema: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    },
    allowedTools: ["scope_read"],
    resourcePolicy: {
      defaultAccessMode: "BOUNDED",
      allowedAccessModes: ["BOUNDED"],
      allowedOperations: ["read"],
    },
    budget,
    directory: "",
    instructions: "Read evidence, then complete in a later turn.",
  };
  const traceEvents = [];
  const backend = new PiInProcessBackend({
    gatewayFactory: new CoreResourceGatewayFactory(),
    createModelRuntime: async () => modelRuntime,
  });

  const result = await backend.run({
    scopeId: "scope",
    invocationId: "invocation",
    cwd: project,
    skill,
    input: {},
    promptRefs: [],
    resourceGrants: [{ path: "fact.txt", kind: "file", operations: ["read"] }],
    accessMode: "BOUNDED",
    budget,
    hostContext: { model: faux.getModel(), modelRegistry: {}, thinkingLevel: "off" },
    onTrace: (type, data) => traceEvents.push({ type, data }),
  });

  assert.equal(faux.state.callCount, 2);
  assert.equal(result.terminationReason, "completed");
  assert.equal(result.protocolIssue, undefined);
  assert.equal(result.completion?.summary, "alpha is supported");
  assert.deepEqual(result.completionResourceAudit?.modelVisibleSet, ["fact.txt"]);
  assert.ok(traceEvents.some((event) =>
    event.type === "completion_batch_rejected"
    && event.data?.code === "COMPLETION_HAS_SIBLING_TOOL"));
});
