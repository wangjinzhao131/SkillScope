import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PREPILOT_TASK_IDS,
  SENIOR_SWE_COMMIT,
  assertLeakFree,
  assertPinnedSeniorDataset,
  buildSelectionRecord,
  parseSeniorTaskToml,
  rankFormalCandidates,
  readSafeTaskTomlPrefix,
  selectFormalTasks,
  selectPrepilotTasks,
  selectionHash,
} from "./selector.mjs";

const fixtureUrl = new URL("./fixtures/selector-task.toml", import.meta.url);

test("task.toml parser retains only the selection whitelist", async () => {
  const task = parseSeniorTaskToml(await readFile(fixtureUrl, "utf8"), { taskId: "fixture-investigate-task" });
  assert.deepEqual(Object.keys(task).sort(), ["agent", "datasetVersion", "environment", "id", "language", "repo", "segment", "tags", "taskName", "variant", "verifier", "visibility"].sort());
  assert.equal(task.language, "typescript");
  assert.equal(task.environment.buildTimeoutSec, 300);
  const serialized = JSON.stringify(task);
  assert.doesNotMatch(serialized, /LEAK_CANARY/u);
  assert.doesNotMatch(serialized, /solution|oracle|leaderboard/iu);
  assert.equal(assertLeakFree(task), true);
});

test("dataset reader stops before narrative and answer bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "skillscope-senior-safe-prefix-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "task.toml");
  const source = await readFile(fixtureUrl, "utf8");
  await writeFile(path, source);
  const prefix = await readSafeTaskTomlPrefix(path);
  assert.match(prefix, /\[metadata\.narrative\]/u);
  assert.doesNotMatch(prefix, /LEAK_CANARY/u);
  assert.ok(Buffer.byteLength(prefix) < Buffer.byteLength(source));
});

test("parser rejects a task directory/name mismatch", async () => {
  const source = await readFile(fixtureUrl, "utf8");
  assert.throws(() => parseSeniorTaskToml(source, { taskId: "renamed-task" }), /does not match/u);
});

test("prepilot is exactly the two frozen cross-repo, cross-language tasks", () => {
  const tasks = [
    fakeTask(PREPILOT_TASK_IDS[0], { repo: "better-auth", language: "typescript" }),
    fakeTask(PREPILOT_TASK_IDS[1], { repo: "posthog", language: "python" }),
    fakeTask("extra", { repo: "elsewhere", language: "go" }),
  ];
  assert.deepEqual(selectPrepilotTasks(tasks).map((task) => task.id), PREPILOT_TASK_IDS);
});

test("formal order freezes before qualification and selection only skips failed candidates", () => {
  const tasks = [
    fakeTask(PREPILOT_TASK_IDS[0], { repo: "better-auth", language: "typescript" }),
    fakeTask(PREPILOT_TASK_IDS[1], { repo: "posthog", language: "python" }),
    fakeTask("python-slow", { repo: "repo-a", language: "python", build: 300, verify: 100 }),
    fakeTask("python-fast", { repo: "repo-b", language: "python", build: 10, verify: 10 }),
    fakeTask("go-fast", { repo: "repo-c", language: "go", build: 20, verify: 10 }),
    fakeTask("typescript-fast", { repo: "repo-d", language: "typescript", build: 30, verify: 10 }),
    fakeTask("elixir-slow", { repo: "repo-e", language: "elixir", build: 500, verify: 100 }),
    fakeTask("same-repo-rust", { repo: "repo-c", language: "rust", build: 1, verify: 1 }),
    fakeTask("too-long", { repo: "repo-f", language: "java", build: 1, verify: 601 }),
    fakeTask("wrong-segment", { repo: "repo-g", language: "c", segment: "design", build: 1, verify: 1 }),
  ];
  const qualifiedTaskIds = tasks.map((task) => task.id);
  const ranked = rankFormalCandidates(tasks);
  const selected = selectFormalTasks(tasks, { qualifiedTaskIds, count: 3 });
  assert.equal(new Set(selected.map((task) => task.repo)).size, 3);
  assert.equal(new Set(selected.map((task) => task.language)).size, 3);
  assert.equal(selected.some((task) => PREPILOT_TASK_IDS.includes(task.id)), false);
  assert.equal(selected.some((task) => task.id === "too-long" || task.id === "wrong-segment"), false);
  assert.deepEqual(selected.map((task) => task.id), ranked.slice(0, 3).map((task) => task.id));
  const withoutFirst = qualifiedTaskIds.filter((id) => id !== ranked[0].id);
  assert.deepEqual(
    selectFormalTasks(tasks, { qualifiedTaskIds: withoutFirst, count: 2 }).map((task) => task.id),
    ranked.filter((task) => withoutFirst.includes(task.id)).filter((task, index, array) => array.findIndex((candidate) => candidate.repo === task.repo) === index).slice(0, 2).map((task) => task.id),
  );
  assert.throws(() => selectFormalTasks(tasks, { qualifiedTaskIds: [], count: 3 }), /environment qualification/u);
  assert.equal(rankFormalCandidates(tasks, { armPortTaskIds: ["go-fast"] }).at(-1).id, "go-fast");
});

test("selection record contains pinned provenance and no answer-bearing fields", () => {
  const tasks = [
    fakeTask(PREPILOT_TASK_IDS[0], { repo: "better-auth", language: "typescript" }),
    fakeTask(PREPILOT_TASK_IDS[1], { repo: "posthog", language: "python" }),
    fakeTask("formal-go", { repo: "gitea", language: "go" }),
  ];
  const record = buildSelectionRecord(tasks, { qualifiedTaskIds: ["formal-go"], formalCount: 1 });
  assert.equal(record.dataset.commit, SENIOR_SWE_COMMIT);
  assert.doesNotMatch(JSON.stringify(record), /solution|oracle|leaderboard/iu);
  assert.throws(() => assertLeakFree({ nested: { oraclePatch: "secret" } }), /Forbidden answer-bearing key/u);
});

test("dataset checkout rejects any commit other than the frozen upstream commit", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "skillscope-senior-selector-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await runGit(directory, ["init"]);
  await assert.rejects(assertPinnedSeniorDataset(directory), /not a readable git checkout|commit mismatch/u);
});

function fakeTask(id, { repo, language, segment = "investigate", visibility = "public", build = 100, verify = 100 } = {}) {
  return {
    id,
    taskName: `snorkel-ai/${id}`,
    repo: repo ?? id,
    segment,
    language: language ?? "python",
    variant: "hard",
    visibility,
    datasetVersion: "2026.06",
    tags: [language ?? "python"],
    environment: { baseImage: `${id}:latest`, buildTimeoutSec: build, cpus: 4, memory: "8G", storage: "20G", networkMode: "public" },
    verifier: { timeoutSec: verify, networkMode: "public" },
    agent: { timeoutSec: 7200, networkMode: "allowlist" },
  };
}

async function runGit(directory, args) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("git", ["-C", directory, ...args]);
}
