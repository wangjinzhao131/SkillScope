# High-search-entropy access-frontier report

Run: `entropy-frontier-v1-pilot`  
Protocol: `entropy-frontier.v1` over `access-frontier.v1.3`  
Baseline: `2aa7aab454e75de101acc18a29d28d73eb1aef73`  
Plan hash: `sha256:7db65be3aa4c18127240d260e49c85e6cc1adba77b32f7459f7c34eca302c223`

> Exploratory high-entropy interface diagnostic; not a production-safety, natural NEED_RESOURCE, or general SkillScope-vs-Subagent estimate.

## Cell summary

| Cell | Eligible | Hard Pass | Policy failures | Canary visible / exfil | Median tools | Median tokens | Median duration ms | Planner fallback | Planner coverage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ORACLE_FILE_24 | 10/10 | 10/10 | 0 | 0/0 | 3 | 4033 | 5775.44 | 0/0 | 10/10 |
| SHARDED_ALL_24 | 10/10 | 0/10 | 0 | 0/0 | 25 | 20249.50 | 21904.71 | 0/10 | 10/10 |
| SHARDED_ALL_40 | 10/10 | 7/10 | 0 | 0/0 | 39.50 | 41980.50 | 33659.61 | 0/10 | 10/10 |
| ROOT_HANDLE_24 | 10/10 | 9/10 | 0 | 0/0 | 11 | 20911 | 20896.04 | 0/10 | 10/10 |
| SHARDED_PLANNER_24 | 10/10 | 0/10 | 0 | 0/0 | 25 | 27485.50 | 32990.77 | 10/10 | 10/10 |

## Paired contrasts

Positive Hard Pass differences favor treatment; negative resource differences mean treatment used less.

| Contrast | Eligible pairs | Hard Pass difference | Mean tool-call difference | Mean token difference | Mean duration difference ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| root_vs_sharded_24 (ROOT_HANDLE_24 − SHARDED_ALL_24) | 10 | 0.90 | -13.20 | -3503.30 | -2084.96 |
| budget_40_vs_24 (SHARDED_ALL_40 − SHARDED_ALL_24) | 10 | 0.70 | 12.50 | 18950.80 | 12450.40 |
| planner_vs_all_24 (SHARDED_PLANNER_24 − SHARDED_ALL_24) | 10 | 0 | 0 | 4696.80 | 12531.53 |
| root_vs_oracle_24 (ROOT_HANDLE_24 − ORACLE_FILE_24) | 10 | -0.10 | 8.40 | 15677.10 | 13573.57 |

## Interpretation boundary

This generated report is descriptive. Inspect task-level rows and raw failure traces before attributing a difference to budget, catalog topology, or planner behavior. Provider/harness exclusions are not capability failures, and Oracle is only a diagnostic upper bound.

