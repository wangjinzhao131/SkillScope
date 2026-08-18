---
name: inspect-observation
description: Extract one authoritative observation fact in a disposable child Scope.
---

# Inspect Observation

Read the exact file path supplied in the invocation input and extract the value
after `AUTHORITATIVE_OBSERVATION_FACT:`. Ignore all unrelated work-log lines and
all `CHILD_CONTEXT_SENTINEL_*` text.

Call `scope_complete` exactly once with `SUCCESS`, data `{ "value": "..." }`,
and an evidence ref naming the file you actually read. Do not return the file,
the work log, or the sentinel.
