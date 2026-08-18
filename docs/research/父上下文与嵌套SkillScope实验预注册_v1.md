# 父上下文与嵌套 SkillScope 实验预注册 v1

状态：**DESIGN FROZEN / IMPLEMENTED LOCALLY / NO LIVE DATA。** 本文在实现前冻结研究问题和测量口径；嵌套 Runtime、任务语料、Harness 与测试现已落盘，但仍必须与本文一起进入一个 clean commit，才允许创建 live manifest。任何 live 数据出现后不得静默修改任务 truth、主要指标或成功标准。

日期：2026-08-18（Asia/Shanghai）

计划模型：`deepseek-v4-flash`

## 1. 根本目标

SkillScope 不是以“限制文件访问”为最终目标。它要验证的是：

> 把一次委托实现为随用随销的新 Scope，让主 Skill 在自己的 Scope 内再启动多个互不继承历史的子 Skill Scope，并且只允许 Runtime 校验过的结构化结果跨 Scope 边界，能否减少父会话上下文占用，同时保持或提高端到端任务稳定性。

本实验只研究四件事：

1. 临时子 Agent 是否把工作过程移出父上下文；
2. Runtime 结构化返回是否比自由文本更容易被父 Agent 稳定消费；
3. 主 Skill→多个独立子 Skill Scope 是否形成可用的技能组合；
4. 上述设计对父上下文、端到端正确率、重复稳定性和总成本的影响。

ResourceSet、grant planner、动态补权、目录授权和安全 Profile 都不是本轮处理因素。所有非 Inline 条件固定使用相同的两个 exact-file grants；资源边界只作为控制变量。

## 2. 冻结架构语义

```text
Parent AgentSession
  └─ disposable main Skill Scope
       ├─ disposable child Skill Scope A → typed SkillResult A → destroy
       ├─ disposable child Skill Scope B → typed SkillResult B → destroy
       └─ typed aggregate SkillResult → destroy → Parent
```

每个子 Skill 调用都必须：

- 创建新的 in-memory AgentSession，不继承父 Scope messages、tool history、Skills、Prompts 或 AGENTS；
- 有独立 `scopeId`、预算、timeout、Trace 和 usage；
- 只能由调用方显式传入 input、prompt refs 与不超过调用方边界的 resource grants；
- 只通过 Runtime 校验的 `SkillResult` 返回；child transcript 不进入调用方消息；
- 在成功、失败、超时或取消后 dispose；再次调用必须创建新 Scope；
- 受 Runtime 的最大深度、每 Scope 子调用数、并发数和向下授权约束。

v1 实验只允许两层 Skill：顶层 main Skill 可以创建 child Skill；child Skill 不得继续创建 grandchild。这个限制用于获得可解释的首轮证据，不代表最终产品永远只有两层。

## 3. 四个配对条件

固定五个 workflow family、三个 repeat、四个条件，共 `5 × 3 × 4 = 60` 个父任务 trial。同一 family-repeat 在四个条件共享模型 seed、问题、两份 evidence bytes、决策规则、父级记忆码和预算；条件顺序按 manifest seed 打乱。

| 条件 | 工作位置 | 跨边界返回 |
| --- | --- | --- |
| `INLINE_PARENT` | 父 Agent 用两个 exact-file read 工具直接取证并决策 | 原始工具结果留在父 messages |
| `EPHEMERAL_FREEFORM` | 一个全新临时子 Agent 读取同两文件 | 最终 assistant 自由文本；无 Runtime output schema |
| `SKILLSCOPE_FLAT` | 一个全新 SkillScope 读取同两文件 | Runtime 校验的结构化 `SkillResult` |
| `SKILLSCOPE_NESTED` | main Skill Scope 分别调用两个全新 child Skill Scope，再汇总 | child typed results→main typed result→父 Agent |

父 Agent 在所有条件都必须通过同一个严格 `parent_complete` 工具提交最终决定、两个事实字段和初始 Prompt 中的记忆码。这样，父级输出格式不成为条件差异；被处理的是工作过程留在哪里、子 Agent 返回自由文本还是 Runtime 结构，以及是否发生真实嵌套技能组合。

