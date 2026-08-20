export { freshToken, hashBytes, hashJson, seededShuffle, stableStringify } from "../../composition-topology/src/protocol.mjs";

export const PROTOCOL_VERSION = "routing-authority.v1";
export const MODEL = Object.freeze({
  provider: "opencode-go",
  id: "deepseek-v4-flash",
  apiBase: "https://opencode.ai/zen/go/v1",
  piTransport: "openai-completions",
});
export const CONDITIONS = Object.freeze(["MODEL_ROUTED", "RUNTIME_ROUTED"]);
export const REPEATS = 3;
export const PARENT_BUDGET = Object.freeze({ maxTurns: 8, timeoutMs: 180_000 });

export function routeFor(condition, dependencyDirection) {
  if (condition === "MODEL_ROUTED") return "MODEL_ROUTE";
  if (condition !== "RUNTIME_ROUTED") throw new Error(`Unknown condition ${condition}`);
  if (dependencyDirection === "constraint-first") return "CONSTRAINT_FIRST";
  if (dependencyDirection === "observation-first") return "OBSERVATION_FIRST";
  if (dependencyDirection === "independent") return "PARALLEL_JOIN";
  throw new Error(`Unknown dependency direction ${dependencyDirection}`);
}
