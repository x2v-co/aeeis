---
title: AEEIS 外部项目接口契约
status: proposed-architecture
created: 2026-09-18
tags: [aeeis, toolkit-new, ownhow, planprice, temporal, contracts, integration]
---

# AEEIS 外部项目接口契约

## 总原则

外部项目提供能力平面，AEEIS 保持任务和语义控制平面。所有接口都以稳定 ID、版本、来源、授权和 Receipt 为核心，不允许通过数据库直连共享内部表。

Room 是 AEEIS 的长期协作边界。一个 Room 可以关联多个 Goal，并按 owner/tenant 隔离；飞书群、Hermes 房间、Linear 项目或其他消息渠道只作为 Room 的投影目的地。Room 创建与 Goal 绑定先写入 AEEIS 的 canonical domain store，再通过带 `channel`、`destination`、`aggregateType=room` 和幂等键的 Projection Outbox 投影出去。外部渠道的线程、群组或任务 ID 必须保存在投影回执中，不能反过来成为 Room 的主键或权限依据。

Shared Session 的 `session-event/1` 也是可投影的 canonical aggregate。事件可以绑定单 Goal 或 Room 级多 Goal Context Manifest；后者在投影前仍必须重新验证每个来源。事件先由 Session Event Service 按当前 Room membership 和 Context Manifest audience 校验，再由 owner/operator 通过 Projection API 以 `aggregateType=session_event` 写入 Outbox；Projection payload 是事件快照，幂等键包含 channel、destination 和 event identity。修订和撤回通过 `operation`、`targetEventId`、`revision` 和 `retractionReason` 表达，旧事件不被删除，Projection sink 必须按关系处理迟到或重复投影。外部渠道只能展示或转发该快照，不能回写为 canonical response，也不能绕过事件读取时的实时 ACL。Session Event repository 与 Projection Outbox 是两个独立事实源，崩溃窗口由幂等投影请求和显式 delivery/reconcile 收敛。

Feishu 投影分为两个边界。Incoming Webhook 适合低权限的单向通知；应用 API 适合需要应用身份和 `chat_id` 访问控制的群协作。应用 API sink 在 AEEIS 边界内获取并缓存短期 tenant access token，向消息请求写入由投影幂等键派生的 UUID，并只发送经过隐私分类裁剪的摘要卡片；生产配置可用 `AEEIS_FEISHU_ALLOWED_CHAT_IDS` 再限制目的群。token 获取或消息发送的传输结果不明时，Projection Outbox 进入 `unknown`，必须由运营方核查后才能继续，不能因为 token 刷新而自动重发可能已经发送的消息。AEEIS 使用 `RoutingProjectionSink` 按 `ProjectionEvent.channel` 选择 Feishu、Hermes CLI 或通用 HTTP sink，因此多个渠道可以同时启用；没有专用路由的 channel 才会落到显式配置的通用 fallback，未知 channel 且没有 fallback 会被拒绝。

## toolkit_new

### 提供

- Tool Registry 与 Tool manifest；
- Connector、Sandbox 和 Artifact；
- Capability 定义与工具执行；
- Tool Receipt、成本、延迟、错误和副作用记录。

### AEEIS 发送

- `task_id`、`run_id`、purpose；
- 输入 Artifact 引用和 Context Manifest；
- AEEIS 已批准的 Capability 引用；
- idempotency key、预算和超时。

### AEEIS 接收

- schema 化输出、Artifact 引用和 Tool Receipt；
- `completed / failed / unknown` 状态；
- 外部副作用的 verification 结果。

AEEIS 负责判断该 Tool 结果是否足以推进业务任务、是否写回 Brain/Task，以及是否需要人工审批。

## ownhow

### 提供

- Skill / Method 的发现、解析和版本信息；
- Receipt、Proposal、Apply、Rollback 机制；
- 方法的依赖、适用范围和变更记录。

### AEEIS 负责

- 根据 Goal、Context、Profile 和历史表现选择方法；
- 把用户纠正和真实 Outcome 形成 Personal Skill Profile；
- 运行 replay、holdout、安全和成本评测；
- 决定候选保持私有、提交团队版本，或申请公共版本晋升。

一次 Receipt 或 Proposal 不能自动改变 AEEIS 的运行版本；Apply 必须绑定授权、版本和回滚点。

### RSI evaluator

隔离 evaluator 只接收版本化 candidate、单个 bounded test case 和评测模式，返回带 `passed`、`score` 与 evidence references 的 observation；它没有 AEEIS 写权限。AEEIS 为每个 replay/holdout/safety/cost/shadow gate 先持久化 reservation，再应用结果。进程重启、传输结果不明或 evaluator 超时会保留 `started` attempt，禁止盲目重发；操作者必须通过 `reconcile-evaluation` 提供外部核查结果，已结算的 gate 不会再次调用或重复计入。评测结果的 evidence 只能作为候选证据，不能越过 AEEIS 的晋升、激活和回滚策略。

