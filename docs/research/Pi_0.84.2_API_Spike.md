# Pi 0.84.2 公开 API Spike

> **历史证据说明：** 本文中的 `dry-run.ts`、`bridge-test.ts`、`live-bridge.ts` 位于当时的 `/tmp` Spike 工程，未提交，不能作为当前一键复现入口。现行证据由 `tests/pi/**`、`tests/plugin-audit/**` 与 `experiments/pi-e2e/**` 取代。早期“config/native provider clone 可行”只说明 API 探索；v0.1 产品桥已窄化为显式 API-key `openai-completions`，明确拒绝 ambient/OAuth/native/custom stream。

日期：2026-08-17
目标包：`@earendil-works/pi-coding-agent@0.84.2`
状态：公开类型核验、严格 TypeScript Spike、无网络确定性运行和真实 Zen 子 Session 均已完成。

## 1. 研究问题与结论

本 Spike 不以“文档看起来支持”为证据，而是直接检查 npm 发布物的声明文件和实现，再用精确版本依赖编译、构造 Session，并运行确定性 provider。

| 假设 | 结论 | 证据摘要 |
| --- | --- | --- |
| H-SDK-01：公开 API 足以实现进程内 SkillScope MVP | **有条件支持** | 独立 `AgentSession`、in-memory session、工具 allowlist、同名工具覆盖、最小 ResourceLoader 和终止工具均真实可用 |
| H-SDK-02：Extension 可直接复用父 `ModelRuntime` | **否决** | `ExtensionContext` 暴露 `model` 和 `modelRegistry`，但没有 `modelRuntime`；`ModelRegistry.runtime` 是 private |
| H-SDK-03：可经 `ModelRegistry` 安全桥接 API-key provider 到子 Runtime | **支持，但有实现不变量** | 动态 config、native provider 和内存 API key 均完成确定性桥接；桥接后必须对 provider 做一次无网络 `refresh` |
| H-SDK-04：`terminate: true` 无条件立即结束 Agent | **否决** | 它只是批次级 early-termination hint；只有同批所有 finalized result 都终止时才跳过下一次 LLM 调用 |
| H-SDK-05：内置工具 `operations` 都是完整资源后端 | **部分否决** | Read/Find/Ls 可注入关键 I/O；Grep 的实际搜索仍由本机 `rg` 直接完成 |
| H-SDK-06：工具 `execute()` 内 before/after `getContextUsage()` 可测当前工具结果增量 | **否决** | 当前工具结果在 `execute()` 返回后才进入父消息，execute 内的 after 通常仍看不到它 |

工程结论是：

> Pi 0.84.2 可以支撑 SkillScope 的进程内功能性 MVP。父模型和 API-key provider 可以通过公开 API 桥接，但不能宣称任意认证机制都能等价继承；资源隔离必须由 SkillScope 自己的工具后端承担。

## 2. 取证方法与可复现来源

发布物通过下列命令取得，未修改仓库根 `package.json`：

```bash
npm view @earendil-works/pi-coding-agent@0.84.2 \
  dist.tarball dist.integrity dist.shasum version types exports --json

npm pack @earendil-works/pi-coding-agent@0.84.2
npm pack @earendil-works/pi-agent-core@0.84.2
```

发布物标识：

```text
pi-coding-agent version: 0.84.2
sha1: e4d4c1e769963c816959f5cea02a0a10ccc0495a
integrity: sha512-l4E+B7hgXKWddRo8bC/eSue2aWZjEgJ9xIpf5p0Og+lq8a2TArCwJ0HCoCPCgaBP/tN4zbYH/wOwvx9pJpeLCA==
types: ./dist/index.d.ts
```

本文的路径和行号均相对于解包后的 npm package 根目录。关键声明位置如下：

