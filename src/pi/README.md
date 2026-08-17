# SkillScope Pi Extension（Pi 0.84.2）

本目录是 SkillScope 的 Pi 适配层。它注册一个父级工具 `scoped_skill_run`，为每次调用创建全新的内存态 `AgentSession`，只注入显式 input/prompt refs，只暴露 ResourceBroker 支持的只读工具和 `scope_complete`，最后由 Runtime 生成 `SkillResult`。

## 已核对的 Pi 公开 API

实现以 `@earendil-works/pi-coding-agent@0.84.2` 的实际类型和官方示例为准：

- Extension 使用 `ExtensionAPI.registerTool()`；工具签名为 `execute(toolCallId, params, signal, onUpdate, ctx)`。
- 独立 Session 使用 `createAgentSession()`、`SessionManager.inMemory()`、`SettingsManager.inMemory()` 和显式 `ResourceLoader`。
- `scope_complete` 是 custom tool；终止标志位于工具执行结果 `terminate: true`，不在 tool definition 上。
- child session 传入 `noTools: "all"` 和显式 tool allowlist，不加载默认 Extensions、Skills、Prompts 或 AGENTS files。
- ExtensionContext 不公开父 `ModelRuntime`。适配器通过父 `ModelRegistry.getApiKeyAndHeaders(ctx.model)` 冻结本次已解析的 API-key/baseUrl/headers/env snapshot，按所选 model 重建一个静态 OpenAI-compatible provider，并执行 `runtime.refresh({ providers: [providerId], allowNetwork: false })`。Pi 0.84.2 若省略这次 refresh，`hasConfiguredAuth()` 的 snapshot 会过期。

插件从 `ctx.model` 复用父模型，不硬编码 `deepseek-v4-flash`、Zen endpoint 或任何其他模型。实验/E2E 可以在父 Pi Session 选择 `deepseek-v4-flash`。

## 协议边界

`promptRefs` 与 `resourceGrants` 是两个不同概念：

- `promptRefs` 是 child 启动前物化一次的不可变 Prompt 快照，支持 inline 或带可选行范围的项目相对 file ref。
- `resourceGrants` 是运行期间 `scope_read`、`scope_list`、`scope_search` 可探索的资源范围；它不会自动注入 Prompt。

访问模式：

- `SEALED`：允许显式 prompt refs，不允许运行期资源工具。
- `BOUNDED`：默认模式，只物化和开放 invocation grants。
- `PROJECT`：为可信项目提供项目级只读快照；默认跳过 `.git`、`.pi`、`node_modules`。

模型只能通过 `scope_complete` 提交：

```ts
interface CompletionPayload {
  status: "SUCCESS" | "PARTIAL" | "NEED_CONTEXT" | "BLOCKED";
  summary: string;
  data?: unknown;              // SUCCESS/PARTIAL 必须提供；另按 outputSchema 校验
  evidenceRefs: EvidenceRef[];
  requestedResources?: RequestedResource[];
  warnings?: string[];
}
```

`scopeId`、`invocationId`、Skill 版本、usage、wall time、traceId、错误和最终时间由 Runtime 封装；这些字段不在 completion tool Schema 中，模型无法合法提交。`SUCCESS`/`PARTIAL` 必须携带并通过 output schema 的 `data`；`NEED_CONTEXT`/`BLOCKED` 可以省略业务数据。正常退出但未调用 `scope_complete` 会得到 `INVALID_RESULT`。timeout、budget、cancel 或 backend failure 始终优先于竞态中已接收的 completion。

`scope_complete` 采用 first-valid-wins，第二个合法 completion 会令整个结果 fail closed。Pi 0.84.2 的 sibling tools 同批并发，模型在该批结束前尚未看见任何 tool result；因此含 `scope_complete` 和任一 sibling tool 的 assistant message 会拒绝 completion，要求下一轮单独提交。Runtime 只用“接受 completion 之前”的 `modelVisibleSet` 校验 `evidenceRefs.resource`，不会用事后 final snapshot 为引用追认可见性。

