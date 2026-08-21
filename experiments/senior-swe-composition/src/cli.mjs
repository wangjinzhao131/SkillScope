#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { runNativeVerifier } from "./docker-task.mjs";
import { createSeniorLiveEnvironment, runSeniorLiveJob } from "./live-harness.mjs";
import { assertKnownCondition } from "./protocol.mjs";

const args = parseArgs(process.argv.slice(2));

if (args.mode === "qualify") {
  const taskRoot = requiredPath(args, "task-root");
  const record = {
    schemaVersion: "skillscope.senior-swe.qualification.v1",
    taskId: required(args, "task"),
    image: required(args, "image"),
    repoPath: required(args, "repo-path"),
    startedAt: new Date().toISOString(),
    attempts: [],
  };
  const repeats = Number(args.repeats ?? 1);
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 3) throw new Error("--repeats must be 1..3");
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const noop = await timed(() => runNativeVerifier({ image: record.image, repoPath: record.repoPath, taskRoot }));
    const gold = await timed(() => runNativeVerifier({ image: record.image, repoPath: record.repoPath, taskRoot, applyGold: true }));
    record.attempts.push({ repeat, noop, gold });
  }
  record.endedAt = new Date().toISOString();
  record.quickGatePass = record.attempts.every(({ noop, gold }) => noop.result.infrastructureValid
    && gold.result.infrastructureValid && !noop.result.nativeVerifierPass && gold.result.nativeVerifierPass);
  await emit(record, args.output);
} else if (args.mode === "run-one") {
  const apiKey = process.env.EXPERIMENT_KEY;
  if (!apiKey) throw new Error("EXPERIMENT_KEY is not set; invoke through the login shell without printing it");
  const arm = required(args, "arm");
  assertKnownCondition(arm);
  const taskRoot = requiredPath(args, "task-root");
  const environment = await createSeniorLiveEnvironment(apiKey);
  try {
    const result = await runSeniorLiveJob({
      taskId: required(args, "task"),
      arm,
      seed: Number(args.seed ?? 20260822),
      image: required(args, "image"),
      verifierImage: args["verifier-image"],
      repoPath: required(args, "repo-path"),
      taskRoot,
      instruction: await readFile(join(taskRoot, "instruction.md"), "utf8"),
      artifactRoot: args["artifact-root"] ? resolve(args["artifact-root"]) : undefined,
      keepArtifacts: Boolean(args["artifact-root"]),
      stageLimit: args["stage-limit"] ? Number(args["stage-limit"]) : undefined,
    }, environment);
    await emit(result, args.output);
  } finally {
    await environment.dispose();
  }
} else {
  throw new Error("Use --qualify or --run-one");
}

async function timed(operation) {
  const start = process.hrtime.bigint();
  try { return { result: await operation(), wallTimeMs: Number(process.hrtime.bigint() - start) / 1e6 }; }
  catch (error) { return { result: { infrastructureValid: false, nativeVerifierPass: false }, wallTimeMs: Number(process.hrtime.bigint() - start) / 1e6, error: { name: error.name, message: error.message.slice(0, 4000) } }; }
}

async function emit(value, output) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (output) {
    const path = resolve(output);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serialized, "utf8");
  }
  process.stdout.write(serialized);
}

function parseArgs(argv) {
  const result = { mode: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--qualify") result.mode = "qualify";
    else if (value === "--run-one") result.mode = "run-one";
    else if (value.startsWith("--")) {
      const key = value.slice(2);
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${value} requires a value`);
      result[key] = next;
      index += 1;
    } else throw new Error(`unexpected argument ${value}`);
  }
  return result;
}
function required(argsObject, key) { if (!argsObject[key]) throw new Error(`--${key} is required`); return argsObject[key]; }
function requiredPath(argsObject, key) { return resolve(required(argsObject, key)); }