`EPHEMERAL_FREEFORM` 也使用全新 in-memory Pi Session、相同模型和相同只读工具，因此 Flat−Freeform 主要反映 Runtime 结构化返回包，而不是“有无独立上下文”。它仍不是所有第三方 Subagent 实现的代表。

## 4. 任务语料

五个 family 都是需要合并两份独立证据的维护决策，例如配置约束＋运行观测、兼容性声明＋测试状态、迁移策略＋消费者版本。每个 trial 的 virtual project 固定两个 exact files：

- policy/constraint packet，由 `inspect-constraint` child Skill 处理；
- observation/status packet，由 `inspect-observation` child Skill 处理。

每个 packet 含必要事实、固定长度的无关工作记录以及一个每次 execution 新鲜的 `CHILD_CONTEXT_SENTINEL_*`。Sentinel 不参与答案；它只检查原始 child working context 是否意外进入父 messages。Inline 条件看到 Sentinel 是预期暴露，三个 offload 条件中出现则是上下文隔离失败。

main Skill 只看到问题、规则、两个路径和可用 child Skill 名，不先读取 packet 正文。它必须启动两个不同 child Scopes、消费两个 typed results，并生成自己的 typed aggregate result。Flat 与 Freeform 各由单个临时 Session 读取两份相同 packet。

## 5. 主要指标

### 5.1 父上下文占用

每个 trial 同时记录：

- `parentProviderContextTokens`：父 Session 最终提交所在 assistant turn 的 provider/context usage；
- `parentEstimatedContextTokens`：对最终 parent messages 使用 Pi 公共估算器得到的保守值；
- `parentMessageBytes`：发送给模型的 parent message JSON UTF-8 bytes；
- `parentToolResultBytes`：本 trial 留在父 messages 的所有 tool-result正文 bytes；
- `childSentinelVisibleInParent`：父 message corpus 是否包含 child-only Sentinel。

主要上下文对比为 Nested−Inline；Freeform−Inline 估计仅把过程移出父会话的效果；Flat−Freeform 估计结构化返回包的附加效果。

### 5.2 端到端稳定性

`Parent Hard Pass` 要求：

- 父级合法调用 `parent_complete`；
- decision 与两个事实字段完全正确；
- 初始父 Prompt 的记忆码正确；
- 没有未声明字段或类型强制转换；
- 对 SkillScope 条件，所有 required Scope 都有 Runtime-valid result；Nested 恰好有一个 main 和两个不同 child Scopes。

稳定性同时报告：每 family 三次结果一致率、能力失败代码、缺失/非法 control call、Runtime schema invalid、重复/超时、平均值与最差 family，而不是只报告总体均值。

### 5.3 总成本与生命周期

记录 parent、main Scope、child Scope 的 input/output/cache/total tokens、API calls、wall time，并报告整棵调用树总和。父上下文减少不等于总 Token 降低；若 Nested 只是把成本搬到子 Scope，报告必须明确写出。

生命周期门禁：每个计划 Scope 必须有唯一 ID、父子关系、start/finish/dispose 记录；结束后 active-scope count 必须回到零。child transcript bytes 可以在实验内存审计中计数，但不得进入父 messages 或提交的 raw artifact。

## 6. 预定对比与成功标准

主要条件包对比：

1. `EPHEMERAL_FREEFORM − INLINE_PARENT`：临时上下文卸载；
2. `SKILLSCOPE_FLAT − EPHEMERAL_FREEFORM`：Runtime 结构化返回；
3. `SKILLSCOPE_NESTED − SKILLSCOPE_FLAT`：独立子 Skill 组合；
4. `SKILLSCOPE_NESTED − INLINE_PARENT`：当前完整产品思路。

本探索性 Pilot 将“核心思路得到支持”定义为同时满足：

