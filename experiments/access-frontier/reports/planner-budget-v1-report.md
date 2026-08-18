# Planner output-budget probe

Baseline: `a488a1a5a6b201d72c248570981f0a04158b484c`

Plan hash: `sha256:935110a21a1c4446871e95220f7643d948f2ea27ea2184a450bfa4fbc236ad9b`

> Planner protocol/coverage probe only; a valid tool call is not a worker success or a natural planner-benefit estimate.

| Catalog | max tokens | Eligible | Valid plan | First / repaired | Fallback-all | Coverage among valid | Median selected | Median completion tokens | Finish reasons | Tool-call attempts |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| root | 512 | 10/10 | 10/10 | 10/0 | 0/10 | 10/10 | 1 | 144 | tool_calls=10 | 10/10 |
| root | 1024 | 10/10 | 10/10 | 10/0 | 0/10 | 10/10 | 1 | 162.50 | tool_calls=10 | 10/10 |
| root | 2048 | 10/10 | 10/10 | 10/0 | 0/10 | 10/10 | 1 | 150.50 | tool_calls=10 | 10/10 |
| sharded | 512 | 10/10 | 0/10 | 0/0 | 10/10 | 0/0 | NA | 1024 | length=20 | 0/20 |
| sharded | 1024 | 10/10 | 3/10 | 0/3 | 7/10 | 3/3 | 16 | 2048 | length=17; tool_calls=3 | 3/20 |
| sharded | 2048 | 10/10 | 9/10 | 5/4 | 1/10 | 9/9 | 16 | 2545 | length=6; tool_calls=9 | 9/15 |

A valid `select_grants` call only establishes protocol completion. Coverage is evaluated separately, and neither metric is a worker Hard Pass.

