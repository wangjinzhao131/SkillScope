# Virtual Resource Broker

本目录实现 SkillScope 访问边界实验与 Pi 插件共用的只读资源内核。它使用纯 Node ESM 和内存文件快照，不依赖第三方包。

## 研究假设

Broker 将资源访问拆成三个可观测层次：

1. `attemptedSet`：模型/调用方尝试访问的路径；
2. `actualReadSet`：Broker 为完成工具调用真正检查或读取过的资源；
3. `modelVisibleSet`：Broker 返回到模型边界的资源。

例如，`search` 可能扫描两个文件但没有命中：两个文件进入 `actualReadSet`，都不进入 `modelVisibleSet`。因此“Canary 未出现在最终答案”不能替代边界测量；Canary 在 Prompt 或工具返回中出现时，会在 `canaryVisibility` 和 `model_visible` 事件中按 ID 记录。

`declaredSet` 是 SkillSpec 的最大包络，`grantedSet` 是本次调用的有效授权。`BOUNDED` 构造时强制 `grantedSet ⊆ declaredSet`；调用者不能通过 invocation grant 扩大 Skill 声明。路径包含关系按完整 segment 判断，`src/auth` 不覆盖 `src/authz`。

## 三种访问模式

- `PROJECT`（兼容 `PROJECT_READ_ONLY`）：整个虚拟项目可读，审计中表示为根目录 `.` 的完整 grant。
- `SEALED`：资源工具全部拒绝；只有显式 `promptRefs` 或由 adapter 调用 `recordModelVisibility` 注入的材料可见。
- `BOUNDED`（兼容 `BOUNDED_*` 实验臂名称）：只允许 invocation grants 覆盖的操作和资源。

Grant 结构：

```js
{
  path: "src/auth",
  kind: "directory", // 或 "file"
  operations: ["read", "list", "search"]
}
```

历史工具名仅作为输入兼容层：`grep → search`、`find/ls → list`。Snapshot 始终输出 canonical operations。

## API

```js
import { ResourceBroker } from "./src/core/index.js";

const broker = new ResourceBroker({
  files: [
    { path: "src/a.js", content: "export const a = 1", sensitivity: "public" },
  ],
  mode: "BOUNDED",
  declaredGrants: [
    { path: "src", kind: "directory", operations: ["read", "list", "search"] },
  ],
  grants: [
    { path: "src", kind: "directory", operations: ["read", "search"] },
  ],
  canaries: [{ id: "outside", value: "random-secret-token" }],
  promptRefs: [{ name: "task", content: "Inspect a.js", sourcePath: "src/a.js" }],
});

broker.read("src/a.js", { startLine: 1, endLine: 20, maxBytes: 4096 });
broker.list("src", { recursive: false, maxEntries: 100 });
broker.search("export", { path: "src", caseSensitive: true, maxResults: 20 });
broker.execute("read", { path: "src/a.js" });
broker.recordModelVisibility("adapter-created message", {
  source: "pi:tool-result",
  resourcePaths: ["src/a.js"],
});

const trace = broker.snapshot();
```

`read/list/search/execute` 是同步方法，调用方可以直接使用或 `await`。所有成功返回值都是 JSON-compatible object。拒绝通过 `ResourceAccessError` 返回，稳定字段包括：

```text
code, operation, rawPath, path, details
```

当前错误码包括 `SEALED`、`INVALID_PATH`、`UNAUTHORIZED`、`NOT_FOUND`、`NOT_A_FILE`、`NOT_A_DIRECTORY` 和 `INVALID_ARGUMENT`。

`snapshot()` 返回防御性副本，包含：

```text
declaredSet, grantedSet,
attemptedSet, attemptedOperations,
actualReadSet, actualReadOperations,
modelVisibleSet, modelVisibleSources,
canaryVisibility, events, denials, counts
```

Snapshot 不保存文件内容、查询原文或 Canary value，只保存哈希、Canary ID 和经过 Canary 替换的路径/来源。实验 runner 应把 snapshot 作为 Trace 数据，而不是重新向模型注入。

## 路径策略

输入路径必须是 POSIX 相对路径。Broker 会折叠重复 `/` 和 `.`，但拒绝：

- 任意 `..` segment；
- `/` 开头的绝对路径；
- 任意 Windows drive 前缀（如 `C:secret`、`C:/secret`）；
- 反斜杠和 NUL；
- 规范化后的重复文件；
- 同一路径同时作为文件和祖先目录。

拒绝 traversal 而不是先做 `normalize`，是为了保留 hostile attempt 的证据。百分号编码不会被解码；adapter 不得在 Broker 校验后再执行 URL decode 或其他路径重写。

## 明确不覆盖的安全边界

这是虚拟文件快照的 capability gateway，不是 OS sandbox。它针对的威胁模型是“不可信模型/内容通过已注册工具读取越界资源，而 Runtime 和 adapter 可信”。

真实文件系统 adapter 不能把 canonical string 直接拼到 cwd 后就声称安全。它仍需：

- 对授权根与目标执行 `realpath`/基于已打开 fd 的 containment；
- 拒绝 symlink、hardlink 与 mount escape；
- 防止检查与读取之间的 TOCTOU；
- 确保 Trace、凭据和 Artifact 位于所有授权根之外；
- 不在 Broker 校验后重新解码或改写路径。

如果 Skill/Extension 自己可以调用 `node:fs`、网络或子进程，Broker 无法拦截；该威胁模型需要 ChildProcess/Container 与 OS 权限边界。

## Adapter 责任

Broker 把自己的工具返回视为会进入模型消息，并自动记录 `modelVisible`。如果 adapter 对结果做裁剪、聚合或完全吞掉，应以真正提交的消息调用 `recordModelVisibility`，并在分析时注明自动记录与最终提交之间的差异。Pi 插件若要获得严格的一次边界记录，可在 adapter 层关闭/替换自动事件作为后续演化；当前 Pilot 保留自动记录，以免漏计可见 Canary。

`promptRefs` 有两种兼容格式：

- 路径快照：`{path,startLine,endLine,purpose}`，内容从构造时的虚拟项目解析；
- 内嵌快照：`{name,content,sourcePath?}`，适用于实验 fixture 已提前装配的 Prompt。

构造参数中的 `promptRefs` 表示“已经确定会注入模型”，因此会立即计入 `modelVisibleSet`。仅供候选选择、尚未注入的材料不应放入该字段。
