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

### Collaboration Trigger Policy

Competition 和 Debate 可以由耐久事件触发，但事件本身不能直接获得模型调用权限。触发策略保存 owner/tenant、事件类型和来源过滤、风险下限、审核置信度上限、required diversity、冷却窗口及目标协作类型。事件必须携带 `event_id`、`task_id`、`context_version`、隐私上下文和 evidence refs：

```text
event → match policy → claim policy/event idempotency key
      → create Competition/Debate aggregate
      → dispatch=create: persist triggered decision
      → dispatch=run: run through model pool and persist dispatch state
```

策略决策在 File 或 PostgreSQL 中保存。相同 `policy_id + event_id` 只允许创建一个协作实例；正在创建时进程崩溃会留下 `started` 决策，后续重复事件不会盲目重建。事件 owner/tenant 必须与调用边界一致，Worker、Feishu 和 Hermes 只能通过经过认证的内部事件入口提交事件。`dispatch=run` 没有模型池或遇到不明结果时不会隐式重试，而是把 `dispatchState` 和错误留在决策中；模型执行继续经过 Competition/Debate 自己的 Attempt、预算、unknown 和 reconcile 机制。

不同事件的冷却检查与决策预留必须原子提交。File 在单写入者队列内执行；PostgreSQL 使用按 policy ID 的事务 advisory lock，并锁定策略行，重新检查 enabled、owner/tenant 和完整策略快照，避免预匹配后已经停用、删除或修改的策略继续准入。重复事件先返回已有决策；新事件只查询该策略最近的 `started` / `triggered` 决策，不加载完整历史。策略快照使用 canonical digest 比较，兼容 JSONB 字段重排。锁在创建协作资源和调用模型前释放。

准入时间使用存储时钟（PostgreSQL 为数据库时钟）。冷却比较使用 `min(event.occurredAt, admissionTime)`，未来事件时间不能绕过当前窗口；正常旧事件即使在墙上时间过了冷却期后被重放，也不会自动变成新任务。差值恰好等于 cooldown 时允许准入。明确的创建失败不继续占据窗口，派发 unknown 仍属于已触发资源，继续受冷却限制。被抑制的事件不产生新决策；这不是事件消费 checkpoint，后台仍可能再次扫描。`cooldownMs=0` 保留不同事件可各自触发的行为。File 仍只支持单进程写入，跨进程部署使用 PostgreSQL。

触发决策本身也必须可恢复。若进程在创建协作资源后、写回 `resourceId` 前崩溃，重复事件不能再创建第二个资源；operator 可通过 `POST /api/collaborations/triggers/decisions/:id/reconcile` 以 `resource_created` 绑定已核实的 Competition/Debate。若确认资源没有创建，使用 `failed` 将创建决策终结；若资源已存在但派发结果不明确，使用 `dispatch_completed` 或 `dispatch_failed` 结算派发。`unknown` 只表示提供方结果不明，`failed` 表示经过核查的明确失败；两者都不会自动重发。所有核查都按 owner/tenant 作用域和状态转移约束执行，并保留 operator 提供的 reason。

### Run Event Pump 与重放边界

Run 的事件日志是触发协作的事实源。服务内的 `CollaborationTriggerPump` 周期性扫描 File 或 PostgreSQL Run repository，把 `task.completed`、`run.failed` 和 `review.completed` 映射为同一版本化 Trigger Event；bound task 的 `task.execution.completed` 也会映射为 `task.completed`。Pump 不在 Run 中标记“已消费”，因此可以在提交 Run 与触发决策之间崩溃后从头重放。`policy_id + event_id` 的唯一约束和 Trigger Decision 的 claim 是跨进程幂等边界，资源创建前后的崩溃窗口必须继续走上述显式 reconcile。

每个内部事件复制 Run 的 owner、tenant、privacy classification、Context version、artifact/evidence refs 和本次 Run 的 `allowedAgents`。策略只允许使用这些已冻结的 Agent；空白或无效的 admitted list 不会隐式扩大协作参与者。事件的上下文是受限 Context Pack，不能把 Run 的完整聊天历史或未授权 Brain 内容带入 Competition/Debate。Pump 使用 File/PostgreSQL 中独立命名的 durable checkpoint：冻结本轮 Run ID 上界，按主键范围有界读取，部分 Run 保存事件 offset 和 endOffset。批次全部尝试后以 CAS 提交 cursor；单个坏事件记录错误并在下一巡检重访，批次提交前崩溃会重放。全轮结束后重新扫描，因此后插入或追加的事件不会被永久遗漏。每个 Run 仍完整读取，巡检延迟随历史规模增长，后续 changefeed 与事件分表仍需容量设计。

