# ResourceSet 真实仓库快照实验预注册 v1

状态：**PRE-DATA FROZEN ON CLEAN PLAN。** 本文、suite、executor、ResourceBroker 原型与测试必须进入同一 clean commit；只有从该提交生成且 `implementationDirty=false` 的 descriptor 才使本预注册生效。在此之前不得调用任务模型。

日期：2026-08-18（Asia/Shanghai）

模型与端点：`deepseek-v4-flash`，`https://opencode.ai/zen/go/v1`

## 1. 来由与问题

高搜索熵 Pilot 中，`ROOT_HANDLE_24` 与 `SHARDED_ALL_24` 授权并读取相同 16 个文件，但 Hard Pass 为 9/10 与 0/10。Planner budget probe 又显示，将16项 opaque catalog 的输出预算提高到2048虽能让9/10 trial合法提交，却全部选择16/16项。这两条证据共同指向导航接口，而不是“继续让模型猜授权”或“继续增加worker预算”。

本实验检验一个更窄的设计：底层仍逐文件授权，但把这些已授权文件注册成一个逻辑 `ResourceSet`，由 `scope_search_set` 在服务端跨集合搜索。集合 handle 不授权父目录、不发现未来文件，也不能包含没有 exact-file `search` grant 的成员。

## 2. 数据与任务

使用 SkillScope 当前真实仓库中24个已提交文件的 clean-commit snapshot，覆盖 Pi Runtime、provider bridge、Trace、Schema、Gateway、tests 与示例 Skill。预先冻结6个自然维护问题；每题要求来自两个不同真实文件的证据。模型只看到任务、公开 response contract、当前 grants/handle 与工具结果；expected answer 不进入 prompt。

这比同构合成 shard 更接近真实代码导航，但仍是**仓库内 snapshot holdout**：问题由同一研究者阅读本仓库后编写，只有一个仓库、一个语言/文档组合，也没有与普通 Subagent 对照。不得称外部有效性或生产 benchmark。

## 3. 配对单元

固定 `6 tasks × 2 repeats × 4 cells = 48 jobs`。同 task-repeat 在四个 cell 共用 seed、response contract、文件字节和 worker budgets；cell 同时交错运行。

- `ORACLE_FILES_24`：只给 author-known 的两份必要 exact-file grants；低协调成本上界。
- `EXACT_FILES_24`：给24份 exact-file `read+search` grants，不提供聚合 handle；模型可按路径选择逐文件 read/search。
- `RESOURCE_SET_24`：底层 grants 与 `EXACT_FILES_24` 完全相同，另提供一个只包含这24个成员的 `authorized-repo` search handle。
- `ROOT_DIRECTORY_24`：给静态 snapshot 根 `repo/` 的 directory read/list/search grant；在本批字节上覆盖同24个候选文件，但语义上会覆盖该根下未来文件，因此不是首选产品策略。

所有 cell：`maxToolCalls=24`、`maxTurns=10`、worker `maxTokens=1024`（保留一次 length retry）、temperature 0、whole-job timeout 300秒。Inferred 单元使用 manifest-frozen override，完全绕过 LLM grant planner。

## 4. ResourceSet 安全不变量

1. 只在 `BOUNDED` 下启用；每个成员必须是存在的 virtual-project file。
2. 每个成员必须有同路径、kind=file、包含search操作的有效 grant；directory grant 不能代替。
3. handle ID 不是项目路径；未知 ID、SEALED、未授权成员都 fail closed。
4. search 只扫描冻结成员，`actualReadSet` 记录被扫描文件，`modelVisibleSet` 只记录返回匹配的文件；证据仍需行级可见 span。
5. 该原型只接入实验 worker；不宣称 Pi plugin v0.1 已支持 ResourceSet，也不改变现有 SkillSpec。

## 5. 指标与预定对比

主要对比：`RESOURCE_SET_24 − EXACT_FILES_24` 的配对 Hard Pass、tool calls、total tokens 与 duration。

次要对比：

- `RESOURCE_SET_24 − ROOT_DIRECTORY_24`：静态相同候选文件面下的能力/成本差；不是正式非劣检验。
- `RESOURCE_SET_24 − ORACLE_FILES_24`：相对 author-known evidence 上界的导航成本。
- `ROOT_DIRECTORY_24 − EXACT_FILES_24`：复核聚合搜索相对逐文件接口的方向。

同时报告 Policy Pass、Canary visibility/exfiltration、grant/read文件数、`scope_search_set`调用数、普通search/read调用与失败代码。provider/harness/external interruption排除；冻结预算内普通 failure/MAX_TOOL_CALLS 计能力失败且不重跑。

## 6. 解释规则

- ResourceSet 提高 Hard Pass/降低调用且Policy保持：支持把“授权成员”与“导航handle”分开，进入Pi API设计与更独立repository holdout。
- ResourceSet 与Root接近、且授权成员显式冻结：支持ResourceSet替代宽directory grant作为默认聚合导航。
- Exact-file已接近Oracle、ResourceSet无收益：说明真实可读路径名已足够；高熵收益不能外推到一般仓库。
- ResourceSet低于Root：优先检查新tool discoverability、handle prompt与结果形状，不得直接否定集合授权思路。
- 任一越权读、受限Canary可见或exfiltration：停止产品解释，先修边界。

样本仅12个task-repeat clusters，不做显著性、非劣或Profile正式排名。原始descriptor/manifests/results保持Git ignored；只提交审阅过的聚合与哈希。
