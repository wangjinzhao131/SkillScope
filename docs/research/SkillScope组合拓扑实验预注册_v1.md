# SkillScope 组合拓扑实验预注册 v1

状态：**DESIGN FROZEN / NO LIVE DATA。** 本文在新增实验 Skill、Harness 和任何任务模型调用前冻结。实现阶段允许修复代码与协议错误，但首次 live preflight 后不得静默修改任务 truth、主要指标、条件定义或成功标准；任何 outcome-relevant 修订必须换新协议与 manifest。

日期：2026-08-20（Asia/Shanghai）

计划模型：`opencode-go/deepseek-v4-flash`

## 1. 重新对齐根本问题

本轮只研究：

> 固定完全相同的原子 Skill、模型、证据、调用次数、Schema 与预算，只改变 Skill Scope 的执行拓扑和 Runtime-valid 结果的流向，是否能提高任务正确率、重复稳定性和错误控制，同时保持父上下文有界，并量化新增的总 Token 与延迟。

访问 Profile、目录授权、planner、动态补权、ResourceSet、模型选择和普通 Subagent 都不是处理因素。所有 trial 固定 exact-file `BOUNDED` 读取；每次 Skill 调用仍创建不继承历史、执行后销毁的新 Scope。

## 2. 冻结 Skill 与调用不变量

四个条件都使用同一版本的两个 Skill：

- `inspect-contextual-evidence`：同一个原子 Skill 被调用恰好两次，分别读取 constraint 与 observation exact file；它可以接收前一个 Scope 的 compact typed result，但不能看到前一个 Scope 的 messages、工具历史或文件正文。
- `workflow-compose`：同一个 main Skill 被调用恰好一次，按照条件指定的拓扑启动两个原子 Scope，消费 typed result，应用同一 decision rule，并返回同一 output schema。

每个 trial 固定：一个 main Scope、两个 depth-1 child Scopes、两个 exact-file read grants、相同模型 seed、相同 evidence bytes、相同 parent completion schema、相同每 Scope 最大预算。条件之间允许实际 Token 与时延不同，因为它们是结果；不允许通过增加调用数、重试、投票或额外 reviewer 获得优势。

## 3. 四个组合条件

| 条件 | Scope 拓扑 | 第二个原子 Skill 是否收到第一个 typed result |
| --- | --- | --- |
| `PARALLEL_JOIN` | constraint 与 observation 在同一 tool batch 并行，随后 main 汇总 | 否 |
| `CONSTRAINT_FIRST` | constraint → observation → main | 是，即使第一个结果为`AMBIGUOUS`也必须传递四字段投影 |
| `OBSERVATION_FIRST` | observation → constraint → main | 是，即使第一个结果为`AMBIGUOUS`也必须传递四字段投影 |
| `ADAPTIVE_ORDER` | main 只根据公开问题与 routing cue 选择上述两个串行方向 | 是 |

`ADAPTIVE_ORDER` 不增加 router Scope，也不增加叶子调用；选择由已经存在的 main Skill 完成。它必须在方向依赖任务中先调用可以独立解析的 packet。独立对照任务允许任一串行方向。

多数投票、双向都跑、失败重试、review loop 和第三个验证 Skill 被明确排除，留给后续“额外计算是否值得”的产品策略实验。

## 4. 任务机制与语料

冻结六个 family，每个三个 repeat、四个条件，共 `6 × 3 × 4 = 72` 个 live trial：

- 两个 `constraint-first` family：constraint packet 可独立解析，其 key 决定 observation packet 多个候选条目中哪一个有效；
- 两个 `observation-first` family：反方向依赖；
- 两个 `independent` family：两份 packet 都可独立解析，作为负对照。

每个 packet 使用同一公开语法：

- `INDEPENDENT`：给出一个 `PRIMARY_KEY` 与 `PRIMARY_VALUE`；
- `REQUIRES_UPSTREAM`：给出五个 key 不同的 `ENTRY`，只有 key 等于上游 typed result 的条目可选；没有可用上游时必须返回 `AMBIGUOUS/UNKNOWN`，不得猜测。

题目与 routing cue 只说明哪类证据决定另一类证据，不泄漏实际 key、value 或答案。每个 packet 另含等长无关工作记录与新鲜 Sentinel；Sentinel 不参与答案。

这是刻意构造的机制与产品原型实验：它能证明信息流拓扑是否有表达力、main 是否能选对方向，不能直接估计自然工作负载中方向依赖任务的发生率。报告必须把 `direction-matched` 结果与 `independent` 负对照分开。

## 5. 输出契约与正确性

原子 Skill 的 Runtime-valid data 固定包含：

