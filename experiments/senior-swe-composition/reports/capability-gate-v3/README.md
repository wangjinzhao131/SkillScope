# Senior SWE Runtime checkpoint capability gate v3

状态：**ALL CAPABILITY GATES PASSED / EFFECT NOT ESTABLISHED**

日期：2026-08-22（Asia/Shanghai）

## 结论

Runtime把工作工具收窄为当前completion后，`deepseek-v4-flash`第一次在同一真实任务上让Inline、Flat、Composed三臂都完成investigate→implement→review→repair、形成非空patch并进入有效原生verifier。真实效果实验因此具备基本可比性；本轮每臂只有一次，不能据此判断哪种组合表现更好。

## 逐级结果

| gate | 运行 | 用时 | stages | checkpoint stages | patch | native | root bytes | coordinator/worker bytes | total tokens |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | Composed investigate-only | 393.7s | 1/1 | 1 | n/a | n/a | 1,604 | 6,085 | 852,807 |
| B | Composed full | 713.9s | 4/4 | 2 | 3,757B | 1/4 | 1,852 | 17,721 | 1,705,513 |
| C1 | Flat full | 826.9s | 4/4 | 2 | 7,302B | 2/4 | 1,852 | 646,917 | 9,836,732 |
| C2 | Inline full | 765.4s | 4/4 | 1 | 7,878B | 2/4 | 682,857 | 682,857 | 7,953,700 |

三条完整链路全部满足：4/4 Runtime-valid stages、非空artifact、native verifier infrastructure valid、runner error为空、实际启动Scope全部销毁、active Scope/container为0、Sentinel与raw transcript不进入父投影。

原生成绩1/4、2/4、2/4只是探索性观测。Composed、Flat和Inline各自产生了不同patch；一次运行既不能估计平均正确率，也不能区分组合效果与模型运行波动。

## 机制证据

- Gate A工作30 turns仍未自然完成，Runtime checkpoint只用1 turn提交合法investigate结果；这直接证实completion-only机制能解决v2的共同收口故障。
- 完整Composed与Flat的调查、实现都由checkpoint收口；Inline的调查由checkpoint收口，后三阶段自然完成。
- disposable两臂相对Inline的父末态下降99.73%。
- Composed相对Flat的工作/编排末态下降97.26%；这符合fresh leaf不继承前阶段工作transcript的机制预期。
- 本次Composed总tokens比Flat低82.66%、比Inline低78.56%，但这是单任务单次结果，只构成正式pilot的成本假设，不构成效果结论。

## 一项测量命名修正

v3 raw中的`workTurns=41`表示SDK发出第41个`turn_start`后立刻被40-turn门abort；最后一个边界turn没有完成新的repo工作，但旧字段把turn start与完成turn合称为`workTurns`。Raw不改。正式运行从分析层记录：

- `workTurns`：最多40个已完成工作turn；
- `workTurnStarts`：包括被abort的边界start；
- `workTurnLimitTriggered`：是否触发上限。

该修正不增加调用、工具或预算，只消除计数歧义，并有回归测试。

## Raw identity

四文件bundle SHA-256：

```text
3d415b4eda0ec37b9aaf679ae4be78e92abcec6264a1722c2bc2a9b1c84a59f4
```

登录环境中的`EXPERIMENT_KEY`精确值在四份raw中命中0。单文件哈希：

```text
ee7d71aedf4b770bb69354047e8fbc1627c635059c535f25ffdb7c6cd8593b22  gate-a-electric-composed-investigate.json
5ebd556a63b73fe258e955aa536e986628f76354f78fbb10b8c754d82e974b0b  gate-b-electric-composed-full.json
dec5764a0a3324c5e01801a1b311f1b36e196db0f4e3e874b165edb4d507bade  gate-c1-electric-flat-full.json
9c6b9b3e7c0093a58fcd18eb14118fe4efc775ecb6dca264a1b7edf47ce35a9f  gate-c2-electric-inline-full.json
```

Raw results保持Git ignored。