## planprice / aiplans.dev

### 提供

- Model、Provider、价格和计费单位；
- Benchmark、上下文限制、能力标签；
- Availability、区域和时间信息。

### AEEIS 负责

- 依据任务质量、隐私、延迟、预算、可用性和历史表现做 Model Decision；
- 记录候选模型、最终模型、路由理由、fallback 和预算消耗；
- 在相同 Skill/Profile/Eval 上重新验证新模型；
- 不把目录中的 benchmark 当作真实任务保证。

Model Catalog 数据变化不能悄悄改变已启动 Run；长时任务使用启动时锁定的 Model Decision，除非明确触发迁移策略。

Planprice 的健康边界与模型供应商健康边界分开。可配置同源、无凭证参数的只读
`AEEIS_PLANPRICE_HEALTH_URL`；AEEIS 只执行有界 `GET`，拒绝重定向，不读取响应正文，且不会
调用模型或触发价格写入。`/readyz` 的模型检查会先报告目录探针/目录读取失败，再报告“没有满足
策略的候选模型”，最后才检查被选中的 provider；`/api/status.modelHealth` 同时保留 `catalog`
和 `provider` 子结果。没有显式目录 health URL 时，目录仍可通过一次只读 catalog read 被验证，
但会明确标记为未配置独立探针。这样目录中断、策略无候选和供应商不可用不会被压成同一个错误。

模型恢复以 `model + endpoint + promptVersion + provider` 的完整 Pin 为身份。不同 provider 即使共享网关和模型名，也不能共享适配器缓存或互换凭证。目录 resolver 从持久化 Pin 重建适配器时不重新查询目录，并在返回适配器前校验四个字段；不匹配时拒绝恢复且不缓存错误适配器，部署者恢复原配置后可以再次尝试。这一边界同时保护主 Runtime 和直接使用 resolver 的 RSI 提案调用，不把重启视为模型迁移授权。

每次目录路由都会把规范化的候选目录保存为 `catalogHash`，并记录 `catalogRetrievedAt`。Hash 对候选行排序后计算，不受供应商返回顺序影响；它与已保存的 Model Decision 一起构成价格、Provider 和可用性判断的审计指纹。目录后续变化不会改写已启动 Run，运营方可以用同一目录快照重建当时的选择依据。

主 Runtime 可对 Run 保存 `modelBudget.tokens` 与 `modelBudget.moneyUsd`，覆盖 Planner、Executor 和 Reviewer。Model Decision 保留输入和输出 USD 目录价，后续目录变化不改写运行中的估算。每次调用用量随回执落盘，汇总由回执重建；无有效 usage 时保留未确认状态，禁止将缺报当成零消耗继续预算 Run。当前在调用返回后结算并阻止超额结果推进业务和后续模型请求，单次调用仍可越过阈值。供应商硬扣费预留与账单核查尚未实现。

## Temporal

Temporal 仅承担执行耐久性：Workflow、Activity、Timer、Signal、Retry、Heartbeat、Child Workflow、Continue-As-New 和 Worker Versioning。AEEIS 将 Run、Step、Checkpoint、Approval、Evidence 和用户可见状态映射到 Temporal，但不把 Temporal History 当作业务数据库。

## 外部任务与知识系统

外部任务系统只通过投影 API 或事件同步 Goal/Task 的允许字段；外部知识系统只通过 Connector 产生 Source/Claim/Artifact 引用。AEEIS 负责授权过滤、规范化、版本、撤销、引用和写回。

当前实现将知识系统抽象为 `KnowledgeProvider`：Provider 只返回带 classification、source、content hash 和 score 的知识记录，Context Manifest 再按 audience 和允许分类形成最小上下文。AEEIS 不把 Provider 返回的内容当作指令；真实向量索引（如 pgvector）可以替换 Provider，而不改变任务、授权和 Evidence Graph 语义。

向量是可重建的派生索引，不是知识事实源。启用 pgvector 时，AEEIS 将每个 embedding model 的回填保存为 durable operator job：canonical record 与向量写入、cursor 和 indexed 计数在同一批事务中提交；失败批次保留错误并不推进 cursor，服务重启可从最近一次成功批次继续，超过租约的 running 状态可被后续 worker 接管。回填通过 operator-only 的入队、单批执行和状态 API 驱动，也可由受控的进程内 pump 调度；检索在向量服务不可用或记录尚未回填时回退全文检索。生产部署仍需单独验收 pgvector 扩展、批次 SLA、容量和 embedding 供应商成本。