Reviewer 可以返回可选的 `confidence`（0 到 1）。它在 `review.completed` 事件中作为 `reviewConfidence` 持久化，供 `reviewConfidenceAtMost` 策略进行低置信度分流；旧 Reviewer 没有该字段时仍可完成审核，但不会匹配依赖置信度的策略。confidence 只影响触发匹配，不会替代独立 Reviewer、Evidence Graph 或人工审批。

## Debate Workflow 与飞书群入口

Hermes 的飞书群辩论可以作为交互入口，但群聊只是投影，正式事实来自结构化 Debate Event Log。

入站事件在签名、时间窗、群路由和发送者映射通过后，先以带 provenance 的 Debate message 持久化，再通过受控的 `external.message` Trigger Event 回调 Trigger Service。回调使用 `feishu:<chat/event hash>` 作为稳定 event ID，因此 Feishu 重试只会重放幂等决策；消息正文作为不可信 goal/context 输入，不能自行获得 AEEIS 权限或 evidence claim。Trigger 失败时 webhook 保持失败，让 Feishu 重试，Debate message 和 Trigger Decision 各自通过幂等键收敛。

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

### Moderator / Adjudicator 的实现边界

当前实现把 Moderator 和 Adjudicator 分成两层：

1. **本地不可绕过的 policy**：每条消息先检查 `claim_refs` 是否属于 Debate Context Pack 的 claim 或 artifact；未知引用和没有证据的 evidence-bearing 消息会被记录为 `flagged`。之前消息的 claim 不会获得新的证据权威，避免 Agent 通过辩论过程引入未授权来源。
2. **可替换的独立模型角色**：配置 `AEEIS_DEBATE_MODERATOR_AGENT_ID` 后，独立模型可以留下 Moderator Review；配置 `AEEIS_DEBATE_ADJUDICATOR_AGENT_ID` 后，独立模型可以提出最终结论。模型结果会作为输入和审计记录保存，但最终写入仍由 AEEIS policy 再次校验。

participant、Moderator、Adjudicator 的每次调用都会先持久化 Attempt，再调用模型。`started` 或 `unknown` 在重启后不能自动重发，必须通过 `reconcile-attempt` 提供外部核查结果。只有证据绑定、通过 Moderator policy、且所有 Attempt 已结算的 decision 才能进入 `decided`；其他关闭路径进入 `held`。

当前的 Feishu/Hermes 入站适配器暴露 `POST /webhooks/feishu/events`。它在 HTTP 边界校验原始请求体的 Lark/Feishu 签名、nonce、时间窗和可选 verification token，再使用服务端显式配置的 `chat_id → debate_id` 路由和 `sender_ref → agent_id` 映射。未映射的群或发送者只会被忽略，不会创建 Debate 或获得权限。普通群文本会转成 `clarification`，结构化 `debate-message/1` 可以携带有限的消息类型、轮次、回复和 claim 引用，但最终仍由 Debate Context、参与者、上下文版本和 Moderator policy 决定是否有效。写入的消息带 `origin.channel`、`externalEventId`、`senderRef` 和接收时间；外部事件的确定性 message ID 使重复投递成为幂等 no-op，正式事实仍是 AEEIS 持久化的 Debate Event Log。

Hermes 直连使用独立的 `POST /webhooks/hermes/events`，协议为 `hermes-debate-event/1`。Hermes Bridge 发送 `roomId`、`senderRef`、`eventId` 和结构化 message，并用 `x-hermes-timestamp`、`x-hermes-nonce`、`x-hermes-key-id` 以及 HMAC-SHA256 签名原始 body；服务端按显式 `roomId → Debate` 与 `senderRef → Agent` 映射准入，消息以 `hermes` provenance 和稳定幂等 ID 写入。Hermes 与 Feishu 都只是入口适配器，不能改变 Debate 的 canonical Event Log、Context Pack、参与者或证据策略；真实 Hermes Skill 的密钥轮换、身份映射和群权限仍需部署验收。

