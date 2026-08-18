import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { TASK_SCHEMA_VERSION, hashJson } from "./protocol.mjs";

const taskPath = fileURLToPath(new URL("../tasks/cases.json", import.meta.url));

export async function loadFamilies() {
  const parsed = JSON.parse(await readFile(taskPath, "utf8"));
  validateCorpus(parsed);
  return parsed.families.map((family) => Object.freeze({ ...family }));
}

export function materializePackets(family, sentinel) {
  if (!/^CHILD_CONTEXT_SENTINEL_[A-F0-9]+$/u.test(sentinel)) {
    throw new Error("sentinel must be a fresh uppercase hexadecimal child-context marker");
  }
  const constraintPath = `evidence/${family.id}-constraint.txt`;
  const observationPath = `evidence/${family.id}-observation.txt`;
  const constraint = packet({
    kind: "constraint",
    authoritativeLine: `AUTHORITATIVE_CONSTRAINT_FACT: ${family.constraintFact}`,
    context: family.constraintContext,
    sentinel,
    familyId: family.id,
  });
  const observation = packet({
    kind: "observation",
    authoritativeLine: `AUTHORITATIVE_OBSERVATION_FACT: ${family.observationFact}`,
    context: family.observationContext,
    sentinel,
    familyId: family.id,
  });
  return {
    constraintPath,
    observationPath,
    files: { [constraintPath]: constraint, [observationPath]: observation },
    bytes: Buffer.byteLength(constraint) + Buffer.byteLength(observation),
  };
}

export function validateCorpus(parsed) {
  if (!parsed || parsed.schemaVersion !== TASK_SCHEMA_VERSION || !Array.isArray(parsed.families)) {
    throw new Error(`Task corpus must use ${TASK_SCHEMA_VERSION}`);
  }
  if (parsed.families.length !== 5) throw new Error("Task corpus must contain exactly five workflow families");
  const ids = new Set();
  for (const family of parsed.families) {
    const keys = ["id", "question", "decisionRule", "constraintFact", "observationFact", "expectedDecision", "constraintContext", "observationContext"];
    for (const key of keys) if (typeof family[key] !== "string" || family[key].length === 0) throw new Error(`${family.id ?? "family"}.${key} is required`);
    if (ids.has(family.id)) throw new Error(`Duplicate family id ${family.id}`);
    ids.add(family.id);
    if (!/^[a-z0-9-]+$/u.test(family.id)) throw new Error(`Invalid family id ${family.id}`);
    if (!['ALLOW', 'BLOCK'].includes(family.expectedDecision)) throw new Error(`${family.id}.expectedDecision is invalid`);
  }
  return true;
}

export function corpusHash(families) {
  return hashJson(families);
}

function packet({ kind, authoritativeLine, context, sentinel, familyId }) {
  const lines = [
    `PACKET_KIND: ${kind}`,
    `WORKFLOW_FAMILY: ${familyId}`,
    authoritativeLine,
    `CONTEXT: ${context}`,
    "BEGIN_UNRELATED_WORK_LOG",
  ];
  for (let index = 1; index <= 120; index += 1) {
    const sequence = String(index).padStart(3, "0");
    lines.push(`worklog-${sequence} component=aux-${index % 11} status=unchanged note=historical-maintenance-record-not-used-for-this-decision`);
    if (index === 60) lines.push(sentinel);
  }
  lines.push("END_UNRELATED_WORK_LOG", authoritativeLine, "END_PACKET", "");
  return lines.join("\n");
}
