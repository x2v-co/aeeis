---
title: AEEIS Agent 重新设计基线
status: accepted-architecture
created: 2026-09-18
tags: [aeeis, agent, rsi, brain, product-architecture, design-baseline]
---

# AEEIS Agent 重新设计基线

## 设计决定

AEEIS 从“聊天机器人”重新定义为一个拥有长期 Brain、持续推进任务、能够在受控范围内自我改进的 Agent。它独立于 `ai-chat-system` 重新设计；本文冻结核心边界和协议，当前实现按本文逐项落地，具体完成度以 `docs/implementation-status.md` 为准。

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

### 外部渠道身份边界

外部平台的发送者不能直接等同于 AEEIS Principal 或 Agent。Feishu `open_id`、Hermes `senderRef` 等首先经过独立的 `channel-identity/1` resolver，按 `channel + externalSubjectId + tenant` 解析稳定 subject；只有状态为 `active` 且 subject type 为 `agent` 的记录，才可以进入 Debate participant admission。Channel Identity 记录包含验证时间和 provenance，配置 resolver 时旧的静态 sender map 只保留本地兼容用途。

入站 Debate message 同时保留原始 `senderRef` 和当时的 identity snapshot。身份撤销、租户变化或映射更新会影响后续事件，但不会重写历史消息的 provenance。resolver 不可用、返回跨租户记录或返回 suspended/revoked/non-agent 记录时均 fail closed；HTTPS 组织目录是生产边界，JSON/InMemory 适配器只用于开发和协议验证。

`Room` 现在是可持久化的一等领域对象：它按 owner/tenant 隔离，承载多个 Goal，并可以作为外部协作渠道的投影聚合。Room 支持更新和归档；归档后不能再接收新 Goal，但历史 Goal、Run 和 Evidence 仍可读取。 Room membership 是 AEEIS 的授权扩展，成员 role 分为 editor、viewer、agent；成员记录按 tenant 持久化并可撤销，不能扩大 Principal 的原始租户边界。Room 只负责长期协作边界和归属；Goal、Plan、Task、Run 与 Evidence 仍各自保持状态语义。旧数据没有 `roomId` 时继续按未分组 Goal 兼容。

Room 同时作为 Shared Session 的当前产品边界，并拥有独立的 `session-event/1` 事实源。规范答复、决策、任务更新和普通消息都保存为带 sequence 的 append-only event；每条 event 绑定创建时的 Context Manifest binding hash、完整 audience snapshot、actor、证据引用、content hash 和幂等键。事件可以引用单个 Goal Manifest，也可以引用 Room 级 Shared Session Manifest。后者只组合已经发布的 Goal Manifest，保存每个来源的 binding hash，并要求所有接收者都能读取所有来源；它解决一个 Room 中多个 Goal 协作时的上下文一致性，不能把 Room membership 变成跨 Goal 的资料授权。读取时重新验证所有来源 Manifest 与实时 membership，后加入者不能获得历史受限 event，退出、角色变化、Goal 脱离 Room 或来源改变会立即阻止后续读取。规范答复的修订和撤回也只追加新 event：`revise` 通过 `targetEventId` 形成只能沿最新版本推进的线性链，`retract` 保存撤回原因和目标关系；旧 event 保留用于审计，投影层按 operation 解释当前交付。Debate、Feishu、Hermes 和其他外部渠道只能产生不可信输入或投影，不能直接成为 Shared Session 的 canonical response；`canonical_response` 必须由 AEEIS event service 记录。

Room 权限由领域服务统一判断，不依赖某一个 HTTP 路由：owner 可以归档 Room 和管理成员；editor 可以更新 Room 元数据、邀请或撤销成员并创建共享 Goal；viewer 与 agent 可以读取已加入的 Room，不能改变 Room 或成员关系。任何非 owner 都不能归档或撤销 owner，所有操作还要通过租户和活动 membership 校验。

认证与目录是两条不同的边界。OIDC 或静态 token 只证明当前请求的 Principal；Room 邀请还必须回答“目标 Principal 是否存在、属于哪个 tenant、当前是否允许加入”。因此 AEEIS 提供可选 `PrincipalDirectory` 端口：本地使用内存/只读文件，组织部署使用 HTTPS adapter。目录启用后，邀请只接受同 tenant 且 `active` 的身份，`suspended`、`disabled`、不存在或目录不可用都拒绝；目录不改变 AEEIS 自己持有的 membership 事实源，也不把 OIDC provider 变成 Room ACL 的事实源。目录健康状态只作为可观测依赖暴露，不会把目录暂时不可用转换成默认放行。

第一阶段从“项目持续推进 Agent”切入，首个核心 Skill 可命名为 `Project Pulse`：

- 读取项目文档、任务、消息和代码变化；
- 汇总进展、风险、阻塞和决策；
- 生成下一步行动并跟进负责人和截止日期；
- 生成日报、周报和决策记录；
- 需要时发起审批和后续提醒；
- 学习用户的汇报风格、提醒频率和决策偏好。

