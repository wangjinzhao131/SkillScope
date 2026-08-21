import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  auditSeniorSweEnvironment,
  inspectDockerfile,
  parseByteSize,
  readTaskTomlResourcePrefix,
} from "./environment-audit.mjs";

const repositoryRoot = resolve(new URL("../../..", import.meta.url).pathname);

test("classifies native and ARM_PORT tasks while keeping qualification separate", async (t) => {
  const fixture = await createDatasetFixture();
  t.after(() => rm(fixture, { recursive: true, force: true }));

  await createTask(fixture, "native-task", {
    dockerfile: "FROM node:22-bookworm\nRUN echo portable\n",
    cpus: 4,
    memory: "8G",
    storage: "20G",
    validation: true,
  });
  await createTask(fixture, "x86-task", {
    dockerfile: "FROM --platform=linux/amd64 ubuntu:24.04\nRUN curl -LO tool-x86_64.tar.gz\n",
    cpus: 8,
    memory: "16G",
    storage: "20G",
    validation: false,
  });

  const report = await auditSeniorSweEnvironment({
    datasetRoot: fixture,
    limits: { cpus: 4, memory: "8G", storage: "120G" },
  });

  assert.deepEqual(report.summary, {
    total: 2,
    native: 1,
    armPort: 1,
    verifierReady: 2,
    validationAvailable: 1,
    staticEligible: 1,
  });
  const native = report.tasks.find((task) => task.taskId === "native-task");
  const x86 = report.tasks.find((task) => task.taskId === "x86-task");
  assert.equal(native.architecture.classification, "native");
  assert.equal(native.qualification.staticEligible, true);
  assert.equal(native.validation.validationAvailable, true);
  assert.equal(x86.architecture.classification, "ARM_PORT");
  assert.deepEqual(x86.architecture.indicators.map((entry) => entry.code), [
    "FORCED_AMD64_FROM_PLATFORM",
    "AMD64_LITERAL",
    "X86_64_LITERAL",
  ]);
  assert.equal(x86.qualification.staticEligible, false);
  assert.ok(x86.qualification.reasons.includes("ARCHITECTURE_PORT_REQUIRED"));
  assert.ok(x86.qualification.reasons.includes("CPU_LIMIT_EXCEEDED"));
  assert.ok(x86.qualification.reasons.includes("MEMORY_LIMIT_EXCEEDED"));
});

test("resource prefix reader stops before solution body", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "skillscope-senior-prefix-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "task.toml");
  const prefix = [
    'version = "1.0"',
    "[task]",
    'name = "fixture"',
    "[environment]",
    "cpus = 4",
    'memory = "8G"',
    'storage = "20G"',
    "build_timeout_sec = 1800.0",
    "[verifier]",
    "timeout_sec = 600.0",
    "[solution.env]",
    "",
  ].join("\n");
  const forbiddenBody = 'SECRET_ORACLE_SENTINEL = "must-not-be-read"\n';
  await writeFile(path, prefix + forbiddenBody);

  const result = await readTaskTomlResourcePrefix(path);
  assert.equal(result.environment.cpus, 4);
  assert.equal(result.environment.memory, "8G");
  assert.equal(result.verifier.timeout_sec, 600);
  assert.equal(result.stoppedAtSection, "solution.env");
  assert.equal(result.sourceBytesRead, Buffer.byteLength(prefix));
  assert.ok(result.sourceBytesRead < Buffer.byteLength(prefix + forbiddenBody));
});

test("does not open instruction, solution, oracle, or test bodies", async (t) => {
  const fixture = await createDatasetFixture();
  t.after(async () => {
    await makeForbiddenBodiesReadable(fixture, "guarded-task");
    await rm(fixture, { recursive: true, force: true });
  });
  await createTask(fixture, "guarded-task", {
    dockerfile: "FROM alpine:3.22\n",
    cpus: 2,
    memory: "4G",
    storage: "10G",
    validation: true,
  });
  await protectForbiddenBodies(fixture, "guarded-task");

  const report = await auditSeniorSweEnvironment({ datasetRoot: fixture });
  assert.equal(report.tasks[0].qualification.staticEligible, true);
  assert.deepEqual(report.policy.forbiddenBodies, ["instruction.md", "solution/**", "**/oracle*", "tests/**"]);
  assert.equal(report.tasks[0].validation.inspectionMode, "lstat-only-no-test-body-read");
});

test("validation is existence-only and optional unless explicitly required", async (t) => {
  const fixture = await createDatasetFixture();
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await createTask(fixture, "no-validation", {
    dockerfile: "FROM python:3.13\n",
    cpus: 2,
    memory: "4G",
    storage: "10G",
    validation: false,
  });

  const optional = await auditSeniorSweEnvironment({ datasetRoot: fixture });
  const required = await auditSeniorSweEnvironment({ datasetRoot: fixture, requireValidation: true });
  assert.equal(optional.tasks[0].validation.validationAvailable, false);
  assert.equal(optional.tasks[0].qualification.staticEligible, true);
  assert.equal(required.tasks[0].qualification.staticEligible, false);
  assert.ok(required.tasks[0].qualification.reasons.includes("VALIDATION_FILES_MISSING"));
});

test("CLI produces JSON without changing the dataset", async (t) => {
  const fixture = await createDatasetFixture();
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await createTask(fixture, "cli-task", {
    dockerfile: "FROM golang:1.25\n",
    cpus: 4,
    memory: "8G",
    storage: "20G",
    validation: true,
  });
  const before = await snapshotPaths(fixture);
  const run = spawnSync(process.execPath, [
    join(repositoryRoot, "scripts/senior-swe-environment-preflight.mjs"),
    "--dataset", fixture,
    "--task", "cli-task",
    "--strict",
  ], { encoding: "utf8" });
  const after = await snapshotPaths(fixture);

  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).summary.staticEligible, 1);
  assert.deepEqual(after, before);
});

