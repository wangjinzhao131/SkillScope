import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import "./register-typescript.js";

const { TraceStore } = await import("../../src/pi/trace-store.ts");

test("TraceStore rejects unsafe scope ids", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "skillscope-trace-id-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, "project");
  await mkdir(project);
  await assert.rejects(() => new TraceStore(join(base, "traces")).begin("../escape", project, {}), /scopeId/);
});

test("TraceStore detects outside symlink into project before creating directories", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "skillscope-trace-link-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, "project");
  await mkdir(project);
  const alias = join(base, "outside-looking-link");
  await symlink(project, alias);
  const target = join(alias, "new-traces");
  await assert.rejects(() => new TraceStore(target).begin("safe-id", project, {}), /outside/);
  await assert.rejects(() => access(join(project, "new-traces")), { code: "ENOENT" });
});

test("TraceStore persists a deterministic metadata-only projection", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "skillscope-trace-metadata-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, "project");
  const traceRoot = join(base, "traces");
  await mkdir(project);

  const promptContent = "PROMPT-CONTENT-b6de9697-61dd-41bd-8668-b06950632db2";
  const businessSummary = "BUSINESS-SUMMARY-406209b4-a337-463f-becc-097f7e21554b";
  const businessData = "BUSINESS-DATA-c26dd105-ab47-4386-b5f0-99ff0a281d9f";
  const evidenceClaim = "EVIDENCE-CLAIM-75e9814f-e9fc-4df5-ae8c-45ee02bd106d";
  const upstreamError = "UPSTREAM-ERROR-d7cbd1e9-bb14-4558-99a5-d76413d8c384";
  const fixedTime = new Date("2026-08-18T01:02:03.004Z");
  const store = new TraceStore(traceRoot, { now: () => fixedTime });
  const trace = await store.begin("scope-metadata", project, {
    input: { privateQuestion: promptContent },
    startedAt: fixedTime.toISOString(),
    requestedAccessMode: "BOUNDED",
    requestedSkill: "analyze-evidence",
    parentSessionId: "parent-fixed",
    invocationId: "invocation-fixed",
    scopeId: "scope-metadata",
    schemaVersion: "1.0",
    promptRefs: [{ content: promptContent, name: "fact", kind: "inline" }],
    resourceGrants: [{ operations: ["search", "read"], kind: "directory", path: "allowed" }],
    rawUpstreamError: upstreamError,
  });

  trace.event(`provider_error:${upstreamError}`, { prompt: promptContent, message: upstreamError });
  trace.event("tool_end", {
    error: upstreamError,
    isError: true,
    toolCallId: "provider-call-id-sensitive",
    tool: "scope_read",
  });
  trace.event("completion_batch_rejected", {
    code: "DUPLICATE_COMPLETION",
    completionCalls: 2,
    siblingCalls: 0,
    fatal: true,
  });
  trace.event("completion_rejected", {
    code: "EVIDENCE_NOT_VISIBLE",
    bytes: 42,
  });
  trace.event("completion_batch_rejected", {
    code: "COMPLETION_HAS_SIBLING_TOOL",
    completionCalls: 1,
    siblingCalls: 1,
    fatal: false,
  });
  trace.event("completion_rejected", { code: "EVIDENCE_ID_NOT_FOUND", bytes: 43 });
  trace.event("completion_rejected", { code: "REQUESTED_RESOURCE_INVALID", bytes: 44 });
  await trace.finish({
    schemaVersion: "1.0",
    scopeId: "scope-metadata",
    invocationId: "invocation-fixed",
    parentSessionId: "parent-fixed",
    skill: { name: "analyze-evidence", version: "1.0.0" },
    status: "FAILED",
    summary: businessSummary,
    data: { z: businessData, a: 1 },
    evidenceRefs: [{ id: "e1", resource: "allowed/fact.txt", claim: evidenceClaim }],
    requestedResources: [{ path: "more.txt", operations: ["read"], reason: businessSummary }],
    warnings: [businessData],
    error: { code: "FAILED", message: upstreamError, retryable: true },
    usage: { turns: 1, toolCalls: 1, totalTokens: 7, wallTimeMs: 12 },
    traceId: "scope-metadata",
    startedAt: fixedTime.toISOString(),
    endedAt: fixedTime.toISOString(),
    resourceAudit: {
      mode: "BOUNDED",
      declaredSet: [{ path: "allowed", kind: "directory", operations: ["read", "search"] }],
      grantedSet: [{ path: "allowed", kind: "directory", operations: ["read"] }],
      attemptedSet: ["allowed/fact.txt"],
      actualReadSet: ["allowed/fact.txt"],
      modelVisibleSet: ["allowed/fact.txt"],
      physicalMaterializedSet: ["allowed/fact.txt", "allowed/other.txt"],
      attemptedOperations: [{ operation: "read", path: "allowed/fact.txt", rawPath: promptContent, allowed: true }],
      denials: [{ code: "UNAUTHORIZED", operation: "read", rawPath: promptContent, message: upstreamError }],
      events: [{ message: upstreamError }],
      counts: { attempts: 1, denials: 1 },
    },
  });

  const manifestText = await readFile(join(trace.directory, "manifest.json"), "utf8");
  const eventsText = await readFile(join(trace.directory, "events.jsonl"), "utf8");
  const resultText = await readFile(join(trace.directory, "result.json"), "utf8");
  const persistedText = `${manifestText}\n${eventsText}\n${resultText}`;
  for (const rawValue of [promptContent, businessSummary, businessData, evidenceClaim, upstreamError, "provider-call-id-sensitive", "allowed/fact.txt"]) {
    assert.equal(persistedText.includes(rawValue), false, `Trace must not contain ${rawValue}`);
  }

  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.traceFormat, "metadata-only-v1");
  assert.equal(manifest.scopeId, "scope-metadata");
  assert.equal(manifest.inputHash, sha256('{"privateQuestion":"PROMPT-CONTENT-b6de9697-61dd-41bd-8668-b06950632db2"}'));
  assert.equal(manifest.promptRefs[0].contentHash, sha256(promptContent));
  assert.equal(manifest.promptRefs[0].content, undefined);
  assert.deepEqual(manifest.resourceGrants, [{
    pathHash: sha256("allowed"),
    pathBytes: Buffer.byteLength("allowed"),
    kind: "directory",
    operations: ["search", "read"],
  }]);

  const events = eventsText.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events[0].at, fixedTime.toISOString());
  assert.equal(events[0].type, "unclassified_event");
  assert.equal(events[0].typeHash, sha256(JSON.stringify(`provider_error:${upstreamError}`)));
  assert.equal(events[0].data.message, undefined);
  assert.equal(events[1].type, "tool_end");
  assert.deepEqual(
    { tool: events[1].data.tool, isError: events[1].data.isError },
    { tool: "scope_read", isError: true },
  );
  assert.equal(events[1].data.toolCallId, undefined);
  assert.equal(events[1].data.toolCallIdHash, sha256("provider-call-id-sensitive"));
  assert.deepEqual(events[2].data, {
    dataHash: events[2].data.dataHash,
    dataBytes: events[2].data.dataBytes,
    code: "DUPLICATE_COMPLETION",
    completionCalls: 2,
    siblingCalls: 0,
    fatal: true,
  });
  assert.equal(events[2].type, "completion_batch_rejected");
  assert.equal(events[3].type, "completion_rejected");
  assert.equal(events[3].data.code, "EVIDENCE_NOT_VISIBLE");
  assert.deepEqual(
    events.slice(2).map((event) => event.data.code),
    [
      "DUPLICATE_COMPLETION",
      "EVIDENCE_NOT_VISIBLE",
      "COMPLETION_HAS_SIBLING_TOOL",
      "EVIDENCE_ID_NOT_FOUND",
      "REQUESTED_RESOURCE_INVALID",
    ],
  );

  const result = JSON.parse(resultText);
  assert.equal(result.traceFormat, "metadata-only-v1");
  assert.equal(result.status, "FAILED");
  assert.equal(result.summary, undefined);
  assert.equal(result.data, undefined);
  assert.equal(result.summaryHash, sha256(businessSummary));
  assert.equal(result.dataHash, sha256(`{"a":1,"z":"${businessData}"}`));
  assert.deepEqual(result.error, {
    classification: "upstream_failure",
    code: "FAILED",
    retryable: true,
    messageHash: sha256(upstreamError),
    messageBytes: Buffer.byteLength(upstreamError),
  });
  assert.deepEqual(result.resourceAudit, {
    mode: "BOUNDED",
    declaredSet: [{ pathHash: sha256("allowed"), pathBytes: 7, kind: "directory", operations: ["read", "search"] }],
    grantedSet: [{ pathHash: sha256("allowed"), pathBytes: 7, kind: "directory", operations: ["read"] }],
    attemptedSet: [{ sha256: sha256("allowed/fact.txt"), bytes: 16 }],
    attemptedSetCount: 1,
    actualReadSet: [{ sha256: sha256("allowed/fact.txt"), bytes: 16 }],
    actualReadSetCount: 1,
    modelVisibleSet: [{ sha256: sha256("allowed/fact.txt"), bytes: 16 }],
    modelVisibleSetCount: 1,
    physicalMaterializedSet: [
      { sha256: sha256("allowed/fact.txt"), bytes: 16 },
      { sha256: sha256("allowed/other.txt"), bytes: 17 },
    ],
    physicalMaterializedSetCount: 2,
    attemptedOperations: [{ pathHash: sha256("allowed/fact.txt"), pathBytes: 16, operation: "read", allowed: true }],
    denials: [{ code: "UNAUTHORIZED", operation: "read" }],
    counts: { attempts: 1, denials: 1 },
  });
});

function sha256(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
