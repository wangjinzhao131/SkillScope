---
name: workflow-compose
description: Compose two calls to the same contextual evidence Skill using a frozen parallel, serial, or adaptive topology.
---

# Compose Contextual Evidence

Call `inspect-contextual-evidence` exactly twice, once for each role and exact
path. Every call uses `BOUNDED` with only its matching exact-file `read` grant.
Never read evidence yourself and never call a third child.

Follow `compositionMode` exactly:

- `PARALLEL_JOIN`: issue both calls in one tool batch; neither input has
  `upstream`.
- `CONSTRAINT_FIRST`: call constraint alone; after seeing its typed result, call
  observation with only the four business fields from that result copied into
  `input.upstream`.
- `OBSERVATION_FIRST`: the reverse.
- `ADAPTIVE_ORDER`: infer from `routingCue` which role can be resolved without
  the other; call it first, then pass its typed result to the other call.
- `MODEL_ROUTE`: infer the full topology from `routingCue`. Use
  constraint-first or observation-first for one-way dependencies, and use the
  parallel batch when the cue says the packets are independent.

Each child input has only `question`, `role`, `path`, and optional `upstream`.
When present, `upstream` has exactly this shape and no additional keys:

```json
{"role":"constraint","resolution":"RESOLVED","key":"<exact key>","value":"<exact value>"}
```

or the same four fields with role `observation`. Never copy `upstreamPassed`,
`scopeId`, status, summary, evidence, warnings, errors, or any Runtime-owned
field into `input.upstream`. Do not pass the decision rule, routing cue, other
path, or invented fields.

For every non-parallel mode, always make the second call and always include the
four-field `upstream`, even when the first result is `AMBIGUOUS` with
`UNKNOWN` values. Do not optimize away the edge, retry the first role, swap the
frozen order, or request more resources.

After both results are visible, apply `decisionRule` exactly. If either result is
not `SUCCESS` or its data is not `RESOLVED`, return `ABSTAIN` and use `UNKNOWN`
for the unresolved fact. Otherwise return both exact values and `ALLOW` or
`BLOCK`. Set `observedFirstRole` to `parallel` for the parallel batch, otherwise
to the role actually called first; set `upstreamPassedToSecond` to whether the
second child input contained the first typed result.

Call `scope_complete` alone on a later turn. When both children are resolved,
use status `SUCCESS`; when either is ambiguous, use status `PARTIAL` with the
required data fields and `ABSTAIN`. In both cases omit `requestedResources`
entirely and submit `evidenceRefs: []`: Runtime binds canonical evidence for the
actual child results. Never copy scope IDs, child messages, packet text,
candidates, work logs, or sentinels.
