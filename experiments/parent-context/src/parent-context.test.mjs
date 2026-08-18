import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import "../../../tests/pi/register-typescript.js";

import { analyzeExperiment } from "./analyze.mjs";
import { loadFamilies, materializePackets } from "./corpus.mjs";
import { buildManifest, validateManifest } from "./manifest.mjs";
import { runScriptedSmoke } from "./scripted-smoke.mjs";

const { SkillRegistry } = await import("../../../src/pi/skill-registry.ts");

test("five workflow families materialize paired packets with one child sentinel", async () => {
  const families = await loadFamilies();
  assert.equal(families.length, 5);
  for (const family of families) {
    const sentinel = "CHILD_CONTEXT_SENTINEL_0123456789ABCDEF";
    const packets = materializePackets(family, sentinel);
    assert.equal(Object.keys(packets.files).length, 2);
    assert.ok(packets.bytes > 20_000, "packet pair must create a measurable inline parent-context burden");
    assert.equal(Object.values(packets.files).every((content) => content.includes(sentinel)), true);
    assert.ok(packets.files[packets.constraintPath].includes(`AUTHORITATIVE_CONSTRAINT_FACT: ${family.constraintFact}`));
    assert.ok(packets.files[packets.observationPath].includes(`AUTHORITATIVE_OBSERVATION_FACT: ${family.observationFact}`));
  }
});

test("experiment skills freeze flat and two-child nested contracts", async () => {
  const registry = new SkillRegistry(new URL("../../../skills/", import.meta.url).pathname);
  const main = await registry.load("workflow-main");
  const flat = await registry.load("workflow-flat");
  const constraint = await registry.load("inspect-constraint");
  const observation = await registry.load("inspect-observation");
  assert.deepEqual(main.delegationPolicy, { allowedSkills: ["inspect-constraint", "inspect-observation"], maxChildScopes: 2, maxConcurrency: 2 });
  assert.deepEqual(flat.delegationPolicy.allowedSkills, []);
  assert.deepEqual(constraint.allowedTools, ["scope_read"]);
  assert.deepEqual(observation.allowedTools, ["scope_read"]);
});

test("manifest creates 15 four-arm paired blocks with shared bytes and clean identity field", async () => {
  const manifest = await buildManifest({ allowDirty: true });
  assert.equal(manifest.jobCount, 60);
  assert.equal(manifest.identity.implementationDirty, true);
  assert.equal(validateManifest(manifest, { requireClean: false }), true);
  const blocks = Map.groupBy(manifest.jobs, (job) => job.blockId);
  assert.equal(blocks.size, 15);
  for (const jobs of blocks.values()) {
    assert.equal(jobs.length, 4);
    assert.equal(new Set(jobs.map((job) => job.seed)).size, 1);
    assert.equal(new Set(jobs.map((job) => JSON.stringify(job.packets))).size, 1);
    assert.equal(new Set(jobs.map((job) => job.condition)).size, 4);
  }
});

test("scripted smoke keeps the sentinel only in the inline parent projection", async () => {
  const result = await runScriptedSmoke();
  assert.equal(result.ok, true);
  assert.equal(result.checks.length, 20);
  assert.equal(result.checks.filter((check) => check.sentinelVisible).every((check) => check.condition === "INLINE_PARENT"), true);
});

test("analyzer applies the preregistered parent-context and stability gates", async (t) => {
  const manifest = await buildManifest({ allowDirty: true });
  const output = await mkdtemp(join(tmpdir(), "skillscope-parent-analysis-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const contexts = { INLINE_PARENT: 1000, EPHEMERAL_FREEFORM: 520, SKILLSCOPE_FLAT: 470, SKILLSCOPE_NESTED: 400 };
  const bytes = { INLINE_PARENT: 30000, EPHEMERAL_FREEFORM: 6200, SKILLSCOPE_FLAT: 5200, SKILLSCOPE_NESTED: 4500 };
  const records = manifest.jobs.map((job) => ({
    schemaVersion: "parent-context.result.v1",
    protocolVersion: job.protocolVersion,
    manifestHash: manifest.manifestHash,
    jobId: job.jobId,
    blockId: job.blockId,
    familyId: job.familyId,
    repeat: job.repeat,
    condition: job.condition,
    seed: job.seed,
    status: "completed",
    verification: { hardPass: true, failureCode: null },
    parentResult: { decision: job.family.expectedDecision, constraintFact: job.family.constraintFact, observationFact: job.family.observationFact, memoryCode: job.memoryCode },
    parentMetrics: {
      parentProviderContextTokens: contexts[job.condition],
      parentEstimatedContextTokens: contexts[job.condition] + 10,
      parentMessageBytes: bytes[job.condition],
      parentToolResultBytes: job.condition === "INLINE_PARENT" ? 25000 : 1000,
    },
    usage: { parent: { totalTokens: 100 }, children: { totalTokens: job.condition === "INLINE_PARENT" ? 0 : 200 }, tree: { totalTokens: job.condition === "SKILLSCOPE_NESTED" ? 500 : 300 } },
    wallTimeMs: 1000,
    sentinel: { visibleInParent: job.condition === "INLINE_PARENT" },
    lifecycle: { valid: true },
  }));
  const summary = await analyzeExperiment(manifest, records, output);
  assert.equal(summary.gates.supported, true);
  assert.equal(summary.blocks.completeBlocks, 15);
  assert.equal(summary.blocks.medianNestedProviderContextReduction, 0.6);
  assert.equal(summary.blocks.contrasts.nestedToInline.treeTokens, 5 / 3);
  assert.equal(summary.conditions.INLINE_PARENT.familyConsistencyRate, 1);
  assert.equal(summary.conditions.EPHEMERAL_FREEFORM.familyConsistencyRate, 1);
  assert.equal(summary.conditions.SKILLSCOPE_FLAT.familyConsistencyRate, 1);
  assert.equal(summary.conditions.SKILLSCOPE_NESTED.familyConsistencyRate, 1);
  assert.match(await readFile(join(output, "report.md"), "utf8"), /当前探索性证据支持继续发展/);
});