| 能力 | 发布物证据 |
| --- | --- |
| 根入口公开导出 | `dist/index.d.ts:7-24` |
| `ExtensionContext` | `dist/core/extensions/types.d.ts:193-249` |
| `ExtensionAPI.registerTool` | `dist/core/extensions/types.d.ts:867-903` |
| `ToolDefinition.execute` | `dist/core/extensions/types.d.ts:342-386` |
| `createAgentSession` 选项 | `dist/core/sdk.d.ts:10-56, 107` |
| `DefaultResourceLoader` | `dist/core/resource-loader.d.ts:67-119` |
| `ModelRuntime` | `dist/core/model-runtime.d.ts:3-99` |
| `ModelRegistry` | `dist/core/model-registry.d.ts:16-44` |
| Session ID 与 parent 字段 | `dist/core/session-manager.d.ts:5-16, 125-140, 184-208, 318-341` |
| `AgentSession.modelRuntime` getter | `dist/core/agent-session.d.ts:243-245` |
| `AgentToolResult.terminate` | `@earendil-works/pi-agent-core/dist/types.d.ts:315-329` |
| Read/Grep/Find/Ls operations | `dist/core/tools/{read,grep,find,ls}.d.ts` |

临时 Spike 位于：

```text
/tmp/skillscope-pi-0842-typecheck
```

临时目录不是仓库交付物；本文保留了重建命令和最小代码设计。

## 3. 真实 Extension API

### 3.1 导入路径

以下符号都从公开根入口导入，不需要深层导入：

```ts
import {
  createAgentSession,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionOptions,
  type ExtensionAPI,
  type FindOperations,
  type GrepOperations,
  type LsOperations,
  type ReadOperations,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Type } from "typebox";
```

`typebox` 应作为插件的直接依赖声明，不能只依赖 Pi 的传递依赖。

### 3.2 `registerTool` 和 execute 签名

真实定义是：

```ts
pi.registerTool({
  name: "scoped_skill_run",
  label: "Run scoped skill",
  description: "Run a task in an independent AgentSession.",
  parameters: Type.Object({ task: Type.String() }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // Promise<AgentToolResult<TDetails>>
    return {
      content: [{ type: "text", text: "done" }],
      details: {},
    };
  },
});
```

完整参数顺序为：

```ts
execute(
  toolCallId: string,
  params: Static<TParams>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
  ctx: ExtensionContext,
): Promise<AgentToolResult<TDetails>>
```

工具失败没有独立的 `isError` 返回字段；通常应抛出异常。`isError` 是 tool-result 拦截和内部消息层的概念。

### 3.3 父 Session 可读取字段

`ExtensionContext` 明确提供：

```ts
ctx.cwd
ctx.sessionManager
ctx.modelRegistry
ctx.model
ctx.scopedModels
ctx.thinkingLevel
ctx.signal
ctx.getContextUsage()
ctx.getSystemPrompt()
ctx.abort()
```

因此父级 trace 可以直接记录：

```ts
const parent = {
  sessionId: ctx.sessionManager.getSessionId(),
  sessionFile: ctx.sessionManager.getSessionFile(),
  piParentSessionFile: ctx.sessionManager.getHeader()?.parentSession,
  model: ctx.model
    ? { provider: ctx.model.provider, id: ctx.model.id }
    : undefined,
};
```

三个语义需要校准：

1. `getSessionId()` 是正式公开方法，不应再写成可选链。
2. Pi 的 `parentSession` 是父 session **文件路径**，不是 session ID。SkillScope 自己的 lineage 应使用 `getSessionId()` 或独立 trace ID。
3. `ReadonlySessionManager` 仍公开 `getEntries()`、`getBranch()` 和 `buildContextEntries()`。可信插件代码能读取父历史；隔离承诺应表述为“子 Session 不继承父消息”，而不是“插件 Runtime 看不到父消息”。

`AgentSession` 对 SDK 消费者公开 `session.modelRuntime`，但 Extension tool 的 `ctx` 没有父 `AgentSession`，因此没有受支持的 `ctx.modelRuntime`。

## 4. 独立子 Session 的最小正确组合

`createAgentSession()` 真实支持：

```ts
cwd
agentDir
modelRuntime
model
thinkingLevel
scopedModels
noTools
tools
excludeTools
customTools
resourceLoader
sessionManager
settingsManager
sessionStartEvent
```

独立上下文的关键不是 `createAgentSession()` 本身，而是显式传入一个新的：

```ts
SessionManager.inMemory(cwd)
```

它不会继承父消息，也不写 session 文件。

### 4.1 ResourceLoader 的实际必填项

设计稿原示例需要修正：`DefaultResourceLoader` 的 `cwd` 和 `agentDir` 都是必填字段。仅写 `{ cwd, settingsManager }` 会在严格 TypeScript 下得到 `TS2741`。

