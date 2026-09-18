---
title: AEEIS Agent 协议与领域模型
status: proposed-architecture
created: 2026-09-18
tags: [aeeis, protocol, domain-model, agent, context, receipt, authorization]
---

# AEEIS Agent 协议与领域模型

## 目标

本协议把 AEEIS 内部 Agent、可信外部 Agent 和开放世界 Agent 放进同一套可验证的任务交换模型。Agent 之间不直接复制原始聊天上下文，而是交换版本化、最小化、带权限的任务包和结果包。

## Agent Principal

每个 Agent 都有稳定的 `agent_principal`，但稳定身份不等于永久授权。Principal 记录：

- owner / organization；
- identity verification level；
- Agent Card 版本；
- 支持的协议、能力和返回 schema；
- endpoint、回调方式和可用性；
- trust dimensions 和撤销状态。

## Agent Card

Agent Card 是 Agent 的可发现描述，不是权限凭证。至少包含：

```json
{
  "agent_id": "agent_123",
  "name": "research-agent",
  "owner": "org_abc",
  "protocols": ["aeeis-task/1", "a2a-compatible"],
  "capabilities": ["research", "citation"],
  "input_schemas": ["research.brief/1"],
  "output_schemas": ["result.envelope/1"],
  "auth": ["signed_request", "oauth"],
  "privacy": {"data_retention": "none"},
  "pricing": {"unit": "run"},
  "card_version": "3"
}
```

MCP 适合 Tool 调用；Agent 委托、异步任务、状态更新和结果回调应采用 Agent-to-Agent 类协议，不能只把 Agent 模拟成 MCP Tool。

## Task Brief 与 Context Pack

委托方先发 `Task Brief`，再按授权生成 `Context Pack`。两者必须可单独版本化：

```json
{
  "task_id": "task_123",
  "goal": "评估 Temporal 方案",
  "non_goals": ["修改生产配置"],
  "context_manifest_id": "ctx_789",
  "known_facts": [{"claim": "...", "evidence_refs": ["ev_1"]}],
  "constraints": ["预算上限", "不得披露私人 Brain"],
  "expected_output": "result.envelope/1",
  "deadline": "...",
  "budget": {"tokens": 50000, "money": 2.0},
  "allowed_capabilities": ["read_public_sources"]
}
```

外部 Agent 不能通过 task_id 反查 AEEIS 的全部上下文；Context Pack 是唯一输入边界。

## Context Acknowledgement

执行前，接收方必须返回对上下文的理解：

```json
{
  "task_id": "task_123",
  "context_version": "ctx_789",
  "understood_goal": true,
  "missing_information": [],
  "assumptions": [],
  "conflicts": [],
  "ready": true
}
```

`ready=false` 时不能直接执行；缺失信息、假设和冲突必须由委托方补充、接受或拒绝。

## Delegation Grant

Delegation Grant 是短期、任务级、可撤销授权。它必须明确：

```text
能看见任务 ≠ 能看见私人 Brain
能看见上下文 ≠ 能调用工具
能调用工具 ≠ 能使用用户账号
能执行动作 ≠ 能代表 AEEIS 发言
能返回结果 ≠ 能修改共享状态
```

Grant 至少包含 subject、task、resource、purpose、actions、data scope、expiry、budget、revocation endpoint 和 delegation chain。默认只允许读取公开/脱敏上下文和返回建议；写 Brain、改 Task、发消息、使用账号必须另行授权。

## Result Envelope

所有 Agent 返回统一结果包：

```json
{
  "task_id": "task_123",
  "agent_id": "agent_123",
  "status": "completed",
  "result_type": "research.report/1",
  "summary": "...",
  "claims": [{"text": "...", "confidence": 0.82, "evidence_refs": ["ev_2"]}],
  "artifacts": ["artifact_1"],
  "unresolved": [],
  "requested_followups": [],
  "cost": {"tokens": 12000, "money": 0.31},
  "capabilities_used": ["public_web_read"],
  "context_version": "ctx_789",
  "receipt_ref": "receipt_555"
}
```

状态至少包括：`accepted`、`completed`、`partial`、`blocked`、`needs_clarification`、`needs_approval`、`failed`、`rejected`、`unknown`。AEEIS 不应把 partial、blocked 或 unknown 改写成成功措辞。

## 验证与合并

AEEIS 对外部返回执行：schema validation、授权验证、证据检查、事实冲突检查、成本和预算检查、恶意指令与数据外传检查。结果先进入候选区，再由 AEEIS 或独立 Reviewer 合并到 Task、Artifact、Decision 或 Brain。

外部 Agent 不能直接写入 AEEIS 的 canonical state。所有写回都产生 Receipt 和 Evidence Graph 边。

## 版本与兼容性

Task Brief、Context Pack、Acknowledgement、Result Envelope、Agent Card 和 Grant 都带 schema version。协议升级采用向后兼容的读取策略、明确的最小版本和过期时间；禁止依赖自然语言猜测字段含义。