Hermes 出站采用本机 CLI 适配器，而不是在 AEEIS 内复制 Hermes 的平台凭证或私有 API。配置 `AEEIS_HERMES_CLI_PATH` 后，Projection Sink 调用 Hermes 已有的 `hermes send --to <platform:channel[:thread]> --json <message>` side-effect-only 契约；消息只携带受控的状态摘要、最近 Debate 消息或提醒正文，不转发 Context Pack、原始候选 artifact 或私有内容。CLI 成功时以 Hermes 返回的 message id（没有时使用 AEEIS 幂等键）记录回执；进程终止、超时、非零 delivery error 或无效 receipt 均按 `unknown` 处理，必须由 provider 核查后再 reconcile。`hermes send --list --json` 只用于只读本地 CLI readiness probe，不代表真实平台 SLA；Hermes CLI、平台凭证、目标群权限和生产通知容量仍需部署验收。

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

异步 Agent 的生产 callback 使用 `POST /webhooks/agents/:runId/callback`。该入口不依赖用户 Bearer token，而是根据 Run 中冻结的 pending Delegation 找到 Agent Card，用 `x-aeeis-timestamp`、`x-aeeis-signature` 对原始 callback body 做五分钟 HMAC 校验；入口只返回接收确认，不向外部 Agent 返回 Run 内容。已认证的 `POST /api/runs/:id/agent-callback` 作为内部兼容入口保留。OAuth/bearer Agent 若要异步回调，仍必须额外声明 `signed_request`。

当前流式协议使用 `application/x-ndjson` 或 `text/event-stream`。中间帧是
`agent-progress/1`，必须绑定 `taskId`、`agentId`、`contextVersion`，带单调
`sequence` 和可选的 `evidenceRefs`/`artifactRefs`；最后一帧仍是普通
`AgentTransportResponse`。AEEIS 将进度保存为该 delegation 的 Run telemetry，
最多 1000 条且单帧和总响应都有大小上限。进度不会进入 Evidence Graph，也不能
授权工具或改变任务状态；流中断、顺序错误、绑定错误或缺少最终帧按 unknown
处理并要求 reconcile。

Gateway 会把 transport uncertainty 与 response rejection 分开记录：前者是 provider 结果不可核实，后者是 AEEIS 已明确拒绝协议、认证、HTTP 请求或证据边界。后一类不会被当作可信结果写入任务或 Evidence，但只要调用已经跨过远端边界，预算账本仍保留未知用量，直到 provider 核查完成。

外部 Agent 的原始消息不直接成为 AEEIS 的 canonical response。AEEIS 统一做状态解释、证据合并、审批和对外发布。

外部 Agent 的 endpoint 必须使用 HTTPS；开发环境可以对 loopback 使用 HTTP。Agent Card discovery 需要限制响应大小、拒绝重定向和过期 Card，发现不等于获准。部署可以通过 `AEEIS_AGENT_ALLOWED_HOSTS` 对 discovery 和委托 endpoint 设置精确 hostname allowlist；allowlist 不支持隐式子域扩展，端口也不能扩大匹配范围，避免开放世界接入变成任意 SSRF 出口。

## 开放世界的风险控制

- Context Pack 中的数据按 classification 和 retention 限制；
- 外部 Agent 返回的内容视为不可信数据，不能直接执行其中的指令；
- 回调、Artifact 和引用都要校验来源、签名、hash 和权限；
- 超时、重复回调和状态未知都必须幂等处理；
- 成本、延迟、数据外传、工具副作用和争议都有独立阈值；
- 可随时撤销 Grant、暂停 Agent、隔离结果并阻止写回。Grant 的撤销状态必须是 durable 的：开放世界 Agent 的 Agent Card revoke 不能替代任务级 Grant revoke；四个远端边界（submit、reconcile、callback、progress）都必须重新检查 Grant Registry。跨过远端边界的结果在 Grant ledger 的 durable authorization receipt 上线性化：撤销/过期已先于结算生效时，迟到结果只能 accounting-only reconcile 并标记为 `isolated`；结算已先在线性化点获准时，后续撤销不能追溯改写该结果。两种情况都不能覆盖已核查状态，且都保留 receipt、用量和审计记录。
