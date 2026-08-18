# Planner 输出预算实验预注册 v1

状态：**PRE-DATA FROZEN ON CLEAN PLAN**。本文、probe executor 与 planner diagnostics 必须先进入同一 clean commit，之后才生成 descriptor 并调用任务级 planner API。

日期：2026-08-18（Asia/Shanghai）

模型：`deepseek-v4-flash`

端点：`https://opencode.ai/zen/go/v1`

## 1. 触发证据

高搜索熵 50-job Pilot 的 `SHARDED_PLANNER_24` 在 10/10 task-repeat 上都执行 `planner_fallback_all`。每次两轮 planner response 的 completion tokens 都恰好为 512、`rawSelection=null`，错误均为“planner arguments must be an object”。这与 forced `select_grants` 之前输出预算耗尽相容，但现有结果没有保存 finish reason，不能把它直接断言为模型不会使用 planner tool。

本 probe 在看到上述结果后提出，因此是新的机制实验，不属于高搜索熵 Pilot 的预注册对比，也不改写其 0/10 planner cell。

## 2. 因子与样本

使用同一五个语义 task、两个 repeat 和相同 seed，做完全配对的 `catalogMode × plannerMaxTokens`：

- Catalog：`root`（单一 `corpus/` 条目）与 `sharded`（16 个 opaque shard 条目）；
- 每次 planner response 输出预算：512、1024、2048 tokens；
- 共 `5 tasks × 2 repeats × 2 catalog modes × 3 budgets = 60 trials`；
- 每个 trial 最多允许原协议已有的一次 repair，即最多两个 provider calls；温度固定 0。

Probe 只运行 parent-side `select_grants`，不启动 worker，不测最终任务正确率。所有 cell 并发交错；descriptor 在首次 trial 前冻结任务、seed、模型、端点、实现与 suite/source hash。

## 3. 指标与解释

主要指标：每 cell 的 `model_planner` 有效选择率。次要指标：first-attempt success、repair 后 success、fallback-all、finish reason、tool-call presence、completion tokens、选择数量，以及选择是否覆盖两份必要证据。

预定解释：

- 1024/2048 显著恢复有效 tool call：支持输出预算是当前 planner 协议瓶颈；后续 runner 应把 planner budget 独立冻结，而不是复用一个隐含常量。
- Root 在 512 成功而 Sharded 在 512 失败：支持 catalog 宽度与 reasoning/output budget 交互。
- 更高预算得到合法选择但覆盖不足：协议问题已修复，opaque metadata 下的选择不可识别仍是独立问题。
- 所有预算都失败：应检查 `deepseek-v4-flash` forced-tool 行为或改用更小的约束式 planner，不应继续盲目加预算。

本 probe 不能证明 planner 的自然任务收益，也不能把有效 JSON/tool call 等同于正确授权或 worker Hard Pass。
