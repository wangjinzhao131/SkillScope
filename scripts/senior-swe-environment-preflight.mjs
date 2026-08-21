#!/usr/bin/env node

import { resolve } from "node:path";
import {
  auditSeniorSweEnvironment,
  parseByteSize,
} from "../experiments/senior-swe-composition/src/environment-audit.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
  } else {
    const report = await auditSeniorSweEnvironment(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (options.strict && report.summary.staticEligible !== report.summary.total) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error.code ? `${error.code}: ` : ""}${error.message}\n`);
  process.exitCode = 2;
}

function parseArgs(argv) {
  const result = {
    limits: { cpus: 4, memory: "8G", storage: "120G" },
    taskIds: [],
    requireValidation: false,
    strict: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dataset") result.datasetRoot = resolve(requiredValue(argv, ++index, argument));
    else if (argument === "--task") result.taskIds.push(requiredValue(argv, ++index, argument));
    else if (argument === "--max-cpus") result.limits.cpus = positiveNumber(requiredValue(argv, ++index, argument), argument);
    else if (argument === "--max-memory") result.limits.memory = byteSize(requiredValue(argv, ++index, argument), argument);
    else if (argument === "--max-storage") result.limits.storage = byteSize(requiredValue(argv, ++index, argument), argument);
    else if (argument === "--require-validation") result.requireValidation = true;
    else if (argument === "--strict") result.strict = true;
    else if (argument === "--help" || argument === "-h") result.help = true;
    else throw Object.assign(new Error(`Unknown argument ${argument}`), { code: "UNKNOWN_ARGUMENT" });
  }
  if (!result.help && !result.datasetRoot) throw Object.assign(new Error("--dataset is required"), { code: "DATASET_ROOT_REQUIRED" });
  if (result.taskIds.length === 0) delete result.taskIds;
  return result;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw Object.assign(new Error(`${flag} requires a value`), { code: "ARGUMENT_VALUE_REQUIRED" });
  return value;
}

function positiveNumber(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw Object.assign(new Error(`${flag} must be a positive number`), { code: "INVALID_ARGUMENT" });
  return number;
}

function byteSize(value, flag) {
  if (parseByteSize(value) === null) throw Object.assign(new Error(`${flag} must be a byte size such as 8G or 120GiB`), { code: "INVALID_ARGUMENT" });
  return value;
}

function usage() {
  return [
    "Read-only Senior SWE-Bench ARM/Harbor static environment audit",
    "",
    "Usage:",
    "  node scripts/senior-swe-environment-preflight.mjs --dataset /path/to/senior-swe-bench [options]",
    "",
    "Options:",
    "  --task ID              Audit one task (repeatable; default: every task)",
    "  --max-cpus N           Qualification ceiling (default: 4)",
    "  --max-memory SIZE      Qualification ceiling (default: 8G)",
    "  --max-storage SIZE     Qualification ceiling (default: 120G)",
    "  --require-validation   Require optional validation-agent files",
    "  --strict               Exit 1 if any selected task is not statically eligible",
    "  --help                  Show this text",
    "",
    "The command never builds images or writes files. It does not open instructions,",
    "solutions, oracle files, or test bodies.",
    "",
  ].join("\n");
}
