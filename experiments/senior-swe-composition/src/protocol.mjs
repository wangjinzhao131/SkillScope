export const PROTOCOL_VERSION = "senior-swe-composition.scripted.v1";

export const CONDITIONS = Object.freeze([
  "INLINE_PERSISTENT",
  "FLAT_DISPOSABLE",
  "COMPOSED_DISPOSABLE",
]);

export const ARMS = Object.freeze({
  INLINE: CONDITIONS[0],
  FLAT: CONDITIONS[1],
  COMPOSED: CONDITIONS[2],
});

export const STAGES = Object.freeze([
  "investigate",
  "implement",
  "review",
  "repair",
]);

export const DEFAULT_STAGE_BUDGET = Object.freeze({
  maxTurns: 40,
  maxToolCalls: 40,
  timeoutMs: 600_000,
  maxResultBytes: 32_768,
});

export function normalizeStageBudget(value = DEFAULT_STAGE_BUDGET) {
  const budget = {
    maxTurns: value.maxTurns,
    maxToolCalls: value.maxToolCalls,
    timeoutMs: value.timeoutMs,
    maxResultBytes: value.maxResultBytes,
  };
  for (const [name, amount] of Object.entries(budget)) {
    if (!Number.isSafeInteger(amount) || amount < 1) throw new Error(`${name} must be a positive safe integer`);
  }
  return Object.freeze(budget);
}

export function assertKnownCondition(condition) {
  if (!CONDITIONS.includes(condition)) throw new Error(`Unknown condition ${condition}`);
}