`requestedResources` 状态矩阵是 fail closed 的：`NEED_CONTEXT` 必须给出非空列表；`SUCCESS`、`PARTIAL`、`BLOCKED` 不得请求扩权。每个 path 必须是无 absolute/drive/backslash/NUL/`..` 的项目相对路径，operations 必须是当前 Skill `allowedOperations` 的子集。v0.1 不会自动扩权，父级可审阅后发起一次新 Scope。另有一个最小通用 provenance 约定：`completion.data` 中任意层级名为 `evidenceIds` 的字符串数组，其每个 ID 都必须存在于 top-level `evidenceRefs.id`。

`budgetOverride` 只能取 SkillSpec 上限与本次值的最小值，因此调用方不能扩权。timeout 从 backend invocation 入口开始，覆盖 Gateway snapshot、Prompt materialization、ModelRuntime bridge、Session 创建、推理和清理；父级取消使用同一全链路 abort 边界。其他预算包括 turns、资源 tool calls、Prompt 字节和结果字节。

## ResourceBroker 的 real-fs adapter

`src/core/ResourceBroker` 是 virtual-only。`core-resource-gateway.ts` 把真实 cwd 转换成只读文本快照后，才把 `scope_*` tools 接到 Broker：

- BOUNDED 只扫描 grants 和显式 file prompt refs；不会越过授权 envelope 扫描项目。当前已实证主路径是 exact-file BOUNDED。
- PROJECT 扫描项目，但应用上述默认目录排除；工具面仍取 `allowedTools` 与 `allowedOperations` 的交集，PROJECT 不会扩大 Skill 的操作类型。
- SEALED 只读取显式 file prompt refs，Broker 仍拒绝一切运行期探索。
- 所有根先做 lexical containment，再 `realpath` containment；目录 symlink 不跟随，显式 symlink escape 会拒绝。
- cwd 本身先 canonicalize，兼容 macOS `/var` → `/private/var` 等系统路径别名。
- list-only 目录只物化路径元数据，不读取正文；`read`/`search` envelope 会在 trusted in-process adapter 中预物化授权正文，再交给 virtual Broker。`resourceAudit.physicalMaterializedSet` 与 `actualReadSet`/`modelVisibleSet` 分开记录。
- 默认 snapshot 限制：最多 5,000 个文件、物化正文总计 32 MiB、单文件 2 MiB。需要正文时遇到超限或二进制文件会明确 fail closed；不会为了让 `scope_list` 看似成功而静默省略路径。
- Snapshot 是执行开始时的视图；运行中的外部文件变化不会自动刷新。

这仍是进程内逻辑边界，不是 OS sandbox，也不声称物理读取最小化：模型可见访问由 Broker 强制，但 trusted adapter 可预物化已授权 envelope。目录 BOUNDED 与 PROJECT 在 v0.1 属于 experimental；若威胁模型包含恶意 Skill/Extension 作者，应切换到 ChildProcess/Container backend。

Realpath containment 也无法辨认“项目内 hardlink 与项目外文件共享同一 inode”的来源关系；v0.1 因而假设 cwd 是可信工作区，不把攻击者可预置 hardlink 的目录当作隔离边界。强对抗场景需要受控文件描述符/openat 或进程/容器文件系统。

## ModelRuntime 桥的信任假设

v0.1 只支持并验证 `openai-completions` transport，且父 `ModelRegistry.getApiKeyAndHeaders(ctx.model)` 必须为本次调用物化出 API-key snapshot；当前真实放行目标是父 Session 已选择的 `deepseek-v4-flash`。适配器无法也不尝试判断该 snapshot 最初来自设置、CredentialStore 还是父进程环境变量。它保证的是 child 不会在 snapshot 缺失时自行读取 ambient env 兜底：父 Registry 未返回 API key 即 fail closed。models.json-only/static custom provider 会由所选 model 与父侧 resolved request auth snapshot 重建。

下列配置明确不支持并在 child 调用前拒绝：

- 需要可刷新 OAuth credential 的 provider；
- 父 `ModelRegistry` 无法物化为本次 API-key snapshot、仍要求 child 自行读取 provider-specific environment/ambient credential 的认证；
- 非 `openai-completions` transport；
- custom native provider / `streamSimple` provider；Pi 0.84.2 的 `registerProvider()` 会删除同 id native registration，因此 v0.1 不声称能等价克隆 native stream；
- 每次请求动态生成且不能冻结为 resolved baseUrl/headers/env 的认证或路由。

