import { loadFamilies, materializePackets } from "./corpus.mjs";
import { CONDITIONS } from "./protocol.mjs";

export async function runScriptedSmoke() {
  const families = await loadFamilies();
  const sentinel = "CHILD_CONTEXT_SENTINEL_0123456789ABCDEF";
  const checks = [];
  for (const family of families) {
    const packets = materializePackets(family, sentinel);
    const typed = { decision: family.expectedDecision, constraintFact: family.constraintFact, observationFact: family.observationFact };
    for (const condition of CONDITIONS) {
      const parentProjection = condition === "INLINE_PARENT"
        ? `${packets.files[packets.constraintPath]}\n${packets.files[packets.observationPath]}`
        : condition === "EPHEMERAL_FREEFORM"
          ? `decision=${typed.decision}; constraintFact=${typed.constraintFact}; observationFact=${typed.observationFact}`
          : JSON.stringify({ status: "SUCCESS", data: typed });
      checks.push({
        familyId: family.id,
        condition,
        correct: typed.decision === family.expectedDecision && typed.constraintFact === family.constraintFact && typed.observationFact === family.observationFact,
        sentinelVisible: parentProjection.includes(sentinel),
        expectedSentinelVisible: condition === "INLINE_PARENT",
      });
    }
  }
  const ok = checks.every((check) => check.correct && check.sentinelVisible === check.expectedSentinelVisible);
  return { ok, families: families.length, conditions: CONDITIONS.length, checks };
}
