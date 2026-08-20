# SkillScope Routing Authority Experiment

状态：**设计与本地Harness已实现，全仓`npm run verify`通过；尚未调用本实验的live任务API。**

本实验固定同一main Skill、同一原子Skill、两次child Scope与Runtime自动child-evidence binding，只比较模型根据routing cue选顺序和工作流声明依赖后由Runtime侧给出顺序。完整设计见[预注册](../../docs/research/SkillScope路由权责实验预注册_v1.md)。

计划矩阵为六个family、三个repeat、两个条件，共36个trial。Raw manifest/results将写入`experiments/routing-authority/runs/`并由Git忽略；仓库只提交审核后的报告。

## 条件

- `MODEL_ROUTED`：同一main Skill读取routing cue，自行选择constraint-first、observation-first或parallel。
- `RUNTIME_ROUTED`：工作流作者声明依赖方向，Runtime侧把它映射为具体组合模式；main仍只负责执行该模式。

两组都调用同一个`workflow-compose`和同一个`inspect-contextual-evidence`两次，也都由Runtime把本次真实child Scope绑定为最终evidence refs。区别只有“谁决定组合模式”。

## 本地与live命令

```bash
npm run test:routing
npm run routing:smoke
zsh -ilc 'npm run routing:preflight'
npm run routing:plan
zsh -ilc 'npm run routing:run'
npm run routing:analyze
```

正式plan要求结果相关文件已进入clean commit；每个results文件只允许单进程writer。