桥接失败会在 child 调用前明确失败。解析出的 key 只存于临时内存 CredentialStore；不得写入 Prompt、错误详情或 Trace。

## Trace

Trace 必须位于项目 cwd 外。默认值：

```text
~/.pi/agent/skillscope/traces
```

可用绝对路径环境变量 `SKILLSCOPE_TRACE_ROOT` 覆盖。每个 Scope 写入：

```text
<traceRoot>/<scopeId>/manifest.json
<traceRoot>/<scopeId>/events.jsonl
<traceRoot>/<scopeId>/result.json
```

TraceStore 在创建目录前 canonicalize 最近存在祖先，创建后再次 `realpath` 检查，可阻止“项目外 symlink 指回 cwd”的目录副作用；scopeId 也拒绝路径分隔符。并发同用户恶意替换 symlink 的 TOCTOU 不在进程内 MVP 的保证范围，强对抗环境需 fd/openat 或进程/容器后端。

默认 Trace 格式是 `metadata-only-v1`：不落业务 summary/data、Prompt 内容、evidence claim、resource request reason、warning 或原始上游错误。它保存稳定 hash/bytes、状态、usage、安全错误分类，以及资源审计集合；路径、Prompt/source 名称和物理物化集合也只保存逐项 hash 与 count。通用系统无法可靠识别任意秘密，因此这里采用写入白名单，而不承诺内容级“自动脱敏”。这些 hash 是无盐 SHA-256：会泄漏相等关系，低熵值也可能被字典猜测；状态、计数、usage、时间戳等白名单元数据仍以明文保存。Trace 的多个文件不是事务性提交，写入失败只产生 warning，因此消费者必须把缺失或不完整 Trace 当作审计失败，而不能据此断言没有敏感访问。

## Skill 目录

每个 Scoped Skill 需要：

- `SKILL.md`：可同时作为 Pi native Skill 文档和 child instructions；
- `scope.json`：name/version、input/output JSON Schema、允许工具、资源策略和预算。

MVP 的 Runtime validator 支持 `type`、`const`、`enum`、`anyOf`、对象 properties/required/additionalProperties、数组 items/minItems/maxItems，以及字符串 minLength/maxLength。Manifest 若使用 `$ref`、`oneOf`、`pattern`、数值范围等尚未实现的约束会在加载时 fail closed，而不是静默忽略。

示例位于 `skills/analyze-evidence/`。父 Agent 调用示例见其中 `example.json`。

## 验证

```bash
npm run test:pi
npm run typecheck
```

Pi adapter 测试覆盖 Runtime 元数据所有权、状态相关 output、completion batch/重复提交、pre-completion evidence ledger、全链路 timeout、资源物化审计、真实路径 symlink escape、metadata-only Trace，以及 0.84.2 provider bridge refresh/fail-closed 矩阵。

当前依赖树配合 TypeScript 7/NodeNext 严格检查时，Pi 0.84.2 自身的若干 `.d.ts`（JSON import attributes、`path.PlatformPath`、transitive optional types）会在 `skipLibCheck: false` 下报第三方错误；仓库因此显式启用 `skipLibCheck: true`，项目源码仍在 strict 模式检查。该项属于依赖声明兼容性，不改变运行时协议。

### 2026-08-18 验证记录

- `npm run typecheck`：通过。
- `npm test`：通过；精确数量以当前 test runner 输出为准。
- `node scripts/security/run.mjs`：通过；29 个确定性/生成式 hostile tests，其中生成了 7,168 个 traversal/absolute/drive/separator 路径和 1,024 个 grant prefix-collision 操作。
- 真实 `deepseek-v4-flash` Extension E2E 已通过：运行于 Pi 0.84.2，使用 exact-file `BOUNDED` grant、父 `ModelRegistry` 物化的 API-key snapshot、`openai-completions` transport 与可信进程内 adapter；结果为 `SUCCESS`，3 turns、3 tool calls，并验证了 `metadata-only-v1` 外置 Trace、越权枚举拒绝和 grant 外文件未读。证据见 `docs/research/实验日志.md` Step 14 与 `experiments/pi-e2e/results/latest.json`。这只验证上述窄路径，不外推到目录/`PROJECT` 的物理最小读取、OAuth/native/custom-stream provider、恶意 Extension 的 OS 隔离或 Trace 的内容机密性。
