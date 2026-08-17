import { mkdir, open, readFile, readdir, rename, stat, truncate, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, extname, join } from "node:path";
import { validateFixtureRecord } from "./task-validator.mjs";

export async function readJsonLines(path, { allowMissing = false, recoverTruncatedTail = false, onRecovery } = {}) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return [];
    throw error;
  }
  const text = bytes.toString("utf8");
  const values = [];
  const lines = text.split(/\r?\n/);
  const endsWithNewline = bytes.length === 0 || bytes.at(-1) === 0x0a;
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    try {
      values.push(JSON.parse(line));
    } catch (error) {
      const isRecoverableTail = recoverTruncatedTail && !endsWithNewline && index === lines.length - 1;
      if (isRecoverableTail) {
        const lastNewline = bytes.lastIndexOf(0x0a);
        const validLength = lastNewline + 1;
        const tail = bytes.subarray(validLength);
        const quarantinePath = `${path}.corrupt-tail-${Date.now()}-${randomUUID()}`;
        await durableWrite(quarantinePath, tail, { exclusive: true });
        await truncate(path, validLength);
        const handle = await open(path, "r+");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        onRecovery?.({ path, quarantinePath, bytes: tail.length, line: index + 1 });
        break;
      }
      throw new SyntaxError(`${path}:${index + 1}: invalid JSONL: ${error.message}`);
    }
  }
  return values;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function loadTasks(inputPath) {
  const info = await stat(inputPath);
  if (info.isDirectory()) {
    const names = (await readdir(inputPath, { recursive: true }))
      .filter((name) => extname(name) === ".json")
      .sort();
    const records = await Promise.all(names.map((name) => readJson(join(inputPath, name))));
    return records.map(unwrapTask);
  }
  if (inputPath.endsWith(".jsonl")) return (await readJsonLines(inputPath)).map(unwrapTask);
  const value = await readJson(inputPath);
  const records = Array.isArray(value) ? value : [value];
  return records.map(unwrapTask);
}

function unwrapTask(record) {
  validateFixtureRecord(record);
  if (record?.task && typeof record.task === "object") {
    Object.defineProperty(record.task, "fixtureSchemaVersion", {
      value: record.schemaVersion,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    return record.task;
  }
  throw new Error("Task input must use the {schemaVersion, task} fixture envelope");
}

export class JsonlWriter {
  #path;
  #chain = Promise.resolve();

  constructor(path) {
    this.#path = path;
  }

  append(value) {
    const line = Buffer.from(`${JSON.stringify(value)}\n`);
    this.#chain = this.#chain.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      const handle = await open(this.#path, "a", 0o600);
      try {
        await writeAll(handle, line);
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    return this.#chain;
  }

  async close() {
    await this.#chain;
  }
}

export async function writeJsonLines(path, values) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${join("", path.split("/").at(-1))}.tmp-${randomUUID()}`);
  const body = Buffer.from(values.map((value) => `${JSON.stringify(value)}\n`).join(""));
  try {
    await durableWrite(temporaryPath, body, { exclusive: true });
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function durableWrite(path, bytes, { exclusive = false } = {}) {
  const handle = await open(path, exclusive ? "wx" : "w", 0o600);
  try {
    await writeAll(handle, bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
    if (bytesWritten <= 0) throw new Error("JSONL write made no forward progress");
    offset += bytesWritten;
  }
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
