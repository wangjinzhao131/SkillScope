import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  JsonlWriter,
  readJsonLines,
} from "../../experiments/access-frontier/src/jsonl.mjs";

test("one JsonlWriter serializes concurrent appends into complete records", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "skillscope-audit-jsonl-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "results.jsonl");
  const writer = new JsonlWriter(path);
  const expected = Array.from({ length: 64 }, (_, index) => ({ index, payload: "x".repeat(index) }));

  await Promise.all(expected.map((value) => writer.append(value)));
  await writer.close();

  assert.deepEqual(await readJsonLines(path), expected);
  const text = await readFile(path, "utf8");
  assert.equal(text.endsWith("\n"), true);
  assert.equal(text.trimEnd().split("\n").length, expected.length);
});

test("resume quarantines a crash-truncated final JSONL record and preserves valid rows", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "skillscope-audit-jsonl-tail-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "results.jsonl");
  await writeFile(path, "{\"complete\":true}\n{\"truncated\":", { mode: 0o600 });
  let recovery;

  const rows = await readJsonLines(path, {
    recoverTruncatedTail: true,
    onRecovery(event) { recovery = event; },
  });

  assert.deepEqual(rows, [{ complete: true }]);
  assert.equal(await readFile(path, "utf8"), "{\"complete\":true}\n");
  assert.ok(recovery?.quarantinePath);
  assert.equal(await readFile(recovery.quarantinePath, "utf8"), "{\"truncated\":");
});

test("resume does not hide a malformed non-tail JSONL record", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "skillscope-audit-jsonl-middle-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "results.jsonl");
  await writeFile(path, "{bad}\n{\"complete\":true}\n", { mode: 0o600 });

  await assert.rejects(
    readJsonLines(path, { recoverTruncatedTail: true }),
    /invalid JSONL/,
  );
});

test.todo("multiple OS processes need an explicit single-writer or locking invariant");
