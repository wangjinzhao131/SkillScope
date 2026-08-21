#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { CONDITIONS } from "./protocol.mjs";

export function analyzePrepilot(manifest, records, rawFiles = []) {
  if (manifest?.schemaVersion !== "skillscope.senior-swe.prepilot-manifest.v2") {
    throw new Error("expected a frozen Senior SWE prepilot v2 manifest");
  }
  if (!Array.isArray(manifest.jobs) || manifest.jobs.length === 0) throw new Error("manifest.jobs must be non-empty");

  const expected = new Map(manifest.jobs.map((job) => [jobKey(job), job]));
  if (expected.size !== manifest.jobs.length) throw new Error("manifest contains duplicate task-arm-seed jobs");
  const actual = new Map();
  for (const record of records) {
    if (record?.schemaVersion !== "skillscope.senior-swe.live-result.v1") throw new Error("unexpected result schema");
    const key = jobKey(record);
    if (!expected.has(key)) throw new Error(`result is not present in manifest: ${key}`);
    if (actual.has(key)) throw new Error(`duplicate result: ${key}`);
    actual.set(key, record);
  }
  const missing = [...expected.keys()].filter((key) => !actual.has(key));
  if (missing.length) throw new Error(`missing manifest results: ${missing.join(", ")}`);

  const rows = manifest.jobs.map((job) => resultRow(actual.get(jobKey(job))));
  const byArm = Object.fromEntries(CONDITIONS.map((arm) => {
    const armRows = rows.filter((row) => row.arm === arm);
    return [arm, {
      jobs: armRows.length,
      stagesCompleted: armRows.reduce((sum, row) => sum + row.stageCount, 0),
      nativeVerifierReached: armRows.filter((row) => row.nativeVerifierReached).length,
      medianWallTimeMs: median(armRows.map((row) => row.wallTimeMs)),
      medianRootFinalBytes: median(armRows.map((row) => row.rootFinalBytes)),
      medianCoordinatorFinalBytes: median(armRows.map((row) => row.coordinatorFinalBytes)),
      medianTotalTokens: median(armRows.map((row) => row.totalTokens)),
    }];
  }));
  const inlineRoot = byTask(rows.filter((row) => row.arm === "INLINE_PERSISTENT"), "rootFinalBytes");
  const pairedRootReduction = Object.fromEntries(["FLAT_DISPOSABLE", "COMPOSED_DISPOSABLE"].map((arm) => {
    const percentages = rows.filter((row) => row.arm === arm).map((row) => {
      const baseline = inlineRoot.get(row.taskId);
      return 100 * (1 - row.rootFinalBytes / baseline);
    });
    return [arm, { perTaskPercent: percentages, medianPercent: median(percentages) }];
  }));
  const wallMedian = median(rows.map((row) => row.wallTimeMs));
  const allStartedScopesClosed = rows.filter((row) => row.allStartedScopesClosed).length;
  const topologyComplete = rows.filter((row) => row.topologyComplete).length;
  const leakageClear = rows.filter((row) => row.leakageClear).length;
  const telemetryComplete = rows.every((row) => [
    row.wallTimeMs, row.rootFinalBytes, row.rootContextAucBytes, row.coordinatorFinalBytes,
    row.coordinatorContextAucBytes, row.apiCalls, row.totalTokens,
  ].every(Number.isFinite));
  const gates = {
    nativeVerifier6of6: rows.filter((row) => row.nativeVerifierReached).length === 6,
    usablePatchAtLeast5of6: rows.filter((row) => row.finalArtifactPresent && row.stageCount === 4).length >= 5,
    everyStartedScopeClosed: allStartedScopesClosed === rows.length,
    leakageClear: leakageClear === rows.length,
    telemetryComplete,
    nativeOutcomeVaries: false,
  };
  gates.formalExperimentAllowed = Object.values(gates).every(Boolean);

  const sortedRawFiles = [...rawFiles].sort((a, b) => a.name.localeCompare(b.name));
  const bundleMaterial = sortedRawFiles.map((file) => `${file.name}:${file.sha256}\n`).join("");
  return {
    schemaVersion: "skillscope.senior-swe.prepilot-analysis.v1",
    manifest: {
      implementationCommit: manifest.implementationCommit,
      datasetCommit: manifest.dataset?.commit,
      model: manifest.model?.id,
      seed: manifest.pairedSeed,
      jobs: manifest.jobs.length,
    },
    rows,
    byArm,
    pairedRootReduction,
    totals: {
      stagesCompleted: rows.reduce((sum, row) => sum + row.stageCount, 0),
      nativeVerifierReached: rows.filter((row) => row.nativeVerifierReached).length,
      missingStageComplete: rows.filter((row) => row.failureCode === "MISSING_STAGE_COMPLETE").length,
      allStartedScopesClosed,
      topologyComplete,
      leakageClear,
      rawLifecycleValid: rows.filter((row) => row.rawLifecycleValid).length,
    },
    runtime: {
      medianTaskArmMs: wallMedian,
      band: wallMedian <= 20 * 60_000 ? "LE_20_MIN" : wallMedian <= 30 * 60_000 ? "GT_20_LE_30_MIN" : "GT_30_MIN",
      taskCountIfAllOtherGatesPassed: wallMedian <= 20 * 60_000 ? 6 : wallMedian <= 30 * 60_000 ? 4 : 0,
    },
    gates,
    rawIdentity: {
      files: sortedRawFiles,
      bundleSha256: sortedRawFiles.length ? sha256(bundleMaterial) : null,
    },
  };
}