建议的子 Scope loader：

```ts
const settingsManager = SettingsManager.inMemory();
const loader = new DefaultResourceLoader({
  cwd,
  agentDir: getAgentDir(),
  settingsManager,

  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,

  systemPromptOverride: () => compiledChildPrompt,
  appendSystemPromptOverride: () => [],
});
await loader.reload();
```

公开覆盖项确实包括：

```text
extensionsOverride
skillsOverride
promptsOverride
themesOverride
agentsFilesOverride
systemPromptOverride
appendSystemPromptOverride
```

但 `no*` 开关比“加载后再清空”更适合作为隔离默认值，因为 extensions/context files 在 override 之前已经发生发现和读取。需要子 Scope inline extension 时，可使用 `extensionFactories`；`noExtensions: true` 不会删除显式 inline factory。

另外，Pi 的系统提示构建器仍会加入 cwd 等运行信息。因此 `systemPromptOverride()` 是“替换自定义主体”，不是保证最终 system prompt 与返回字符串逐字相同。

### 4.2 tools 是名称 allowlist

```ts
const { session } = await createAgentSession({
  cwd,
  model,
  modelRuntime,
  resourceLoader: loader,
  settingsManager,
  sessionManager: SessionManager.inMemory(cwd),
  tools: ["read", "grep", "find", "ls", "scope_complete"],
  customTools,
});
```

`tools` 不只是初始 UI 选择，它会成为允许名称集合；后续扩展 reload 也会被过滤。

`createAgentSession()` 不暴露 `ToolsOptions` 或 `baseToolsOverride`。要注入 grant-aware I/O，正确做法是把同名定义放进 `customTools`；SDK custom tool 后写入 registry，会覆盖同名 builtin。

严格 TypeScript 下，具体泛型的内置 definition 直接组成数组会遇到函数参数逆变导致的 assignability 错误。用 `defineTool()` 包一层可同时保留参数推断和 `customTools` 兼容性：

```ts
const customTools = [
  defineTool(createReadToolDefinition(cwd, { operations: readOps })),
  defineTool(createGrepToolDefinition(cwd, { operations: grepOps })),
  defineTool(createFindToolDefinition(cwd, { operations: findOps })),
  defineTool(createLsToolDefinition(cwd, { operations: lsOps })),
  scopeComplete,
];
```

## 5. 文件工具 operations 的真实边界

公开类型如下：

| 工具 | 可替换操作 |
| --- | --- |
| Read | `access`, `readFile`, 可选 `detectImageMimeType` |
| Grep | `isDirectory`, `readFile` |
| Find | `exists`, `glob` |
| Ls | `exists`, `stat`, `readdir` |
| Bash | `exec` |
| Edit | `readFile`, `writeFile`, `access` |
| Write | `writeFile`, `mkdir` |

所有文件路径会先解析为绝对路径；绝对路径、`..` 和 home 展开并不会被 cwd 自动阻断。授权后端必须对每次 operation 收到的绝对路径执行：

```text
normalize/canonicalize
→ realpath 或等价对象身份检查
→ grant root containment
→ symlink/TOCTOU 策略
→ 实际 I/O
```

不能只在工具参数进入时做字符串前缀比较。

### Grep 的特殊风险

`GrepOperations` 不是完整 grep 后端。0.84.2 的实现顺序是：

1. 通过 `ops.isDirectory(searchPath)` 检查入口；
2. 直接 `spawn(rgPath, args)` 搜索真实文件系统；
3. 只有上下文行读取走 `ops.readFile(filePath)`。

证据：`dist/core/tools/grep.js:76-148`。

因此：

- 对本机 BOUNDED 目录，可以在 `isDirectory` 中 canonicalize 并拒绝越界根，再让 `rg` 搜索已批准根；仍需处理 symlink 和检查后替换的 TOCTOU。
- 对远程/虚拟资源或严格对象能力系统，不能把 `GrepOperations` 当作完整抽象；应实现 SkillScope 自己的 grep ToolDefinition。

## 6. `scope_complete` 与 terminate 的真实语义

最小终止工具可以编译：

