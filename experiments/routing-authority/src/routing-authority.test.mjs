import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeExperiment, canonicalEvidenceBound } from "./analyze.mjs";
import { loadFamilies } from "./corpus.mjs";
import { buildManifest, validateManifest } from "./manifest.mjs";
import { routeFor } from "./protocol.mjs";
import { runScriptedSmoke } from "./scripted-smoke.mjs";

test("corpus keeps six pre-frozen families", async () => { const families = await loadFamilies(); assert.equal(families.length, 6); assert.deepEqual([...new Set(families.map((family) => family.dependencyDirection))].sort(), ["constraint-first", "independent", "observation-first"]); });

test("manifest creates matched 36-trial paired matrix", async () => {
  const manifest = await buildManifest({ allowDirty: true, repeats: 3, createdAt: "2026-08-20T00:00:00.000Z" });
  assert.equal(manifest.jobCount, 36); assert.equal(manifest.jobs.length, 36); assert.equal(validateManifest(manifest, { requireClean: false }), true);
  for (const cells of Map.groupBy(manifest.jobs, (job) => job.blockId).values()) {
    assert.equal(cells.length, 2); assert.deepEqual(cells.map((job) => job.condition).sort(), ["MODEL_ROUTED", "RUNTIME_ROUTED"]);
    assert.equal(new Set(cells.map((job) => JSON.stringify({ seed: job.seed, family: job.family, packets: job.packets, memoryCode: job.memoryCode, sentinel: job.sentinel }))).size, 1);
    for (const job of cells) assert.equal(job.compositionMode, routeFor(job.condition, job.family.dependencyDirection));
  }
});

test("scripted matrix resolves all family-condition cells", async () => { const result = await runScriptedSmoke(); assert.equal(result.ok, true); assert.equal(result.checks.length, 12); assert.equal(result.checks.every((check) => check.hardPass), true); });

test("canonical evidence must name only the two actual children", () => {
  const record = { scopes: [{ depth: 1, scopeId: "a" }, { depth: 1, scopeId: "b" }], mainEvidenceRefs: [{ id: "runtime-child-1", resource: "scope://a" }, { id: "runtime-child-2", resource: "scope://b" }] };
  assert.equal(canonicalEvidenceBound(record), true); record.mainEvidenceRefs[1].resource = "scope://bogus"; assert.equal(canonicalEvidenceBound(record), false);
});

test("analyzer reports an ideal paired matrix", async () => {
  const manifest = await buildManifest({ allowDirty: true, repeats: 3, createdAt: "2026-08-20T00:00:00.000Z" });
  const records = manifest.jobs.map((job) => idealRecord(job, manifest.manifestHash)); const directory = await mkdtemp(join(tmpdir(), "routing-analysis-"));
  try {
    const summary = await analyzeExperiment(manifest, records, directory);
    assert.equal(summary.gates.supported, true); assert.equal(summary.gates.checks.h3ParentContextBounded, true); assert.equal(summary.conditions.RUNTIME_ROUTED.hardPassRate, 1); assert.match(await readFile(join(directory, "report.md"), "utf8"), /Runtime证据绑定/u);
    const oversized = records.map((record) => ({ ...record, parentMetrics: { ...record.parentMetrics, parentProviderContextTokens: 2000 } }));
    const rejected = await analyzeExperiment(manifest, oversized, directory);
    assert.equal(rejected.gates.checks.h3ParentContextBounded, false); assert.equal(rejected.gates.supported, false);
  }
  finally { await rm(directory, { recursive: true, force: true }); }
});

function idealRecord(job, manifestHash) {
  const firstRole = job.family.dependencyDirection === "independent" ? "parallel" : job.family.dependencyDirection === "observation-first" ? "observation" : "constraint";
  return { protocolVersion: job.protocolVersion, jobId: job.jobId, manifestHash, blockId: job.blockId, familyId: job.familyId, dependencyDirection: job.family.dependencyDirection, repeat: job.repeat, condition: job.condition, compositionMode: job.compositionMode, seed: job.seed, status: "completed", verification: { hardPass: true, abstained: false, checks: { decision: true, constraintFact: true, observationFact: true } }, parentResult: { decision: job.family.expectedDecision, constraintFact: job.family.constraintFact, observationFact: job.family.observationFact }, mainEvidenceRefs: [{ id: "runtime-child-1", resource: `scope://${job.jobId}-a` }, { id: "runtime-child-2", resource: `scope://${job.jobId}-b` }], topology: { valid: true, sameAtomicSkill: true, observedFirstRole: firstRole }, lifecycle: { valid: true }, scopes: [{ depth: 0, scopeId: `${job.jobId}-root` }, { depth: 1, scopeId: `${job.jobId}-a` }, { depth: 1, scopeId: `${job.jobId}-b` }], sentinel: { visibleInParent: false }, parentMetrics: { parentProviderContextTokens: 1000, parentMessageBytes: 4000 }, usage: { tree: { totalTokens: 3000 } }, wallTimeMs: 1000 };
}