Brain 使用同一原则，但不把语义侧索引混入 Brain 事实源：`AEEIS_BRAIN_EMBEDDING_URL` 启用后，PostgreSQL 只保存 claim ID、租户/owner/scope、classification、content hash 和向量。查询接口先由语义索引排序候选，再回到 `GovernedBrain` 重新执行 grant、租户、classification 和 active 状态校验；派生索引失效时回退词法检索。Brain 的 canonical JSONB revision、撤回历史和 read audit 不依赖 embedding 服务，索引可从完整 claim history 重建。为处理 embedding 服务恢复或索引迁移，安装 operator 可以通过 `GET/POST /api/brain/semantic-reindex` 查看当前索引绑定并按 canonical claims 重建；该操作不改变 Brain revision 或审计，重建失败也不影响 canonical Brain 读写。

语义索引的 readiness 不能通过一次真实 embedding 请求探测，因为那可能计费、产生配额消耗或改变上游审计。配置 `AEEIS_BRAIN_EMBEDDING_HEALTH_URL` 后，AEEIS 只对同源、无凭证参数的只读 GET 健康端点进行有界探测，同时检查本地 pgvector 索引表；没有显式 health URL 时，语义索引报告为 optional unavailable，Brain canonical 读写和词法检索仍可用。`/readyz`、`/api/status` 展示 Brain 配置与语义索引探针状态；工作台显示语义索引健康状态。表可读和健康端点可达不代表索引已完整回填或检索质量达标。

### 项目源增量同步

项目源可以实现 `project-source-sync/1`。请求包含查询、租户、隐私允许范围和可选 `cursor`；响应必须返回 `nextCursor`、有界 records，以及 `project-source-sync-receipt/1`：

```text
request_hash / response_hash
previous_cursor / next_cursor
record_count / changed
provider / completed_at
```

AEEIS 会重新计算请求和响应 hash，并检查回执中的游标、记录数、租户、分类、重复 ID 和内容 hash。回执还必须声明 `update`：`snapshot` 替换视图、`unchanged` 复用已接收视图、`delta` 携带受限 tombstone、`scan` 表示分页扫描的开始/继续/完成。只有完整快照或扫描完成后才允许删除未见记录。游标与规范化 records 在同一个 checkpoint CAS 中保存；因此 Run 后续解析失败、服务重启或空页不会丢掉已接收资料。游标只表示 Connector 的同步版本，不授予额外读取权限；Run 保存同步回执。服务端可启用 durable Project Source Checkpoint Store，按 provider、租户、查询、结果上限和隐私范围保存最新游标；File 模式使用原子替换和目录同步，PostgreSQL 模式使用事务行锁和 compare-and-set。省略 `projectSourceCursor` 的长时 Run 会自动从 checkpoint 续接，并将 checkpoint revision 写入回执；显式游标必须与当前 checkpoint 一致。Connector 的厂商凭证和增量游标语义仍由适配器负责，AEEIS 不直接连接厂商数据库。

当前已提供 Linear GraphQL 适配器作为第一个厂商实现：它使用安装级 API key 调用
`issueSearch`，可按团队和租户限制范围，把 issue 的标题、描述、状态、团队、负责人和 URL
规范化为 `task` Source。Linear 的 `endCursor` 只作为不透明分页游标保存；它不被解释成
全局变更日志，也不能绕过 AEEIS 的 checkpoint、classification 或 evidence 校验。Linear
API 版本、限流、凭证有效性和生产增量同步语义仍由部署验收负责。

同时提供 Jira REST 适配器作为第二个厂商实现：它使用受服务端配置限制的 JQL 搜索端点，支持
bearer token 或 email + API token 的 basic auth、项目过滤和 Jira Cloud 的 `nextPageToken`。
Jira 的 Atlassian Document Format 描述会在适配器边界内提取为纯文本，原始 JSON 不会直接成为
Agent 指令；issue key、状态、负责人、项目和 URL 会进入带内容 hash 的 `task` Source。
`nextPageToken` 与查询、租户、项目和连接器身份一起封装进 `jira-v1` 游标，扫描结束前不会删除
未见记录。Jira API 版本、限流、凭证有效性和生产增量同步语义仍由部署验收负责。

供应商的 `hasNextPage` 必须保留，分页结束前不能把视图标记为可删除；本地 `denied`、`empty` 等哨兵值不能发送给供应商作为分页参数。多来源 provider 先分别提交子来源证据，再生成合并视图，不能因为全局 `maxItems` 裁剪而消费未交付的子来源页。

## 统一 Receipt 要求

所有外部调用都返回可验证 Receipt，至少包括：

```text
receipt_id
provider / component
request_hash / response_hash
input_refs / output_refs
capabilities_used
started_at / completed_at
status
cost / latency
schema_version
```

Receipt 是 Evidence Graph 的节点，也是 RSI 评测和争议调查的输入。

## 失败与升级