```ts
const scopeComplete = defineTool({
  name: "scope_complete",
  label: "Complete scope",
  description: "Submit the final structured scope result.",
  parameters: Type.Object({
    summary: Type.String(),
    evidence: Type.Array(Type.String()),
  }),
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text" as const, text: "Scope result accepted." }],
      details: params,
      terminate: true,
    };
  },
});
```

`terminate` 是 execute result 字段，不是 ToolDefinition 顶层字段。它也不是 `abort()`：

- 当前批次中已经产生的其他工具仍会运行；
- 只有同一批次每个 finalized tool result 都带 `terminate: true`，agent loop 才跳过自动 follow-up；
- 如果模型同批调用 `read + scope_complete`，普通 read result 不终止，仍可能再产生一次 LLM 调用。

因此必须同时做：

1. 提示模型将 `scope_complete` 作为唯一、最后的调用；
2. 记录 `scope_complete` 与其他工具同批出现的发生率；
3. Runtime 从 tool result 的 `details` 提取模型提交内容，自己生成可信的 scope/session/usage/status 外壳。

确定性 faux provider 实验得到：

```json
{
  "completionResults": 1,
  "assistantMessages": 1,
  "lastRole": "toolResult",
  "providerCalls": 1
}
```

这证明“单独调用终止工具”的 happy path 会跳过额外 assistant continuation；不证明混合批次也终止。

## 7. 父 ModelRegistry 到子 ModelRuntime 的桥

### 7.1 为什么需要桥

如果 `createAgentSession()` 不传 `modelRuntime`，它会新建 Runtime，并重新读取默认 auth/models 文件。这对默认 agentDir、持久化认证和内置 provider 通常可用，但不能保证继承：

- 父 Runtime 的 `setRuntimeApiKey()` 临时 key；
- Extension 动态注册的 provider；
- 父进程使用的自定义 agentDir；
- 任意 provider-private credential 状态。

虽然 `ctx.modelRegistry.runtime` 在 JavaScript 运行时存在，它在公开声明中是 private。SkillScope 不应通过类型逃逸读取它。

### 7.2 已验证的公开 API-key 桥

0.84.2 的 `ModelRegistry` 提供了足够的受支持方法：

```ts
getRegisteredProviderConfig(providerId)
getRegisteredNativeProvider(providerId)
getRegisteredProviderIds()
getApiKeyForProvider(providerId)
```

已编译并运行通过的桥接逻辑：

```ts
async function bridgeProviderRuntime(
  parentRegistry: ModelRegistry,
  providerId: string,
  signal?: AbortSignal,
): Promise<ModelRuntime> {
  const child = await ModelRuntime.create({
    // 不读取默认 auth.json；子 Runtime 只获得下面显式桥接的 key。
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    signal,
  });

  const native = parentRegistry.getRegisteredNativeProvider(providerId);
  const config = parentRegistry.getRegisteredProviderConfig(providerId);
  if (native) {
    child.registerNativeProvider(native);
  } else if (config) {
    child.registerProvider(providerId, config);
  }

  const apiKey = await parentRegistry.getApiKeyForProvider(providerId);
  if (apiKey) {
    await child.setRuntimeApiKey(providerId, apiKey, { signal });

    // Pi 0.84.2 必须保留的实现不变量，见下一节。
    await child.refresh({
      providers: [providerId],
      allowNetwork: false,
      signal,
    });
  }
  return child;
}
```

对于内置 provider，新的 Runtime 已有 provider/model 定义，只需桥接 key；对于 Extension 动态 config/native provider，则先复制选中 provider。`InMemoryCredentialStore` 是安全边界的一部分：若省略它，`ModelRuntime.create()` 默认仍可能读取用户的 auth storage，使子 Runtime 在内存中拥有未声明的其他 provider 凭据。

### 7.3 明确实现不变量：桥接后必须 refresh

确定性实验复现了一个 0.84.2 状态不一致：动态 provider config 注册并 `setRuntimeApiKey()` 后，子 Runtime 一度呈现：

```json
{
  "hasConfig": true,
  "hasModel": true,
  "hasAuth": false,
  "authStatus": { "configured": true, "source": "runtime" },
  "getAuthResolved": true
}
```

也就是说：

- `getProviderAuthStatus()` 已认为 runtime key 存在；
- `getAuth()` 已能解析认证；
- 但 `hasConfiguredAuth()` 的 snapshot 仍为 false。

追加一次：

