# AEEIS

> 一个由用户拥有 Brain、可持续推进任务、并以证据约束自我改进的 RSI Agent。

AEEIS 正在作为独立 Agent 开发，不是 `ai-chat-system` 的改版，也不是聊天界面。当前运行时已经能把真实目标交给模型：生成动态 DAG、等待用户批准、按任务读取本次授权资料、产生产物、独立审核，并在暂停、取消、重启和模型结果不明时保持可解释状态。

当前版本是开发中的可验证纵向切片，尚未宣称生产可用。核心运行时、Brain 读取、Knowledge、协作状态平面和受治理 RSI 候选已经接入；工作台可查看 DAG、RSI、Competition、Debate、Trigger Policy/Decision、Projection Outbox 和 Shared Session 规范事件，并可对最新 canonical response 发起 append-only 修订或撤回；真实外部部署、生产观测和多用户控制面仍在建设。

能力与验证入口的对应关系见[验证矩阵](docs/verification-matrix.md)。

工作台的“工作方式”提供内置 `Project Pulse`（`project-pulse/1`）：不接项目连接器时，也可以直接粘贴项目资料。AEEIS 会按目标先生成计划，执行后交付带 Evidence refs 的进展、已完成变更、阻塞、风险、决策、负责人、期限、下一步和未知信息；审核通过后，`nextActions` 会生成可继续调度的后续 Plan。它是首个产品化入口，连接器只是让同一工作方式自动读取项目源。

当后续 Plan 生成后，Run 工作台的“当前交付”会显示 successor Plan，并可按需展开后续任务、依赖、状态和证据引用；实际调度仍在“长期目标”区域完成，Plan 仍只有一份领域事实源。

提醒是 AEEIS 的另一类领域事实源，不是外部消息系统里的临时消息。通过 `POST /api/reminders` 或工作台“提醒”面板创建提醒，记录 owner/tenant、截止时间、隐私级别、目标关联、投影渠道和幂等键；重复规则支持兼容旧格式的 `recurrence: { intervalMs, maxOccurrences }`，以及按 IANA 时区运行的 `recurrence: { calendar: { frequency: "daily" | "weekly" | "monthly", timeZone, time, daysOfWeek?, dayOfMonth? }, maxOccurrences? }`。日历规则共享同一 Temporal 计算器，夏令时缺失的本地时刻和不存在的月末日期会跳过，重复时刻只触发一次；离线错过多个周期时从提交时钟后的下一次规则时间继续，不补发风暴。服务内 Reminder Pump 会在到期时用租约 claim，并把按 occurrence 隔离的 `reminder:<id>:<occurrence>` 事件写入 Projection Outbox；投影成功后才推进下一次。服务重启会重新 claim 已过期租约，投影失败按有界重试时间再次尝试；Temporal 模式下，创建、取消和 retry 会唤醒同一 Reminder Timer Workflow，Workflow 只负责 durable sleep 和内部 advance，实际 claim、投影和幂等仍由 Reminder Pump/Outbox 负责；Feishu、Hermes 或自定义 sink 只负责投影交付，不能改变 Reminder 的业务状态。当前支持 `scheduled`、`firing`、`projected`、`failed`、`cancelled` 和显式 retry；历史读取还提供 owner/tenant scoped 的 `GET /api/reminders/page?limit=50&cursor=...&status=...` 稳定 keyset 分页，避免 PostgreSQL 长历史查询依赖 offset 或全量载入。真实通知渠道 SLA 仍需部署侧验收。

Room 是 AEEIS 自己持有的长期协作边界，按 owner/tenant 隔离，可关联多个 Goal，并通过 `/api/rooms`、`/api/rooms/:id/goals` 查询；`PATCH /api/rooms/:id` 可更新标题、说明或归档状态，归档 Room 不能再绑定新 Goal。外部任务和消息系统只作为带幂等键的投影渠道。Room 成员通过 `POST /api/rooms/:id/members` 邀请为 `editor`、`viewer` 或 `agent`，通过 `DELETE /api/rooms/:id/members/:principalId` 撤销；成员身份仍受同一 tenant 的 Principal 认证约束。权限由领域服务统一校验：owner 可归档和管理成员，editor 可更新 Room 元数据、管理成员并创建或修订共享 Plan，viewer 只能读取共享 Goal/Plan/Run，agent 可以推进已存在 Task；共享 Run 的事件、解释和 Evidence Graph 也按 Room membership 开放读取。调度、Run 控制、记忆写入和其他外部副作用仍需要资源 owner 或 operator；非 owner 不能归档或撤销 owner。成员状态在 File 或 PostgreSQL 中持久化。组织部署可额外配置 `AEEIS_PRINCIPAL_DIRECTORY_URL`（HTTPS）或本地开发用 `AEEIS_PRINCIPAL_DIRECTORY_PATH`；邀请成员时目录会确认目标 principal 存在、属于当前 tenant 且为 `active`，目录不可用时拒绝邀请。API 进程会对同一身份的并发目录查询合并，并对 active/不存在结果使用有界短 TTL 缓存；目录异常不进入缓存，过期结果也不会作为授权回退。可用 `AEEIS_PRINCIPAL_DIRECTORY_CACHE_TTL_MS` 与 `AEEIS_PRINCIPAL_DIRECTORY_CACHE_MAX_ENTRIES` 调整边界。未配置目录时保留本地开发兼容行为。

Goal、Plan、Task、Memory 也由 AEEIS 自己持有，并通过 `/api/goals`、`/api/goals/:id/plans`、`/api/goals/:id/plans/revise`、`/api/plans/:planId/tasks/:taskId/transition`、`/api/plans/:planId/tasks/:taskId/run` 和 `/api/goals/:id/memories` 暴露；Memory 条目带 owner/tenant、分类、证据引用、来源 Run 和版本状态，`POST /api/goals/:id/memories/:memoryId/correct` 会保留 superseded 历史，`POST /api/goals/:id/memories/:memoryId/retract` 会保留撤回原因。`POST /api/goals/:id/memories/from-run` 只允许把同一 Goal 的 Run Evidence Graph 中真实存在的来源、产物或回执写回 Memory，并阻止降低源 Run 的隐私级别。绑定 Goal 启动 Run 时，Runtime 自动创建并冻结一次带 owner/tenant/Goal 归属的 Goal-linked Memory Context Manifest；Run 保存 manifest ID、内容 hash 和冻结引用，外部 Agent 可通过 `GET /api/goals/:id/context-manifests/:manifestId` 在同一权限边界内重建上下文。按 Run privacy 和查询词把 active 记忆作为带版本与证据引用的来源注入 Planner、Executor 和 Reviewer；旧版本和撤回条目不会再次进入上下文。本地模式使用 `data/runs/domain.json`，配置 `DATABASE_URL` 后领域对象和 Run 一起写入 PostgreSQL。使用 `/api/goals/:id/runs` 启动时，Run 会保存 `goalId`，Planner 产出的计划会创建对应领域 Plan，节点执行会写入领域 Receipt。对已有 `ready` 任务调用 `.../run` 会创建一个绑定该 Plan/Task 的单任务 Run，先经过同样的精确计划审批，再把运行中的 start、等待、失败、取消和 succeed 回执写回原任务；一个领域任务在同一 owner/tenant 下只会保留一个确定性的绑定 Run，重复请求会返回它。对整张 DAG 可调用 `POST /api/goals/:id/schedule` 或 `POST /api/plans/:id/schedule`，调度器只预留当前 `ready` 节点，使用 durable dispatch ledger 绑定确定性的 Run/Temporal workflow；节点完成后自动解锁并调度后继节点，恢复泵和单 Plan reconcile 都按有界 keyset page 扫描 dispatch ledger，避免长历史在每次 tick 或冷启动时完整载入，`GET /api/plans/:id/scheduler` 可查看状态，`POST /api/plans/:id/scheduler/reconcile` 用于显式恢复。Project Pulse 后续任务使用 Run 的 `followUpPlanId` 指向新计划，原报告 Run 的 `domainPlanId` 仍指向产生它的计划。如果任务带有 `evidenceRunId` 和 `evidenceRefs`，入口会按租户和隐私权限把原 Run 中对应的来源或产物冻结为本次上下文，找不到证据时拒绝启动。

工作台的 Run、Goal、Room、Competition、Debate、RSI candidate、Trigger Policy/Decision、Projection 和 Goal Memory 列表支持存储层有界读取：PostgreSQL 在权限过滤后执行排序和 `LIMIT`，本地 File Run / RSI candidate / Competition / Debate 使用可重建的元数据索引，Memory 查询按 `updatedAt` 取最近记录。共享 Room 成员读取 Run 历史时，PostgreSQL 和 File Run 都会在存储边界按 tenant、owner/Goal membership 和 `public/internal` privacy 过滤后再执行 keyset `LIMIT`，并由 domain store 在存储侧筛选可读 Goal，避免把整个 tenant 的历史载入 API 进程。Run 另提供 owner-scoped `GET /api/runs/page?limit=50&cursor=...` 稳定 keyset 分页，Competition/Debate 提供 `GET /api/collaborations/competitions/page` 和 `GET /api/collaborations/debates/page`，工作台使用这些接口，避免历史记录增长时反复跳过旧 offset；`GET /api/runs/:id/events?limit=100&cursor=...` 读取独立的可重建事件 projection，`GET /api/runs/:id/events/stream?cursor=...&waitMs=30000` 提供有界 SSE 长轮询，事件使用 seq 作为恢复断点，同时接受标准 `Last-Event-ID` header，超时会发送 `timeout` 帧，并按 `AEEIS_MAX_SSE_CONNECTIONS` 限制每个 API 进程的并发长连接，超限返回 429。Agent Registry 在复制或 SQL 投影时截取记录，保留插入顺序并避免传回完整审计历史。未传 `limit` 的 API 保留完整列表。后台完整扫描和大规模历史容量仍待完善，详见 [实现状态](docs/implementation-status.md)。
Readiness 探针只检查存储可达性，不会为了响应 `/readyz` 加载完整 Run 历史；Prometheus `/metrics` 仍会按独立采集器读取状态计数。
API 重启后，Reminder Timer 只按活动状态分页重连 `scheduled`、`firing` 和 `failed` 记录，已完成或已取消的历史不会参与 Temporal timer 重新挂接。

