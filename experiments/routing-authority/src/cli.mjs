#!/usr/bin/env node

import { resolve } from "node:path";
import "../../../tests/pi/register-typescript.js";
import { analyzeExperiment, canonicalEvidenceBound } from "./analyze.mjs";
import { projectRootPath } from "./implementation-identity.mjs";
import { buildManifest } from "./manifest.mjs";
import { readManifest, readResults, runManifest, writeManifest } from "./runner.mjs";
import { runScriptedSmoke } from "./scripted-smoke.mjs";

const args = parseArgs(process.argv.slice(2));
if (args.smoke) {
  const result = await runScriptedSmoke(); process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); if (!result.ok) process.exitCode = 1;
} else if (args.preflight) {
  const apiKey = process.env.EXPERIMENT_KEY;
  if (!apiKey) throw new Error("EXPERIMENT_KEY is not set; invoke through the login shell without printing it");
  const manifest = await buildManifest({ allowDirty: false, repeats: 1 });
  const blockId = manifest.jobs[0].blockId; const jobs = manifest.jobs.filter((job) => job.blockId === blockId);
  const { createLiveEnvironment, runCompositionJob } = await import("../../composition-topology/src/live-harness.mjs");
  const environment = await createLiveEnvironment(apiKey, { skillsRoot: resolve(projectRootPath(), "skills") });
  try {
    const records = [];
    for (const job of jobs) {
      const record = await runCompositionJob(job, environment); records.push(record);
      process.stdout.write(`${JSON.stringify({ condition: record.condition, compositionMode: record.compositionMode, status: record.status, hardPass: record.verification?.hardPass, topology: record.topology, canonicalEvidence: canonicalEvidenceBound(record), lifecycle: record.lifecycle?.valid, sentinelVisible: record.sentinel?.visibleInParent })}\n`);
    }
    const ok = records.every((record) => record.verification?.hardPass === true && record.topology?.valid === true && canonicalEvidenceBound(record) && record.lifecycle?.valid === true && record.sentinel?.visibleInParent === false && !["provider_error", "harness_error"].includes(record.status));
    process.stdout.write(`${JSON.stringify({ ok, kind: "engineering-preflight", blockId, trials: records.length })}\n`); if (!ok) process.exitCode = 1;
  } finally { await environment.dispose(); }
} else if (args.plan) {
  const manifest = await buildManifest({ allowDirty: args.allowDirty, repeats: args.repeats }); await writeManifest(args.plan, manifest);
  process.stdout.write(`${JSON.stringify({ ok: true, manifest: args.plan, manifestHash: manifest.manifestHash, jobs: manifest.jobCount, dirty: manifest.identity.implementationDirty })}\n`);
} else if (args.run) {
  const apiKey = process.env.EXPERIMENT_KEY;
  if (!apiKey) throw new Error("EXPERIMENT_KEY is not set; invoke through the login shell without printing it");
  const manifest = await readManifest(args.manifest, { requireClean: true });
  const { createLiveEnvironment, runCompositionJob } = await import("../../composition-topology/src/live-harness.mjs");
  const environment = await createLiveEnvironment(apiKey, { skillsRoot: resolve(projectRootPath(), "skills") });
  try {
    const records = await runManifest({ manifest, resultsPath: args.results, environment, runJob: runCompositionJob, concurrency: args.concurrency, onProgress(event) { process.stdout.write(`${JSON.stringify(event)}\n`); } });
    process.stdout.write(`${JSON.stringify({ ok: true, results: args.results, completed: records.length, total: manifest.jobCount })}\n`);
  } finally { await environment.dispose(); }
} else if (args.analyze) {
  const manifest = await readManifest(args.manifest, { requireClean: true }); const records = await readResults(args.results);
  const summary = await analyzeExperiment(manifest, records, args.output); process.stdout.write(`${JSON.stringify({ ok: true, output: args.output, gates: summary.gates, excluded: summary.excluded })}\n`);
} else { usage(); process.exitCode = 2; }

function parseArgs(argv) {
  const result = { concurrency: 1, repeats: 3 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--smoke") result.smoke = true;
    else if (value === "--preflight") result.preflight = true;
    else if (value === "--plan") result.plan = resolve(required(argv, ++index, value));
    else if (value === "--run") result.run = true;
    else if (value === "--analyze") result.analyze = true;
    else if (value === "--manifest") result.manifest = resolve(required(argv, ++index, value));
    else if (value === "--results") result.results = resolve(required(argv, ++index, value));
    else if (value === "--output") result.output = resolve(required(argv, ++index, value));
    else if (value === "--concurrency") result.concurrency = Number(required(argv, ++index, value));
    else if (value === "--repeats") result.repeats = Number(required(argv, ++index, value));
    else if (value === "--allow-dirty") result.allowDirty = true;
    else throw new Error(`Unknown argument ${value}`);
  }
  if (result.run && (!result.manifest || !result.results)) throw new Error("--run requires --manifest and --results");
  if (result.analyze && (!result.manifest || !result.results || !result.output)) throw new Error("--analyze requires --manifest, --results, and --output");
  return result;
}
function required(argv, index, flag) { const value = argv[index]; if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`); return value; }
function usage() { process.stderr.write(["Usage:", "  node experiments/routing-authority/src/cli.mjs --smoke", "  zsh -ilc 'node experiments/routing-authority/src/cli.mjs --preflight'", "  node experiments/routing-authority/src/cli.mjs --plan experiments/routing-authority/runs/manifest.json", "  node experiments/routing-authority/src/cli.mjs --run --manifest experiments/routing-authority/runs/manifest.json --results experiments/routing-authority/runs/results.jsonl", "  node experiments/routing-authority/src/cli.mjs --analyze --manifest experiments/routing-authority/runs/manifest.json --results experiments/routing-authority/runs/results.jsonl --output experiments/routing-authority/reports/latest", ""].join("\n")); }