接口需要区分：协议不兼容、权限拒绝、限流、瞬时失败、业务失败、数据冲突、状态未知和安全拒绝。AEEIS 根据错误类型决定 retry、补偿、人工审批或停止；不能把所有错误都包装成统一的自然语言失败。


## Run 外部执行预算与回执结算

`externalBudget` 定义本次 Run 的 Tool 与外部 Agent 合计 calls/tokens/moneyUsd 停止阈值；`modelBudget` 仍仅负责主模型。两者是独立预算池，Grant 可继续设置更窄的委托边界。独立 Competition/Debate、RSI evaluator 和连接器检索尚未归入这两个池。

外部执行遵循：发送前检查 → 保存回执 → 重建用量 → 校验停止条件 → 应用结果。次数到达上限后只允许核查原调用，token/USD 达到上限后不再发起新外部调用。精确阈值不禁止在主模型预算内整理现有结果；超额、缺报所需 token/USD 维度或币种不可验证时，后续模型和外部执行均停止。未知费用不是零；非 USD 数字不参与 USD 汇总。

accepted 是已受理而未完成的 reservation，不能以零成本提前 settle。最终 callback/reconcile 以委托幂等键替换原状态，最终回执不可被并发旧响应覆盖；Run 的结果应用与用量更新在同一次存储 mutation 中提交。暂停/取消不取消已经发生的费用；取消时仅保存回执，暂停时更新 resumeStatus 而不恢复调度。核查已有外部调用不应被已用完的模型预算阻断。

当前仅实现回执驱动的停止阈值，不承诺供应商硬扣费上限或取消外部副作用。provider 必须报告可信用量；真实账单核对、未知费用补录及多实例执行准入仍需进一步验收。取消后的 Run 可通过 `reconcile-cancelled` 复用原 Tool/Agent receipt 查询 provider，最终结果只计量并丢弃，不会恢复 Run。


## 协作预算与调用用量

Competition / Debate 的 `modelBudget` 是单个协作 aggregate 的独立预算池，覆盖其所有计费模型角色。调用次数包含已经持久化但结果未明的 attempt，tokens/USD 按供应商 usage 和服务端配置报价核算；模型自己生成的 `cost` 不能成为额度控制依据。每个 attempt 保存实际模型 Pin、当次输入/输出 token、价格与用量，以便检查估算来源。静态模型池可以按逻辑 Agent 配置价格；配置 Planprice resolver 后，候选、evaluator、participant、Moderator 和 Adjudicator 角色按 Context privacy 选择可用模型，并使用归一化 USD 目录价格。此时 attempt 的模型 Pin 还保存 `catalogHash` 和 `catalogRetrievedAt`，使协作模型选择具备与主 Runtime 相同的目录审计指纹。AEEIS 仍以 durable attempt、模型 Pin、幂等键和显式 reconcile 作为状态事实源，目录变化不会重发已有 attempt。

准入检查与 attempt reservation 在同一次 repository mutation 内完成；参与者、评估器不能通过并发 run 请求重复占用或绕开限额。结果达到精确阈值仍可应用，超额或缺失必要用量时则保留回执并停止后续工作。超额 Competition 不选择胜者，Debate 只能发布 held 状态。未知结果等待显式核查，核查可携带用量和原因，最终状态不被迟到响应覆盖。供应商必须支持幂等键才能承诺其侧不重复扣费。

预算启用后的手工候选/消息入口不能代替模型 attempt。协作计费与 Run 主模型、外部执行仍保留各自的局部事实账本；AEEIS 现在可选通过 `AEEIS_GLOBAL_BUDGETS` 以 owner/tenant/时间窗口建立上层合并账本，跨进程 PostgreSQL reservation 受行锁保护，unknown 和缺报用量不能被当作免费。该账本已接入 Competition/Debate、Run 主模型、外部执行、Knowledge/项目源连接器同步和 RSI evaluator。连接器协议把一次成功同步作为一个 call；若 provider 返回受信任 usage，则按真实 tokens/USD 结算，并把 usage 纳入 response hash；没有计量的非计量 connector 必须显式使用零 token/零 USD。失败、协议校验失败或不可信结果进入 unknown。作用域内 owner/operator 可通过 `POST /api/budgets/global/reconcile` 提交外部核查的最终用量，同时提供 `source`、`reference`、`reason` 和可选 evidence hash；该审计信息随 reservation 持久化，解除该 reservation。账单系统还可以通过 `POST /api/budgets/global/import` 按 `aeeis-billing-import/1` 提交 invoice batch；入口先预检所有 account/tenant/reservation，再逐条幂等 reconcile，超预算行保留账单 evidence 并返回 rejected。供应商专用账单抓取、折扣/缓存计价和生产容量仍需继续验收；仅本地契约测试通过不代表生产成本 SLA 已完成。
