---
title: AEEIS 任务 DAG 与 Temporal 长时执行设计
status: proposed-architecture
created: 2026-09-18
tags: [aeeis, task, dag, temporal, workflow, durable-execution]
---

# AEEIS 任务 DAG 与 Temporal 长时执行设计

## 核心判断

Temporal 适合做 durable execution plane，但不能成为 AEEIS 的任务产品模型。AEEIS 需要双层结构：

```text
AEEIS Task Domain
  用户可理解、可编辑、可审计的 Goal、Task、Plan Graph 和业务状态

Temporal Execution Plane
  长时执行、等待、重试、恢复、Signal、Timer 和 Worker 版本管理
```

用户看到的是 AEEIS 的 DAG、时间线、阻塞原因和下一步；Temporal 是可靠执行引擎，不是用户任务事实源。

## 三种图

### Plan Graph

Plan Graph 是用户批准或可编辑的目标拆解。节点是 Goal、Task、Review、Approval、Deliverable 等业务节点，边表达依赖、条件和输入输出。

- 版本化且不可变；
- 每次重规划创建 `Plan v2`，不能悄悄覆盖 `Plan v1`；
- 支持人工编辑、批准、比较和恢复到旧版本；
- DAG 可直接用于用户可视化。

### Execution Graph

Execution Graph 记录一次或多次实际执行，包含 attempt、retry、wait、signal、approval、compensation 和 loop。它不强行保持 DAG；重试记录为同一 Step 下的 Attempt，避免把每次重试伪装成新任务。

### Evidence Graph

Evidence Graph 表达“最终产物为何可信”：

```text
Final Artifact
  ← Decision / Synthesis
  ← Research Result / Tool Receipt / Model Receipt
  ← Source Version / Context Manifest
```

它服务于引用、审计、回放、争议处理和 RSI 归因。

## 任务状态

业务任务状态建议包括：

```text
draft → planned → ready → running → waiting
→ needs_approval → blocked → succeeded / failed / cancelled / unknown
```

`unknown` 是一等状态：当外部副作用的最终状态无法确认时，任务必须停在 unknown，等待查询、人工确认或补偿策略，不能盲目重试。

## Temporal 边界

Temporal Workflow 只负责确定性状态、依赖、顺序、等待、Signal、Timer、重试和版本迁移。以下内容放入 Activities：

- LLM 调用、Brain 检索和 Context Manifest 构建；
- Toolkit Tool、Connector、Sandbox 和文件操作；
- 外部 API、任务系统和消息发送；
- 人工审批查询和通知；
- Evidence、Receipt 和 Artifact 持久化。

Workflow 输入只传引用，不传敏感正文和大型文档：

```json
{
  "run_id": "run_123",
  "context_manifest_id": "ctx_456",
  "artifact_refs": ["artifact_789"],
  "capability_ref": "cap_abc"
}
```

## 长时稳定性要求

### 幂等副作用

所有外部写操作必须带 `idempotency_key`，并采用：

```text
prepare → execute → verify
```

执行超时后先查询外部系统；状态未知时进入 `unknown`，不能用普通 retry 代替确认。

### 错误分类

瞬时网络错误、限流和 Worker 故障可以按策略重试；参数错误、权限拒绝、业务冲突和安全拒绝应立即失败或等待修正。重试策略必须写入 Workflow/Skill 版本并记录在 Run Receipt。

当前 Temporal Activity 将这条边界具体化：网络异常、408/425/429 和 5xx 进入最多五次的指数退避；认证、配置和协议错误使用 `AeeisPermanentError` / `AeeisProtocolError` 标记为不可重试。Activity 只返回经过 schema 校验的 Run status，业务事实仍由 AEEIS Run Repository 持有；Workflow 在 Activity 失败后等待 `wake` 或定时再次尝试，避免把 Temporal Failure 当成业务 Task 状态。

### 历史与版本

- 长循环使用 `Continue-As-New`，避免 Workflow History 无限增长；
- Workflow、Skill、Tool、Model、Profile 和 Policy 版本在启动时锁定；
- 新版本只影响新 Run，迁移由 Worker Versioning 和显式策略控制；
- 动态重规划产生新的 Plan 版本并保留父子关系。

### 人工介入

支持暂停、恢复、取消、审批、人工提供信息、重试单个 Step 和从 Checkpoint 继续。人工介入本身也是事件，必须进入 Audit 和 Evidence Graph。

## DAG 可视化

AEEIS 自己构建 DAG/Timeline UI，从领域事件投影出：

- Plan 版本和节点依赖；
- 当前节点、Attempt、等待原因和下一个唤醒时间；
- 失败、阻塞、审批和 unknown 状态；
- 每个节点的输入、产物、成本、耗时和证据；
- 重规划前后差异；
- 暂停、恢复、取消、重试和人工接管历史。

Temporal UI 可作为运维调试入口，但不直接作为终端用户产品。

## 与外部任务系统同步

Linear、Jira、Todoist、飞书等只接收 AEEIS 任务的投影，并带：

- `source_task_id`、`projection_version`、`idempotency_key`；
- 来源、最后同步时间和冲突状态；
- 可同步的字段白名单；
- 外部变更回传后的人工或策略确认。

外部任务系统宕机不应影响 AEEIS Workflow；AEEIS 宕机恢复后根据 outbox 和投影 checkpoint 补发。

## 稳定性验收指标

- Durable Run 和事件不丢失；
- Worker 重启后能从 Checkpoint 恢复；
- 同一外部副作用不会重复执行；
- 任务可以暂停、恢复、取消并解释当前状态；
- 长循环不会无限增长 History；
- Skill、Tool、Model 和 Policy 版本可回放；
- unknown 状态不会被自动重试掩盖；
- 用户能从最终 Artifact 追溯到 Evidence Graph。
