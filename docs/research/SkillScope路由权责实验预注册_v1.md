# SkillScope 路由权责实验预注册 v1

状态：**DESIGN FROZEN / ENGINEERING PREFLIGHT PASSED / NO PILOT DATA。**

日期：2026-08-20（Asia/Shanghai）

计划模型：`opencode-go/deepseek-v4-flash`

## 1. 问题

固定同一个main Skill、同一个原子Skill、相同证据、两次child调用、Schema与预算后，比较：

> 由模型根据routing cue决定并行/串行方向，和由工作流声明依赖、Runtime侧给出具体执行顺序，哪一种更稳定？

本轮先把上一轮已发现的provenance噪声移除：聚合Skill不再手工复制`scope://<childScopeId>`；Runtime只根据实际完成的child results生成canonical evidence refs。模型仍负责业务data，不能伪造或扩大child provenance。

## 2. 两个条件

| 条件 | 顺序由谁决定 | 实际组合 |
| --- | --- | --- |
| `MODEL_ROUTED` | main模型根据同一routing cue判断 | constraint-first、observation-first或parallel |
| `RUNTIME_ROUTED` | 工作流作者声明依赖方向，Runtime侧确定plan | constraint-first任务固定constraint-first；observation-first任务固定observation-first；independent任务固定parallel |

`RUNTIME_ROUTED`使用author-declared依赖，是可部署的声明式工作流上界，不是Runtime从自然语言中自动发现依赖。两组最终仍由同一个main Skill执行工具调用；Runtime继续强制child allowlist、数量、并发、授权、结构化结果、evidence binding与生命周期，并用trace核验实际拓扑。

## 3. 固定项

- main：更新后的同一个`workflow-compose`；
- leaf：同一个`inspect-contextual-evidence`，恰好调用两次；
- 每trial一个main Scope、两个不同child Scope；
- exact-file `BOUNDED`，每个child只读自己的packet；
- 相同模型、seed、packet bytes、memory code、父提交Schema和Scope预算；
- 不允许重试、投票、reviewer、第三次child调用、动态补权或双向都跑；
- 两组都使用Runtime child-evidence binding，因此它不是处理因素。

## 4. 任务与规模

复用上一轮已冻结的六个family：constraint-first、observation-first、independent各两个。每个family三个repeat、两个条件：

```text
6 families × 3 repeats × 2 conditions = 36 live trials
```

每个family-repeat是配对块，两组共享seed、完整packet和Sentinel。任务仍是构造性机制题，不估计自然工作负载分布。

## 5. 指标

主要指标：

1. Parent Hard Pass；
2. 实际路由是否符合依赖方向；
3. family内三次语义结果一致率；
4. abstain、错误`ALLOW/BLOCK`、Runtime/schema/topology failure；
5. `EVIDENCE_NOT_VISIBLE`计数。

成本与边界：父provider context、parent bytes、tree tokens、API calls、延迟、Sentinel父可见、started/disposed/active账本。

## 6. 预定判断

- **P0 自动provenance门：** eligible trial的`EVIDENCE_NOT_VISIBLE`必须为`0`，否则先修Runtime绑定，不解释路由优劣。
- **H1 声明式路由：** `RUNTIME_ROUTED`实际方向命中`100%`，Hard Pass与family一致率不低于`MODEL_ROUTED`。
- **H2 模型路由：** 方向任务与independent任务的路由命中率分别报告；不预设一定达到产品门。
- **H3 父上下文：** 两组Sentinel父可见为零，median父context不超过上一轮上限`1846.5`。
- **H4 生命周期：** eligible trial全部started=disposed=3、active=0，恰好同一main加两个相同原子Skill调用。

“Runtime声明路由更稳定”只在P0、H1、H3、H4同时成立时成立。若Runtime路由只是答案更高但增加调用数，本轮也不能通过；调用数已冻结相同。

## 7. 运行与修订

1. 先实现并单测Runtime child-evidence binding，证明模型提交错误locator时最终结果仍只绑定实际child。
2. scripted smoke必须证明两个条件使用相同Skill、相同两次调用和预期route。
3. 实现、本文、任务、Skill、Runtime、Harness、分析器与依赖进入一个clean commit后，做一个family的两臂真实preflight。
4. preflight修复必须写日志并进入新clean commit；不进入效果数据。
5. 一次生成36-job manifest；首次效果调用后不改truth、条件、预算、主要指标或成功门。
6. capability failure不重跑；provider/network只按冻结retry记录。

## 8. 解释边界

这个实验比较“模型从提示推断路由”与“工作流作者显式声明路由”的接口包，不证明Runtime可以自动发现依赖，也不比较多数投票、reviewer、循环或普通Subagent。若结果支持Runtime路由，下一步才进入自然任务holdout。