Project Pulse 的最终综合结果采用版本化的结构化 Artifact，而不是只生成一段不可验证的自然语言。`project-pulse/1` 固定包含 `progress`、`completedChanges`、`blockers`、`risks`、`decisions`、`owners`、`deadlines`、`nextActions` 和 `unknowns` 九类栏目；每个非空条目必须携带来源、工具回执或依赖产物的 evidence reference。人类可读的 `content` 是展示层，结构化对象和 Evidence Graph 才是机器处理、任务跟进、投影和 RSI 评估的依据。终结任务缺少结构化对象、条目引用未被本次 Run 观察到，或结构化对象与协议不符时，Runtime 拒绝产物。

截止日期和提醒由 AEEIS 自己持有一等 `Reminder` 事实源。提醒记录包含 owner/tenant、dueAt、投影渠道、尝试次数、租约、投影状态和可重试错误；File 与 PostgreSQL 均支持原子 claim、进程崩溃后的 lease recovery、幂等键和作用域隔离。Reminder 支持明确的 interval recurrence 与 maxOccurrences；每次 occurrence 使用独立的 outbox 幂等键，投影成功后才生成下一次 occurrence。错过多个周期时采用可审计的 skip-misfire 策略，从本次提交时钟后的下一个 interval 唤醒，避免恢复风暴。Reminder Pump 只把到期事实写入 Projection Outbox，Feishu、Hermes 或其他渠道只负责后续投影与交付，不能直接改变提醒状态。这样 Project Pulse 产生的“下一步”和“何时提醒”仍分别由 Plan 与 Reminder 表达，Temporal 或其他定时设施可以作为唤醒器而不是事实源。

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

向量库、全文索引、Embedding、缓存和对象存储可以外包；AEEIS 仍控制记忆条目的 owner/tenant、scope、privacy classification、evidenceRefs、evidenceRunId、version、correction、retraction 和 Context Manifest 快照；从 Run 写回 Memory 必须通过 Evidence Graph 校验引用，并保留来源 Run，禁止降低隐私级别。修正生成新的版本并把旧版本标为 `superseded`，撤回保留内容和原因并标为 `retracted`，检索只返回 active 版本。向量索引只是可重建的检索加速层。Brain 负责更长期的 claim、provenance、grant 和审计；Goal-linked Memory 负责把一次长期目标的工作记忆安全冻结进 Run。

用户可通过 `GET /api/brain/:scope/export` 导出受当前 grant 约束的 `aeeis-brain-bundle/1`，Bundle 包含该 scope 的完整 claim history（包括 retracted claim），再通过 `POST /api/brain/:scope/import` 恢复到同一 owner/tenant/scope。Bundle 带 tenant、scope、claims 和内容 hash，并记录 `export`/`import` audit；导入只做幂等合并，拒绝 hash 篡改、跨 owner/tenant/scope、同 ID 内容冲突，不携带 grant，也不能让外部 Agent 写入 Brain。向量索引、缓存和其他衍生层仍需单独重建；完整数据库恢复仍必须使用经过校验的持久化备份。

Context Manifest 的共享模式通过 `context-audience/1` 冻结当时的接收者、Room membership ID、角色、membership 更新时间和 digest。默认 Manifest 只属于 Goal owner；`audienceMode: "room"` 或显式 audience 只能选择创建时已经处于同一 Room 的活跃成员。后加入者不能读取旧 Manifest，成员撤销、角色变化或 Room 归属变化会使后续读取失效；共享 Manifest 的 memory/knowledge 只允许 internal 及以下内容，并要求每个知识记录对所有 audience 都可见。这个 snapshot 是审计和上下文边界，不替代读取时的实时 ACL。

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

实现上增加可重放的 RSI Proposal Pump。它从 Run 的 `review.completed`（低置信度或需要修订）、`run.failed` 和纠正事件发现 `rsi-improvement-signal/1`，把信号和来源写回 Evidence Graph。信号本身不产生权限变化，也不会自动评测、审批或激活；只有事件携带完整且能在本 Run Evidence Graph 中核验的最小 change（target、baseVersion、proposedVersion、risk、sourceRefs）时，Pump 才以稳定的 signal ID 创建 `proposed` candidate。候选 ID 和 signal ID 去重，重启或并发重放不会重复创建。多进程 Pump 通过短租约 claim 协调处理窗口，claim 过期后可恢复；租约不是最终正确性边界，Run 事件和候选唯一 ID 仍必须幂等。Pump 在 claim 后重新读取 Run，避免依据过期证据提案。可选的 Durable Proposal Synthesizer 只接收经过裁剪的本 Run 证据，使用单独的模型调用/Token 预算和 provider 幂等键，持久化输入 hash、模型目录和 usage；它只能返回一个最小提案或 null，unknown 必须显式 reconcile，迟到结果不能覆盖核查结果。提案器从不执行评测、审批、晋升或激活。没有具体 change 的失败或审核信号在未启用提案器时只留下待分析机会，避免把模型生成的泛泛建议伪装成自进化。

评测 canary 与生产流量 canary 是两层边界。前者在隔离 evaluator 中比较候选；后者只允许已晋升候选进入按 tenant 隔离的 durable route。route 保存 base release、候选内容 hash、比例和操作者引用，比例使用 1–9999 basis points，10000 留给全量 activation；新 Run 用稳定 Run ID 确定性分桶，并冻结命中的 route/bucket。暂停、恢复、停止、全量激活和回滚都产生可审计状态变化；候选或 base 漂移时拒绝继续分流。AEEIS 负责版本选择与事实记录，实际模型部署、反向代理和生产指标采集仍由部署系统负责。

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