- Nested 的 median `parentProviderContextTokens` 与 `parentMessageBytes` 均至少比 Inline 低 30%；
- Nested Parent Hard Pass 不低于 Inline 超过 10 个百分点，且不低于 Freeform；
- Nested 的 family 内三次一致率不低于 Freeform；
- 三个 offload 条件的 child Sentinel 父上下文命中为零；
- Nested 每个 eligible trial 都形成两个独立、已 dispose、Runtime-valid 的 child Scopes；
- Policy/runtime contract 没有 fail-open。

这些是产品方向门，不是统计显著性或非劣置信界。只有15个 family-repeat clusters，结果只能决定是否继续和下一步优化，不能作为生产 SLA。

如果父上下文明显减少但总 Token、延迟或失败率大幅增加，结论必须写成“上下文换成本”，不能称整体优化。若 Flat 优于 Freeform而Nested不优于Flat，支持结构化结果但不支持当前嵌套编排。若 Nested上下文更小但父级记忆码失败更多，说明父上下文测量与实际任务稳定性发生冲突，必须先查 Prompt/tool-result设计。

## 7. 运行与停止规则

1. 先完成纯本地 deterministic tests：独立 Session、两 child IDs、授权不扩大、深度/数量/并发限制、父取消传播、所有退出路径 dispose、child evidence可供main引用、child transcript不进入parent projection。
2. 再做 scripted end-to-end smoke：四条件都得到同一正确父结果，并验证只有 Inline 的 Sentinel 留在父 messages。
3. 实现、本文、语料、manifest builder、analyzer与依赖进入同一 clean commit；manifest冻结 commit/source hash、模型、endpoint、四条件、task bytes、seeds、预算和输出契约。
4. live preflight 后一次生成全部60个trial；首次任务模型调用后不增加样本、预算、repair或任务。
5. 能力失败不重跑。provider/network/harness中断单列排除；同一trial若允许external retry，规则必须在manifest中预先冻结并保留所有attempt。
6. 任一 offload Sentinel 进入父 messages、child transcript持久化到父artifact、active Scope泄漏、子 Scope越过调用方授权或Runtime接受非法结果，立即停止效果解释，先修实现并使用新协议/manifest重跑。

## 8. 定期目标对齐

每完成一个阶段，都在实验日志回答四个问题：

1. 这一步是否直接实现或测量“随用随销、嵌套 Skill、Runtime 结构化返回、父上下文、稳定性”中的至少一项？
2. 是否引入了没有进入主要对比的新研究课题？若是，停止并移出本轮。
3. 当前证据是在测父上下文和端到端结果，还是又退回只测 child resource access？
4. 距离60-trial clean-baseline live矩阵还缺哪一条可执行门禁？

本轮明确不继续设计 ResourceSet、planner、NEED_RESOURCE、目录 Profile 或更广安全攻击语料；已有实现只作为固定基础设施。

## 9. 当前实现进展与剩余门禁

本地实现已经补齐：

- main Skill 的 `scope_invoke_skill`，每次创建独立 Pi Session；
- manifest 的 child Skill allowlist、最大数量和并发策略；
- `SkillResult` 1.1 的 parent/root/depth、直接 child 摘要与调用树 usage；
- `scope://<childScopeId>` 结果证据、向下授权子集检查和两层深度限制；
- Runtime active/start/dispose 账本与父取消传播；
- 父 Pi Session 的 provider-context、估算 context、message bytes、tool-result bytes 与 Sentinel 测量；
- Inline、Freeform、Flat、Nested 四条件 Harness、五个 family、60-job clean-manifest builder、resume runner 与结果 analyzer；
- 本地 scripted 5×4 smoke，以及真实嵌套 Scope ID、并发/越权拒绝、child transcript projection、Trace 和 dispose 回归。

剩余门禁是：全仓 `npm run verify`、把 outcome-relevant tree 提交为 clean baseline、登录 shell 的真实 provider preflight，然后一次生成并执行全新 60-job manifest。完成之前仍不能声称 SkillScope 已验证其根本目标。