```ts
await child.refresh({ providers: [providerId], allowNetwork: false, signal });
```

后 `hasConfiguredAuth()` 变为 true，完整桥接和子 Session 运行通过。

这不是可选优化，而是 SkillScope 在 Pi 0.84.2 上的实现不变量，必须有回归测试。若未来升级 Pi，应保留测试，再决定能否删除 workaround。

### 7.4 桥接的安全边界

当前证据只支持以下承诺：

> 对选中 provider 的静态 config/native provider 和可解析 API key，可经公开 API 构造功能等价的子 Runtime。

不能扩大为“复制任意认证状态”，原因包括：

- `getApiKeyForProvider()` 只返回 key，不返回 credential store 本身；
- 动态 OAuth 刷新生命周期、provider 特有 env、临时 headers 和非 API-key 凭据未被证明等价；
- native provider 对象可能含共享可变状态，是否允许共享需按 provider 单独审计；
- `InMemoryCredentialStore` 阻止默认 auth 文件继承，但进程内 Runtime 仍处于同一 `process.env`；它不是进程级秘密隔离；
- 不应把解析后的 key 写入 Trace、错误 details 或 session。

实现要求：

1. 只桥接本次 `ctx.model.provider`，不要默认复制全部 provider。
2. 创建 child Runtime 时显式传入新的 `InMemoryCredentialStore`，禁止隐式读取默认 auth storage。
3. key 只放在子 Runtime 的 `setRuntimeApiKey()` 内存覆盖中。
4. Scope 结束后调用 `removeRuntimeApiKey(providerId)`，再释放 Session/Runtime 引用。
5. OAuth、Bedrock 一类复杂凭据在未专项验证前标记为 `UNSUPPORTED_AUTH_BRIDGE`，而不是静默降级。

若威胁模型要求“不可信 Skill 代码不能观察宿主环境变量”，InProcessBackend 无法提供该保证，应使用带白名单环境的 ChildProcess/Container Backend。

## 8. 取消、清理与上下文测量

`createAgentSession()` 和 `session.prompt()` 没有直接的调用级 signal 参数。Extension tool 收到的 `signal` 需要显式桥接：

```ts
const abortChild = () => void session.abort();
signal?.addEventListener("abort", abortChild, { once: true });

try {
  await session.prompt(prompt, { expandPromptTemplates: false });
} finally {
  signal?.removeEventListener("abort", abortChild);
  session.dispose();
}
```

### `getContextUsage()`

真实返回类型：

```ts
type ContextUsage = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
};
```

整个返回值还可能是 `undefined`。它是当前消息的上下文估算，不等于精确 billed token；刚 compaction 且尚无新 assistant usage 时，`tokens` 和 `percent` 会为 null。

父工具 execute 中的：

```ts
const before = ctx.getContextUsage();
await runChild();
const after = ctx.getContextUsage();
```

通常测不到当前 `scoped_skill_run` 的结果，因为 tool result 是 execute 返回后才写入父消息。正确设计应：

- execute 开始时按 `toolCallId/traceId` 保存 before；
- 在父 `turn_end` 后采样 parent-visible context；
- 下一次父 assistant usage 用于 billed-input 近似；
- 子 Session 另用 `session.getContextUsage()` 和 usage totals 计量。

## 9. 编译与确定性运行记录

环境：

```text
Node.js v26.0.0
npm 11.12.1
TypeScript 5.9.3
@earendil-works/pi-coding-agent 0.84.2
@earendil-works/pi-agent-core 0.84.2
@earendil-works/pi-ai 0.84.2
typebox 1.3.7
```

重建临时项目：

```bash
mkdir -p /tmp/skillscope-pi-0842-typecheck
cd /tmp/skillscope-pi-0842-typecheck
npm init -y --scope=skillscope
npm install --save-exact \
  @earendil-works/pi-coding-agent@0.84.2 \
  @earendil-works/pi-ai@0.84.2 \
  typebox@1.3.7 \
  typescript@5.9.3 \
  @types/node@24.12.4
```

验证命令：

```bash
npm exec tsc -- --noEmit
node --experimental-strip-types dry-run.ts
node --experimental-strip-types bridge-test.ts
```

结果：

