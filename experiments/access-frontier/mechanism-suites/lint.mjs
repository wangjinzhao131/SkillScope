#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { Check, Errors } from "typebox/value";

const suiteRoot = path.dirname(new URL(import.meta.url).pathname);
const taskRoot = path.resolve(suiteRoot, "../tasks/cases");
const suite = JSON.parse(await fs.readFile(path.join(suiteRoot, "forced-undergrant.v1.json"), "utf8"));
const schema = JSON.parse(await fs.readFile(path.join(suiteRoot, "forced-undergrant.schema.json"), "utf8"));
const failures = [];

if (!Check(schema, suite)) {
  for (const error of [...Errors(schema, suite)]) {
    failures.push(`schema ${error.instancePath || "/"}: ${error.message}`);
  }
}

const covers = (grant, filePath) => grant.kind === "file"
  ? grant.path === filePath
  : filePath.startsWith(grant.path.endsWith("/") ? grant.path : `${grant.path}/`);
const isWithin = (grant, envelope) => {
  const pathCovered = envelope.kind === "file"
    ? grant.kind === "file" && grant.path === envelope.path
    : grant.path === envelope.path
      || grant.path.startsWith(envelope.path.endsWith("/") ? envelope.path : `${envelope.path}/`);
  return pathCovered && grant.operations.every((operation) => envelope.operations.includes(operation));
};

const arms = new Map(suite.arms.map((arm) => [arm.id, arm]));
if (arms.size !== 2) failures.push("arms must have two distinct ids");
if (arms.get("FORCED_UNDERGRANT_NO_EXPANSION")?.allowResourceRequest !== false
  || arms.get("FORCED_UNDERGRANT_NO_EXPANSION")?.freshRerunAfterApproval !== false) {
  failures.push("no-expansion arm must forbid requests and reruns");
}
if (arms.get("FORCED_UNDERGRANT_NEED_RESOURCE")?.allowResourceRequest !== true
  || arms.get("FORCED_UNDERGRANT_NEED_RESOURCE")?.freshRerunAfterApproval !== true) {
  failures.push("NEED arm must allow one request followed by a fresh rerun");
}

for (const probe of suite.probes) {
  let task;
  try {
    task = JSON.parse(await fs.readFile(path.join(taskRoot, `${probe.taskId}.json`), "utf8")).task;
  } catch (error) {
    failures.push(`${probe.taskId}: cannot load task fixture: ${error.message}`);
    continue;
  }
  const required = new Set(task.requiredEvidence);
  for (const withheld of probe.withheldRequiredEvidence) {
    if (!required.has(withheld)) failures.push(`${probe.taskId}: withheld path is not required evidence: ${withheld}`);
    if (probe.initialGrants.some((grant) => covers(grant, withheld))) {
      failures.push(`${probe.taskId}: initial grant accidentally covers withheld evidence: ${withheld}`);
    }
    if (!probe.requestEnvelope.some((grant) => covers(grant, withheld))) {
      failures.push(`${probe.taskId}: request envelope cannot recover withheld evidence: ${withheld}`);
    }
  }
  const accessibleRequired = [...required].filter((requiredPath) =>
    probe.initialGrants.some((grant) => covers(grant, requiredPath)));
  if (accessibleRequired.length === 0) failures.push(`${probe.taskId}: initial grant must retain some required evidence`);
  if (accessibleRequired.length === required.size) failures.push(`${probe.taskId}: initial grant is not under-granted`);
  for (const grant of probe.initialGrants) {
    if (!task.oracleGrants.some((oracle) => isWithin(grant, oracle))) {
      failures.push(`${probe.taskId}: initial grant is outside the task Oracle grants: ${grant.path}`);
    }
  }
  for (const envelope of probe.requestEnvelope) {
    if (!task.inferredCatalog.some((catalog) => isWithin(envelope, catalog))) {
      failures.push(`${probe.taskId}: request envelope is outside the declared catalog: ${envelope.path}`);
    }
  }
}

if (failures.length) {
  console.error(`Forced-undergrant lint failed with ${failures.length} issue(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Forced-undergrant lint passed: ${suite.probes.length} paired mechanism probes.`);
}
