# Senior SWE 正式组合 Pilot 预注册 v1

状态：**QUALIFICATION ORDER FROZEN / FORMAL TASK SET NOT YET SELECTED / NO FORMAL MODEL CALLS**

日期：2026-08-22（Asia/Shanghai）

模型：`opencode-go/deepseek-v4-flash`，temperature 0

数据：Senior SWE-Bench v2026.06.2，commit `1212f23a662d2e8d3f321b174735a80be1fdf2e2`

## 1. 研究问题

在真实长程修复任务上，相同的investigate→implement→review→repair原子Skill，以下三种组合是否改变：

1. 父会话和工作会话上下文占用；
2. 完成四阶段并形成可验证patch的概率；
3. 原生任务成绩；
4. 同一任务重复运行的一致性；
5. 总tokens与wall time。

三臂不变：

- `INLINE_PERSISTENT`：四阶段历史留在根会话；
- `FLAT_DISPOSABLE`：四阶段留在一个结束后销毁的worker；
- `COMPOSED_DISPOSABLE`：main调用四个fresh disposable leaf，只跨边界传Runtime-valid typed result与artifact handle。

Runtime checkpoint对三臂相同：工作阶段未提交completion时，repo工具关闭，只保留当前completion；每阶段600秒总预算、工作40 turns/40 tools、checkpoint 4 turns/1 tool/120秒。没有某一臂专属reviewer、重试、投票、工具或上下文。

## 2. 为什么是4任务×3臂×2重复

v3三条完整真实链路中位用时765.4秒（12.8分钟）。24个task-arm预计约5.1小时模型wall time，留出环境资格、外部故障和分析后仍显著低于17小时停止线。

选择4个不同repo/主要语言的任务，每题每臂2次，共`4 × 3 × 2 = 24` jobs。两次重复不是为了显著性检验，而是因为v3同seed仍产生不同诊断与patch；至少两次才能观察臂内一致性。该正式Pilot给出效应方向和成本范围，不声称是最终定论。

## 3. 任务不能按模型成绩选择

数据选择器只读answer-safe `task.toml` prefix。所有prepilot/capability任务继续排除：

```text
better-auth-fix-api-key-run
posthog-fix-llm-gateway-add
electric-fix-elixir-client-cache
```

静态ARM审计后，正式候选顺序在任何正式任务gold/no-op资格结果和任何正式模型调用前冻结：

1. `prefect-fix-resolve-race-condition` — prefect / Python / native
2. `firezone-fix-connlib-align-device` — firezone / Rust / native
3. `better-auth-fix-resolve-dynamic-baseurl` — better-auth / TypeScript / native
4. `electric-perf-array-filter-eval` — electric / Elixir / native
5. `paperless-ngx-perf-document-counts` — paperless-ngx / Python / native
6. `prefect-fix-task-run-recorder` — prefect / Python / native
7. `paperless-ngx-perf-workflow-queries` — paperless-ngx / Python / native
8. `better-auth-fix-oauth-provider-return` — better-auth / TypeScript / native
9. `electric-fix-resolve-pending-shapes` — electric / Elixir / native
10. `better-auth-fix-api-return-response` — better-auth / TypeScript / native
11. `gitea-fix-codeql-code-scanning` — gitea / Go / `ARM_PORT`
12. `gitea-fix-force-push-timeline` — gitea / Go / `ARM_PORT`
13. `gitea-fix-diff-highlight-overlap` — gitea / Go / `ARM_PORT`

资格严格按顺序推进，直到前四个repo互不相同的通过项形成任务集。早期候选失败可以跳过，但不能在通过项中按题目内容、gold难度、模型预期或环境速度重排。每个repo最多一题。

## 4. 每题资格门

每题必须：

- 静态资源不超过4 CPU、8GB、120GB，verifier timeout≤600秒；
- solver image在ARM64可断网启动，固定base commit，工作树干净，不含`/tests`、`/solution`；
- verifier sibling只增加上游公开`tests/test.sh`声明的runner依赖；
- 3次no-op都不能native pass，3次官方gold都必须native pass；
- 6次均infrastructure valid、runner error为空；
- 单次资格超出题目声明build/verifier timeout即失败，不因接近完成放宽。

环境窄移植只能在原Dockerfile真实失败后进行，必须保持依赖、lock、base commit、源码、tests、solution和verifier不变，并记录原/派生/replacement SHA-256与原因。`ENV_BUILD_PORT`和`ARM_PORT`分层报告，不伪装成原生环境。

## 5. 正式矩阵与顺序

两次repeat使用由`sha256("skillscope-senior-formal-v1:" + taskId + ":" + repeat)`导出的seed；同一task-repeat的三臂共享seed。24 jobs按job identity SHA-256全局排序，一次生成manifest；实现dirty、任务集不满4题、镜像ID漂移或资格记录不完整都拒绝生成。

普通能力失败不重跑。真正provider/network外部失败最多从clean state重试一次，保留旧记录并显式supersede。单进程、single writer运行，防止资源竞争成为处理因素。

## 6. 指标与解释

主要结果按task-repeat配对报告：

- native verifier pass和`passed/total`分数；
- 4阶段完成、非空patch、进入有效verifier；
- root final/AUC bytes；
- active worker/coordinator final/AUC bytes；
- API calls、input/output/cache/total tokens、cost、wall time；
- checkpoint使用阶段数；
- 生命周期、泄漏；
- 同一task-arm两次native pass一致、分数绝对差、失败阶段一致性。

主要比较：Flat−Inline、Composed−Inline、Composed−Flat。上下文与成本使用配对中位数和每task-repeat明细；native pass给出计数和配对差，不在8个block上依赖渐近p值。任何一臂若完成链路率明显更低，不能只用成功子集比较上下文或成本。

预定解释：

- Flat与Composed均保护root，但只有Composed降低worker/coordinator AUC：支持fresh leaf分段；
- Composed上下文更小且native/完成率不差：支持继续扩样；
- Composed上下文更小但native、完成率或时间明显变差：结论是上下文换任务/时间成本；
- Flat≈Composed：只支持单disposable worker，当前多leaf组合没有额外收益；
- repeat差异接近或大于臂间差异：先增加重复，不宣称组合效果。

## 7. 停止条件

- 无法得到4个repo互异的合格任务：不生成正式manifest；
- 任一正式镜像或源码hash与manifest不符：停止；
- 累计wall time达到17小时：完成当前job后停止，未运行项记为计划未执行，不换题；
- solution/tests/gold/secret/Sentinel/child transcript泄漏：立即停止并作废受影响运行；
- 分析器不能一一匹配24个job或存在未解释重复：不出效果结论。

该Pilot只在任务资格全部完成、任务集机械选出、clean implementation commit与一次性manifest落盘后才允许调用正式任务模型。
