import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { captureImplementationIdentity } from "./implementation-identity.mjs";
import { validateManifest } from "./manifest.mjs";

export async function writeManifest(path, manifest) { await atomicWrite(path, `${JSON.stringify(manifest, null, 2)}\n`); }
export async function readManifest(path, options) { const manifest = JSON.parse(await readFile(path, "utf8")); validateManifest(manifest, options); return manifest; }

export async function runManifest({ manifest, resultsPath, environment, runJob, concurrency = 1, onProgress = () => {} }) {
  validateManifest(manifest, { requireClean: true });
  assertCurrentIdentity(manifest.identity);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 2) throw new Error("concurrency must be 1..2");
  const existing = await readResults(resultsPath);
  const byJob = new Map(existing.map((record) => [record.jobId, record]));
  const pending = manifest.jobs.filter((job) => !byJob.has(job.jobId));
  await mkdir(dirname(resultsPath), { recursive: true });
  let cursor = 0; let appendChain = Promise.resolve();
  const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    while (true) {
      const index = cursor; cursor += 1; if (index >= pending.length) return;
      const job = pending[index]; const attempts = []; let result;
      for (let attempt = 0; attempt <= job.externalRetryLimit; attempt += 1) {
        result = await runJob(job, environment);
        attempts.push({ attempt: attempt + 1, status: result.status, startedAt: result.startedAt, endedAt: result.endedAt, error: result.error });
        if (result.status !== "provider_error") break;
      }
      const record = { ...result, manifestHash: manifest.manifestHash, externalAttempts: attempts };
      appendChain = appendChain.then(() => appendFile(resultsPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 }));
      await appendChain; byJob.set(job.jobId, record);
      onProgress({ completed: byJob.size, total: manifest.jobs.length, jobId: job.jobId, condition: job.condition, status: record.status });
    }
  });
  await Promise.all(workers); await appendChain;
  return manifest.jobs.map((job) => byJob.get(job.jobId)).filter(Boolean);
}

export async function readResults(path) {
  let text;
  try { text = await readFile(path, "utf8"); } catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const lines = text.split("\n"); const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim(); if (!line) continue;
    try { records.push(JSON.parse(line)); }
    catch (error) { if (lines.slice(index + 1).every((candidate) => candidate.trim() === "")) break; throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`); }
  }
  const ids = new Set();
  for (const record of records) { if (ids.has(record.jobId)) throw new Error(`Duplicate result jobId ${record.jobId}`); ids.add(record.jobId); }
  return records;
}

function assertCurrentIdentity(expected) {
  const current = captureImplementationIdentity({ allowDirty: false });
  for (const key of ["implementationRevision", "sourceTreeHash", "packageConfigHash", "dependencyLockHash", "nodeVersion", "implementationDirty"]) if (current[key] !== expected[key]) throw new Error(`Current implementation ${key} does not match manifest`);
}
async function atomicWrite(path, text) { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.tmp-${process.pid}-${Date.now()}`; await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 }); await rename(temporary, path); }
