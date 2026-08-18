# ResourceSet real-repository snapshot diagnostic

Baseline: `15e6077fc2de32439ffb2c7def2237d3cb63c00b`

Plan hash: `sha256:9b8c8ce821d1cb0658f29b00450808495392fc4d0771fdafe3e133ced4482102`

> Internal real-repository snapshot diagnostic; not an external-validity, SkillScope-vs-Subagent, or production-safety estimate.

| Cell | Eligible | Hard Pass | Errors | Policy failures | Canary visible / exfil | Median tools | Median tokens | Median duration | Median grant/read files | set/search/read calls |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ORACLE_FILES_24 | 12/12 | 9/12 | none | 0 | 0/12 / 0/12 | 6 | 29868.50 | 23090.28 | 2 / 2 | 0 / 3 / 2 |
| EXACT_FILES_24 | 12/12 | 3/12 | MAX_TOOL_CALLS=4; MAX_TURNS=1 | 0 | 0/12 / 0/12 | 20.50 | 122059 | 54716.55 | 24 / 9 | 0 / 11 / 7.50 |
| RESOURCE_SET_24 | 12/12 | 8/12 | MAX_TURNS=1; MISSING_CONTROL_CALL=1 | 0 | 0/12 / 0/12 | 14.50 | 89220 | 47439.92 | 24 / 24 | 3 / 2.50 / 6.50 |
| ROOT_DIRECTORY_24 | 12/12 | 6/12 | INVALID_RESULT=1; MISSING_CONTROL_CALL=2 | 0 | 0/12 / 0/12 | 10 | 61053.50 | 33692.59 | 24 / 24 | 0 / 2.50 / 6.50 |

## Paired exploratory differences

- RESOURCE_SET_24 − EXACT_FILES_24: n=12, Hard Pass +0.42, tools -6.42, tokens -20530.17, duration -4618.52 ms.
- RESOURCE_SET_24 − ROOT_DIRECTORY_24: n=12, Hard Pass +0.17, tools +3.42, tokens +43990.67, duration +11724.37 ms.
- RESOURCE_SET_24 − ORACLE_FILES_24: n=12, Hard Pass -0.08, tools +7.92, tokens +74969.50, duration +27734.04 ms.
- ROOT_DIRECTORY_24 − EXACT_FILES_24: n=12, Hard Pass +0.25, tools -9.83, tokens -64520.83, duration -16342.89 ms.

These paired differences are descriptive over 12 task-repeat clusters; they are not significance or non-inferiority claims.

