# ResourceSet 真实仓库 snapshot Pilot 人工复核

状态：**已完成的探索性仓库内 snapshot 诊断；支持后续接口设计，不是外部有效性、非劣、Profile 排名或生产安全结论。**

运行日期：2026-08-18（Asia/Shanghai）

模型与端点：`deepseek-v4-flash`，`https://opencode.ai/zen/go/v1`

预数据基线：`15e6077fc2de32439ffb2c7def2237d3cb63c00b`，`implementationDirty=false`

设计见 [ResourceSet 真实仓库快照实验预注册 v1](../../../../docs/research/ResourceSet真实仓库快照实验预注册_v1.md)。本批把当前仓库的 24 个已提交文件冻结成 virtual snapshot，用六个需要两份跨文件证据的维护问题，比较 Oracle 两文件、24 个平铺 exact-file grants、相同 24 个 exact-file grants 加一个聚合搜索句柄，以及覆盖同一 snapshot 的根目录句柄。每题两个 repeat，共 48 jobs。

`RESOURCE_SET_24` 与 `EXACT_FILES_24` 的底层 grants、task、seed、response contract、worker budget 及 inner manifest/job identity 相同；区别只由外层冻结的 `ResourceSet` handle 绑定。该 handle 只能搜索已经逐文件授予 `search` 的 24 个成员，不能授权父目录或未来文件。它目前只存在于实验 Harness，Pi 插件 v0.1 尚未公开该 API。

## 冻结身份与数据完整性

```text
planHash = sha256:9b8c8ce821d1cb0658f29b00450808495392fc4d0771fdafe3e133ced4482102
suiteHash = sha256:359d230d6ff89334103e8b1ea79b2d05c262f76cb0758600abd634994833214e
snapshotHash = sha256:7904fd736696b33f45d685e946c6af8a5cda6d1d7e9d2c317282cc38619ff3c8
sourceHash = sha256:ab23b7c0ccd9bf3fc4ba9a985849df40058efa933d67e1e5f4a5944a6b83936d
sourceTreeHash = sha256:c658609a03313528398f0804d394c2eccaf211b7a3f54e886e818a320bf6d4f3
ResourceSet hash = sha256:df26e0b4c4f9546473ce36c2fdd912f5264a1a25fa4a6ca1783327e5a6e21117
descriptor file SHA-256 = e2fba0cf1d4c6c364515b0808d67a9129cbfcd7118d77d0f1e2ce2a3f4db4252
```

48 个 trial、48 个 run 与 48 个 outer result 一一对应。inner `jobId` 有 36 个，因为 12 对 Exact/ResourceSet 有意复用同一个 access-frontier manifest/job；outer `trialId`、cell、plan hash 与 ResourceSet hash 保持两种处理可区分。没有 provider、network、harness、external-cancellation 排除或 supersession，也没有重跑能力失败。

| Cell | Logical manifest hash | Manifest file SHA-256 | Results file SHA-256 |
| --- | --- | --- | --- |
| `ORACLE_FILES_24` | `sha256:879bf02f5e29b5c7ac3546629af51c838904746605a18ee9396a095d09bcc959` | `d7c61c913725e6f2eff429c622c53a858ba186fe08f13938c8308f18ab11c297` | `31169612ced5958c663ab720337c339bd8dde62f5ed54340b6c2afc74a522e48` |
| `EXACT_FILES_24` | `sha256:8875334a1f5a51bb21806eaa1faca3a3d8e9284945ece614f81c5d962f4cb886` | `f6aacab89f702c6f8b5c87603459615291dc73a98cbf006d4f31c487baa13ee6` | `be9236c632d8381bb36aac38d4f5c667cc438703fa16feab998d95161ca3315b` |
| `RESOURCE_SET_24` | `sha256:8875334a1f5a51bb21806eaa1faca3a3d8e9284945ece614f81c5d962f4cb886` | `f6aacab89f702c6f8b5c87603459615291dc73a98cbf006d4f31c487baa13ee6` | `cf2d2a08617b770d6a3132340ce79ba3c3585b9cd2d1dac18b739598d3fb5584` |
| `ROOT_DIRECTORY_24` | `sha256:15acb73926f5aff937b06664bc390684a0b22a819651a2632d12e7ffe112c661` | `96695ad979b69c53dc20be47edbe8f7224447c6a79e7c5a292e6a8c418e78f4b` | `bb1953191a9a4befd1d5bc77b820680f7d80ac3352d230178c353638a52ae9de` |

