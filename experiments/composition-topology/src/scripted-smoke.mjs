import { CONDITIONS } from "./protocol.mjs";
import { loadFamilies } from "./corpus.mjs";

export async function runScriptedSmoke() {
  const families = await loadFamilies();
  const checks = [];
  for (const family of families) for (const condition of CONDITIONS) {
    const outcome = simulate(family, condition);
    const expectedHardPass = family.dependencyDirection === "independent"
      || condition === "ADAPTIVE_ORDER"
      || (family.dependencyDirection === "constraint-first" && condition === "CONSTRAINT_FIRST")
      || (family.dependencyDirection === "observation-first" && condition === "OBSERVATION_FIRST");
    checks.push({ familyId: family.id, dependencyDirection: family.dependencyDirection, condition, hardPass: outcome.hardPass, expectedHardPass, firstRole: outcome.firstRole });
  }
  return { ok: checks.every((check) => check.hardPass === check.expectedHardPass), families: families.length, conditions: CONDITIONS.length, checks };
}

function simulate(family, condition) {
  const order = orderFor(family, condition);
  const first = resolvePacket(family[`${order[0]}Packet`], order[0]);
  const second = resolvePacket(family[`${order[1]}Packet`], order[1], condition === "PARALLEL_JOIN" ? undefined : first);
  const results = { [order[0]]: first, [order[1]]: second };
  const hardPass = results.constraint.resolution === "RESOLVED"
    && results.observation.resolution === "RESOLVED"
    && results.constraint.value === family.constraintFact
    && results.observation.value === family.observationFact;
  return { hardPass, firstRole: condition === "PARALLEL_JOIN" ? "parallel" : order[0] };
}

function orderFor(family, condition) {
  if (condition === "OBSERVATION_FIRST") return ["observation", "constraint"];
  if (condition === "ADAPTIVE_ORDER" && family.dependencyDirection === "observation-first") return ["observation", "constraint"];
  return ["constraint", "observation"];
}

function resolvePacket(spec, role, upstream) {
  if (spec.mode === "INDEPENDENT") return { role, resolution: "RESOLVED", key: spec.primaryKey, value: spec.primaryValue };
  if (!upstream || upstream.role !== spec.requiredUpstreamRole || upstream.resolution !== "RESOLVED") return { role, resolution: "AMBIGUOUS", key: "UNKNOWN", value: "UNKNOWN" };
  return { role, resolution: "RESOLVED", key: upstream.key, value: spec.entries[upstream.key] ?? "UNKNOWN" };
}