test("Dockerfile audit ignores comments but flags architecture literals in instructions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "skillscope-senior-dockerfile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "Dockerfile");
  await writeFile(path, "# old x86_64 note\nFROM ubuntu:24.04\nARG TOOL_ARCH=amd64\n");
  const result = await inspectDockerfile(path);
  assert.equal(result.classification, "ARM_PORT");
  assert.deepEqual(result.indicators, [{ code: "AMD64_LITERAL", line: 3 }]);
});

test("complete runtime architecture dispatch is native but unrelated x86 downloads still fail", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "skillscope-senior-arch-dispatch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "Dockerfile");
  const portable = [
    "FROM ubuntu:24.04",
    "RUN ARCH=$(dpkg --print-architecture) && \\",
    "  case \"$ARCH\" in \\",
    "    amd64) GO_ARCH=amd64 ;; \\",
    "    arm64) GO_ARCH=arm64 ;; \\",
    "  esac && curl -LO https://example.test/go.linux-${GO_ARCH}.tgz",
  ].join("\n");
  await writeFile(path, `${portable}\n`);
  assert.equal((await inspectDockerfile(path)).classification, "native");

  await writeFile(path, `${portable}\nRUN curl -LO https://example.test/protoc-linux-x86_64.zip\n`);
  const hardCoded = await inspectDockerfile(path);
  assert.equal(hardCoded.classification, "ARM_PORT");
  assert.deepEqual(hardCoded.indicators, [{ code: "X86_64_LITERAL", line: 7 }]);
});

test("byte-size parser accepts the task and CLI units", () => {
  assert.equal(parseByteSize("8G"), 8 * 1024 ** 3);
  assert.equal(parseByteSize("20GiB"), 20 * 1024 ** 3);
  assert.equal(parseByteSize("bad"), null);
});

async function createDatasetFixture() {
  const root = await mkdtemp(join(tmpdir(), "skillscope-senior-audit-"));
  await mkdir(join(root, "tasks"));
  return root;
}

async function createTask(root, taskId, { dockerfile, cpus, memory, storage, validation }) {
  const taskRoot = join(root, "tasks", taskId);
  await mkdir(join(taskRoot, "environment"), { recursive: true });
  await mkdir(join(taskRoot, "solution"), { recursive: true });
  await mkdir(join(taskRoot, "tests", "verify"), { recursive: true });
  await mkdir(join(taskRoot, "tests", "judge"), { recursive: true });
  await writeFile(join(taskRoot, "environment", "Dockerfile"), dockerfile);
  await writeFile(join(taskRoot, "task.toml"), [
    'version = "1.0"',
    "[task]",
    `name = "fixture/${taskId}"`,
    "[environment]",
    `base_image = "${taskId}:latest"`,
    "build_timeout_sec = 1800.0",
    `cpus = ${cpus}`,
    `memory = "${memory}"`,
    `storage = "${storage}"`,
    'network_mode = "public"',
    "[verifier]",
    "timeout_sec = 600.0",
    'network_mode = "public"',
    "[solution.env]",
    'SECRET = "forbidden"',
    "",
  ].join("\n"));
  await writeFile(join(taskRoot, "instruction.md"), "FORBIDDEN INSTRUCTION BODY");
  await writeFile(join(taskRoot, "solution", "oracle.patch"), "FORBIDDEN ORACLE BODY");
  await writeFile(join(taskRoot, "tests", "judge", "oracle.patch"), "FORBIDDEN TEST ORACLE BODY");
  for (const relative of ["tests/test-setup.sh", "tests/test.sh", "tests/run_verify.py", "tests/verify/check.py"]) {
    await writeFile(join(taskRoot, relative), "FORBIDDEN TEST BODY");
  }
  if (validation) {
    await mkdir(join(taskRoot, "tests", "validate"), { recursive: true });
    await writeFile(join(taskRoot, "tests", "run_validate.py"), "FORBIDDEN VALIDATION BODY");
    await writeFile(join(taskRoot, "tests", "validate", "validation_spec.toml"), "FORBIDDEN VALIDATION SPEC");
  }
}

async function protectForbiddenBodies(root, taskId) {
  const taskRoot = join(root, "tasks", taskId);
  for (const relative of [
    "instruction.md",
    "solution/oracle.patch",
    "tests/judge/oracle.patch",
    "tests/test-setup.sh",
    "tests/test.sh",
    "tests/run_verify.py",
    "tests/verify/check.py",
    "tests/run_validate.py",
    "tests/validate/validation_spec.toml",
  ]) await chmod(join(taskRoot, relative), 0o000);
}

async function makeForbiddenBodiesReadable(root, taskId) {
  const taskRoot = join(root, "tasks", taskId);
  for (const relative of [
    "instruction.md",
    "solution/oracle.patch",
    "tests/judge/oracle.patch",
    "tests/test-setup.sh",
    "tests/test.sh",
    "tests/run_verify.py",
    "tests/verify/check.py",
    "tests/run_validate.py",
    "tests/validate/validation_spec.toml",
  ]) await chmod(join(taskRoot, relative), 0o600);
}

async function snapshotPaths(root) {
  const results = [];
  async function visit(path, relative = "") {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelative = join(relative, entry.name);
      results.push(`${entry.isDirectory() ? "d" : "f"}:${childRelative}`);
      if (entry.isDirectory()) await visit(join(path, entry.name), childRelative);
    }
  }
  await visit(root);
  return results;
}