审核后的机器聚合为 [summary JSONL](../resource-set-holdout-v1-summary.jsonl) 与 [generated report](../resource-set-holdout-v1-report.md)，SHA-256 分别为 `eb834f0646cb112be9f9c1b228c6834b84b81c62a193c4b564c96a456ba635a3` 和 `aa1f2864b31cac4a9244f72696028d0ec383024a49af89342eedcaada82af839`。Post-run 的答案/facts 与测量歧义切片另存为 [layered summary](../resource-set-holdout-v1-layered-summary.json)，SHA-256 为 `5c9a31bc8619290990cc7cabab8701aa5382c4e5d9ee63d8ea01ee95662c9b9b`；它不修改冻结 truth 或 raw outcome。

密钥精确值与 raw `SCOPE_CANARY_*` 扫描均为零命中。Policy Pass 为 48/48；受限 Canary model-visible 与 exfiltration 都是 0/48。这只说明本批没有观测到边界突破，不是零泄漏率或 OS 隔离证明。

## 冻结主结果

| Cell | Hard Pass | 内生错误 | Median tools | Median tokens | Median duration | Median grant/read files | Median set/search/read calls |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| `ORACLE_FILES_24` | 9/12 | 无 | 6 | 29,868.5 | 23.09 s | 2 / 2 | 0 / 3 / 2 |
| `EXACT_FILES_24` | 3/12 | 4 `MAX_TOOL_CALLS`；1 `MAX_TURNS` | 20.5 | 122,059 | 54.72 s | 24 / 9 | 0 / 11 / 7.5 |
| `RESOURCE_SET_24` | 8/12 | 1 `MAX_TURNS`；1 `MISSING_CONTROL_CALL` | 14.5 | 89,220 | 47.44 s | 24 / 24 | 3 / 2.5 / 6.5 |
| `ROOT_DIRECTORY_24` | 6/12 | 1 `INVALID_RESULT`；2 `MISSING_CONTROL_CALL` | 10 | 61,053.5 | 33.69 s | 24 / 24 | 0 / 2.5 / 6.5 |

预定的 task-repeat 配对描述差为：

- `RESOURCE_SET_24 − EXACT_FILES_24`：Hard Pass `+0.42`，平均 tool calls `−6.42`、tokens `−20,530.17`、duration `−4.62 s`；
- `RESOURCE_SET_24 − ROOT_DIRECTORY_24`：Hard Pass `+0.17`，平均 tool calls `+3.42`、tokens `+43,990.67`、duration `+11.72 s`；
- `RESOURCE_SET_24 − ORACLE_FILES_24`：Hard Pass `−0.08`，平均 tool calls `+7.92`、tokens `+74,969.5`、duration `+27.73 s`；
- `ROOT_DIRECTORY_24 − EXACT_FILES_24`：Hard Pass `+0.25`，平均 tool calls `−9.83`、tokens `−64,520.83`、duration `−16.34 s`。

这些是 12 个 task-repeat cluster 的描述性差，不是显著性、非劣或因果外推声明。

## 推理正确与严格取证分层

Hard Pass 同时要求合法 submission、答案码、facts、所需文件、可见来源和精确 assertion 行覆盖。为区分“找到了正确设计事实”和“引用行精度也完全合格”，另报告不改写 raw score 的 `answerCode + exact facts` 层：

| Cell | 合法 submission | 答案 + facts 正确 | 严格 Hard Pass |
| --- | ---: | ---: | ---: |
| `ORACLE_FILES_24` | 12/12 | 10/12 | 9/12 |
| `EXACT_FILES_24` | 7/12 | 5/12 | 3/12 |
| `RESOURCE_SET_24` | 10/12 | 9/12 | 8/12 |
| `ROOT_DIRECTORY_24` | 9/12 | 7/12 | 6/12 |

