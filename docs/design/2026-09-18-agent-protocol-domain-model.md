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

Grant 不是只存在于请求正文中的声明。AEEIS 在第一次派发前把 Grant 的完整绑定、规范化 digest、`revocationRef`、subject、issuer、task、resource refs、expiry 和状态历史写入 durable Grant Registry。之后的 submit、reconcile、callback 和 progress 都先以 Grant ID 查询该注册；`revoked` 或 `expired` 会阻止新的远端提交、结果写回和能力扩大。撤销不会删除记录，也不会把已经跨过远端边界的调用伪装成取消：已有副作用仍保留可核查的外部边界，允许针对原 receipt 做 accounting-only reconcile。Grant ledger 在结算锁/CAS 内写入 durable authorization receipt，明确结算在线性化点是 `authorized` 还是 `isolated`；撤销/过期已先生效时，已收到的有效结果会标记为 `isolated`，不得进入 Task observations、Artifact、Evidence Graph 或 Agent reputation；若结算已先获准，后续撤销不会追溯改写结果。File 与 PostgreSQL 实现都使用锁/CAS 保护 Grant 状态，进程重启后继续生效。

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

证据引用必须绑定当前 Context Pack：claim 至少引用一个 Pack 中已有的 claim、source 或 artifact，artifact 也必须已经在 Pack 的 `artifactRefs` 中。传输失败、5xx、超时、限流或缺少最终帧表示结果不明，进入 `unknown` 并保留 reconcile；4xx、签名、schema、证据绑定或预算拒绝会形成分类诊断，拒绝的正文不能进入 Evidence。若拒绝仍无法证明远端没有产生副作用或费用，Grant 和全局预算继续保留未知结算边界，不能通过重试绕过。

外部 Agent 不能直接写入 AEEIS 的 canonical state。所有写回都产生 Receipt 和 Evidence Graph 边。

## 版本与兼容性

Task Brief、Context Pack、Acknowledgement、Result Envelope、Agent Card 和 Grant 都带 schema version。协议升级采用向后兼容的读取策略、明确的最小版本和过期时间；禁止依赖自然语言猜测字段含义。
# Tool Capability Settlement Boundary

Tool 调用与 Agent 委托使用不同的授权模型。Tool 的授权来自 Run 创建时冻结的 `approvedTools` manifest/version allowlist 和本次任务生成的 `capabilityGrant`；它没有 Agent Grant 那种独立的远端主体撤销注册表。Tool provider 返回的 Receipt 不能自行决定结果是否可以写入 Run，因为取消、暂停和预算状态由 AEEIS 持有。

因此，Tool Receipt 在 AEEIS 完成同一 Run Repository 的 durable mutation 时追加 `authorization`：它绑定 `toolId`、`toolVersion`、`taskId`、`capabilityGrant`、`idempotencyKey` 和冻结的 `toolManifestDigest`，并记录 `decision=authorized|isolated`。当提交看到 Run 已取消、工具版本不再匹配冻结 manifest，或本次结算使外部预算停止后续应用时，结果仍保留为 usage/accounting 事实，但标记为 `isolated`，不得进入 Task observations、Artifact 或 Evidence Graph；远端副作用不会被假设为已撤销。正常已批准调用在活动 Run 中标记为 `authorized`。`unknown` 仍必须显式 reconcile，核查会替换同一 receipt 位置并沿用同一 idempotency key。

这个边界依赖 File 单写入者提交或 PostgreSQL `SELECT ... FOR UPDATE` 的 Run 事务，因此取消/返回竞态以 durable commit 的先后线性化。每次真正进入 provider 边界的 Tool 尝试还会写入短期 `executionToken`；只有持有该 token 的 Engine 可以提交结果，恢复会清除旧 token 后要求沿原 idempotency key reconcile，避免两个进程同时把一个 Tool 结果写回。provider 只收到公开的 Tool Invocation 字段，token、receipt、预算账号和 reconcile 标志留在 AEEIS 内部。预算 reservation 若在 provider 调用前失败会释放 token；provider 返回后，Run 锁内先再次校验 token，再完成全局预算结算和结果提交，因此恢复后迟到的旧 Engine 不能覆盖 canonical Run 或重复结算。它不会把 Tool 伪装成 Agent Grant，也不会声称能撤销已经发出的工具副作用。
