# SkillScope 路由权责 Pilot 人工复核

状态：**36/36 live trials完成；探索性结果，支持继续开发，不是生产结论。**

## 一句话结论

在同一个main Skill、同一个leaf Skill、恰好两个child Scope和Runtime自动证据绑定下，作者声明依赖并由Runtime侧给出具体组合方式，比让模型从提示自行判断组合方式更稳定：Hard Pass为`17/18`对`15/18`，实际路由正确为`18/18`对`15/18`。

## 冻结设计

- 模型：`opencode-go/deepseek-v4-flash`
- 协议：`routing-authority.v1`
- Clean baseline：`b00fd0c1c86d0eb8e03468325fc660e8d309687d`
- Source tree：`sha256:679385286be969af2bc95c1e57d3d54813d2e0d4507aebe43237d268d201e87f`
- Manifest：`sha256:9af2b09c6c871941ed7d668d7b8991b4c79c3c164c86b10fa1a9f8e77a6cbca8`
- 六个family×三个repeat×两个条件，共18个配对块、36 trials；两臂共享seed、packet、memory与Sentinel。
- 两臂都运行同一个`workflow-compose@1.1.0`，恰好调用同一个`inspect-contextual-evidence`两次。

## 结果

| 条件 | Hard Pass | 路由正确 | family三次一致 | 拒答 | confident wrong | Runtime证据绑定 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `MODEL_ROUTED` | 15/18 | 15/18 | 3/6 | 3 | 0 | 18/18 |
| `RUNTIME_ROUTED` | 17/18 | 18/18 | 5/6 | 1 | 0 | 18/18 |

Runtime−Model的配对差为Hard Pass `+11.1pp`、路由正确`+16.7pp`。模型路由在constraint-first、observation-first、independent三类上的实际路由命中分别为`5/6`、`4/6`、`6/6`；Runtime组为`6/6`、`6/6`、`6/6`。

成本没有因为声明式路由增加：两组平均tree API calls都为`8.67`；Runtime−Model平均tree tokens为`−572.2`，平均延迟为`−2398.3ms`。父provider context中位数为`962.0`对`984.5`，父message bytes为`4322.0`对`4512.5`。这些小样本成本差只作诊断，不声称稳定优势。

## 四个失败

`MODEL_ROUTED`有三个失败，全部是合法拒答而非自信错误：

1. `retention-tier:r2`：constraint-first被执行成parallel；
2. `client-cohort:r1`：输出声称observation-first，但两个child实际重叠且第二个没有上游；
3. `replica-region:r1`：observation-first题实际先做constraint，第二个也没有上游。

`RUNTIME_ROUTED`唯一失败是`client-cohort:r3`：实际observation-first、串行时序和upstream标记都正确，但第二个constraint leaf仍返回`UNKNOWN`。所以声明式路由消除了本轮路由选择错误，没有消除所有模型/typed-input执行波动。

## Runtime自动证据绑定

全体`36/36`最终`mainEvidenceRefs`都只含`runtime-child-1/2`，且逐个对应本次真实创建的两个child Scope；`EVIDENCE_NOT_VISIBLE=0/36`。上一轮组合实验有`13/72`次main因手工locator被拒绝，本轮工程结果说明Runtime binding修复了该故障模式。但两轮同时改变了Skill版本和实验条件，这个跨实验变化不是随机化的因果效应。

生命周期为`36/36`有效：每条恰好一个main＋两个相同leaf Scope，started=disposed=3、active=0。父Sentinel可见`0/36`，生成Canary原文在results中命中`0`，配置的`EXPERIMENT_KEY`精确值命中`0`。Raw结果仍含模型业务输出，应按敏感数据保护并保持Git ignored。

## 分析修正

首次报告代码漏把预注册H3的父context上限`1846.5`接入最终布尔门；实际两组中位数均远低于该值。Post-run amendment只补回冻结阈值与fail-closed回归，未改变raw、条件、任务、分母、主要指标或阈值。修正后的5项routing测试和冻结分析通过。

## Artifact hashes

```text
manifest.json  d8c707e4f109ae1254484aa3b9a1095c0429cd9f24372940550108116e4bd074
results.jsonl  22b62287e3414c8d912849003f56b798d2c275ae2f0b36742d1c8fc569b4ac70
report.md      24912024779a43b2e353dff070e15d3038df1102981524928b2ff09b3626868b
summary.json   482e2facf4c71fe772e52f94c10a59f3b2fa484f0e5cc904f8befed7ef854cab
trials.csv     ee42f15d4979ddbe6ec486f32c0ed492d5e42bac17c8f9752396ef0d02b445fa
```

Raw manifest/results位于Git ignored的`experiments/routing-authority/runs/`；仓库提交的是本人工复核、冻结分析输出和hash。

## 能说什么、不能说什么

本轮支持一个简单的产品方向：**依赖关系已知时，把它声明在Skill/workflow中并由Runtime编译为plan，优于每次让模型重新猜组合方式。**

它不证明Runtime能从自然语言自动发现依赖，也不证明所有自然任务都有`+11.1pp`收益。任务是六个构造family、单模型、三个repeat；下一步应使用作者声明但未参与当前语料设计的自然工作流holdout，并把“声明错误”作为单独风险测试。
