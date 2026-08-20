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

test("six topology families freeze two directions and an independent control", async () => {
  const families = await loadFamilies();
  assert.equal(families.length, 6);
  for (const direction of ["constraint-first", "observation-first", "independent"]) assert.equal(families.filter((family) => family.dependencyDirection === direction).length, 2);
  for (const family of families) {
    const packets = materializePackets(family, "COMPOSITION_SENTINEL_0123456789ABCDEF");
    assert.equal(Object.keys(packets.files).length, 2);
    assert.ok(packets.bytes > 18_000);
    assert.equal(Object.values(packets.files).every((content) => content.includes("COMPOSITION_SENTINEL_0123456789ABCDEF")), true);
  }
});

test("every arm uses the same main and same atomic Skill contract", async () => {
  const registry = new SkillRegistry(new URL("../../../skills/", import.meta.url).pathname);
  const main = await registry.load("workflow-compose");
  const atomic = await registry.load("inspect-contextual-evidence");
  assert.deepEqual(main.delegationPolicy, { allowedSkills: ["inspect-contextual-evidence"], maxChildScopes: 2, maxConcurrency: 2 });
  assert.deepEqual(atomic.delegationPolicy, { allowedSkills: [], maxChildScopes: 0, maxConcurrency: 1 });
  assert.equal(main.version, "1.0.0");
  assert.equal(atomic.version, "1.0.0");
});

test("scripted mechanism distinguishes matched, wrong, parallel, and adaptive topologies", async () => {
  const result = await runScriptedSmoke();
  assert.equal(result.ok, true);
  assert.equal(result.checks.length, 24);
  assert.equal(result.checks.filter((check) => check.dependencyDirection === "independent").every((check) => check.hardPass), true);
  assert.equal(result.checks.filter((check) => check.dependencyDirection !== "independent" && check.condition === "PARALLEL_JOIN").every((check) => !check.hardPass), true);
  assert.equal(result.checks.filter((check) => check.condition === "ADAPTIVE_ORDER").every((check) => check.hardPass), true);
});

test("manifest freezes 18 four-arm blocks with the same bytes, Skill set, and call budget", async () => {
  const manifest = await buildManifest({ allowDirty: true });
  assert.equal(manifest.jobCount, 72);
  assert.equal(validateManifest(manifest, { requireClean: false }), true);
  const blocks = Map.groupBy(manifest.jobs, (job) => job.blockId);
  assert.equal(blocks.size, 18);
  for (const jobs of blocks.values()) {
    assert.equal(jobs.length, 4);
    assert.equal(new Set(jobs.map((job) => job.seed)).size, 1);
    assert.equal(new Set(jobs.map((job) => JSON.stringify(job.packets))).size, 1);
    assert.equal(new Set(jobs.map((job) => job.condition)).size, 4);
  }
});

test("analyzer applies direction, adaptive, negative-control, context, and lifecycle gates", async (t) => {
  const manifest = await buildManifest({ allowDirty: true });
  const output = await mkdtemp(join(tmpdir(), "skillscope-composition-analysis-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const records = manifest.jobs.map((job) => fakeRecord(job, manifest.manifestHash));
  const summary = await analyzeExperiment(manifest, records, output);
  assert.equal(summary.gates.supported, true);
  assert.equal(summary.gates.adaptiveSupported, true);
  assert.equal(summary.mechanism.matched.hardPassRate, 1);
  assert.equal(summary.mechanism.parallel.hardPassRate, 0);
  assert.equal(summary.mechanism.wrongDirection.hardPassRate, 0);
  assert.equal(summary.mechanism.adaptive.hardPassRate, 1);
  assert.equal(summary.mechanism.independentHardPassSpread, 0);
  assert.match(await readFile(join(output, "report.md"), "utf8"), /SUPPORTED FOR CONTINUED DEVELOPMENT/);
});

function fakeRecord(job, manifestHash) {
  const directional = job.family.dependencyDirection !== "independent";
  const matched = !directional
    || job.condition === "ADAPTIVE_ORDER"
    || (job.family.dependencyDirection === "constraint-first" && job.condition === "CONSTRAINT_FIRST")
    || (job.family.dependencyDirection === "observation-first" && job.condition === "OBSERVATION_FIRST");
  const observedFirstRole = job.condition === "PARALLEL_JOIN" ? "parallel"
    : job.condition === "CONSTRAINT_FIRST" ? "constraint"
      : job.condition === "OBSERVATION_FIRST" ? "observation"
        : job.family.dependencyDirection === "observation-first" ? "observation" : "constraint";
  return {
    schemaVersion: "composition-topology.result.v1",
    protocolVersion: job.protocolVersion,
    manifestHash,
    jobId: job.jobId,
    blockId: job.blockId,
    familyId: job.familyId,
    dependencyDirection: job.family.dependencyDirection,
    repeat: job.repeat,
    condition: job.condition,
    seed: job.seed,
    status: matched ? "completed" : "capability_failure",
    verification: { hardPass: matched, schemaPass: true, abstained: !matched, confidentWrong: false, failureCode: matched ? null : "ABSTAINED" },
    parentResult: matched
      ? { decision: job.family.expectedDecision, constraintFact: job.family.constraintFact, observationFact: job.family.observationFact, memoryCode: job.memoryCode }
      : { decision: "ABSTAIN", constraintFact: "UNKNOWN", observationFact: "UNKNOWN", memoryCode: job.memoryCode },
    parentMetrics: { parentProviderContextTokens: 1000, parentEstimatedContextTokens: 900, parentMessageBytes: 4000, parentToolResultBytes: 500 },
    usage: { tree: { totalTokens: job.condition === "PARALLEL_JOIN" ? 1000 : 1200 } },
    wallTimeMs: job.condition === "PARALLEL_JOIN" ? 1000 : 1600,
    topology: { valid: true, observedFirstRole, upstreamPassedToSecond: job.condition !== "PARALLEL_JOIN" },
    lifecycle: { valid: true },
    sentinel: { visibleInParent: false },
  };
}
