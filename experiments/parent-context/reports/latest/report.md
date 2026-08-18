# SkillScope 父上下文与稳定性实验报告

生成时间：2026-08-18T03:18:28.500Z

## 根本问题

本实验只回答：随用随销的子 Agent、主 Skill 下的独立子 Skill Scope，以及 Runtime 约束的结构化返回，能否减少父会话上下文占用并保持或提高端到端稳定性。访问授权只作为固定 exact-file 基础设施，不是处理变量。

## 冻结身份与样本

- 协议：`parent-context.v1`
- 模型：`opencode-go/deepseek-v4-flash`
- Manifest：`sha256:e85075c7a254c82512f6d39fbd82200b282999e325138c9cd984665ad071c893`
- Clean baseline commit：`7392264f7c32bcbb6917659af36a704408885d2c`
- Source tree：`sha256:01f699b5d8554c8efba14b8b6ce4a44ba4bacd48ba76b7cb2cd21f5f7ff51900`
- 结果：60/60；能力分母 60；外因排除 0

## 四个条件

| 条件 | Hard Pass | family一致率 | 父context中位数 | 父message bytes中位数 | 父tool-result bytes | 调用树tokens | 延迟ms | Sentinel命中 | 生命周期 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| INLINE_PARENT | 100.0% (15/15) | 100.0% | 7838.0 | 30251.0 | 26750.0 | 8703.0 | 11805.9 | 15 | 15/15 |
| EPHEMERAL_FREEFORM | 100.0% (15/15) | 100.0% | 1156.0 | 3747.0 | 379.0 | 10217.0 | 21534.4 | 0 | 15/15 |
| SKILLSCOPE_FLAT | 100.0% (15/15) | 100.0% | 1214.0 | 4067.0 | 595.0 | 12854.0 | 25285.0 | 0 | 15/15 |
| SKILLSCOPE_NESTED | 100.0% (15/15) | 100.0% | 1231.0 | 4953.0 | 604.0 | 22147.0 | 51046.9 | 0 | 15/15 |

## 主要配对结果

- 完整 family-repeat 配对：15/15
- Nested 相对 Inline 的父 provider context 中位降幅：84.4%
- Nested 相对 Inline 的父 message bytes 中位降幅：83.7%

## 机制包代价

下面是15个配对块的中位相对变化；正数表示增加，负数表示减少。

| 对比 | 父context | 父message bytes | 调用树tokens | 延迟 |
| --- | ---: | ---: | ---: | ---: |
| Freeform / Inline | -85.2% | -87.5% | +17.2% | +96.5% |
| Flat / Freeform | +3.0% | +7.6% | +25.7% | +13.9% |
| Nested / Flat | +1.5% | +21.6% | +73.0% | +74.0% |
| Nested / Inline | -84.4% | -83.7% | +154.4% | +287.9% |

## 预定方向门

- PASS — providerContextReduction30
- PASS — messageByteReduction30
- PASS — nestedWithin10ppOfInline
- PASS — nestedNotBelowFreeform
- PASS — nestedConsistencyNotBelowFreeform
- PASS — offloadSentinelZero
- PASS — nestedLifecycleAllValid
- PASS — noPolicyFailOpen

总体：**当前探索性证据支持继续发展该设计**。

## 直接结论

- **父上下文假设得到支持：** Nested把过程留在三个随用随销的独立Scope中，只把Runtime-valid结果逐层返回；相对Inline，父provider context和父message bytes均减少约84%。
- **稳定性只证明了“没有下降”，尚未证明“提高”：** 四组Hard Pass和family一致率均为100%，出现天花板效应；因此当前语料不能识别Runtime结构化返回或嵌套是否比freeform更稳定。
- **独立嵌套机制得到运行证据：** Nested的15个trial全部形成一个main与两个不同child Scope，结果均通过Runtime校验，全部dispose，child Sentinel未进入父messages。
- **当前实现是上下文换总成本：** Nested相对Inline的调用树tokens增加154.4%，延迟增加287.9%；不能称为总体效率优化。
- **结构化和嵌套的增量价值仍待证明：** Flat相对Freeform的调用树tokens增加25.7%，Nested相对Flat再增加73.0%，但本轮正确率没有差异。

## 分析修正

首版分析曾把每个repeat故意变化的memory code也纳入family语义一致性，因而错误报告0%。修正版只比较decision、constraintFact、observationFact；memory code仍由每条Hard Pass独立检查。原始60条结果、上下文、成本和正确率均未改变。

## 解释边界

- 父上下文下降不等于总成本下降；调用树 token 与延迟必须一起看。
- Freeform、Flat、Nested 都是机制包对比，不能把差异归因于任意单个提示词。
- 五个 family、三个 repeat 只够做探索性产品决策，不是生产 SLA 或统计确认。
- 本实验不比较普通继承父历史的通用 Subagent，也不估计访问边界、动态补权或安全 Profile 的效果。