本地 File Domain store 使用 `domain.json` 快照加同目录 journal：每次领域事务先写入带 SHA-256 校验并 `fsync` 的日志记录，跨 Goal/Plan/Task/Receipt 的原子提交保持不变，达到阈值后再原子压缩快照；Receipt 和 Memory 历史在压缩时写入按 journal 序号版本化的 sidecar，启动只加载 Goal/Plan/Room 等热状态和 journal tail，首次查询历史时再读取 sidecar。sidecar 与快照按安全顺序发布，旧快照、旧 journal 和旧的无 sidecar 快照都保持兼容；进程崩溃时会从快照序号之后重放日志并截断尾部半写入。这个模式降低小提交和启动对历史状态的全量处理，但不能替代 PostgreSQL 的大规模容量方案。

## 本地运行

需要 Node.js 22 或更新版本。

部署到 Docker/Kubernetes 时，敏感配置可以使用文件形式注入，例如 `AEEIS_ACCESS_TOKEN_FILE=/run/secrets/aeeis-token`、`AEEIS_MODEL_API_KEY_FILE=/run/secrets/model-key` 或 `DATABASE_URL_FILE=/run/secrets/database-url`。AEEIS 会在打开存储和校验配置前读取这些文件；同一个变量同时提供直接值和 `_FILE` 值会拒绝启动，避免轮换时出现歧义。该约定只对 `AEEIS_*`、`TEMPORAL_*` 和 `DATABASE_URL` 生效。

也可以用 Docker Compose 启动一套包含 PostgreSQL、Fixture Model、Fixture RSI Evaluator、Fixture 外部 Agent 和 AEEIS 的开发环境：

```bash
docker compose up --build
```

可选启用本地 Prometheus 观测栈（界面仅绑定 `http://127.0.0.1:9090`）：

```bash
docker compose --profile observability up -d --build
npm run test:monitoring
npm run smoke:monitoring
```

