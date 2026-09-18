---
title: AEEIS Agent 重新设计基线
status: proposed-architecture
created: 2026-09-18
tags: [aeeis, agent, rsi, brain, product-architecture, design-baseline]
---

# AEEIS Agent 重新设计基线

## 设计决定

AEEIS 从“聊天机器人”重新定义为一个拥有长期 Brain、持续推进任务、能够在受控范围内自我改进的 Agent。它独立于 `ai-chat-system` 重新设计，现阶段只冻结方案和协议，不进入实现。

核心定位：

> 一个由用户拥有长期 Brain、对外保持单一身份、能够持续推进项目，并通过可验证的 Personal Skill Profile 逐渐适应用户的 Agent。

AEEIS 的差异化不是模型数量或聊天界面，而是下面四件事同时成立：

```text
用户拥有的 Brain
+ 单一持续身份
+ 权限化 Shared Session
+ 可验证的个人自进化
```

## 产品形态

AEEIS 对外只有一个持续身份。内部可以调度 Planner、Researcher、Reviewer、Operator 等角色，但这些角色不各自维护对外承诺，不直接成为用户联系人。

AEEIS 的核心对象是：

```text
Brain
  → Identity
  → Room / Goal
  → Plan
  → Durable Run
  → Artifact / Decision
  → Receipt
  → Evolution Candidate
```

第一阶段从“项目持续推进 Agent”切入，首个核心 Skill 可命名为 `Project Pulse`：

- 读取项目文档、任务、消息和代码变化；
- 汇总进展、风险、阻塞和决策；
- 生成下一步行动并跟进负责人和截止日期；
- 生成日报、周报和决策记录；
- 需要时发起审批和后续提醒；
- 学习用户的汇报风格、提醒频率和决策偏好。

## AEEIS 自己必须拥有的语义控制权

以下对象属于 AEEIS 的核心领域，不能整体外包：

- Agent Principal、Identity 和对外单一身份；
- Authorization、Grant、Capability 和 Approval；
- Brain 的语义模型、权限、来源、版本、撤销与写回；
- Room、Goal、Task、Plan Graph 和业务状态；
- Run、Step、Attempt、Checkpoint、Context Manifest；
- Run Receipt、Model Decision 和 Evidence Graph；
- 多 Agent 协作、竞争、辩论、结果验证和最终合并；
- RSI / Evolution Engine；
- 用户可见的任务状态、DAG、Timeline 和审计记录。

这些对象共同决定 AEEIS “知道什么、为何行动、能做什么、如何恢复、如何学习”。基础设施可以替换，语义控制权不能随外包系统转移。

## 外部能力的使用原则

采用：

> 外包基础设施，复用连接器，保留语义控制权。

| 外部项目或基础设施 | AEEIS 使用内容 | AEEIS 保留内容 |
|---|---|---|
| `toolkit_new` | Tool、Connector、Sandbox、Artifact、Capability、Tool Receipt | 任务目的、最终授权、工具选择理由、结果验证、写回和审计 |
| `ownhow` | Skill / Method 发现、解析、Receipt、Proposal、Apply、Rollback | Personal Skill Profile、用户授权、运行组合、真实任务反馈和最终晋升 |
| `planprice`（aiplans.dev） | Model、Provider、价格、Benchmark、Availability 目录 | 每次 Model Decision、预算、隐私约束、路由理由、fallback 和结果责任 |
| Temporal | 长时 Workflow、Timer、Signal、Retry、Heartbeat、Child Workflow、Continue-As-New、Worker Versioning | 用户任务 DAG、业务状态、Context Manifest、Checkpoint 语义、审批、Evidence Graph 和 UI 投影 |
| 外部任务系统 | Linear、Jira、Todoist、飞书等的人类任务投影与同步 | AEEIS Goal、Task、Run、Approval、Receipt、长时运行状态 |
| 外部知识系统 | 文档、代码、Wiki、消息等 Connector 和索引能力 | Brain 语义模型、provenance、ACL、Grant、版本、撤销、Context Manifest 和规范化投影 |

## 记忆、任务、知识库的边界判断

这三类能力都不适合“整体外包”。

### 记忆

向量库、全文索引、Embedding、缓存和对象存储可以外包；Brain 的 claim、provenance、scope、grant、version、correction、writeback 和删除语义必须由 AEEIS 控制。向量索引只是可重建的检索加速层。

### 任务

外部系统适合承载人类需要查看和分配的任务，但 Agent 的 Goal、Plan、Run、Attempt、Checkpoint、Approval 和 Receipt 组成另一套运行语义。二者通过带来源和幂等键的投影同步，不能让外部任务系统成为 Agent 执行状态的唯一来源。

### 知识库

AEEIS 不重新做一个完整 Wiki。外部知识源通过 Connector 接入，AEEIS 保存带 provenance、classification、version 和访问授权的规范化投影。用户可以替换源系统，AEEIS 仍保留可解释的知识引用和上下文清单。

## 三个持久化事实源

AEEIS 运行时至少维护三类图：

```text
Plan Graph       用户可理解的目标拆解与版本
Execution Graph  真实执行、重试、等待、审批和补偿
Evidence Graph   产物、主张、工具回执、模型回执和来源之间的证据关系
```

三者不应压缩为一张图。Plan Graph 可以是 DAG；Execution Graph 为了表达 retry、loop 和等待，可能不是 DAG；Evidence Graph 是可审计的依赖图。

## 受控 RSI

AEEIS 的自进化不是模型自由重写自己，而是：

```text
真实任务
→ Receipt / Correction / Outcome
→ 误差归因
→ 最小 Improvement Candidate
→ Replay + Holdout + Safety Eval
→ Shadow / Canary
→ 用户或策略审批
→ Promotion / Rollback
```

默认只允许低风险个人 Profile 逐步适配。Skill、Tool 权限、Workflow、公共版本和基础设施的变化需要更高等级的评测和审批。每次变化都必须有版本、证据、观察窗口和回滚点。

## 设计原则

- 先服务一个用户的真实长期工作，再扩展为开放世界；
- 渠道只是投影，Brain、Task、Run、Receipt 才是事实源；
- 看见消息、获得上下文、调用工具、使用账号、代表 AEEIS 发言是不同权限；
- 外部 Agent 默认只获得任务级、最小化、短期的授权；
- 运行失败、外部状态不明、证据不足都必须显式呈现；
- 稳定性、隐私和可回滚性优先于自动化数量；
- 用可验证的结果降低用户重复解释和手工修改，而不是追求“自动进化次数”。

## 分阶段策略

1. **内部协作**：验证 Plan/Execution/Evidence 三图、DAG、Temporal 和 Receipt。
2. **内部竞争**：验证盲评、证据绑定、成本控制和独立评估。
3. **可信外部 Agent**：验证 Agent Card、Context Acknowledgement、Delegation Grant 和 Result Envelope。
4. **开放世界联邦**：验证发现、声誉、撤销、跨组织协作、计费与争议处理。

在前两个阶段完成前，不将 AEEIS 做成开放 Agent 市场，也不把自进化宣传成无需监督的自主改写。
