import { loadFamilies } from "./corpus.mjs";
import { CONDITIONS, routeFor } from "./protocol.mjs";

export async function runScriptedSmoke() {
  const families = await loadFamilies(); const checks = [];
  for (const family of families) for (const condition of CONDITIONS) {
    const compositionMode = routeFor(condition, family.dependencyDirection);
    const order = orderFor(family, compositionMode);
    const results = order[0] === "parallel"
      ? { constraint: resolvePacket(family.constraintPacket, "constraint"), observation: resolvePacket(family.observationPacket, "observation") }
      : serialResults(family, order);
    const hardPass = results.constraint.resolution === "RESOLVED" && results.observation.resolution === "RESOLVED" && results.constraint.value === family.constraintFact && results.observation.value === family.observationFact;
    checks.push({ familyId: family.id, dependencyDirection: family.dependencyDirection, condition, compositionMode, firstRole: order[0], hardPass });
  }
  return { ok: checks.every((check) => check.hardPass), families: families.length, conditions: CONDITIONS.length, checks };
}

function serialResults(family, order) { const first = resolvePacket(family[`${order[0]}Packet`], order[0]); const second = resolvePacket(family[`${order[1]}Packet`], order[1], first); return { [order[0]]: first, [order[1]]: second }; }

function orderFor(family, mode) {
  if (mode === "PARALLEL_JOIN" || (mode === "MODEL_ROUTE" && family.dependencyDirection === "independent")) return ["parallel", "parallel"];
  if (mode === "OBSERVATION_FIRST" || (mode === "MODEL_ROUTE" && family.dependencyDirection === "observation-first")) return ["observation", "constraint"];
  return ["constraint", "observation"];
}
function resolvePacket(spec, role, upstream) {
  if (spec.mode === "INDEPENDENT") return { role, resolution: "RESOLVED", key: spec.primaryKey, value: spec.primaryValue };
  if (!upstream || upstream.role !== spec.requiredUpstreamRole || upstream.resolution !== "RESOLVED") return { role, resolution: "AMBIGUOUS", key: "UNKNOWN", value: "UNKNOWN" };
  return { role, resolution: "RESOLVED", key: upstream.key, value: spec.entries[upstream.key] ?? "UNKNOWN" };
}