`test:monitoring` 使用固定版本的 Prometheus Docker 镜像校验开发配置、生产 HTTPS/bearer-token 模板和告警的等待、触发、恢复场景；`smoke:monitoring` 验证真实抓取、9 条规则加载、readiness、HTTP 指标和 durable metrics collector 健康。默认规则在 Prometheus 界面中展示状态，尚未配置 Alertmanager 或对外通知。阈值、生产认证和聚合边界见 [运维手册](docs/operations/runbook.md#9-prometheus-观测-profile)。

工作台随后位于 `http://127.0.0.1:4323`。Compose 使用 Fixture Model 和 Fixture RSI Evaluator，只用于本地协议验收；部署真实环境时应替换为受管控的模型、evaluator endpoint 和凭证。Compose 仅在容器内为这两个 fixture 设置开发用的内部 HTTP 开关；开关默认关闭，真实 endpoint 仍必须使用 HTTPS（loopback 开发地址除外）。

Compose 同时启动 `fixture-planprice` 和 `fixture-ownhow`：前者通过 catalog 选择模型并返回 provider health，后者通过 OwnHow CLI 协议提供 Skill resolve/record/propose/apply/rollback/status。AEEIS 的 `/api/status` 会显示 `modelRouting: catalog`、模型探针结果和 `skillGovernanceConfigured: true`。这两个服务及 `AEEIS_PLANPRICE_ALLOW_INSECURE_HTTP=1`、`AEEIS_MODEL_PROVIDER_ALLOW_INSECURE_HTTP=1` 只用于容器内开发验收；生产环境必须改为 HTTPS、真实凭证和受治理的外部服务，启动校验会拒绝不安全的非 loopback HTTP。

Compose 还会把 `fixtures/project-sources.json` 作为服务端配置的 File Project Source 注入 AEEIS。它用于验收 Project Pulse 的真实项目源路径：来源先进入带 checkpoint 的 Context Manifest，再进入证据约束的 `project-pulse/1` 产物，审核接受后生成 successor Plan。Fixture 内容、hash 和租户边界只服务于开发 smoke；生产环境应替换为受治理的 HTTP、Git、Linear、Jira 或其他项目连接器。

Compose 启动后可以用另一终端运行 `npm run smoke:compose`，它会等待 AEEIS `/readyz` 和 Temporal Worker `/readyz`，先通过跨容器 Fixture Model 验证 Trigger Policy 的 `dispatch=run`：事件只创建一个幂等 Competition，两个隔离候选和独立 evaluator 完成 Attempt、盲评和结果持久化；随后再运行一个 Debate，验证两个 participant、独立 Moderator、独立 Adjudicator、轮次边界、全部 Attempt 结算和 `held` 终态；接着创建带 admitted external Agent 的普通 Run，等待它完成后由内部 Run Event Pump 从持久化 `review.completed` 事件自动创建一个 Debate，证明主链路不依赖手动 `/evaluate`；然后创建包含两个依赖节点的领域 DAG，分别经历精确计划审批，再确认 Temporal Worker 驱动调度器自动解锁后继节点、写入两个任务的产物和独立审核，并最终把 Plan 和 Goal 收敛为完成；之后还会通过跨容器 Fixture Evaluator 完成 RSI candidate 的 replay、holdout、safety 三道评测、审批、晋升和激活，并验证 production traffic canary 的启动、Run 路由快照、带证据的线上观察和停止。可用 `AEEIS_SMOKE_TIMEOUT_MS` 和 `AEEIS_BASE_URL` 调整超时时间和地址。
`AEEIS_BASE_URL` 必须指向 AEEIS API，`AEEIS_WORKER_URL`（默认使用 API 主机的 4324 端口）必须指向 Temporal Worker；smoke 会校验两者的协议身份，指向本地演示或错误端口时会立即失败。

Compose 同时启动一个跨容器的 `agent.fixture`，实现 `agent-task/1` 和 `agent-reconcile/1`，用于验收 Context Pack、Delegation Grant、Result Envelope 和跨进程 HTTP 传输；它是协议夹具，不代表真实 Agent 能力或安全等级。Compose 仅为这个开发夹具设置 `AEEIS_AGENT_ALLOW_INSECURE_HTTP=1`；真实外部 Agent 仍必须使用 HTTPS。单独运行时可用 `npm run demo:agent` 启动同一夹具。

Compose 还启用受控的 RSI proposal synthesis smoke：专用运行会产生低置信度审核，后台 Pump 通过模型提案协议生成证据绑定的 `proposed` candidate，然后继续经过独立 evaluator、人工审批、Canary 和 activation。该链路用于验证 RSI 的发现、持久化、预算和状态边界；Fixture 生成的提案内容不代表真实模型质量，也不会绕过审批或自动进入生产。

配置 `DATABASE_URL` 后，可以用 `npm run backup:postgres` 创建 PostgreSQL custom-format 备份。命令使用 `pg_dump` 的参数数组调用，不经过 shell；备份旁边会生成包含大小和 SHA-256 的 manifest。用 `AEEIS_BACKUP_FILE=backups/aeeis-*.dump npm run backup:verify`（或把文件路径作为第一个参数）可只读校验 manifest、文件 hash 和 `pg_restore --list` 归档可读性。可以用 `AEEIS_RESTORE_ADMIN_DATABASE_URL=postgresql://... AEEIS_BACKUP_FILE=backups/aeeis-*.dump npm run backup:restore` 在同一 PostgreSQL 集群创建临时隔离数据库、恢复归档、检查关键 AEEIS 表和行数后自动删除；设置 `AEEIS_RESTORE_KEEP_DATABASE=1` 可保留临时库供人工检查。`AEEIS_RESTORE_ADMIN_DATABASE_URL=postgresql://... AEEIS_BACKUP_FILE=backups/aeeis-*.dump npm run recovery:postgres` 还会在恢复库上启动本地 Fixture Model 和 AEEIS，检查 `/readyz`，然后停止应用并删除临时库。恢复演练不会触碰源数据库，但管理员连接串必须显式提供。生产环境仍应把备份文件和 manifest 上传到独立、加密并受访问控制的存储，并按组织策略执行包含真实应用依赖和凭证策略的恢复演练。

```bash
npm install
npm test
npm run typecheck
npm run dev
```

如果只想在本机快速查看完整的控制面，可以用一条命令启动 Fixture Model 和 AEEIS；它会把演示数据写入独立的 `data/demo-local`，不会覆盖默认的 `data/runs`：

```bash
npm run demo:local
```

启动后打开 `http://127.0.0.1:4323`，按 `Ctrl-C` 会同时停止两个进程。脚本会隔离 `DATABASE_URL`、Temporal、凭证和其他外部 `AEEIS_*` 配置，强制使用 development + File store；Fixture Model 只用于验收规划、执行、审核和证据链路，不代表真实模型质量。可用 `PORT`、`AEEIS_FIXTURE_MODEL_PORT` 和 `AEEIS_DEMO_DATA_DIR` 覆盖端口或演示数据目录。
重复运行命令时，脚本只会复用同时符合 AEEIS 健康协议、`/api/status` Fixture profile、LocalDispatcher、Fixture Model 和 readiness 协议的已有进程；Temporal Worker、生产 AEEIS 或其他仅返回 HTTP 200 的服务不会被误认成演示环境。
保持演示运行时，可在另一个终端执行 `npm run smoke:local`，自动验证单个 Run 的“计划审批 → DAG 执行 → 产物 → 独立审核 → Evidence Graph”，以及领域两节点 DAG 的自动解锁和 Goal 完成；也可用 `AEEIS_BASE_URL` 指向其他本地实例。
如需验证 File 持久化的重启恢复，可执行 `npm run smoke:local:restart`；它会使用临时端口和临时数据目录，在 Run 等待审批时重启 API，确认计划 hash 和等待状态恢复后再继续完成，结束时自动清理。

如果要查看多个外部边界同时接入时的完整开发形态，可运行：

```bash
npm run demo:full-local
```

该入口不需要 Docker，会在动态临时端口启动 Fixture Model、Planprice、OwnHow、RSI Evaluator、外部 Agent 和 AEEIS，强制使用 catalog model routing、Skill governance、RSI evaluator、Agent Gateway 与 LocalDispatcher，并自动运行一次 `smoke:full-local`。完整 smoke 会验证 RSI proposal synthesis、外部 Agent Result Envelope、Trigger Policy 幂等、Competition、Debate、Project Pulse checkpoint/successor Plan、两节点 DAG、生产流量 Canary 和 RSI activation。工作台地址、状态和数据目录会在终端打印；按 `Ctrl-C` 会停止本次启动的全部夹具。它验证的是协议、状态机和接入边界，不代表真实模型、外部 Agent 或生产 SLA。
如果完整开发栈已经由其他方式启动，也可以直接设置 `AEEIS_BASE_URL` 运行 `npm run smoke:full-local`；该命令要求目标 `/api/status` 已启用 catalog、OwnHow、RSI evaluator、外部 Agent 和 LocalDispatcher。

有 PostgreSQL 时可运行真实集成验收；测试会为每个用例创建隔离 schema，并在结束时删除：

```bash
AEEIS_TEST_DATABASE_URL=postgresql://aeeis:aeeis@127.0.0.1:5433/aeeis npm run test:postgres
```

Temporal Worker 发布前还应对线上导出的 Workflow history 做回放验收。先用与目标发布版本一致的代码执行 `npm run build`，再运行
`AEEIS_TEMPORAL_HISTORY_FILE=history.json AEEIS_TEMPORAL_WORKFLOW_ID=<workflow-id> npm run temporal:replay`；命令会使用当前
`dist/temporal/workflows.js`，只做离线 replay，不连接 Temporal Server，也不会重新执行 Activity。history 可以是 Temporal CLI 导出的
`{ "events": [...] }`，也可以是包在 `history` 字段下的同一对象。回放失败时命令以非零状态退出，发布流程不得继续。

服务默认监听 `http://127.0.0.1:4323`，工作台位于 `/`；容器部署时设置 `AEEIS_HOST=0.0.0.0`，并将容器服务名加入 `AEEIS_TRUSTED_HOSTS`，这样 Temporal Worker 可以通过内部 Host 调用 Activity API，同时公网 Host 仍会被拒绝。设置 `AEEIS_ENV=production` 后，启动会在打开数据存储前检查 PostgreSQL、认证方式、HTTPS 传输、公开 Host allowlist 和 Temporal 必需配置；不满足条件会直接拒绝启动。没有模型配置时，页面只显示配置状态，创建运行会返回 `503`，不会生成模拟成功结果。

如果现在只是想在本机查看完整闭环，可以启动开发夹具模型。它只用于验证 AEEIS 的协议和状态机，不代表真实模型质量：

```bash
# 终端一
npm run demo:model

# 终端二
AEEIS_MODEL_BASE_URL=http://127.0.0.1:4399/v1 \
AEEIS_MODEL=aeeis-fixture/1 \
npm run dev
```

然后打开 `http://127.0.0.1:4323`。创建运行后，工作台会经历“规划 → 等待审批 → DAG 执行 → 证据产物 → 独立审核”；也可以直接访问 `GET /readyz` 查看模型依赖是否就绪。

如果设置 `AEEIS_MODEL_HEALTH_URL`，`/readyz` 会用同一模型凭证探测 provider；探针失败会明确返回未就绪。未设置探针时，模型配置仍可用，但就绪信息会标明 provider health probe 未启用。

已配置的 Knowledge、Project Source、Tool Gateway、Agent Registry、RSI evaluator 与 Projection Sink 也会在 `/readyz` 中显示独立的 optional health check，并在 `/api/status` 返回 `knowledgeProviderHealth` / `projectSourcesHealth` / `toolsHealth` / `agentRegistryHealth` / `rsiEvaluatorHealth` / `projectionSinkHealth`。本地文件、PostgreSQL 和 Git 适配器会检查自身依赖；HTTP 资料源可配置 `AEEIS_KNOWLEDGE_HEALTH_URL` / `AEEIS_PROJECT_SOURCES_HEALTH_URL`，以同源、禁止重定向的只读 GET 探测可达性，并复用 connector Bearer token；HTTP 状态成功不代表搜索协议或内容质量已验证。toolkit_new Registry 健康检查只读取 manifest，不调用工具；旧版 HTTP Tool Gateway 健康检查只读取 manifest。Agent Registry 探针只读取本地文件或执行 PostgreSQL `SELECT 1`，不会改变发现、准入或撤销状态。HTTP Projection Sink 可配置 `AEEIS_PROJECTION_SINK_HEALTH_URL`，只发送同源只读 GET，不发送 projection event；HTTP RSI evaluator 可配置 `AEEIS_RSI_EVALUATOR_HEALTH_URL`，只发送同源只读 GET，不执行评测 case。未配置探针的远程 connector、evaluator 或 Feishu sink 会明确报告探针不可用。资料源、工具网关、Registry、RSI evaluator 和 Projection Sink 属于增强依赖层，故障不会阻断核心仓库、模型、dispatcher、domain 和 scheduler 的 required readiness。

复制 `.env.example` 后配置一个 OpenAI-compatible endpoint：

```bash
cp .env.example .env
set -a; source .env; set +a
npm run dev
```

也可以配置 `AEEIS_PLANPRICE_URL` 启用按能力、隐私策略和目录价格的模型选择；AEEIS 读取 Planprice 的 `/api/products/grouped?type=llm` 渠道价格，并用 `/api/exchange-rates` 的汇率归一到 USD；没有可验证汇率时不会把本地币种数字直接拿来比较。每次 Model Decision 都会保存候选目录的排序稳定 `catalogHash` 和读取时间，便于重建长时 Run 当时的路由依据。必须额外为选中的 provider 配置 `AEEIS_MODEL_PROVIDER_ENDPOINTS` 和 `AEEIS_MODEL_PROVIDER_KEYS`。`AEEIS_MODEL_PRIVATE_DATA_ALLOWED` 是由部署者维护的 provider/model 数据策略 JSON 映射；只有显式为 `true` 的条目才能承载 `private` Run，省略条目会安全拒绝路由，策略也会进入候选目录 hash。 在生产环境启用 Planprice 路由时，启动校验会要求两者都是非空 JSON 对象，并拒绝带凭证、查询参数、fragment 或非 HTTPS 的 provider/health URL；目录读取成功但没有可调用 provider 配置不会进入 ready。可用 `AEEIS_PLANPRICE_HEALTH_URL` 配置与目录同源的只读 GET 探针；它只用于依赖诊断，不触发模型调用，重定向、超时或非 2xx 会明确标记目录不可用。`/readyz` 和 `/api/status.modelHealth` 会区分 Planprice 目录故障、无满足策略的模型和被选 provider 故障；可用 `AEEIS_MODEL_PROVIDER_HEALTH_URLS` 按 provider 或 model 配置健康地址，未配置时会明确标出只完成目录选择、没有 provider 探测。工具和 Personal Method 治理分别通过 `AEEIS_TOOLKIT_*`、`AEEIS_OWNHOW_*` 接入。启用 OwnHow 时要设置 `AEEIS_OWNHOW_RUNTIME`，或者在每个 Run 提供 `skillRuntime`，因为 OwnHow 的解析必须绑定具体宿主 runtime。对 toolkit_new，优先设置 `AEEIS_TOOLKIT_REGISTRY_URL`（指向 `/api/v1/registry`）；AEEIS 会读取 Registry index/Manifest，再把已批准的版本调用转换为 toolkit_new 的 `/api/v1/t/:slug` 请求，并保留自己的 allowlist、幂等键和 Receipt。设置 `AEEIS_TOOLKIT_VERIFY_SIGNATURES=1` 后还会读取 `/keysets/current`，验证 Registry keyset 的根签名以及 index/manifest 的 Ed25519 签名和 canonical digest；生产环境默认要求开启，并通过 `AEEIS_TOOLKIT_ROOT_PUBLIC_JWK` 注入独立信任根，启动时会校验该变量是公开的 Ed25519 JWK，缺失或无效会直接拒绝启动；只有显式设置 `AEEIS_TOOLKIT_VERIFY_SIGNATURES=0` 才关闭这一生产要求。旧的 `AEEIS_TOOLKIT_MANIFEST_URL` + `AEEIS_TOOLKIT_INVOKE_URL` 仍支持自定义网关。外部工具版本在 Run 创建时冻结，未知结果只能通过 provider reconcile 恢复。

Planprice 目录默认缓存 30 秒，同一时间的并发读取会合并为一次上游请求；可用 `AEEIS_PLANPRICE_CACHE_TTL_MS=0` 关闭缓存。Model Decision 保存真实上游读取时间，便于重建长时 Run 当时的路由依据。

若要对真实 toolkit_new Registry 做一次端到端协议验收，先完成 `npm run build`，再把服务端配置的 Registry URL、API Token 和线下保存的根公钥注入环境：

```bash
AEEIS_TOOLKIT_REGISTRY_URL=http://127.0.0.1:5099/api/v1/registry \
AEEIS_TOOLKIT_TOKEN=tk_... \
AEEIS_TOOLKIT_ROOT_PUBLIC_JWK='{"kty":"OKP","crv":"Ed25519","x":"..."}' \
npm run smoke:toolkit
```

该命令读取并验证真实 Registry index/Manifest，按发布版本调用一个工具，并检查 AEEIS Receipt 中的 toolkit provider receipt。它只证明协议、签名和调用链路，不代表生产凭证、ACL、供应商容量或工具业务质量已经验收；根公钥必须通过 Registry 之外的可信配置提供。 当前 toolkit_new 的 `/api/v1/run/receipts/:id` 查询路由使用用户会话认证，不能直接作为 AEEIS 的 bearer-token reconcile 端点；如果部署侧提供 `AEEIS_TOOLKIT_RECONCILE_URL`，它必须接受 `tool-reconcile/1` 并返回 `tool-result/1`，AEEIS 才会把未知调用交给该机器间 gateway 核查；否则未知结果会保持 unknown。

若要对真实 Planprice 服务做一次端到端目录验收，先启动 Planprice，再完成 AEEIS 构建，并显式提供按 provider slug 配置的模型 endpoint：

```bash
AEEIS_PLANPRICE_URL=http://127.0.0.1:4325 \
AEEIS_MODEL_PROVIDER_ENDPOINTS='{"openai":"https://api.example/v1","anthropic":"https://api.example/v1"}' \
AEEIS_BASE_URL=http://127.0.0.1:4323 \
npm run smoke:planprice
```

该命令通过 AEEIS 的真实 `PlanpriceHttpCatalog` 读取 grouped LLM 目录和汇率，校验 USD 归一化、可用模型选择、稳定 `catalogHash`；如果配置 `AEEIS_PLANPRICE_HEALTH_URL`，还会先执行只读目录健康探针；在提供 `AEEIS_BASE_URL` 时检查 AEEIS 已使用 catalog routing 且 readiness 报告实际选中的 provider/model。它不会调用模型；只有显式设置 `AEEIS_PLANPRICE_SMOKE_RUN=1` 才会创建一个测试 Run，因此目录验收不会意外产生供应商调用费用。

Knowledge 可以通过 `AEEIS_KNOWLEDGE_URL` 接入受 HTTPS 保护的服务，也可以用 `AEEIS_KNOWLEDGE_FILE` 指向本地 JSON 数组；配置 `AEEIS_KNOWLEDGE_DATABASE_URL`（或仅配置 `DATABASE_URL`）时使用 PostgreSQL Knowledge Provider，提供持久化记录、全文索引和 upsert/delete 接口。若同时配置 `AEEIS_KNOWLEDGE_EMBEDDING_URL`，Provider 会使用 OpenAI-compatible embedding endpoint，并在 PostgreSQL 中启用 `pgvector` cosine 索引；写入和查询都绑定 embedding model，向量服务不可用或记录尚未完成向量回填时回退到全文检索。三种方式都必须返回或包含完整的 Knowledge Record（分类、可选 audience ACL、来源、更新时间和内容 hash），记录可以绑定 `tenantId`；Runtime 会在 Provider 查询后再次校验租户、privacy、audience、数量、分类、重复 ID 和 content hash。旧记录缺少 `tenantId` 时按全局记录兼容，但不能跨租户读取带明确租户归属的记录。embedding 回填是独立的 durable operator job：`POST /api/knowledge/embedding-reindex` 入队、`POST /api/knowledge/embedding-reindex/run` 执行一个有界批次、`GET /api/knowledge/embedding-reindex` 查看 cursor/indexed/status/失败次数；设置 `AEEIS_KNOWLEDGE_REINDEX_INTERVAL_MS` 可启用服务内 pump。回填 checkpoint 与向量写入在同一事务提交，进程重启或单批失败不会提前推进游标；这些维护 API 需要 operator 权限。

Project Pulse 的项目源可以通过 `AEEIS_PROJECT_SOURCES_URL` 接入 HTTP Connector，也可以用 `AEEIS_PROJECT_SOURCES_FILE` 指向本地导入文件；开发时还可以用 `AEEIS_PROJECT_GIT` 配置一个或多个服务端 Git 仓库目录，用 `AEEIS_LINEAR_PROJECT_SOURCES` 接入 Linear GraphQL，或用 `AEEIS_JIRA_PROJECT_SOURCES` 接入 Jira REST 搜索。Linear 连接器只读取 issue 搜索结果，支持安装级 API key、团队过滤、租户/隐私边界和不透明游标；Jira 连接器支持 bearer 或 email + API token basic auth、JQL、项目过滤、租户/隐私边界和不透明 `nextPageToken`；二者都把 issue 转成带稳定来源和内容 hash 的 `task` 记录。Git 适配器只读取已提交的 blob 和限定目录内的提交变化，排除 `.env`、密钥、证书、二进制和符号链接，并把 commit 号写入来源；它不会读取工作区未提交文件。HTTP Connector 接收 `project-source-search/1`，返回 `project-source-results/1`；其他飞书、代码仓库和任务系统适配器可以各自实现这个边界。长期同步可以实现 `project-source-sync/1` → `project-source-sync-results/1`，返回 `nextCursor` 和 `project-source-sync-receipt/1`；请求 hash、响应 hash、前后游标、更新模式和记录数都会在 AEEIS 边界重新验证；`update` 可声明 `snapshot`、`unchanged`、`delta` 或分页 `scan`，只有完整快照或扫描结束后才会删除未见记录，游标与已接收 records 在同一个 checkpoint 中保存。配置 `DATABASE_URL` 时项目源 checkpoint 自动写入 PostgreSQL；本地模式写入 `${AEEIS_PROJECT_SOURCE_CHECKPOINT_PATH}`（默认 `${AEEIS_DATA_DIR}/project-source-checkpoints.json`）。Checkpoint 按 provider、租户、查询和隐私范围隔离，使用事务/CAS 防止并发同步覆盖；创建 Run 时如果省略 `projectSourceCursor`，Runtime 会自动读取 durable checkpoint，服务重启后可以继续同步，并把 checkpoint revision 写入 Run 回执。显式传入的游标必须与当前 checkpoint 一致。记录可标注 `document`、`task`、`message`、`code` 或 `other`，并可绑定 `tenantId` 与隐私分级。创建 Run 时显式提供 `projectSourceQuery`，AEEIS 才会读取有界结果；URL、文件路径和 Git 根目录只由服务端配置，不能由请求指定。结果会经过租户、隐私分级、重复 ID 和 content hash 校验后进入本次 Run 的 Context Manifest，能够被 Planner、Executor 和 Reviewer 作为带来源证据的项目资料使用；启用项目源查询时，内置 `Project Pulse` 行为会要求区分进展、阻塞、风险、决策、责任人、截止日期、下一步行动和未知信息，并为事实绑定证据。最终综合产物必须符合 `project-pulse/1` 结构化契约，包含 `progress`、`completedChanges`、`blockers`、`risks`、`decisions`、`owners`、`deadlines`、`nextActions` 和 `unknowns`；每个非空条目都必须引用本次 Run 实际读取到的来源、回执或依赖产物，Runtime 会拒绝无证据或只返回自然语言的终结产物；审核接受后，`nextActions` 会自动生成带 `evidenceRefs` 和 `evidenceRunId` 的 successor Plan，若原 Goal 已完成则重新激活它，后续任务可通过现有 Goal/Plan/Task API 继续推进。

最小记录格式如下（`contentHash` 是内容的 SHA-256）：

```json
[{"id":"task:ABC-1","title":"Release blocker","content":"Migration is still blocked","source":"linear:ABC-1","kind":"task","tenantId":"team-a","updatedAt":"2026-09-19T00:00:00.000Z","contentHash":"<sha256>"}]
```

外部 Agent 通过 `AEEIS_AGENT_CARDS` 注册（JSON 数组），Run 请求仍需显式提供 `allowedAgents`；Run 创建时会把获准 Agent 的能力、输入/输出 schema、隐私策略和 Card digest 冻结到能力目录，Card 在实际委托前重新校验，发生变化就要求创建新 Run。Agent Card 只描述能力，真正的任务级权限由 AEEIS 生成的 Context Pack 和 Delegation Grant 决定。Context Pack 自身的 claim 必须引用同一 Pack 已冻结的 source、artifact 或其他 claim，不能自引用或带入任意 evidence ID；外部 Result 的 claim 也必须再次通过同一绑定校验。Gateway 会校验 Context Pack 过期时间、Context Acknowledgement、幂等并发和 Grant 的 calls/tokens/money 预算；本地模式把预算账本持久化到 `${AEEIS_DATA_DIR}/agent-grants.json`，配置 `DATABASE_URL` 时改用 PostgreSQL 行锁账本，因此重启后已 reserve 的委托只能 reconcile，竞争调用也不能绕过预算。Grant 在 provider 执行期间撤销或过期时，已经跨出远端边界的结果仍可按原 receipt 做 accounting-only reconcile 并结算真实用量，但会标记为 `isolated`，不会写入 Task observations、Artifact、Evidence Graph 或 Agent reputation；新的提交会被拒绝。`signed_request` Agent 可在 `AEEIS_AGENT_SIGNING_KEYS` 中按 Agent ID 配置共享密钥，OAuth Agent 可通过 `AEEIS_AGENT_OAUTH_CONFIG` 使用 client-credentials token；HTTP 传输会验证 HTTPS、签名响应和结构化 Result Envelope。Agent Registry 在本地模式以 `AEEIS_AGENT_REGISTRY_PATH`（默认 `${AEEIS_DATA_DIR}/agent-registry.json`）持久化；配置 `DATABASE_URL` 且未显式设置该路径时自动使用 PostgreSQL，并以事务 advisory lock 串行化跨进程变更。PostgreSQL Registry 的条目、审计、声誉聚合和观察已规范化为独立表，旧 JSONB 行保留为兼容镜像并在启动时迁移；有界快照在数据库内完成排序和限量。两种模式都持久化 Discovery → Admission → Revocation 生命周期、operator 审计和带证据的多维 reputation 观察；Gateway 会在最终委托结果落盘时自动记录带 receipt、claim 和 artifact 引用的 delegation observation；发现不等于获准，只有 operator 能通过 `/api/agents` 相关接口批准或撤销，撤销后的 Agent 不能靠重新发现绕过。跨 Grant Registry、Run Repository 与全局预算的授权提交仍是两个可恢复步骤，生产部署需以 durable authorization receipt/fencing 作为最终线性化边界。

异步 Agent 可以通过 `POST /webhooks/agents/:runId/callback` 返回最终 Result Envelope，也可以在 callback body 中附带经过绑定校验的 `agent-progress/1` 进度事件；该 webhook 不要求 AEEIS 用户 Bearer token，只接受 Agent Card 对应的 callback HMAC。旧的 `POST /api/runs/:id/agent-callback` 仍保留给已认证的内部调用。带 `signed_request` 的 Agent 必须使用同一共享密钥对原始 `timestamp + callback body` 生成 HMAC，并提供 `x-aeeis-timestamp` / `x-aeeis-signature`；时间窗为 5 分钟。OAuth/bearer Agent 的异步 callback 当前必须同时声明 `signed_request`，避免只有一个公开 Run ID 就能伪造结果。重复 callback 按 delegation receipt 幂等处理，不能重复推进任务或重复结算预算；webhook 只返回接收确认，不返回 Run 内容。

外部 Agent 也可以在 Delegate 决策中选择 `mode: "stream"`。HTTP Gateway 接受 `application/x-ndjson` 或 `text/event-stream`，每个数据帧可以是 `agent-progress/1`，最后必须是普通 Result Envelope；进度只作为受限 telemetry 写入 Run 的 `agentProgress` 和 Timeline，不会自动成为 Evidence、Claim 或工具授权。事件必须匹配 task、Agent 和 Context Pack，序号单调递增且最多 1000 条。传输失败、5xx/超时/限流和缺少最终结果仍进入 `unknown`，必须显式 reconcile；4xx、签名错误、schema/证据绑定错误和预算越界会记录为 `protocol`、`authentication`、`http_rejection` 或 `budget` 的 rejected diagnostic，同时保留本次 Grant/全局预算的未知结算边界，不能把被拒绝内容写入 Evidence。流式结果没有最终帧或超过大小限制也进入该边界。

OAuth 仅支持机器间 client-credentials。每个 Agent ID 配置 `tokenUrl`、`clientId`、`clientSecret` 和可选 `scopes`；`authMethod` 默认 `client_secret_basic`，也可选 `client_secret_post`。token 只在内存缓存，并发申请会合并；按服务商有效期提前刷新，不报告有效期则不缓存。不跟随 token endpoint 重定向，也不在认证失败后自动重发 Agent 任务。用户交互授权、SSO 和生产授权服务器仍未验收。

开发环境可以使用 loopback HTTP；非 loopback endpoint 必须使用 HTTPS。模型调用不会自动重试，传输结果不明会进入 `unknown`，需要显式核查后才能再次调用。每次模型调用都会生成稳定的 `model:<runId>:<callId>` provider 幂等键；reconcile 会复用原调用记录和同一个 key，避免把一次不明结果变成重复计费或重复请求。外部 Agent 返回异步 `accepted` 时，Run 会进入持久化的 `waiting_external`，保留 delegation receipt，只有显式 reconcile 收到最终 Result Envelope 后才继续。服务重启发现未完成的 Tool/Agent 调用时，会恢复为带 Receipt 的 `unknown`，强制走 provider reconcile，不会直接再次发送副作用请求。

## 主模型预算

创建 Run、Goal Run 或领域任务 Run 时，可传入 `modelBudget: { "tokens": 50000, "moneyUsd": 2 }`，两个字段至少填一个；工作台也提供对应输入。该预算覆盖 Planner、Executor、Reviewer 的模型调用，随 Run 固定保存，调用回执和汇总用量一起落盘。

`tokens` 是输入与输出 token 总和；`moneyUsd` 按 Run 创建时锁定的 USD 输入/输出目录价估算，不是供应商账单。配置费用预算时，缺少任一有效价格、负数价格或非 USD 价格都会在创建时拒绝；仅配置固定模型 endpoint 而没有价格目录时，可使用 token 阈值。没有可验证价格时，`modelUsage` 不返回 `moneyUsd`，不会把未知费用显示为免费。

这是按已报告用量停止后续请求的预算阈值，单次在途调用仍可能超出阈值，不是供应商侧的硬扣费上限。超额结果不会继续驱动工具、产物或计划；取消期间返回的结果、无法解析但附带 usage 的模型输出也计入用量。暂停期间结算不解除暂停。缺失或无效 usage 会记录 `unreportedCalls`，设定预算的 Run 不允许通过 retry/replan 绕过；unknown 调用只在显式核查后复用原 key，回执结算一次。供应商必须支持该 key 的幂等语义才能避免重复计费。

当前不合并 toolkit、外部 Agent 或 Competition/Debate 的折扣、缓存价等额外计费规则。预算 Run 的历史用量缺失时会停止；供应商账单可通过下方全局账本的协议化批量导入补录。

## 外部 Tool / Agent 预算

Run 请求可用 `externalBudget` 为本次运行直接调用的 Tool 和外部 Agent 设置合计阈值，例如：

```json
{"externalBudget":{"calls":10,"tokens":50000,"moneyUsd":2}}
```

这与 `modelBudget` 分开计量，不把不同预算池混成一个总上限。内置 `sources.read/search` 不计入外部调用次数。工作台可以填写阈值，并展示 `externalUsage` 的次数、已报告 tokens、已报告 USD 和缺报维度；HTTP 的独立 Run、Goal Run、Task Run 入口均支持同一配置。

Tool 回执和 Agent 最终 Result Envelope 是用量事实源。unknown/accepted 占用调用名额，核查替换原记录，不能作为新调用绕过次数上限。达到阈值后禁止新的外部调用，仍允许主模型在自己的预算内整理已有结果；超额或缺少要求的用量则停止后续模型与外部执行，retry/replan 不能绕过。USD 费用必须明确报告 `currency: "USD"`，其他币种和缺失币种不会作为免费使用处理。未配置 token/USD 阈值时，允许只有调用次数限制的服务不报告费用，但仍展示缺报状态。

异步 Agent 的 accepted 只保留 reservation，最终 callback/reconcile 才结算；重复或并发 callback 不会重复计费或应用结果。暂停、取消期间返回的回执照常保存，取消结果不应用，暂停不被自动解除。外部核查不占新的调用名额，即使主模型预算已经耗尽，也可以核查此前调用。工具/Agent 传输异常及无法验证的返回进入 unknown，不能盲重试。

这些是依赖外部回执的停止阈值，单次调用可能超额，不能撤销已发生的外部副作用，也不是供应商硬扣费上限。当前不含独立 Competition/Debate、RSI evaluator、连接器检索或供应商专用账单抓取；没有费用的旧回执或中断回执需要保留未确认状态，可通过全局账本的 invoice batch 入口补录核查。取消且状态仍不明的运行保留待核查回执；`reconcile-cancelled` 可以只核查 Tool/Agent 并结算费用，最终结果会被丢弃且不会复活 Run。

## Competition / Debate 模型预算

创建 Competition（Brief 顶层）或 Debate（请求顶层）时，可提供 `modelBudget`：

```json
{"modelBudget":{"calls":8,"tokens":50000,"moneyUsd":2}}
```

该预算按一次协作聚合计量，与 Run 的预算独立。Competition 覆盖所有候选和独立 evaluator；Debate 覆盖 participant、Moderator 和 Adjudicator。每次调用先检查额度并持久化 attempt，再发送请求与记录用量；达到阈值时停止新调用，单次调用仍可能超额。超额或缺报所需 token/USD 用量时不应用该结果：Competition 不选出胜者，Debate 以 held 结束。仅限制 calls 时可以使用不报告 token/费用的模型，但仍显示缺报维度。

模型池只使用供应商返回的 `usage`，忽略模型输出 JSON 中的 `cost`。USD 估算必须有服务端配置价格：`AEEIS_COMPETITION_AGENT_MODELS` 每个 Agent 可添加 `prices` 对象，独立 evaluator 通过 `AEEIS_COMPETITION_EVALUATOR_PRICES` 配置相同对象；如果已经配置 `AEEIS_PLANPRICE_URL`，且没有静态 endpoint，Competition/Debate 会复用 Planprice resolver，按协作 Context 的 privacy 分类选择可用模型，并使用目录归一化后的 USD 价格。静态 Agent 配置优先于 resolver：

```json
{"inputPricePerMillion":1,"outputPricePerMillion":2,"currency":"USD"}
```

每个有报告的 attempt 保存实际使用的模型 Pin、输入/输出 token、当次价格和归一化用量；如果由 Planprice 目录解析，还会保存 `catalogHash` 与 `catalogRetrievedAt`，使 Competition/Debate 的模型选择可以重建。聚合 `usage` 保存总调用数、tokens、已知 USD 小计和缺报次数，工作台和投影快照展示这些值。Planprice 目录只在每次逻辑角色 attempt 开始时参与选择，模型 Pin、持久化状态和幂等键仍由 AEEIS 控制；它不是供应商账单。旧 `maxCost`/`totalCost` 保留为候选结果的历史字段，不能替代 `modelBudget`/`usage` 的完整计费。

调用使用稳定 `competition:<id>:<attempt>` 或 `debate:<id>:<attempt>` 幂等键。started/unknown 不自动重发；通过既有 reconcile 接口提交 `usage: {"tokens":123,"moneyUsd":0.02}`、结果与核查原因后继续，核查用量由有权限的操作者负责。较晚返回的模型结果不能覆盖已核查结果。评估器已结算但评分未应用时，重新运行从持久化评分完成选择，不再次调用模型。预算启用后，手工 candidate/message 不能绕过受管控 attempt；旧的无预算工作流保持兼容。

当前验证使用本地模型适配器与文件存储；真实模型池价格、生产计费和供应商账单对账仍未验收。Run、协作、RSI evaluator 和项目源同步已有可选的全局合并预算，但生产容量与供应商连接器计费仍未完成。

## 全局合并预算

配置 `AEEIS_GLOBAL_BUDGETS` 后，AEEIS 会为匹配的 owner/tenant 和 UTC 时间窗口建立一个 durable budget account，把 Competition、Debate 等协作角色的调用与其他已接入的 billable surface 纳入同一账本。例如：

```bash
AEEIS_GLOBAL_BUDGETS='[{"tenantId":"team-a","window":"day","budget":{"calls":100,"tokens":200000,"moneyUsd":20}}]'
```

规则按 owner/tenant specificity 选择；`none`、`hour`、`day`、`month` 分别表示累计、小时、日和月窗口。调用在发送前占用 calls，provider 返回后才结算 tokens/USD；传输结果不明会把 reservation 保留为 unknown，缺少已要求的用量维度时不会把它当作免费调用。相同幂等键重复 reservation 会返回已有状态，PostgreSQL 模式用行锁保护跨进程并发，File 模式使用原子替换。全局账本覆盖 Run 主模型、Run 内 Tool/外部 Agent、Knowledge/项目源连接器、Competition/Debate 和 RSI evaluator，是局部 `modelBudget`、`externalBudget` 和协作预算之上的约束，不会替换这些更窄的业务账本。连接器有 provider usage 时按受信任回执中的 tokens/USD 结算；明确声明无计量的非计量 connector 才能按零 token/零 USD 结算，并始终消耗一个 call。响应 hash 会绑定 usage，失败、协议校验失败或结果不可信进入 unknown；作用域内 owner/operator 可通过 reconcile 提交最终用量，并必须附带 `source`、`reference` 和 `reason`，可选绑定账单或 provider evidence hash。账单系统可以按 `aeeis-billing-import/1` 批量提交 account/idempotency/usage/invoice evidence，AEEIS 会先做租户预检，再逐条幂等核查；超预算行会保留 invoice evidence 并返回 rejected，批次其余行仍可结算。供应商专用账单抓取和生产容量 SLA 仍需接入。

RSI 与协作 Trigger Pump 现在使用独立的持久化 Run 扫描位置，每轮固定 Run ID 上界、每批最多读取 25 个 Run，并保存 Run 内事件进度。RSI 默认每批检查 100 个事件（由 `AEEIS_RSI_PROPOSAL_BATCH` 控制），协作默认 500 个；单条处理失败会在下一轮重试，批次提交前崩溃会重放。两类 checkpoint 由 File 的 `AEEIS_RUN_SCAN_CURSOR_PATH` 或 PostgreSQL 的 `aeeis_run_scan_cursors` 保存，并以 CAS 防止旧进度覆盖新进度。Run/candidate/trigger 的事实源继续负责幂等，扫描完成不等于业务成功。巡检完成后重新扫一轮，因此新事件可能要等到后续巡检；File 仍枚举文件名、单个 Run 仍完整读取，未代表大规模容量验收完成。

## 当前 API

- `GET|POST /api/rooms`、`GET|PATCH /api/rooms/:id`、`GET /api/rooms/:id/goals`、`GET|POST /api/rooms/:id/members`、`DELETE /api/rooms/:id/members/:principalId`
- `GET /health`
- `GET /readyz`（依赖未就绪时返回 503，供部署和长时任务监控使用）
- `GET /metrics`（Prometheus 文本格式的运行、RSI、投影和依赖指标）
- `GET /api/status`
- `GET|POST /api/reminders`、`GET /api/reminders/page`、`GET /api/reminders/:id`、`POST /api/reminders/:id/cancel`、`POST /api/reminders/:id/retry`（owner/tenant scoped 的 durable Reminder；分页接口要求 `limit`，支持 `cursor` 和 `status`）
- `GET /api/knowledge/embedding-reindex`、`POST /api/knowledge/embedding-reindex`、`POST /api/knowledge/embedding-reindex/run`（PostgreSQL + embedding 配置下的 operator 回填任务：入队、查看状态、执行单批）
- `GET /api/brain/semantic-reindex`、`POST /api/brain/semantic-reindex`（PostgreSQL + Brain embedding 配置下的 operator 语义索引配置查看与全量重建）
- `GET /api/brain/:scope/export`（按当前 Principal 的 Brain grant 导出版本化 `aeeis-brain-bundle/1`，包含 claims、tenant/scope 元数据和内容 hash；导出会留下 Brain audit，不能跨租户读取）
- `POST /api/brain/:scope/import`（仅同一 owner/tenant/scope 可导入；校验 hash，幂等合并 claim，拒绝冲突和跨边界数据，不导入 grants）
- `GET /api/budgets/global`（配置 `AEEIS_GLOBAL_BUDGETS` 后查看当前 principal 对应的 durable account）
- `POST /api/budgets/global/reconcile`（owner/operator 用外部核查的最终 token/USD 用量解除指定 unknown reservation；请求还需提供 `reconciliation.source`、`reference`、`reason`，可选 `provider` 和 evidence hash；account scope 会再次校验）
- `POST /api/budgets/global/import`（owner/operator 按 `aeeis-billing-import/1` 批量导入 invoice 用量；先校验 account/tenant 和 reservation，再逐条幂等 reconcile，返回 `imported`/`rejected` 结果）
- `GET /api/agents`、`GET /api/agents/:id/audit`、`GET /api/agents/:id/reputation`、`POST /api/agents/:id/reputation/observations`、`POST /api/agents/discover`、`POST /api/agents/discover-url`、`POST /api/agents/:id/admit`、`POST /api/agents/:id/revoke`（安装 operator 专用）
- `GET /api/skills/proposals`、`POST /api/skills/proposals/:id/apply`、`POST /api/skills/:methodId/:version/rollback`（启用 OwnHow 后可用；apply 要求显式 `approvalRef`）
- `GET /api/runs`
- `GET /api/runs?limit=50`（可选有界最近记录读取；不传 `limit` 保持完整列表兼容）
- `GET /api/runs/:id`
- `GET /api/runs/:id/explanation`（owner/tenant scoped 的 `run-explanation/1` 只读解释投影：当前阻塞和下一步、计划进度、执行/证据计数、治理冻结与预算；不返回资料正文或模型 Prompt）
- `GET /api/runs/:id/events/stream?cursor=...&waitMs=30000&heartbeatMs=15000`（owner/tenant scoped SSE；事件以 `id`/`seq` 或标准 `Last-Event-ID` header 恢复，连接有界结束并发送 `timeout`）
- `POST /api/goals/:id/memories/from-run`（仅从同一 Goal 的 Run Evidence Graph 写回带 `evidenceRunId` 的 Memory）
- `POST /api/goals/:id/context-manifests`（创建冻结 Context Manifest；默认仅 owner，使用 `audienceMode: "room"` 或显式 `audience` 时冻结当时的 Room 成员快照）
- `GET /api/goals/:id/context-manifests/:manifestId`（按 owner/tenant/Goal 权限和 audience snapshot 读取；后来加入或已撤销的成员不能读取旧 Manifest）
- `POST /api/runs/:id/corrections`（把带证据引用的用户纠正转为受治理 RSI candidate）
- `GET /api/runs/:id/graphs` 返回独立的 `plan`、`planHistory`、`planComparisons`、`execution` 和 `evidence` 图；`planComparisons` 比较相邻计划版本的说明、任务增删、标题、instruction 和依赖，并保留 before/after 快照，供工作台和外部投影展示重规划影响。
- `POST /api/runs`
- `POST /api/runs/:id/approve|pause|resume|cancel|answer|retry|reconcile|reconcile-cancelled|replan|dispatch`（`replan` 会保留旧计划并生成新的版本；`reconcile-cancelled` 只核查取消后遗留的 Tool/Agent 调用，最终结果会计量但不会复活 Run）
- `POST /api/runs/:id/model-reconcile`（对 unknown 模型调用提交供应商核查结果；校验 callId、幂等键和输入 hash，不重复发起模型请求；取消中的结果只结算并丢弃，暂停中的结果保留暂停状态）
- `POST /api/goals/:id/schedule`、`POST /api/plans/:id/schedule`、`POST /api/plans/:planId/tasks/:taskId/schedule`（显式激活领域 DAG 调度）
- `GET /api/plans/:id/scheduler`、`POST /api/plans/:id/scheduler/reconcile`（查看或核查 durable dispatch reservation）
- `POST /api/plans/:planId/tasks/:taskId/control/:action`，其中 `action` 为 `dispatch|pause|resume|cancel|retry|reconcile`；控制绑定 Run，并通过同一领域 Receipt 链路更新 Task 状态，`unknown` 只能显式 reconcile
- `POST /internal/runs/:id/advance`（仅 Worker token）
- `GET /api/evolution/activation`
- `GET /api/evolution/candidates`
- `GET /api/evolution/candidates?limit=50`、`GET /api/goals?limit=50`、`GET /api/goals/page?limit=50&cursor=...`、`GET /api/goals/:id/plans/page?limit=50&cursor=...`、`GET /api/rooms?limit=50`（集合读取；Goal page 使用 `createdAt + id`、Plan page 使用 `version + id` 的 owner/tenant-scoped keyset cursor，旧列表接口保持兼容）
- `GET /api/evolution/candidates/:id`
- `POST /api/evolution/candidates`，以及 `/:id/evaluate|evaluate-suite|reconcile-evaluation|approve|start-shadow|run-shadow|record-shadow|start-canary|run-canary|record-canary|reconcile-rollout|promote|activate|start-traffic|update-traffic|pause-traffic|resume-traffic|stop-traffic|record-traffic|rollback`
- `POST /api/evolution/candidates/:id/activate`（仅已晋升的 `profile`/`prompt` 候选，要求 `activationRef`）
- 配置 `AEEIS_RSI_EVALUATOR_URL` 后，额外支持 `/:id/evaluate-suite`，按 replay、holdout、safety（以及可选 cost/shadow）套件逐门运行隔离 evaluator
- `GET|POST /api/collaborations/competitions`，以及 `/:id/candidate|begin-evaluation|score|reconcile-attempt|reconcile-evaluator`
- 配置静态 `AEEIS_COMPETITION_AGENT_MODELS`、`AEEIS_COMPETITION_EVALUATOR_BASE_URL`/`AEEIS_COMPETITION_EVALUATOR_MODEL`，或配置 `AEEIS_PLANPRICE_URL` 使用目录 resolver 后，额外支持 `POST /api/collaborations/competitions/:id/run`：候选模型隔离运行，独立评估器只接收盲化候选，participant/evaluator attempt 和结果持久化回 Competition；重启后通过 reconcile 继续，避免重复调用。
- `GET|POST /api/collaborations/debates`，以及 `/:id/message|close|run|reconcile-attempt`；配置内部模型池后，`run` 按轮次驱动 Debate 并在达到边界或形成 decision 时关闭房间。每条消息都会经过证据引用 Moderator policy，关闭时生成 `decided` 或 `held` 的 Adjudicator 结果；未知证据不会被默认为结论。设置 `AEEIS_DEBATE_MODERATOR_AGENT_ID` 和 `AEEIS_DEBATE_ADJUDICATOR_AGENT_ID` 可启用独立模型角色；模型结果会持久化，但不能绕过 policy 校验。角色调用进入 `started`/`unknown` 时，必须通过 `reconcile-attempt` 提供外部核查结果，不能自动重发。
- `POST /webhooks/feishu/events`（启用 `AEEIS_FEISHU_EVENT_ENCRYPT_KEY` 后的 Feishu Debate 入站）：校验 Lark/Feishu 签名、nonce、时间窗和可选 verification token，再按显式 `AEEIS_FEISHU_DEBATE_ROUTES` 与 sender identity 路由到 Debate。配置 `AEEIS_CHANNEL_IDENTITY_URL` 或本地开发用 `AEEIS_CHANNEL_IDENTITY_PATH` 后，resolver 会按 `channel + externalSubjectId + tenant` 解析稳定 Agent subject；它优先于兼容用的 `AEEIS_FEISHU_SENDER_AGENTS` 静态映射，未知、跨租户、非 Agent、暂停或撤销身份都会 fail closed。普通群文本会记录为无证据的 `clarification`；结构化 `debate-message/1` 仍要经过 Debate 的 contextVersion、参与者和 claim policy。消息保留原始发送者、身份快照和外部 event ID，并按确定性 message ID 幂等，群消息本身不获得 AEEIS 权限。接收成功后会把同一外部事件转换为带稳定 hash event ID 的 `external.message` Trigger Event；Trigger 失败会让 webhook 失败以便外部重试，重复投递不会重复创建协作资源。
- `POST /webhooks/hermes/events`（配置 `AEEIS_HERMES_SIGNING_KEYS` 后的 Hermes Debate bridge）：接收 `hermes-debate-event/1`，使用 `x-hermes-timestamp`、`x-hermes-nonce`、`x-hermes-key-id` 和 HMAC-SHA256 校验原始请求体，再按显式 `AEEIS_HERMES_DEBATE_ROUTES` 与 sender identity 路由到 Debate。Hermes 只提供传输；Channel Identity resolver 优先于兼容用的 `AEEIS_HERMES_SENDER_AGENTS`，Debate room 冻结的参与者、Context Pack、tenant 和证据策略仍是准入边界。消息和 `external.message` Trigger 都带 `hermes` provenance、稳定幂等 ID，外部消息不会获得 AEEIS 权限或新增 Evidence。协议、签名密钥轮换、群路由和 sender identity 配置见 `.env.example`。
- `POST /api/rooms/:roomId/context-manifests`、`GET /api/rooms/:roomId/context-manifests/:manifestId`：创建和读取 Room 级 Shared Session Context Manifest。它通过多个已经发布的 Goal Manifest 组合出单一、冻结的多 Goal 上下文，保存 `goalIds`、每个来源的 binding hash、完整 audience snapshot 和最小化的记忆/知识集合；所有来源 Goal 必须属于该 Room，且每个接收者必须仍能读取每个来源。Room owner/editor 才能创建，成员撤销、角色变化、Goal 脱离 Room 或来源内容变化都会使读取失效；非 owner 读取时仍按 internal 级别过滤。
- `GET|POST /api/rooms/:roomId/session-events`：Room 是 Shared Session 的协作边界，`session-event/1` 是独立的规范事件事实源。事件可以绑定同一 Goal 的 Context Manifest，也可以绑定 Room 级多 Goal Context Manifest（此时 `goalId` 省略）；事件保存 manifest binding hash、audience snapshot、actor、证据引用和幂等键。事件创建会校验 Goal 与 Room 的归属，禁止跨 Room 混用上下文。`canonical_response`、`decision` 等事件由 AEEIS 统一记录，外部 Debate/Feishu/Hermes 只是输入或投影。读取会重新验证 manifest、所有来源和当前 membership，后加入成员、撤销成员或变更角色不能读取旧的受限事件；File 使用 `AEEIS_SESSION_EVENTS_PATH`，PostgreSQL 使用共享数据库。事件是 append-only：`operation=revise` 通过 `targetEventId` 形成线性 revision，`operation=retract` 通过同一关系保存撤回原因；旧答复不会被删除或原地修改，投影可以据此显示修订/撤回。
- `POST /api/rooms/:roomId/session-events/:eventId/revise`、`POST /api/rooms/:roomId/session-events/:eventId/retract`：分别修订或撤回最新的 `canonical_response`。两者都需要当前 Room writer、原事件仍可读和幂等键；修订保留旧事件并递增 `revision`，撤回保留目标关系和理由，不能对撤回事件再次操作。
- `POST /webhooks/agents/:runId/callback`（外部异步 Agent 的签名 callback）：校验原始 body 的 `x-aeeis-timestamp` / `x-aeeis-signature`，通过 pending Delegation 的 Agent Card、Context Pack、Grant 和 Result Envelope 约束结果；成功只返回 `{ "accepted": true }`，不会把 Run 详情暴露给外部 Agent。
- `GET|POST /api/collaborations/projections`，以及 `/:id/deliver`、`/:id/reconcile`、`/deliver-pending`；投影 outbox 以幂等键持久化 Debate、Competition、Evolution、Goal、Plan、Task、Run 和 `session_event` 快照，服务 pump 会周期性从独立 canonical state 重发现 RSI/协作/Run 快照，传输结果不明会进入 `unknown`，只能通过 provider 核查恢复，配置 `AEEIS_PROJECTION_SINK_URL` 后可投递到飞书/Hermes/Linear/Jira 等渠道；也可配置 `AEEIS_FEISHU_WEBHOOK_URL` 使用内置飞书 Incoming Webhook 卡片适配器，或配置 `AEEIS_FEISHU_APP_ID`、`AEEIS_FEISHU_APP_SECRET` 使用飞书应用 API 按 `chat_id` 投影。设置 `AEEIS_FEISHU_ALLOWED_CHAT_IDS` 后，应用只能向明确允许的群发送。也可配置 `AEEIS_HERMES_CLI_PATH`，通过本机 Hermes 的 `hermes send --to TARGET --json` 契约投影到 `feishu:chat_id` 等 Hermes 目标；Hermes CLI 不复制凭证到 AEEIS，进程/传输不明会保留为 `unknown`。`RoutingProjectionSink` 按 channel 同时路由多个渠道，未知 channel 只有在配置通用 fallback 时才会投递。三种内置 channel sink 都拒绝私有内容，confidential 内容需显式允许；应用 API 使用短期 tenant access token 缓存和消息幂等 UUID。Task 投影的 aggregate ID 使用 `planId.taskId`；Shared Session 事件必须先经 `SessionEventService` 的实时 Room/Manifest 权限校验，再由 owner/operator 通过 Projection Outbox 显式投影，外部消息仍不能成为 canonical event。

运行状态和事件保存在 `data/runs`；设置 `DATABASE_URL` 可切换 Run、Room、Room membership、Goal、Plan、Receipt、Memory、Context Manifest、Brain、RSI candidate/activation registry、Competition/Debate 协作状态、Task dispatch ledger 和 Projection outbox 到 PostgreSQL，启动时会创建所需表和索引。Brain 使用版本化 JSONB 状态和乐观并发检测；并发写入不会静默覆盖，遇到冲突需要重新读取后重试。设置 `AEEIS_RUNNER=temporal` 后，API 会把 Run 调度到 Temporal，领域 Task Scheduler 为每个已确认的任务保存对应的 Run/Workflow ID，并通过同一 dispatcher 启动 `agentRunWorkflow`；Temporal 仍是执行平面，Plan/Task/Receipt 和 dispatch ledger 是 AEEIS 的事实源。Worker 使用 `npm run worker` 启动。Worker 支持稳定的 `AEEIS_BUILD_ID`、可选的 Temporal Worker Versioning、显式 `TEMPORAL_NAMESPACE`，以及 `AEEIS_WORKER_SHUTDOWN_GRACE_MS` / `AEEIS_WORKER_SHUTDOWN_FORCE_MS` 优雅退出配置。启用 Versioning 时，Worker 启动前会检查当前 Build ID 是否已注册；生产滚动发布必须通过 `AEEIS_TEMPORAL_BUILD_ID_ROLLOUT` 显式选择 `bootstrap`、`new-default`、`compatible` 或 `promote`，兼容发布还要提供 `AEEIS_TEMPORAL_COMPATIBLE_WITH`，不会静默把不兼容的 Worker 接到旧长时任务上。目标 Temporal namespace 必须启用对应的 Worker Versioning 能力；服务端未启用时 Worker 会在启动阶段明确失败。生产 Temporal 配置强制启用 Versioning。Worker health surface 默认在 `http://127.0.0.1:4324/health` 和 `/readyz`；设置 `AEEIS_TEMPORAL_WORKER_HEALTH_URL` 后，API 在 Temporal 模式下的 `/readyz` 会同时检查 Temporal gRPC health service 与 Worker `/readyz`，生产必须提供 HTTPS Worker health URL，避免只有 Temporal 集群存活而 Worker 没有轮询时仍接收长时任务。

HTTP API 默认保持本地单用户 `owner` 模式。开发环境可设置 `AEEIS_PRINCIPAL_TOKENS`，其值是“Bearer token → Principal”的 JSON 对象，例如 `{"alice-secret":{"id":"alice","tenantId":"team-a","roles":["owner"]}}`。组织部署可改用 OIDC：同时设置 `AEEIS_OIDC_ISSUER`、`AEEIS_OIDC_AUDIENCE` 和 `AEEIS_OIDC_JWKS_URL`，AEEIS 会只接受 RS256，校验 issuer、audience、exp/nbf、JWKS `kid`，并从配置的租户和角色 claims 构造 Principal；OIDC 不能和本地 token 映射同时启用。Goal、Plan、Memory、Context Manifest、Run、RSI candidate/activation、Competition、Debate 和 Projection event 会按 principal 过滤；owner 只能管理自己的租户，operator 可执行安装级运维。反向代理部署时用 `AEEIS_PUBLIC_HOSTS` 显式列出公开 Host，用 `AEEIS_TRUSTED_ORIGINS` 显式列出浏览器 Origin；`/internal/` Worker 端点仍只接受 `AEEIS_TRUSTED_HOSTS`，不会因为公开 Host 配置而暴露。用户交互授权、组织策略和密钥轮换仍由外部 OIDC 提供商负责。

设置 `AEEIS_PROJECTION_TARGETS` 可启用领域变更的 transactional outbox，例如 `[{"channel":"feishu","destination":"team-room","aggregateTypes":["room","task","plan"]}]`。支持的 aggregate type 包括 `room`、`goal`、`plan`、`task`、`run`、`evolution`、`competition`、`debate` 和 `session_event`。Task transition 会把 Goal/Plan/Task 投影意图和领域状态在同一次 domain commit 中持久化；Run、RSI 和协作状态由后台 pump 按版本 hash 重发现，再以包含目的地的幂等键写入 Projection Outbox。Session Event 作为独立事实源，通过显式 Projection API 写入 Outbox，不会伪装成 domain transaction；事件本身的读取仍经过实时 membership 和 Manifest 校验。进程重启后未 dispatch 的意图和当前快照都会继续恢复，外部投影仍需通过已有 sink delivery/reconcile 完成。

领域 Task 转移以一次存储提交更新 Plan、Goal 完成状态和 Receipt。并发分支按最新 Plan 快照重新校验，避免状态覆盖和缺失回执；JSON 存储限制单个活动写入者，PostgreSQL 使用行锁与事务。Plan 的 `version` 仍表示 DAG 版本，不作为执行状态的修订号。

创建 Run 时可以提供 `knowledgeQuery`、`knowledgeMaxItems`、`brainScope`、`brainQuery` 和 `brainMaxItems`。配置 Knowledge Provider 后，Runtime 会按 Run 的 privacy 级别检索知识，并把命中的记录作为带 hash 的来源交给 Planner、Executor 和 Reviewer；填写 `brainScope` 时，Runtime 会按 owner 授权读取对应 Brain claims、留下 read 审计并把 claim hash 作为来源；同时填写 `brainQuery` 会使用权限检查后的有界确定性检索，避免把整个长期 Brain scope 注入上下文；没有配置对应 Provider 时会明确失败。

Brain 的语义检索是可选的派生能力。配置 `AEEIS_BRAIN_EMBEDDING_URL` 且使用 PostgreSQL 时，AEEIS 会在 `aeeis_brain_embeddings` 中维护按 embedding model 绑定的 pgvector 侧索引；Brain 的版本化 JSONB 状态、撤回历史和审计仍是唯一事实源，索引可以丢弃后从 claims 重建。语义服务只返回候选 claim ID，Runtime 会再次按 owner/tenant、grant、classification 和 active 状态校验；embedding 服务或 pgvector 暂不可用时自动回退确定性词法检索，不阻断 Brain 写入或 Run 创建。embedding 服务恢复后，operator 可调用 `GET /api/brain/semantic-reindex` 查看索引配置，并用 `POST /api/brain/semantic-reindex` 按当前 canonical claims 重建派生索引；该操作不会改变 Brain 版本或审计记录。

RSI candidate API 只管理有证据的变更候选：低风险候选可以在 `proposed → evaluating → approved → promoted` 后显式晋升；中高风险候选必须经过 `approved → shadowing → canarying → promoted`，每个阶段都要记录带证据的观察，失败会进入 `held` 并可回滚。Run 的 `/corrections` 入口会校验纠正引用是否来自该 Run 的真实上下文、产物、Receipt 或模型调用，再创建绑定 correction 引用的 candidate。默认必须分别通过 replay、holdout、safety 三道评测门。晋升后仍需用 activation reference 激活；`profile`/`prompt` 作为文本补充，`skill`、`workflow`、`tool-policy` 和 `model-policy` 必须先通过各自的 typed JSON schema，激活版本在新 Run 创建时冻结；workflow policy 会约束模型调用和计划节点预算，tool/model policy 会在能力审批和模型选择处执行。回滚会撤销激活候选并恢复父版本，旧 Run 不受影响。

配置隔离 evaluator 后，`run-shadow` 和 `run-canary` 接收 `{ "cases": [{ "id": "case.1", "input": {} }] }`，每批最多 100 项，逐项预留 attempt、调用并落盘；遇到失败或无有效证据即停止批次。case ID 在同一候选阶段内不可重复。attempt 保留输入 hash、时间和观察结果，调用中断后的 `started` 记录会阻止新调用和阶段晋升。`reconcile-rollout` 接收 `attemptId`、`outcome`（`completed` 或 `failed`）、必填 `reason`；完成结果还必须提供 `passed`、`score` 和 `evidenceRefs`。该入口记录操作者核查结论，不重新调用 evaluator。这里的 canary 是隔离评测模式。

晋升后的候选还可以进入独立的生产流量 canary：`POST /api/evolution/candidates/:id/start-traffic` 创建按 tenant 隔离的 durable route，`percentage` 使用 1–9999 basis points，10000 保留给全量 activation；每个新 Run 使用稳定 Run ID 做哈希分桶，并把 route、percentage、bucket 和命中结果冻结到 Run。`update-traffic` 调整比例，`pause-traffic` / `resume-traffic` 控制暂停和恢复，`stop-traffic` 停止并保存原因；`record-traffic` 接收带唯一 ID、分数、通过状态和 evidenceRefs 的线上观察，重复观察会被拒绝并持久化在 route 上。启动时可传 `safety: { minScore, maxFailedObservations, autoPause }`，达到失败阈值会在同一持久化事务中自动暂停 route，默认首个 `passed=false` 观察即暂停；人工核查后才能恢复或回滚。`GET /api/evolution/traffic` 和 Run 详情可审计当前 route。route 保存候选内容 hash，候选、基线或激活版本发生漂移时拒绝路由；全量激活、回滚或撤销受影响版本时会自动停止 route。AEEIS 负责版本选择和审计，模型 provider 的物理部署、反向代理和真实生产指标仍由外部部署系统负责。

竞争 API 把候选结果和独立评测拆成两个阶段，并持久化成本、评分、选定候选和 `partial` 状态；评测者不能是参赛 Agent。启用 `blindEvaluation` 时，评测视图只暴露 `candidate_1` 这类匿名键，最终映射只保存在 AEEIS 状态中。Participant 和 evaluator 都有带 input hash、状态和结果的 durable attempt；服务重启后不会重复调用，必须通过 `reconcile-attempt` 或 `reconcile-evaluator` 明确恢复。Debate API 持久化房间和消息，强制参与者、轮次、单 Agent 消息数、总消息数和上下文版本边界。新增 Collaboration Trigger Policy：owner 可通过 `/api/collaborations/triggers/policies` 按事件类型、来源、风险下限、审核置信度上限和 required diversity 配置 Competition/Debate，动作的 `dispatch` 可选 `create` 或 `run`；`POST /api/collaborations/triggers/evaluate` 接收带 owner/tenant、上下文版本和 evidence refs 的事件，`/internal/collaborations/triggers/evaluate` 供 Worker、Feishu/Hermes bridge 使用；Run 内部的任务完成、失败和 review 事件会由可重放的 Trigger Pump 自动转成同一协议事件，并用 Run 的 `allowedAgents` 限制协作参与者；`GET /api/collaborations/triggers/decisions` 查看耐久决策，`POST /api/collaborations/triggers/decisions/:id/reconcile` 支持 `resource_created`、`failed`、`dispatch_completed`、`dispatch_failed` 四种显式恢复。策略与 policy/event 决策以 File 或 PostgreSQL 持久化，重复事件只返回原 resource，跨租户事件会被拒绝；`run` 会复用现有模型池、Attempt、预算和 unknown/reconcile 边界，模型池未配置或派发结果不明时会把 `dispatchState` 留在 durable decision 中。Projection outbox 只发送带 hash 和幂等键的结构化快照，渠道投递失败会保留 failed 状态并可重试；PostgreSQL outbox 在外部 sink 调用期间持有跨进程 advisory lock，多个 pump 不会重复发送同一事件，进程崩溃后连接释放锁并由恢复流程继续处理；渠道消息不是 canonical 状态。

## 设计边界

AEEIS 自己持有 Goal、Plan Graph、Execution Graph、Evidence Graph、权限、Context Manifest、Receipt 和 RSI Candidate 的语义。Temporal 只负责耐久执行；toolkit_new 提供工具能力；ownhow 提供 Skill 治理；planprice 提供模型目录和价格数据。所有外部结果先经过版本、授权、证据和 Receipt 校验。

RSI 提案发现会从失败、低置信度审核和纠正事件中生成带 Evidence refs 的改进信号。若开启 `AEEIS_RSI_PROPOSAL_SYNTHESIS_ENABLED=1`，它可以为没有具体变更的信号额外发起一次受单独 calls/token 预算约束的模型调用；模型只能返回最小变更或 `null`，不能评测、审批、晋升、激活或授予权限。每次调用会冻结模型 Pin、输入 hash、证据 ID、版本和幂等键。供应商超时或连接中断会进入 `unknown`，服务重启后不会自动重发，必须使用 `POST /api/runs/:id/rsi-proposal-synthesis-reconcile` 提交同一 attempt 的核查结果、usage 和审计引用；迟到的供应商响应也不能覆盖已核查事件。若全局账本配置了 `moneyUsd`，请使用 Planprice 提供的 USD 价格，固定模型可设置 `AEEIS_RSI_PROPOSAL_SYNTHESIS_PRICES`，动态目录路由必须使用所选模型的目录价格；没有可验证价格时不会发送调用。提案器默认关闭，启用后默认只允许 `public,internal`，每个 Run 最多 1 次调用、16000 tokens，可用 `AEEIS_RSI_PROPOSAL_SYNTHESIS_MAX_CALLS` / `MAX_TOKENS` 调整。token 阈值根据返回的实际 usage 停止后续调用，单次请求可能超额；缺报或超额不会发布候选。生产环境应按数据分类缩小范围。工作台“RSI 改进机会”展示调用和核查入口，具体核查回执见[运维手册](docs/operations/runbook.md#rsi-提案调用核查)。真实模型的改进质量仍需单独评测。

- [设计基线](docs/design/2026-09-18-aeeis-design-baseline.md)
- [Agent 协议与领域模型](docs/design/2026-09-18-agent-protocol-domain-model.md)
- [任务 DAG 与 Temporal](docs/design/2026-09-18-task-dag-temporal-design.md)
- [多 Agent 与开放世界](docs/design/2026-09-18-multi-agent-open-world-design.md)
- [外部项目接口契约](docs/design/2026-09-18-external-project-contracts.md)
- [商业化、社区与开源](docs/design/2026-09-18-commercial-community-open-source-strategy.md)
- [当前实现状态](docs/implementation-status.md)

## 安全与数据边界

模型来源资料被当作不可信数据处理。外部 Agent 默认只能收到最小化 Context Pack，只能返回候选 Result Envelope，不能直接写 Brain、修改任务或代表 AEEIS 发言。个人 Brain、客户任务、凭证和未经脱敏的运行日志不能提交到公开仓库。

## 开源方向

项目采用协议优先、逐步开放核心运行时的 Open Core 路线。协议 schema、Receipt、导出格式、本地运行器、评测工具和 Connector SDK 适合开放；托管控制面、企业治理、托管连接器和高级运营能力可以商业化。

## 贡献

协议、权限、任务状态、证据和进化变更请先提交 RFC 或 Issue，并说明兼容性、安全边界、评测方式和回滚策略。

- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [行为准则](CODE_OF_CONDUCT.md)
- [运维手册](docs/operations/runbook.md)
- [部署方案](docs/operations/deployment-architecture.md)
- [2000 元/年采购单与上机清单](docs/operations/2000-yuan-procurement-order.md)

## License

Apache-2.0。产品名称和商标归其所有者所有。
