# SkillScope 路由权责实验报告

生成时间：2026-08-20T15:45:23.694Z

## 问题

同样的main Skill、leaf Skill、两次调用、证据、模型和预算，只比较由模型从提示判断组合方式，还是由工作流作者声明依赖并由Runtime侧给出具体组合方式。两组都由Runtime绑定真实child evidence。

## 冻结身份

- 协议：`routing-authority.v1`
- 模型：`opencode-go/deepseek-v4-flash`
- Manifest：`sha256:9af2b09c6c871941ed7d668d7b8991b4c79c3c164c86b10fa1a9f8e77a6cbca8`
- Clean baseline：`b00fd0c1c86d0eb8e03468325fc660e8d309687d`
- Source tree：`sha256:679385286be969af2bc95c1e57d3d54813d2e0d4507aebe43237d268d201e87f`
- 结果：36/36；能力分母 36；外因排除 0

## 两组结果

| 条件 | Hard Pass | 路由正确 | Runtime证据绑定 | family一致 | 拒答 | confident wrong | 父context | tree tokens | 延迟ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| MODEL_ROUTED | 15/18 (83.3%) | 15/18 (83.3%) | 18/18 | 3/6 | 3 | 0 | 984.5 | 24961.0 | 22539.8 |
| RUNTIME_ROUTED | 17/18 (94.4%) | 18/18 (100.0%) | 18/18 | 5/6 | 1 | 0 | 962.0 | 24689.0 | 20754.4 |

## 配对差值（Runtime − Model）

- 完整配对块：18
- Hard Pass：+11.1pp
- 路由正确：+16.7pp
- Tree tokens：-572.2
- 延迟：-2398.3 ms

## 预定门

父context冻结上限：1846.5 tokens。

- PASS — p0EvidenceRejectionsZero
- PASS — p0CanonicalEvidenceAll
- PASS — h1RuntimeRoutePerfect
- PASS — h1RuntimeHardPassNotWorse
- PASS — h1RuntimeConsistencyNotWorse
- PASS — h3ParentContextBounded
- PASS — h3SentinelZero
- PASS — h4LifecycleAll
- PASS — h4SameSkillAndTwoChildren

总体：**SUPPORTED FOR CONTINUED DEVELOPMENT**。

## 解释边界

- Runtime组使用作者已知的依赖声明，是声明式工作流上界；不是Runtime自动理解自然语言并发现依赖。
- Runtime child-evidence binding是两组共同基础设施；它修复上一轮provenance混杂，但本实验不估计它本身的因果收益。
- 六个构造family、三个repeat、单一模型只支持探索性产品决策。

