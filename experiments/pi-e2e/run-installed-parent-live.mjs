#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "../..");
const fixtureRoot = join(here, "parent-fixture");
const outputPath = resolve(process.argv[2] ?? join(here, "results", "installed-parent-latest.json"));
const apiKey = process.env.EXPERIMENT_KEY;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

if (!apiKey) {
  throw new Error("EXPERIMENT_KEY is not set; run from a login shell without copying the key to disk");
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "skillscope-installed-parent-e2e-"));
const installRoot = join(temporaryRoot, "install");
const traceRoot = join(temporaryRoot, "traces");

try {
  const packed = await run(npm, ["pack", "--json", "--pack-destination", temporaryRoot], {
    cwd: repositoryRoot,
    timeout: 60_000,
  });
  const packRecords = JSON.parse(packed.stdout);
  const pack = packRecords[0];
  if (!pack?.filename || !pack?.shasum) throw new Error("npm pack did not return a package identity");
  const tarball = join(temporaryRoot, pack.filename);

  await run(npm, [
    "install",
    "--prefix", installRoot,
    "--no-audit",
    "--no-fund",
    tarball,
    "@earendil-works/pi-coding-agent@0.84.2",
    "typebox@1.3.7",
    "yaml@2.9.0",
  ], { cwd: repositoryRoot, timeout: 120_000 });

  const pi = join(installRoot, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
  const extension = join(installRoot, "node_modules", "pi-scoped-skills", "src", "pi", "index.ts");
  const childEnvironment = { ...process.env };
  delete childEnvironment.EXPERIMENT_KEY;
  childEnvironment.OPENCODE_API_KEY = apiKey;
  childEnvironment.PI_CODING_AGENT_DIR = join(temporaryRoot, "pi-config");
  childEnvironment.SKILLSCOPE_TRACE_ROOT = traceRoot;

  const version = await run(pi, ["--version"], { cwd: fixtureRoot, env: childEnvironment, timeout: 30_000 });
  const startedAt = new Date().toISOString();
  const startedNs = process.hrtime.bigint();
  const parent = await run(pi, [
    "--provider", "opencode-go",
    "--model", "deepseek-v4-flash",
    "--thinking", "off",
    "--mode", "text",
    "--print",
    "--no-session",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-extensions",
    "--no-builtin-tools",
    "--tools", "scoped_skill_run",
    "--extension", extension,
    "--approve",
    "@PROMPT.md",
  ], { cwd: fixtureRoot, env: childEnvironment, timeout: 300_000 });
  const durationMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
  if (!/Status:\s*SUCCESS/i.test(parent.stdout)) throw new Error("Real parent Pi did not report a successful scoped result");
  if (`${parent.stdout}\n${parent.stderr}`.includes(apiKey)) throw new Error("Parent Pi output unexpectedly contained the API key");

  const traceDirectories = (await readdir(traceRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  if (traceDirectories.length !== 1) throw new Error(`Expected one scoped Trace directory, found ${traceDirectories.length}`);
  const traceDirectory = join(traceRoot, traceDirectories[0].name);
  const [manifestText, eventsText, resultText] = await Promise.all([
    readFile(join(traceDirectory, "manifest.json"), "utf8"),
    readFile(join(traceDirectory, "events.jsonl"), "utf8"),
    readFile(join(traceDirectory, "result.json"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  const result = JSON.parse(resultText);
  const audit = result.resourceAudit ?? {};
  if (result.traceFormat !== "metadata-only-v1" || result.status !== "SUCCESS") {
    throw new Error("Installed Extension did not persist a successful metadata-only-v1 Trace");
  }
  for (const [field, expected] of [
    ["physicalMaterializedSetCount", 1],
    ["actualReadSetCount", 1],
    ["modelVisibleSetCount", 1],
  ]) {
    if (audit[field] !== expected) throw new Error(`Unexpected Trace ${field}: ${audit[field]}`);
  }
  if (!audit.denials?.some((denial) => denial.code === "UNAUTHORIZED" && denial.operation === "list")) {
    throw new Error("Installed Extension Trace did not preserve the denied project-root list attempt");
  }

  const traceCorpus = `${manifestText}\n${eventsText}\n${resultText}`;
  const forbidden = [
    apiKey,
    "logs/import.log",
    "warehouse-loader",
    "E_SCHEMA_VERSION",
    "producer emits schema v3",
  ];
  const hits = forbidden.filter((fragment) => traceCorpus.includes(fragment));
  if (hits.length > 0) throw new Error("Installed Extension Trace retained forbidden secret or business plaintext");

  const summary = {
    schemaVersion: "1.0",
    experiment: "installed-tarball-real-parent-pi-e2e",
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs,
    package: {
      name: "pi-scoped-skills",
      version: pack.version,
      tarballSha1: pack.shasum,
      tarballIntegrity: pack.integrity,
      installedInFreshPrefix: true,
    },
    host: {
      piVersion: version.stdout.trim(),
      provider: "opencode-go",
      model: "deepseek-v4-flash",
      noSession: true,
      noContextFiles: true,
      globalSkillsDisabled: true,
      globalExtensionsDisabled: true,
      builtinToolsDisabled: true,
      outerToolAllowlist: ["scoped_skill_run"],
    },
    scope: {
      scopeId: result.scopeId,
      accessMode: manifest.accessMode,
      grantKind: "exact-file",
      status: result.status,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      usage: result.usage,
    },
    trace: {
      format: result.traceFormat,
      manifestHash: manifest.manifestHash,
      manifestFileSha256: digest(manifestText),
      eventsFileSha256: digest(eventsText),
      resultFileSha256: digest(resultText),
      actualReadSetCount: audit.actualReadSetCount,
      modelVisibleSetCount: audit.modelVisibleSetCount,
      physicalMaterializedSetCount: audit.physicalMaterializedSetCount,
      denialCount: audit.denials?.length ?? 0,
    },
    parentOutput: {
      sha256: digest(parent.stdout),
      bytes: Buffer.byteLength(parent.stdout),
      reportedSuccess: true,
    },
    assertions: {
      realParentPiInvokedInstalledExtension: true,
      independentChildCompleted: true,
      grantedEvidenceRead: true,
      projectRootListingDenied: true,
      businessPlaintextAbsentFromTrace: true,
      apiKeyAbsentFromTraceAndOutput: true,
    },
  };
  const serialized = `${JSON.stringify(summary, null, 2)}\n`;
  if (serialized.includes(apiKey)) throw new Error("Refusing to persist an artifact containing EXPERIMENT_KEY");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ok: true, output: outputPath, status: result.status, durationMs })}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function run(command, args, options) {
  try {
    return await execFile(command, args, {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    // Do not attach child stdout/stderr: a hostile provider could echo secrets.
    const outcome = error?.killed
      ? `timeout after ${options?.timeout ?? "unknown"}ms`
      : `exit ${error?.code ?? "unknown"}${error?.signal ? ` signal ${error.signal}` : ""}`;
    throw new Error(`Command failed during installed-parent E2E: ${command} (${outcome})`);
  }
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
