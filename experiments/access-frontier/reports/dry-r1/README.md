# Access-frontier v1 engineering dry pilot

Status: **measurement design rejected; not an architecture comparison**
Run date: 2026-08-18
Model: `deepseek-v4-flash`
Matrix: 14 synthetic tasks × 5 conditions × 1 repeat = 70 jobs

## Why this run is retained

The run completed and exposed a fatal measurement problem before a larger experiment: the worker was asked for arbitrary `answerCode: string` and `facts: object`, while the hidden validator required fixture-author spelling and an exact private object shape. Semantically correct answers could not reliably infer that naming convention. Consequently, the observed 0% semantic/Hard Pass rate is not evidence that the model or SkillScope has zero capability.

This batch also used protocol `access-frontier.v1`, whose manifest did not freeze `apiBase`, and the source tree evolved after the process loaded its modules. It is therefore an engineering dry pilot, not a reproducible or confirmatory batch.

## Mechanical observations

| Measure | Result |
| --- | ---: |
| Jobs / unique job IDs | 70 / 70 |
| Completed submissions | 60 |
| Endogenous protocol/model failures | 10 |
| Provider/network/harness failures | 0 |
| `semanticPass` / `hardPass` | 0 / 70 |
| `policyPass` | 70 / 70 |
| Restricted-condition Canary model-visible | 0 / 56 |
| Project-wide Canary model-visible | 14 / 14 |
| Canary result exfiltration | 0 / 70 |
| NEED_RESOURCE requests | 0 / 14 |

The ten endogenous failures were four `MAX_TOOL_CALLS`, five `INVALID_RESULT`, and one `MISSING_CONTROL_CALL`. All 60 valid submissions failed exact facts matching. This common-mode failure destroys between-condition capability discrimination even though evidence provenance often passed.

`PROJECT_READ_ONLY` Canary visibility is authorized exposure, not a policy bypass: that condition deliberately grants the whole virtual project. The contrast with 0/56 visibility in restricted conditions is retained as exposure evidence. Zero observed result exfiltrations is not a proof of zero leakage probability.

## Hypotheses affected

- H1/H2 capability contrasts: not identifiable because the outcome contract failed in every arm.
- H3 dynamic recovery: not identifiable because no NEED_RESOURCE request occurred.
- H4 grant granularity: not estimable from one pair and no registered pair-family analysis.
- H5 parent-history isolation: not tested; this corpus has only a project out-of-grant Canary.
- H6 strict completion contribution: not tested; every arm used the same strict completion mechanism.

## Design changes required before the next live run

1. Publish a task-level response contract with multiple plausible answer-code choices and an exact facts schema; validate hidden truth against the same contract.
2. Keep natural planner/NEED triggering in the five-arm matrix, but test forced undergrant recovery in a separate randomized mechanism experiment.
3. Freeze endpoint, provider protocol, model, all budgets, protocol version, and implementation revision before manifest creation.
4. Commit and test the implementation before starting a trusted batch; do not edit the loaded source during that batch.
5. Treat any numerical decision threshold added after this run as exploratory unless a subsequent protocol freezes it before data collection.

## Local artifact identity

Raw artifacts are deliberately ignored by Git because they embed hidden fixture truth and unreviewed model output.

- Manifest: 70 lines; SHA-256 `ae3d03eba1c152f1b732bb9b3fc147e1848887b84319ee8256bb274a625020ec`
- Results: 70 lines; SHA-256 `7e5d685f2a2b1e1c7a2e27aa6e969986f86c4e44c4fc9b5d1286d2a314c4d266`

The current analyzer intentionally refuses this manifest because it lacks frozen `apiBase`; no compatibility bypass was used to generate this report.
