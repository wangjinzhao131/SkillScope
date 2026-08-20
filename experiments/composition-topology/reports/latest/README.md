# 同一 Skill、不同组合拓扑：72-job live Pilot 人工复核

状态：**探索性 live Pilot 已完成；信息流机制得到部分支持，整体“提升稳定性”结论不成立。**

## 直接结论

固定同一个main Skill、同一个原子Skill、相同模型、证据、两次叶子调用和预算后，**组合顺序是否匹配信息依赖，确实会改变任务表现**：四个方向依赖family中，匹配方向的固定串行为`8/12` Hard Pass，并行与错误方向固定串行均为`0/12`；自适应组合为`11/12`，首调用方向也命中`11/12`。

但这还不能推出“自适应组合已经普遍提升SkillScope稳定性”。两个independent负对照family中，四条件Hard Pass从`2/6`到`6/6`，spread为`66.7pp`，远超预定的`20pp`检查线；全部六个family的三次语义一致率也只有`50.0%–66.7%`。因此当前证据支持继续研发“按typed依赖自适应排序”，不支持把它直接设为默认生产策略。

## 冻结设计与分母

- 模型：`opencode-go/deepseek-v4-flash`；
- 协议：`composition-topology.v1`；
- 六个family：constraint-first、observation-first、independent各两个；
- 每family三个repeat、四条件，共`72`个trial；
- 每个trial固定一个`workflow-compose` main Scope和两次同一个`inspect-contextual-evidence`原子Skill调用；
- raw结果`72/72`、unique job `72/72`、四臂各`18`，外因排除`0`，每个job只有一次冻结attempt；
- 四臂共享family-repeat内的seed、packet和Sentinel；没有能力失败择优重跑。

## 结果

| 条件 | Hard Pass | Abstain | confident-wrong | family一致率 | median父context | median tree tokens | median延迟 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Parallel | 3/18 | 15 | 0 | 66.7% | 1004.5 | 21,686.5 | 18.68s |
| Constraint-first | 8/18 | 10 | 0 | 66.7% | 1004.0 | 25,101.0 | 27.01s |
| Observation-first | 8/18 | 10 | 0 | 50.0% | 996.5 | 25,260.0 | 28.76s |
| Adaptive | 15/18 | 2 | 0 | 66.7% | 989.5 | 24,910.0 | 26.58s |

相对Parallel，中位串行/自适应tree tokens约增加`14.9%–16.5%`，延迟约增加`42.3%–54.0%`；中位计费成本只增加约`2.6%–3.1%`，但这取决于当前provider的cache计价，不能外推。四条件父context都约一千tokens，低于预定`1846.5`上限；组合差异没有重新膨胀父会话。

按依赖方向分层：

| 依赖 | Parallel | Constraint-first | Observation-first | Adaptive |
| --- | ---: | ---: | ---: | ---: |
| constraint-first | 0/6 | 6/6 | 0/6 | 6/6 |
| observation-first | 0/6 | 0/6 | 2/6 | 5/6 |
| independent | 3/6 | 2/6 | 6/6 | 4/6 |

这张表说明两件事同时成立：一是typed信息流方向具有真实表达力；二是当前执行协议仍受family与模型行为影响，不能只看Adaptive总体`15/18`就宣布胜利。

## 失败拆解

`38`个capability failure由`24`个合法`ABSTAINED`和`14`个`TOPOLOGY_INVALID`组成。后者进一步拆成：

- `13/72`：两个原子child都`SUCCESS`，但main提交了Runtime不可确认的evidence resource，因`EVIDENCE_NOT_VISIBLE`被fail closed；main结果被拒绝后，完整方向/upstream字段也无法核验。
- `1/72`：Adaptive在independent任务中擅自执行Parallel；业务答案恰好正确，但违反冻结拓扑。

这不是资源访问失败，也不是child Session泄漏。它暴露的是一个产品接口问题：当前main模型必须把工具返回的opaque child Scope ID手工复制为`scope://...` evidence ref。只要复制错、引用了业务路径或构造了别的locator，Runtime就会正确拒绝；安全性是对的，但人机接口不稳定。

`EVIDENCE_NOT_VISIBLE`并非均匀噪声：`independent-feature`占6次、`replica-region`占3次、`independent-budget`占2次，另两个family各1次。这解释了负对照spread为何很大，也意味着本轮不能把所有差异纯归因于顺序。

## 安全、上下文和生命周期

- `72/72`均为一个main加两个不同child Scope，Skill集合逐条相同；
- `72/72`生命周期有效：started=disposed=3、active=0；
- 父会话Sentinel可见`0/72`；18个配对块各自共享一个新Sentinel，raw result中没有任何Sentinel明文；
- 配置的`EXPERIMENT_KEY`精确值扫描为零命中；
- raw manifest/results继续由`.gitignore`保护，没有提交模型正文或隐藏truth。

## 预定成功门

- H1 信息流：通过；matched高于parallel与wrong-direction。
- H2 自适应方向：通过；方向命中与Hard Pass均`11/12`。
- H3 independent负对照：失败；spread `66.7pp`。
- H4 父上下文/Sentinel：通过。
- H5 生命周期部分通过：Scope dispose `72/72`，但只有`58/72`能完整验证冻结拓扑。

所以“组合方向值得继续”的严格总门为**未通过**；更窄的“自适应方向在构造依赖任务上值得继续研究”为**通过**。

## Post-run分析修正

首次自动分析把一条“答案正确、但Adaptive擅自改为Parallel”的trial算成confident-wrong。预注册定义的是错误的`ALLOW/BLOCK`，不是任何Hard Pass失败；这是派生指标bug。Raw JSONL保持不变，分析器改为只在decision或两个业务fact错误时计confident-wrong，并增加回归测试。修正后四条件confident-wrong均为零，同时该trial仍严格保留为`TOPOLOGY_INVALID`。主要Hard Pass、分母、成功门和其他原始结果均未改变。

## 下一步设计

当前最有证据价值的下一步不是立刻增加投票、reviewer或重试，而是先消除一个已证实的Runtime接口噪声：

1. Runtime直接为每个child result生成不可伪造、可枚举的evidence handle，或在main completion时自动绑定实际child results；模型不再手抄opaque Scope ID。
2. 用同一72-cell机制先做“手工evidence locator vs Runtime绑定”的小型配对回归，确认负对照spread和`EVIDENCE_NOT_VISIBLE`下降。
3. 再在新的、自然任务holdout上比较Parallel、固定串行与Adaptive；此时才能研究组合是否不仅有表达力，而且真正提高稳定性。
4. 多数投票、双向都跑和review loop作为后续独立算力实验，不能与拓扑优化混在一起。

## 可复核身份

```text
clean baseline = a2170e959539b403de54d220a5dcfdd9076cdcf4
sourceTreeHash = sha256:a05b91e933c2502613a5cb8798934a5f1b43d1ad2208c1a1726ba23c9867181c
logical manifestHash = sha256:1796bfaeac7fad43ef5c0e2137443c087a64ef6ba47847bb0309fe7aa6c2af25
raw manifest file SHA-256 = b21f47994d907f29b4a2bc161715a6c5bc8cda15d419c6f9fcb8718b0f2ad127
raw results file SHA-256 = 1aab58df3d8060cf08c0e9ba8509c54fc961642da13b0817f06ab571df3896c5
```

机器生成的完整表见[report.md](./report.md)、[summary.json](./summary.json)和[trials.csv](./trials.csv)。预定设计见[SkillScope组合拓扑实验预注册_v1.md](../../../../docs/research/SkillScope组合拓扑实验预注册_v1.md)。
