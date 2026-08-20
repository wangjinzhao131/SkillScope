# SkillScope 组合拓扑实验报告

生成时间：2026-08-20T14:17:43.508Z

## 根本问题

本实验固定同一个main Skill、同一个原子Skill、两次叶子调用、模型、证据和预算，只改变并行/串行方向以及Runtime-valid结果的流向，观察任务表现、稳定性、父上下文与总成本。

## 冻结身份

- 协议：`composition-topology.v1`
- 模型：`opencode-go/deepseek-v4-flash`
- Manifest：`sha256:1796bfaeac7fad43ef5c0e2137443c087a64ef6ba47847bb0309fe7aa6c2af25`
- Clean baseline：`a2170e959539b403de54d220a5dcfdd9076cdcf4`
- Source tree：`sha256:a05b91e933c2502613a5cb8798934a5f1b43d1ad2208c1a1726ba23c9867181c`
- 结果：72/72；能力分母 72；外因排除 0

## 条件结果

| 条件 | Hard Pass | Abstain | Confident wrong | family一致率 | 父context | 父message bytes | tree tokens | 延迟ms | 拓扑 | 生命周期 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PARALLEL_JOIN | 3/18 (16.7%) | 15 | 0 | 66.7% | 1004.5 | 4462.0 | 21686.5 | 18676.3 | 15/18 | 18/18 |
| CONSTRAINT_FIRST | 8/18 (44.4%) | 10 | 0 | 66.7% | 1004.0 | 4515.0 | 25101.0 | 27005.9 | 14/18 | 18/18 |
| OBSERVATION_FIRST | 8/18 (44.4%) | 10 | 0 | 50.0% | 996.5 | 4521.5 | 25260.0 | 28761.8 | 14/18 | 18/18 |
| ADAPTIVE_ORDER | 15/18 (83.3%) | 2 | 0 | 66.7% | 989.5 | 4499.5 | 24910.0 | 26582.7 | 15/18 | 18/18 |

## 依赖方向分层

| 依赖方向 | Parallel | Constraint-first | Observation-first | Adaptive |
| --- | ---: | ---: | ---: | ---: |
| constraint-first | 0/6 (0.0%) | 6/6 (100.0%) | 0/6 (0.0%) | 6/6 (100.0%) |
| observation-first | 0/6 (0.0%) | 0/6 (0.0%) | 2/6 (33.3%) | 5/6 (83.3%) |
| independent | 3/6 (50.0%) | 2/6 (33.3%) | 6/6 (100.0%) | 4/6 (66.7%) |

## 组合机制

- 方向依赖任务 matched serial：8/12 (66.7%)
- 方向依赖任务 parallel：0/12 (0.0%)
- 方向依赖任务 wrong-direction serial：0/12 (0.0%)
- 方向依赖任务 adaptive：11/12 (91.7%)
- Adaptive首调用方向命中：11/12 (91.7%)
- Independent四条件Hard Pass spread：66.7%
- Runtime evidence visibility拒绝：13/72
- 已确认执行了错误拓扑：1/72
- main被Runtime拒绝后无法核验完整拓扑：13/72

## 预定成功门

- PASS — h1MatchedAboveParallel
- PASS — h1MatchedAboveWrongDirection
- PASS — h2AdaptiveDirection75
- PASS — h2AdaptiveWithin10ppMatched
- FAIL — h3IndependentSpread20pp
- PASS — h4ParentContextBounded
- PASS — h4SentinelZero
- FAIL — h5TopologyAllValid
- PASS — h5LifecycleAllValid

组合方向总体：**NOT SUPPORTED**。
构造性方向依赖任务的自适应方向门：**PASSED**。

## 解释边界

- 方向依赖任务是构造性机制测试；matched提升证明typed information flow有用，不估计自然任务中这种依赖的发生率。
- 四个条件固定相同Skill和调用数；实际token与延迟差是组合结果，不是额外调用造成。
- 父上下文受控不等于整棵Scope tree成本下降；必须结合表中的tree tokens和延迟。
- 六个family、三个repeat和单一模型只支持探索性产品决策，不是生产SLA或统计确认。

