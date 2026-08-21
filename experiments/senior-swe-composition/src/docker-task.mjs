import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;

export class DockerTaskRuntime {
  constructor({ image, repoPath, artifactRoot, cpus = 4, memory = "8g" }) {
    if (!image || !repoPath || !artifactRoot) throw new Error("image, repoPath, and artifactRoot are required");
    this.image = image;
    this.repoPath = repoPath;
    this.artifactRoot = resolve(artifactRoot);
    this.cpus = cpus;
    this.memory = memory;
    this.active = new Set();
  }

  async createStage({ inputPatchPath } = {}) {
    const name = `skillscope-senior-${randomUUID()}`;
    const created = await run("docker", [
      "create", "--name", name, "--network", "none",
      "--cpus", String(this.cpus), "--memory", this.memory,
      "--workdir", this.repoPath, this.image, "sleep", "infinity",
    ]);
    const containerId = created.stdout.trim();
    if (!containerId) throw new Error("docker create returned no container id");
    this.active.add(containerId);
    try {
      await run("docker", ["start", containerId]);
      if (inputPatchPath) {
        const patch = await readFile(inputPatchPath);
        if (patch.length > 0) {
          await runWithInput("docker", ["exec", "-i", "--workdir", this.repoPath, containerId, "git", "apply", "--binary", "-"], patch);
        }
      }
      const sentinel = `SCOPE_SENTINEL_${randomUUID()}`;
      return { containerId, sentinel, createdAt: new Date().toISOString() };
    } catch (error) {
      await this.disposeStage(containerId);
      throw error;
    }
  }

