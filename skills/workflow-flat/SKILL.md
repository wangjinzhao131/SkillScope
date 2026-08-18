---
name: workflow-flat
description: Read two exact evidence packets and return one typed workflow decision.
---

# Flat Workflow Decision

Read both exact paths from the invocation input. Extract the value after
`AUTHORITATIVE_CONSTRAINT_FACT:` and the value after
`AUTHORITATIVE_OBSERVATION_FACT:`. Apply the supplied decision rule exactly.
Ignore unrelated work-log lines and `CHILD_CONTEXT_SENTINEL_*` text.

Call `scope_complete` exactly once with:

- `data.decision`: `ALLOW` or `BLOCK`;
- `data.constraintFact`: the exact extracted constraint value;
- `data.observationFact`: the exact extracted observation value;
- evidence refs for both files.

Do not return either packet or its sentinel.
