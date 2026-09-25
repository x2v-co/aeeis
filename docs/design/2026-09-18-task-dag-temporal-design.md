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

当前 Temporal Activity 将这条边界具体化：网络异常、408/425/429 和 5xx 进入最多五次的指数退避；认证、配置和协议错误使用 `AeeisPermanentError` / `AeeisProtocolError` 标记为不可重试。Activity 只返回经过 schema 校验的 Run status，业务事实仍由 AEEIS Run Repository 持有；Workflow 在 Activity 失败后等待 `wake` 或定时再次尝试，避免把 Temporal Failure 当成业务 Task 状态。Run 已进入 `needs_approval`、`needs_input`、`waiting_external`、`unknown`、`failed` 等业务等待状态时，Workflow 改为只等待同一确定性 Run ID 的 `wake` Signal，不再用固定轮询制造 Activity 负载；审批、provider reconcile、外部 callback、retry 和 operator 控制负责发送该 Signal。

### 历史与版本

- 长循环使用 `Continue-As-New`，避免 Workflow History 无限增长；
- Workflow、Skill、Tool、Model、Profile 和 Policy 版本在启动时锁定；
- 新版本只影响新 Run，迁移由 Worker Versioning 和显式策略控制。启用 Versioning 的 Worker 必须使用稳定 Build ID，并在启动前通过 `AEEIS_TEMPORAL_BUILD_ID_ROLLOUT` 明确执行注册、兼容加入或晋升；`none` 只允许已经注册的 Build ID，避免 Worker 表面健康但实际收不到任务。兼容发布需要显式指定旧 Build ID，旧长时 Workflow 只有在确认兼容后才允许迁移；目标 namespace 必须开启 Temporal 的 Worker Versioning 能力，生产环境强制启用 Versioning。Temporal 新版 Worker Deployment API 尚未作为默认实现，迁移时需按目标集群能力选择对应机制。
- 每次 Worker 发布前必须对至少一条由上一版本产生的真实 history 做离线 replay。当前仓库的 `tests/temporal-workflow.test.ts` 会让上一版 fixture bundle 生成 history，再用当前 bundle 回放；运维可用 `npm run temporal:replay` 对 Temporal CLI 导出的 history 执行同一检查。回放只运行 Workflow 代码，不连接 Temporal Server，也不会再次执行 Activity；出现 nondeterminism 或其他 replay error 时发布必须停止。跨版本兼容通过后，才允许在目标 namespace 执行 Build ID compatible/promote rollout。
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

后续任务执行入口与 durable 调度

Project Pulse 审核后生成的 successor Plan 不能停留在“建议列表”。对状态为 `ready` 的领域节点，`POST /api/plans/:planId/tasks/:taskId/run` 创建一个绑定 `domainPlanId` 和 `taskId` 的单任务 Run。该 Run 仍然需要精确计划审批，但跳过重复的 Planner 调用，使用原领域节点作为唯一执行节点；Run 的 `start`、`waiting`、`unknown`、`failed`、`cancelled` 和 `succeed` 状态通过领域 Receipt 回写原节点。

如果节点带有 `evidenceRunId` 与 `evidenceRefs`，入口只从同一 owner/tenant 的来源或产物中解析这些引用，并把内容作为冻结的本次上下文。证据引用无法解析时拒绝创建 Run，避免后续任务脱离产生它的 Evidence Graph。

整张 DAG 通过 `POST /api/goals/:id/schedule` 或 `POST /api/plans/:id/schedule` 显式激活。调度器读取 Plan 的当前快照，只为 `ready` 节点写入一条 durable dispatch reservation；reservation 使用 owner、tenant、Plan、Task 的确定性幂等键，并保存绑定 Run ID、Workflow ID、执行器、attempt 和状态，同时冻结创建 Run 所需的任务级输入、预算、隐私和资料引用。reservation 与 Run 创建之间还有一个短期 `createLease` fencing：持有有效租约的创建者仍在准备上下文或写入 Run 时，恢复 pump 不会用另一组输入重复 create；租约过期后，恢复者先读取确定性 Run，已存在就直接采用并 reconcile，只有确认不存在才按冻结请求补建。调度器在通知执行器前再次确认租约仍由当前创建者持有，外部 API 只返回脱敏后的调度记录，不暴露创建请求或 lease token。创建 Run 或通知 Temporal 发生进程故障时，`queued` reservation 会在恢复 pump 中继续处理；`dispatched`、`waiting`、`unknown` 和终态 reservation 不会被无条件重发。Run 成功后，调度器重新读取领域 Plan，由原子 Task transition 暴露的 `ready` 节点解锁后继任务。Run/Plan/Receipt 仍是业务事实源，dispatch ledger 只记录调度事实和恢复引用。

`GET /api/plans/:id/scheduler` 返回调度记录，`POST /api/plans/:id/scheduler/reconcile` 可在外部执行结果已知但投影尚未推进时显式核查。对于 Temporal runner，dispatch record 的 `workflowId` 等于确定性绑定 Run ID，现有 `TemporalDispatcher` 启动或 signal 同一个 `agentRunWorkflow`；这样服务重启不会因为重复的 DAG pump 创建第二个 Workflow。调度器不会自动重试 `unknown` 任务，必须先走 Run/provider reconcile，再由新的可审计状态继续推进。

API 的 Temporal dispatcher 同时检查 Temporal gRPC health 和配置的 Worker `/readyz`。Temporal 集群可达但没有 RUNNING Worker 时，API readiness 会失败，避免长时任务被接受后永远停在 dispatch ledger。Worker 健康 URL 是独立的只读进程探针，不调用 Activity 或业务 API；生产 Temporal 部署必须配置 HTTPS Worker health URL。Compose 让 API 先启动、Worker 再启动，避免 API readiness 与 Worker 启动之间形成循环依赖。

恢复必须区分“Run 不存在”和“Run 存在但派发尚未确认”。对 queued reservation，先读取已绑定 Run：不存在时才按领域 readiness 补建；存在且处于 queued/planning/running/reviewing/needs_approval 时，先通知相同 Run ID，再同步派发状态，不能仅凭 Run 存在就认为执行器已接收。复用现存 Run 会保留其创建时的输入、预算与授权配置，避免用恢复默认值重建后发生 request hash 冲突。通知再次失败时保留 queued 和错误，由后续恢复继续处理；通知成功但状态回写前崩溃时可以再次通知同一执行器标识。paused、needs_input、waiting_external、unknown 和终态只同步状态，不由恢复隐式唤醒。这个机制只重投递执行器通知，模型和外部副作用仍经过 Run 的幂等、审批和 unknown 边界。

调度控制面通过 `POST /api/plans/:planId/tasks/:taskId/control/:action` 暴露 `dispatch`、`pause`、`resume`、`cancel`、`retry` 和 `reconcile`。控制操作先查找同一 owner/tenant 下的 reservation，再调用绑定 Run 的既有命令边界，因此 Run 的审批、预算、外部回执和 Task Receipt 规则不会被 scheduler 绕过。`retry` 只有在领域 Task 已经由 `failed`/`unknown` 显式转为 `ready` 后才会复用确定性 Run，并同步新的 Task attempt；`unknown` reservation 不会被后台 pump 自动转成新调用。