例如 Oracle 的一个 Trace trial 和 ResourceSet 的一个 provider-bridge trial 给出了正确答案/facts，但引用范围没有覆盖冻结的精确断言行，因而仍按预注册记 Hard Fail。这个门槛对需要机器审计的 SkillResult 有意义；分层只防止把引用偏移误写成核心推理失败。

## 测量歧义与敏感性

`af-rs-completion-order` 的公开 facts 把两种不同语义压成了一个 `duplicatePolicy`：实现保留第一次合法 completion payload，但第二次 completion 会添加 fatal protocol issue，使整个 invocation fail closed。冻结 truth 使用 `fail-closed`，而五个实际提交都选择 `first-wins-success`；它们同时全部给出正确的主答案 `FIRST_VALID_SEPARATE_TURN` 和正确的 `later-turn-required`。因此该 family 无法干净区分“payload 保留策略”和“最终调用结果”，应标为测量歧义，而不是模型或 ResourceSet 失败。

不修改冻结结果，预先之外增加一个剔除该 family 的敏感性切片（五个其余任务 × 两 repeat）：

| Cell | 答案 + facts | Hard Pass |
| --- | ---: | ---: |
| `ORACLE_FILES_24` | 10/10 | 9/10 |
| `EXACT_FILES_24` | 5/10 | 3/10 |
| `RESOURCE_SET_24` | 9/10 | 8/10 |
| `ROOT_DIRECTORY_24` | 7/10 | 6/10 |

切片中的 Hard Pass 配对方向为 ResourceSet−Exact `+0.50`、ResourceSet−Root `+0.20`、ResourceSet−Oracle `−0.10`。所以主要方向不由这道歧义题制造，但数值仍只是小样本描述。

## 设计结论

### 有把握的判断

1. **底层授权集合与导航拓扑应该分开。** Exact 与 ResourceSet 有完全相同的 24 个 exact-file grants 和 inner job identity；增加一个跨已授权成员搜索的 handle 后，Hard Pass 从 3/12 到 8/12，同时平均少 6.42 次工具调用和约 2.05 万 tokens。结合此前 high-entropy Root 9/10、Sharded 0/10，这已经是跨合成布局与真实仓库 snapshot 的两轮同方向证据。
2. **当前 ResourceSet 原型优于平铺 exact-file 接口，但没有成本支配 root handle。** 它在本批比 Root 多 2 个 Hard Pass，却平均多 3.42 次调用、约 4.40 万 tokens 和 11.72 秒。原因包括新工具发现/策略、普通 search/read 与集合 search 混用，以及 Prompt 中重复展示 grants、catalog 和全部成员。产品设计不能只保留“8/12 大于 6/12”而忽略成本。
3. **Oracle/static resolver 仍是重要上界。** Oracle 以 2 个 grants 获得 9/12 Hard Pass，成本远低于所有探索式接口；能由父级可靠解析的任务不应强迫子模型自己导航 24 个候选。
4. **ResourceSet 保留的是授权语义，不是最小物理 I/O。** 每次集合搜索会扫描冻结成员；ResourceSet trial 的 median read surface 是 24/24。它比 directory grant 更明确、不会自动覆盖未来文件，但仍需索引/检索层才能降低物理扫描和元数据成本。

### 仍不确定的设计问题

- ResourceSet 应作为 SkillSpec 一等公民，还是由父级 resolver 临时编译成 opaque search handle；在接口稳定前不接入 Pi v0.1。
- handle 应只暴露 `search(query)`，还是增加服务端检索/排序、一次返回 source spans 的 `retrieve`；当前模型 median 调用三次 set search，随后仍大量 read，说明原始 grep 形状未充分降低协调。
- 是否用签名的 frozen membership hash 代替 Prompt 中完整重复成员表；这可能显著降低 token 成本，但会改变可理解性与审计体验，需要新消融。
- 本批只有一个仓库、六个作者设计的问题、两个 repeat 和一个模型；还需要独立仓库/任务作者、不同目录规模与普通 Subagent 对照，才能判断收益是否外推。

因此当前最合理的下一步不是把 Root/PROJECT 设为默认，也不是直接发布 ResourceSet，而是把它推进为 **experimental BOUNDED navigation layer**：保持 exact-file grants 是授权真源，handle 只做可审计的聚合检索，再以独立仓库 holdout 比较检索质量、Prompt/索引成本和边界语义。
