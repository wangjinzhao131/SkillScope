import { createHash, randomBytes } from "node:crypto";

export const PROTOCOL_VERSION = "composition-topology.v1";
export const TASK_SCHEMA_VERSION = "composition-topology.tasks.v1";
export const MODEL = Object.freeze({
  provider: "opencode-go",
  id: "deepseek-v4-flash",
  apiBase: "https://opencode.ai/zen/go/v1",
  piTransport: "openai-completions",
});
export const CONDITIONS = Object.freeze([
  "PARALLEL_JOIN",
  "CONSTRAINT_FIRST",
  "OBSERVATION_FIRST",
  "ADAPTIVE_ORDER",
]);
export const REPEATS = 3;
export const PARENT_BUDGET = Object.freeze({ maxTurns: 8, timeoutMs: 180_000 });

export function hashJson(value) { return hashBytes(Buffer.from(stableStringify(value), "utf8")); }
export function hashBytes(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
export function freshToken(prefix, bytes = 16) { return `${prefix}_${randomBytes(bytes).toString("hex")}`; }
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function seededShuffle(values, seed) {
  const output = [...values];
  let state = uint32(seed);
  for (let index = output.length - 1; index > 0; index -= 1) {
    state = xorshift32(state);
    const target = state % (index + 1);
    [output[index], output[target]] = [output[target], output[index]];
  }
  return output;
}
function uint32(value) { const digest = createHash("sha256").update(String(value)).digest(); return digest.readUInt32LE(0) || 1; }
function xorshift32(value) { let result = value >>> 0; result ^= result << 13; result ^= result >>> 17; result ^= result << 5; return result >>> 0; }
