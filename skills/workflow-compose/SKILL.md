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
  observation with that result copied into `input.upstream`.
- `OBSERVATION_FIRST`: the reverse.
- `ADAPTIVE_ORDER`: infer from `routingCue` which role can be resolved without
  the other; call it first, then pass its typed result to the other call.

Each child input has only `question`, `role`, `path`, and optional `upstream`.
Do not pass the decision rule, routing cue, other path, or invented fields.

After both results are visible, apply `decisionRule` exactly. If either result is
not `SUCCESS` or its data is not `RESOLVED`, return `ABSTAIN` and use `UNKNOWN`
for the unresolved fact. Otherwise return both exact values and `ALLOW` or
`BLOCK`. Set `observedFirstRole` to `parallel` for the parallel batch, otherwise
to the role actually called first; set `upstreamPassedToSecond` to whether the
second child input contained the first typed result.

Call `scope_complete` alone on a later turn. Cite both child results with
`scope://<child scopeId>`. Never copy child messages, packet text, candidates,
work logs, or sentinels.
