import { readFileSync } from "node:fs";
import { Check, Errors } from "typebox/value";

const TASK_SCHEMA = JSON.parse(readFileSync(
  new URL("../tasks/task.schema.json", import.meta.url),
  "utf8",
));

export function validateFixtureRecord(record, label = "task fixture") {
  if (Check(TASK_SCHEMA, record)) return record;
  const details = [...Errors(TASK_SCHEMA, record)]
    .slice(0, 12)
    .map((error) => `${error.instancePath || "/"}: ${error.message}`)
    .join("; ");
  throw Object.assign(new Error(`${label} does not satisfy task.schema.json: ${details}`), {
    code: "INVALID_TASK_FIXTURE",
  });
}
export function fixtureRecordForTask(task, schemaVersion) {
  const schemaTask = Object.fromEntries(
    Object.entries(task ?? {}).filter(([key]) => key !== "fixtureSchemaVersion"),
  );
  return { schemaVersion, task: schemaTask };
}