  async exec(containerId, command, { timeoutMs = 120_000 } = {}) {
    this.#assertActive(containerId);
    if (typeof command !== "string" || command.length === 0 || command.length > 16_384) {
      throw new Error("command must be 1..16384 characters");
    }
    const result = await run("docker", ["exec", "--workdir", this.repoPath, containerId, "bash", "-lc", command], {
      timeoutMs,
      allowFailure: true,
      maxOutputBytes: MAX_TOOL_OUTPUT_BYTES,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
    };
  }

  async applyPatchText(containerId, patchText) {
    this.#assertActive(containerId);
    if (typeof patchText !== "string" || patchText.length === 0 || Buffer.byteLength(patchText) > 512 * 1024) {
      throw new Error("patchText must be a non-empty unified diff no larger than 512 KiB");
    }
    const result = await runWithInput("docker", [
      "exec", "-i", "--workdir", this.repoPath, containerId,
      "git", "apply", "--binary", "--whitespace=nowarn", "-",
    ], Buffer.from(patchText, "utf8"), { allowFailure: true, maxOutputBytes: MAX_TOOL_OUTPUT_BYTES });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  async exportPatch(containerId, label) {
    this.#assertActive(containerId);
    const result = await run("docker", [
      "exec", "--workdir", this.repoPath, containerId, "bash", "-lc",
      "git diff --binary \"$(cat /var/lib/devcontainer_base_ref)\" -- . ':(exclude).git'",
    ], { maxOutputBytes: 8 * 1024 * 1024 });
    const bytes = Buffer.from(result.stdout, "utf8");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const safeLabel = String(label).replace(/[^A-Za-z0-9_.-]/gu, "_");
    const directory = join(this.artifactRoot, "sha256", hash.slice(0, 2));
    const path = join(directory, `${hash}-${safeLabel}.patch`);
    await mkdir(directory, { recursive: true });
    await writeFile(path, bytes, { flag: "wx" }).catch(async (error) => {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readFile(path);
      if (!existing.equals(bytes)) throw new Error("content-addressed patch collision");
    });
    const changed = await this.exec(containerId, "git diff --name-only \"$(cat /var/lib/devcontainer_base_ref)\" -- . ':(exclude).git'");
    return {
      artifactRef: `sha256:${hash}`,
      artifactHash: hash,
      artifactBytes: bytes.length,
      changedPaths: changed.stdout.split(/\r?\n/u).filter(Boolean),
      path,
    };
  }

  async disposeStage(containerId) {
    if (!this.active.has(containerId)) return;
    await run("docker", ["rm", "-f", containerId], { allowFailure: true });
    this.active.delete(containerId);
  }

  async dispose() {
    await Promise.all([...this.active].map((id) => this.disposeStage(id)));
  }

  lifecycle() {
    return { activeContainers: [...this.active], activeCount: this.active.size };
  }

  #assertActive(containerId) {
    if (!this.active.has(containerId)) throw new Error("container is not an active stage workspace");
  }
}

export async function runNativeVerifier({ image, repoPath, taskRoot, patchPath, applyGold = false, timeoutMs = 900_000 }) {
  if (Boolean(patchPath) && applyGold) throw new Error("patchPath and applyGold are mutually exclusive");
  const runtime = new DockerTaskRuntime({ image, repoPath, artifactRoot: join(taskRoot, ".unused-artifacts") });
  let stage;
  try {
    stage = await runtime.createStage({ inputPatchPath: patchPath });
    const id = stage.containerId;
    if (applyGold) {
      await run("docker", ["cp", join(taskRoot, "solution"), `${id}:/solution`]);
      const solved = await runtime.exec(id, "bash /solution/solve.sh", { timeoutMs: 120_000 });
      if (solved.exitCode !== 0) throw new Error(`gold patch failed to apply: ${solved.stderr}`);
    }
    await run("docker", ["cp", join(taskRoot, "tests"), `${id}:/tests`]);
    const repoName = basename(repoPath);
    if (!/^[A-Za-z0-9_.-]+$/u.test(repoName)) throw new Error("repoPath basename is not safe for REPO_NAME");
    const command = [
      "set -euo pipefail",
      "mkdir -p /logs/verifier",
      `export REPO_NAME=${repoName}`,
      "source /tests/test-setup.sh",
      "python3 /tests/run_verify.py",
    ].join("\n");
    const execution = await runtime.exec(id, command, { timeoutMs });
    const resultText = await run("docker", ["exec", id, "bash", "-lc", "test -f /logs/verifier/verifier_results.json && cat /logs/verifier/verifier_results.json"], {
      allowFailure: true,
      maxOutputBytes: 2 * 1024 * 1024,
    });
    let verifier;
    try { verifier = JSON.parse(resultText.stdout); }
    catch { verifier = null; }
    const infrastructureValid = execution.exitCode === 0
      && verifier !== null
      && Number.isSafeInteger(verifier.total)
      && verifier.total > 0
      && !verifier.runner_errors;
    return {
      infrastructureValid,
      nativeVerifierPass: infrastructureValid && verifier.all_pass === true && verifier.passed === verifier.total,
      passed: verifier?.passed ?? 0,
      total: verifier?.total ?? 0,
      runnerErrors: verifier?.runner_errors ?? null,
      executionExitCode: execution.exitCode,
      stderrTail: execution.stderr.slice(-4000),
    };
  } finally {
    if (stage) await runtime.disposeStage(stage.containerId);
    await runtime.dispose();
  }
}

async function run(command, args, options = {}) {
  return spawnCaptured(command, args, options);
}

async function runWithInput(command, args, input, options = {}) {
  return spawnCaptured(command, args, { ...options, input });
}

function spawnCaptured(command, args, {
  input,
  timeoutMs = 300_000,
  allowFailure = false,
  maxOutputBytes = 16 * 1024 * 1024,
} = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    const collect = (chunks, counter, chunk) => {
      if (counter.value >= maxOutputBytes) { truncated = true; return; }
      const remaining = maxOutputBytes - counter.value;
      chunks.push(chunk.subarray(0, remaining));
      counter.value += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) truncated = true;
    };
    const stdoutCounter = { value: stdoutBytes };
    const stderrCounter = { value: stderrBytes };
    child.stdout.on("data", (chunk) => collect(stdout, stdoutCounter, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, stderrCounter, chunk));
    if (input) { child.stdin.end(input); }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); rejectPromise(error); });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      const result = {
        exitCode: exitCode ?? 128,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        truncated,
      };
      if (!allowFailure && result.exitCode !== 0) {
        const error = new Error(`${command} ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.slice(-2000)}`);
        error.result = result;
        rejectPromise(error);
      } else resolvePromise(result);
    });
  });
}