```json
{"activeTools":["find","grep","ls","read","scope_complete"],"toolSources":{"read":"sdk","grep":"sdk","find":"sdk","ls":"sdk","scope_complete":"sdk"},"messageCount":0,"sessionPersisted":false,"hasModel":true}
{"dynamicConfigCloned":true,"apiKeyBridgedInMemory":true,"nativeProviderCloned":true,"completionResults":1,"assistantMessages":1,"lastRole":"toolResult","providerCalls":1}
```

这两次运行分别证明：

- 新 in-memory Session 没有继承消息；
- 允许的五个工具均激活；
- 同名 read/grep/find/ls 来自 SDK custom tool，确实覆盖 builtin；
- 动态 provider config、runtime API key 和 native provider 均能通过公开 API 桥接；
- 单独的 `terminate: true` completion 会结束确定性 agent loop。

`tsconfig` 使用 `strict: true` 和 `skipLibCheck: true`。关闭 `skipLibCheck` 时，0.84.2 的传递声明图在本环境出现第三方 `undici-types`、MCP SDK 和 JSON import attribute 错误；这些不是 Spike 源码错误，但插件构建当前需要保留 `skipLibCheck`，或由上游依赖修复后再收紧。

## 10. 真实 Zen E2E 结果

已准备：

```text
/tmp/skillscope-pi-0842-typecheck/live-bridge.ts
```

脚本使用 `deepseek-v4-flash`，并在父 `ModelRegistry` 显式注册动态 Zen provider config：

```text
baseUrl = https://opencode.ai/zen/go/v1
api = openai-completions
maxTokens = 1024
```

然后执行：

```text
EXPERIMENT_KEY
→ parent ModelRegistry.registerProvider(...)
→ parent ModelRuntime.setRuntimeApiKey(providerId, key)
→ ModelRegistry public bridge
→ child ModelRuntime
→ independent AgentSession
→ scope_complete
```

子任务的普通非交互 exec 没有该环境变量；主实验环境随后通过登录 zsh 注入变量，并在不打印凭据的前提下执行：

```bash
zsh -ilc 'cd /tmp/skillscope-pi-0842-typecheck && npm exec tsc -- --noEmit && node --experimental-strip-types live-bridge.ts'
```

加入独立 `InMemoryCredentialStore` 后重新执行严格版；TypeScript 检查和 live run 总计约 12.9 秒、退出码 0，输出：

```json
{
  "dynamicProviderCloned": true,
  "apiKeyResolved": true,
  "childAuthConfigured": true,
  "toolCalls": 1,
  "completionResults": 1,
  "assistantMessages": 1,
  "lastRole": "toolResult"
}
```

这证明公开桥接路径不仅能通过 faux provider，还能在不读取默认 credential store 的配置下完成一次真实 Zen 网络闭环：动态 provider 被复制到 child Runtime，内存 key 可解析，独立 Session 调用 `scope_complete`，`terminate: true` 跳过额外 assistant continuation。运行日志没有输出 API key。

本次配置是为 transport/bridge 预检固定的最小配置，不能据此宣称所有 `deepseek-v4-flash` reasoning/compat 组合都已验证。后续正式实验应从锁定的 Pi model catalog 或实验 manifest 读取完整模型参数，并把实际参数随 run metadata 记录。

## 11. 对 SkillScope 实现的直接决策

1. **InProcessBackend 可继续开发。** 独立 Session、最小 loader、工具覆盖和结构化完成协议均已有编译与确定性运行证据。
2. **为 API-key provider 实现公开桥。** 不读取 private runtime；桥接后强制执行 provider-scoped、`allowNetwork:false` 的 refresh。
3. **复杂认证先显式拒绝。** 未验证的 OAuth/env/header credential 不得被描述为继承成功。
4. **ResourceLoader 默认全关闭。** 使用 `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles`，再显式加入 Scope 所需资源。
5. **资源边界放在自有工具后端。** 尤其不要把 `GrepOperations` 当成完整远程或 capability filesystem。
6. **completion 只提交模型字段。** Runtime 生成 scope ID、状态、usage、trace 和版本字段。
7. **上下文增量延后采样。** execute 内只记录 before，父 turn 结束后再测 parent-visible 增量。
8. **保留回归测试。** 至少覆盖 provider refresh 不变量、同名工具覆盖、零消息继承、completion 单调用终止和混合工具批次不终止。