- `role`: `constraint | observation`；
- `resolution`: `RESOLVED | AMBIGUOUS`；
- `key`、`value`: 解析成功时为 packet 中的精确值，否则均为 `UNKNOWN`；
- `upstreamPassed`: 本次调用 input 是否包含前一个 typed result。

main Skill 的 Runtime-valid data 固定包含：

- `decision`: `ALLOW | BLOCK | ABSTAIN`；
- 两个 exact fact，无法解析时为 `UNKNOWN`；
- `observedFirstRole`: `constraint | observation | parallel`；
- `upstreamPassedToSecond`: boolean。

父 Agent 在所有条件都只能看到 main 的 compact result，并通过同一个严格 `parent_complete` 提交决定、两个 fact 与初始 memory code。

`Parent Hard Pass` 要求 decision、两个 fact、memory code 全部精确正确，main 和两个 child 都是 Runtime-valid `SUCCESS`，拓扑与条件相符，所有 Scope dispose。合法 `ABSTAIN` 是 schema pass 但不是 Hard Pass；错误的 `ALLOW/BLOCK` 另计 confident-wrong。

固定调用实验不允许任何条件请求更多资源或修复运行：两结果都resolved时main用`SUCCESS`；任一ambiguous时用`PARTIAL`加完整data与`ABSTAIN`，并省略`requestedResources`。这只是把冻结协议写成可执行形状，不改变处理因素或答案规则。

## 6. 主要指标与预定分析

主要表现指标：

1. 各条件总体与按 dependency direction 分层的 Parent Hard Pass；
2. matched serial、wrong-direction serial、parallel、adaptive 的配对差；
3. 每 family 三次 semantic result 一致率；
4. `ABSTAIN` 率、confident-wrong 率、Runtime/schema/topology failure；
5. adaptive 首调用方向命中率。

上下文与成本指标：

- 父 provider context tokens、估算 tokens、parent message bytes、tool-result bytes；
- main、children 与整棵 Scope tree 的 token、API calls、wall time；
- child start/end 是否重叠、Scope started/disposed/active 账本；
- Sentinel 是否进入父 messages 或提交 artifact。

以 family-repeat 为配对块，不把单个 trial 当独立样本。本探索性 Pilot 报告计数、配对方向和 family-level 分层，不声称统计确认或生产 SLA。

## 7. 预定假设与成功门

- **H1 信息流：** 在四个方向依赖 family 中，matched serial Hard Pass 高于 parallel 与 wrong-direction serial。
- **H2 自适应：** adaptive 在方向依赖 family 的首调用方向命中率至少 `75%`，且 Hard Pass 不低于 matched serial 超过 `10pp`。
- **H3 负对照：** independent family 中四条件 Hard Pass 不应出现超过 `20pp` 的系统差；若出现，优先怀疑提示、预算或实现不等价。
- **H4 父上下文：** 四个条件的 child Sentinel 父可见均为零，且任一条件 median parent provider context 不超过上一轮 Nested 基准 `1231` 的 `1.5×`。
- **H5 生命周期：** eligible trial 全部恰好一个 main＋两个不同 child Scope，started=disposed=3、active=0，无 fail-open。

“组合方向值得继续”要求 H1、H4、H5 同时成立。H2 用于判断是否值得把自适应路由做成产品能力。即使正确率提高，只要 tree tokens 或 latency 明显增加，也必须报告代价；不能把性能包描述成免费收益。

## 8. 运行、停止与修订规则

1. 先做 corpus lint、Skill schema、scripted topology smoke、真实 Pi faux-provider 顺序/并行/上游传递与 dispose 测试。
2. 实现、本文、Skill、任务、Harness、analyzer、依赖进入同一个 clean commit；manifest 冻结 commit/source hash、模型、endpoint、seeds、packet bytes、条件与预算。
3. live preflight 只跑一个 family 的四条件，验证部署协议，不进入效果数据。若修实现，必须新 clean commit 后重跑 preflight。
4. 一次生成72-job manifest；首次效果调用后不新增 family、repeat、repair、预算或条件。
5. capability failure 不重跑；冻结的 provider/network retry 单列并保留 attempt。
6. 任一父 Sentinel 泄漏、原始 child transcript进入父artifact、错误拓扑被计为有效、授权扩大或 active Scope 泄漏，立即停止效果解释。

## 9. 每阶段目标对齐

每个阶段都必须回答：

1. 是否仍只改变同一组 Skill 的组合拓扑与 typed information flow？
2. 是否偷偷增加了调用数、Skill能力、资源面或模型预算？
3. 当前证据测的是任务表现、稳定性、父上下文和总成本，还是又偏回资源访问研究？
4. 哪个 artifact 能证明组合被实际执行，而不只是提示中声称执行？

若不能回答，暂停 live 运行并修复设计。
