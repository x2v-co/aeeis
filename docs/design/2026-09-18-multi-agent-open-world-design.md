---
title: AEEIS 多 Agent 协作、竞争与开放世界设计
status: proposed-architecture
created: 2026-09-18
tags: [aeeis, multi-agent, collaboration, competition, debate, open-world]
---

# AEEIS 多 Agent 协作、竞争与开放世界设计

## 单一身份与内部编排

AEEIS 对用户保持单一身份：

```text
AEEIS
  ↓ Collaboration Orchestrator
  ├── Planner
  ├── Researcher
  ├── Reviewer
  ├── Operator
  └── External Agent
  ↓
统一验证、合并、审批和返回
```

内部 Agent 是执行器。它们的上下文、工具、成本、状态和承诺归属于 AEEIS 的 Run；外部 Agent 即使完成任务，也只能返回候选结果。

## 三类 Agent

1. **Internal Agent**：AEEIS 自己控制版本、权限和运行环境。
2. **Trusted External Agent**：已注册，有明确 Agent Card、协议、身份和历史表现。
3. **Open World Agent**：临时发现或未充分验证，只能获得最小授权和隔离任务。

信任不是一个总分，而是按任务类型和维度记录：身份、结果质量、证据完整性、工具安全、延迟稳定性、成本稳定性、隐私合规和撤销响应。

## 协作 Workflow

协作适合有依赖的分工：

```text
Planner → Researcher → Reviewer → Operator
```

每个节点接收自己的 Task Brief 和 Context Pack，只拿到所需信息。前一个 Agent 的结果以 Result Envelope 传递，不能让后继 Agent自动读取前者的完整聊天历史。

## 竞争 Workflow

竞争用于降低单一 Agent 偏差或探索不同方案：

- 所有参赛 Agent 使用相同 Task Brief；
- 结果在提交前互相隔离；
- 可使用不同 Model、Provider、Skill 和 Tool；
- 独立 Evaluator 评分，不由参赛 Agent 担任唯一评委；
- 结果必须绑定证据、成本和 Context Version；
- 事实型任务必须进行来源验证，不能用多数投票取代事实检查。

竞争输出包括候选排名、分歧点、证据差异、评估理由和未解决风险，而不是只有一个分数。

### Durable Competition Attempt

每个 participant 和 evaluator 都先创建持久化 Attempt，再调用外部模型或 Agent：

```text
reserve attempt(input_hash)
→ execute once
→ persist completed / failed result
→ evaluate
```

如果服务在副作用之后、写回之前重启，Attempt 保持 `started`。恢复流程不得再次调用原 participant 或 evaluator；操作者必须使用 `reconcile-attempt` 或 `reconcile-evaluator` 提供已核实的 Result Envelope / score，之后编排才能继续。Attempt 的 input hash、状态、错误、结果和时间戳属于协作事实源，不能只依赖 Temporal History 或内存 Promise。

## Debate Workflow 与飞书群入口

Hermes 的飞书群辩论可以作为交互入口，但群聊只是投影，正式事实来自结构化 Debate Event Log。

Debate Room 包含：

```text
Debate Goal
Participants / Roles
Rounds / Speaking Order
Evidence Policy
Time / Token Budget
Moderator
Adjudicator
Decision Rule
Final Artifact
```

流程：

```text
发布 Debate Brief
→ 各 Agent 独立立场
→ Moderator 检查格式与证据
→ 限定轮次质询
→ 更新立场
→ Reviewer 检查冲突
→ Adjudicator 形成结论
→ AEEIS 写入 Decision / Task / Artifact
```

每条消息带 `debate_id`、`round_id`、`speaker_agent_id`、`reply_to`、`claim_refs`、`context_version` 和 `message_type`。消息类型包括 position、evidence、challenge、rebuttal、clarification、concession、decision。

必须设置最大轮数、最大成本、单 Agent 发言次数、最大等待时间、无证据观点上限和无限循环中止规则。

## 开放世界生命周期

```text
Discovery
→ Admission
→ Delegation
→ Execution
→ Verification
→ Reputation
→ Revocation
→ Learning
```

开放世界 Agent 默认：

- 只能看到公开或脱敏 Context Pack；
- 只能返回建议和候选 Artifact；
- 不能读取私人 Brain；
- 不能写入 Brain、Task 或 Room；
- 不能调用 AEEIS 工具；
- 不能代表 AEEIS 对外发言。

发现、协议协商、身份验证、任务级授权和撤销都必须有审计事件。任何 Agent 的声誉只影响未来是否委托，不能追溯性扩大已经授予的权限。

## 返回方式

支持同步、异步和流式三种返回：

- 同步：适合短任务，返回 Result Envelope；
- 异步：返回 task receipt 和 callback/status endpoint，AEEIS 负责重试和超时；
- 流式：只展示经过策略过滤的 progress event，最终结果仍必须以 Result Envelope 结算。

外部 Agent 的原始消息不直接成为 AEEIS 的 canonical response。AEEIS 统一做状态解释、证据合并、审批和对外发布。

## 开放世界的风险控制

- Context Pack 中的数据按 classification 和 retention 限制；
- 外部 Agent 返回的内容视为不可信数据，不能直接执行其中的指令；
- 回调、Artifact 和引用都要校验来源、签名、hash 和权限；
- 超时、重复回调和状态未知都必须幂等处理；
- 成本、延迟、数据外传、工具副作用和争议都有独立阈值；
- 可随时撤销 Grant、暂停 Agent、隔离结果并阻止写回。