function resultRow(record) {
  const lifecycle = record.lifecycle ?? {};
  const started = lifecycle.startedScopes;
  const disposed = lifecycle.disposedScopes;
  const active = lifecycle.activeScopes;
  const containers = lifecycle.activeContainers;
  const leakage = record.leakage ?? {};
  return {
    taskId: record.taskId,
    arm: record.arm,
    seed: record.seed,
    status: record.status,
    failureCode: record.failure?.code ?? null,
    stageCount: record.stages?.length ?? 0,
    finalArtifactPresent: Boolean(record.finalArtifact),
    nativeVerifierReached: Boolean(record.nativeVerifier),
    wallTimeMs: record.wallTimeMs,
    rootFinalBytes: record.context?.rootFinalBytes,
    rootContextAucBytes: record.context?.rootContextAucBytes,
    coordinatorFinalBytes: record.context?.coordinatorFinalBytes,
    coordinatorContextAucBytes: record.context?.coordinatorContextAucBytes,
    apiCalls: record.usage?.apiCalls,
    totalTokens: record.usage?.totalTokens,
    expectedScopes: lifecycle.expectedScopes,
    startedScopes: started,
    disposedScopes: disposed,
    activeScopes: active,
    activeContainers: containers,
    allStartedScopesClosed: disposed === started && active === 0 && containers === 0,
    topologyComplete: started === lifecycle.expectedScopes,
    rawLifecycleValid: lifecycle.valid === true,
    leakageClear: leakage.sentinelInRootProjection === false && leakage.rawTranscriptsPersisted === false,
  };
}

function jobKey(value) { return `${value.taskId}\u0000${value.arm}\u0000${value.seed}`; }
function byTask(rows, field) { return new Map(rows.map((row) => [row.taskId, row[field]])); }
function median(values) {
  if (!values.length || values.some((value) => !Number.isFinite(value))) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

async function main(argv) {
  const args = parseArgs(argv);
  const manifest = JSON.parse(await readFile(args.manifest, "utf8"));
  const entries = (await readdir(args.results, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name));
  const records = [];
  const rawFiles = [];
  for (const entry of entries) {
    const body = await readFile(join(args.results, entry.name));
    records.push(JSON.parse(body.toString("utf8")));
    rawFiles.push({ name: entry.name, sha256: sha256(body) });
  }
  process.stdout.write(`${JSON.stringify(analyzePrepilot(manifest, records, rawFiles), null, 2)}\n`);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!["--manifest", "--results"].includes(key) || !value) throw new Error("use --manifest <file> --results <directory>");
    result[key.slice(2)] = resolve(value);
  }
  if (!result.manifest || !result.results) throw new Error("--manifest and --results are required");
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${basename(process.argv[1])}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
