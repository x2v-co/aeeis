# 2026-09-22 增量：完整本地协议栈与 PostgreSQL 事务复验

`AEEIS_FULL_DEMO_DATA_DIR=/tmp/aeeis-full-local-final npm run demo:full-local` 已实际启动 Fixture Model、Planprice、OwnHow CLI、RSI Evaluator、HTTP 外部 Agent 和 AEEIS；状态确认 `modelRouting=catalog`、Skill governance、RSI evaluator、Agent Gateway 全部启用，随后完整本地 smoke 验证了 Run/DAG、Competition、Debate、外部 Agent、Project Pulse 和 RSI Canary/activation，Goal 收敛为 `completed`。该运行结束后已回收所有夹具进程。

本轮另外用本机 PostgreSQL 17 临时实例（仅监听 `127.0.0.1:55433`，测试结束自动停止）执行 `AEEIS_TEST_DATABASE_URL=postgresql://127.0.0.1:55433/postgres npm run test:postgres`：24 个 PostgreSQL 测试文件、68 个测试全部通过，包含 Session Event、Task Scheduler recovery、Run fencing、Projection、RSI、Knowledge、Room membership 和 changefeed；额外的 Session Event 定向回归验证了两个并发线性 revision 只有一个获准，以及获胜幂等键可回放。该证据验证真实 PostgreSQL 事务边界可运行；生产容量、跨区域恢复和真实外部依赖仍需部署侧验收。

# 2026-09-22 增量：Shared Session 工作台修订与撤回操作

Room 时间线现在会显示规范答复的 operation、revision、目标事件和撤回原因；当前可读且处于最新版本线上的 `canonical_response` 可以直接在工作台发起修订或撤回。操作继续调用已有的 append-only HTTP API，使用一次性幂等键，旧事件不会被原地修改或删除；历史版本在时间线中保留。修订/撤回的最新版本检查已经下沉到 InMemory、JSON 和 PostgreSQL repository 的序列化边界，两个并发请求最多一个能追加同一目标的子事件；同一幂等键重试会回放原事件，不会被线性检查误拒绝；普通 decision/message 不能伪装成 canonical response 撤回。TypeScript 检查、构建以及 Session Event/HTTP 回归通过。

# 2026-09-22 增量：Feishu Debate 入站的参与者准入边界

Feishu/Hermes Debate 入站事件现在携带 Debate room 冻结的 `allowedAgentIds` 和真实 Context classification/claims/artifactRefs/redactions；外部群消息仍只追加不可信输入的 redaction，不产生新证据。Trigger Policy 在评估时因此不能把群消息扩散到未加入该 Debate 的 Agent。新增越权参与者拒绝回归，并通过 Feishu ingress、Trigger 定向测试、typecheck、build 和 diff check。

# 2026-09-22 增量：多渠道 Projection 路由

Projection 由单一 sink 改为 `RoutingProjectionSink`：专用 Feishu、Hermes CLI 和通用 HTTP sink 可以并存，按 `ProjectionEvent.channel` 选择边界，未配置专用路由时才使用显式通用 fallback；没有匹配路由的事件会明确失败，不会被投递到任意默认渠道。路由复用各 sink 的隐私策略、幂等键和 unknown/reconcile 行为，健康检查聚合各已配置 sink。新增多渠道路由回归，typecheck、build 和 Projection 定向测试通过。

# 2026-09-22 增量：Brain Bundle 导出边界

新增 `GET /api/brain/:scope/export`，按当前 Principal 的 owner/tenant/grant 权限导出版本化 `aeeis-brain-bundle/1`，包含该 scope 的完整 claim history（包括 retracted claim）、scope/tenant 元数据和内容 hash；调用沿用 Brain 的 `export` audit，不会通过导出接口获得跨租户或外部 Agent 写入权限。导出用于用户迁移和审查，恢复仍依赖校验过的持久化备份或受治理 Bundle 导入流程。HTTP Brain 回归已覆盖 Bundle 内容和 hash。

# 2026-09-22 增量：Brain Bundle 受治理导入

新增 `POST /api/brain/:scope/import`，校验 `aeeis-brain-bundle/1` 的 schema、owner/tenant/scope 和 claims 内容 hash；只允许同一 owner 在同一 scope 做幂等合并，重复 claim 按 ID 跳过，内容冲突、篡改 hash 和跨边界 claim 返回拒绝。导入不携带 grant 或源端 audit，不覆盖本地 canonical history；每次导入留下本地 `import` audit，向量索引仍由独立 reindex 维护。HTTP 回归覆盖删除后恢复、重复导入和 hash 篡改，Brain 定向测试、typecheck 和 build 已通过。

# 2026-09-22 增量：Shared Context audience snapshot

Context Manifest 新增版本化 `context-audience/1` snapshot。默认只冻结 Goal owner；`audienceMode: "room"` 或显式 audience 会在创建时读取同一 Room 的活跃成员、角色、membership ID 和更新时间并写入 digest。后加入成员不能读取旧 Manifest，撤销、角色变化或 Room 变化会使后续读取失效；共享上下文自动限制为 internal 及以下，并要求知识记录对所有 audience 都通过 ACL。新增 service、memory 和 HTTP 回归，typecheck、build 已通过；snapshot 是审计和上下文边界，不能替代实时 ACL。

# 2026-09-22 增量：Hermes 本地 CLI 出站投影适配器

新增 `HermesCliProjectionSink`，接入 Hermes 已有的 `hermes send --to TARGET --json MESSAGE` side-effect-only 契约。AEEIS 不复制 Hermes 平台凭证，目标使用 `platform:channel[:thread]`，投影消息只包含受控状态摘要；private 始终拒绝，confidential 需要显式允许。成功回执保存 Hermes message id（缺失时回退到 AEEIS 幂等键）；CLI 超时、进程终止、delivery error 或无效 JSON 都进入 `ProjectionOutcomeUnknown`，不能自动重发。`hermes send --list --json` 只用于本地 CLI readiness probe，不冒充平台 SLA。配置、README、开放世界设计、Projection 单测和启动选择均已同步，定向 42 tests、typecheck 已通过；真实 Hermes 平台权限、凭证轮换、群路由和通知 SLA 仍需部署验收。

# 2026-09-22 增量：Temporal Run 唤醒的 signal/start 竞态

`TemporalDispatcher.notify()` 原先在“先 signal、再 start”的窗口里可能与另一个 API 进程同时启动同一 Run Workflow；如果本进程看到 NotFound，另一进程随后成功启动，原实现会把 `AlreadyStarted` 直接当成派发失败。新增 `notifyTemporalRunWorkflow()`：在启动竞争获胜后再次 signal，若 Workflow 已在此期间完成则安全收敛到 durable Run 状态；不创建第二个 Workflow。新增 4 个竞态回归；dispatcher 定向测试、typecheck、build、diff check 和 `npm run smoke:local:restart` 均通过。

# 2026-09-22 增量：API 关闭时停止后台扫描与本地进程树回收

修复本地重启 smoke 在 API 进程收到终止信号后仍遗留 `npm/tsx` 子进程的问题。smoke 现在为 Fixture Model 和 AEEIS 分配独立 POSIX process group，停止时回收整个进程树；AEEIS 服务关闭时先标记 closing、停止 interval、解除 Run change notification，再等待已在途的 projection、scheduler、knowledge、reminder、RSI/协作 Pump，避免临时 File 数据目录删除后仍有后台扫描读取已消失的 Run。`npm run smoke:local:restart` 实跑通过，退出阶段不再出现 `Unknown run`；`npm run typecheck`、`npm run build` 和 `git diff --check` 通过。

# 2026-09-22 增量：本地 DAG smoke 处理 queued reservation 窗口

完整本地协议栈曾在调度器返回 durable `queued` reservation、Run 仍在 create lease 窗口内时，过早读取 `/api/runs/:id` 并把暂时的 404 误报为失败。`scripts/smoke-local.mjs` 现在只对已由调度器返回的可信 Run ID 重试这个窄窗口，权限错误和其它 HTTP 错误仍立即失败；两次独立临时数据目录的 `npm run demo:full-local` 均完成 catalog routing、OwnHow、RSI evaluator、Agent Gateway、两节点 DAG、Reviewer 和 Goal completed 闭环。该修复只改变验收脚本的等待策略，不放宽 API 权限或 Run 状态机。

# 2026-09-22 增量：隔离 PostgreSQL 回归复验

使用本机 PostgreSQL 17 临时实例（仅监听 `127.0.0.1`，测试结束后停止）运行 `AEEIS_TEST_DATABASE_URL=... npm run test:postgres`，23 个 PostgreSQL 测试文件、67 个测试全部通过，包含跨连接 Task Scheduler recovery lease/create recovery、Run execution fencing、全局预算、Agent Registry、Knowledge、Projection、Room membership、Project Source checkpoint、RSI proposal claims、Trigger claim 和 Run changefeed。该结果证明当前事务契约在本地 PostgreSQL 17 上可运行；生产容量、备份存储、真实外部依赖和正式故障演练仍需部署侧验收。

# 2026-09-22 增量：长历史兼容接口的耐久性回归边界

`GET /api/runs` 在未传 `limit` 时继续保留完整历史兼容语义。对应 HTTP 回归会创建 205 条带 `fsync` 的 File Run，并在共享 Room 成员视角验证全部记录可见；全量 Vitest 并行执行时，测试边界调整为 30 秒，以覆盖持久化写入与其它耐久性测试共享磁盘的情况，不改变 API 或存储语义。本轮最终回归为 71 个测试文件、598 个测试通过、65 个跳过；`npm run typecheck`、`npm run build` 和 `git diff --check` 通过。

# 2026-09-22 增量：Task Scheduler 创建租约恢复边界

Task Scheduler 的 reservation 与 Run 创建之间新增短期 `createLease` fencing。reservation 同时冻结创建请求（包含任务级输入、预算、隐私和资料），恢复泵看到仍在有效租约中的 queued reservation 时会暂停探测和重建，避免在原创建者尚未完成上下文准备时用另一组输入创建同一确定性 Run；租约过期后，恢复者会先读取原 Run，若 Run 已落盘则直接采用并 reconcile，只有确认不存在才按冻结请求补建。调度器会在通知执行器前再次确认自己仍持有租约，HTTP 调度响应会剥离创建请求和租约 token，避免内部恢复数据泄露。这样覆盖了“Run 已创建、ledger 尚未确认”和“原创建者在窗口内退出”两类恢复路径，同时兼容旧的无租约 dispatch record。新增 File/InMemory 并发租约、过期 Run 采用、输入恢复和 HTTP 脱敏测试；`tests/task-scheduler.test.ts` 23 个、HTTP 相关定向测试 79 个通过，typecheck、build 和 diff check 已通过；本次完整本地回归为 71 个测试文件、598 个通过、65 个跳过。

# 2026-09-22 增量：全量回归下的领域存储测试稳定性

`tests/runtime.test.ts` 中同时创建多个 Goal Run、写入 JSON Domain journal 并推进两套 Plan 的场景，在全量并发回归时曾因默认 5 秒测试预算偶发超时。测试现在显式关闭 `JsonFileStore`，并为这条包含多次 fsync 的持久化恢复场景设置 15 秒边界；运行时语义没有放宽。定向测试、`npm test`（71 个测试文件、592 个通过、65 个跳过）、`npm run typecheck`、`npm run build` 和 `git diff --check` 均通过。

# 2026-09-22 增量：完整本地协议栈演示

新增 `npm run demo:full-local`（`scripts/demo-full-local.mjs`）。它不依赖 Docker，使用动态临时端口启动 Fixture Model、Planprice、OwnHow CLI、RSI Evaluator、HTTP 外部 Agent 和 AEEIS；AEEIS 强制走 catalog model routing、LocalDispatcher，并启用 Skill governance、RSI evaluator、Agent Gateway、Project Source 和协作模型池。脚本会校验各依赖健康协议与 AEEIS `/readyz`，确认 `/api/status` 的完整开发能力后自动运行一次 `smoke:full-local`；本轮实际验证通过，Run/DAG、Competition、Debate、外部 Agent、Project Pulse 和 RSI 闭环均成功。Fixture 仍只证明协议和状态边界，真实模型、Agent、凭证、网络和 SLA 仍需部署侧验收。

# 2026-09-22 增量：Temporal 业务等待状态改为 signal-driven

验证入口与生产发布边界已汇总到 [验证矩阵](verification-matrix.md)，用于区分 Fixture/本地证据和真实外部依赖验收。

本地独立启动 `fixture-planprice.mjs` 后，`npm run smoke:planprice` 已实际通过 PlanpriceHttpCatalog 健康探针、grouped LLM 目录、汇率归一、provider/model 选择和稳定 `catalogHash`；把 `AEEIS_BASE_URL` 指向当前 pinned 本地 AEEIS 会按预期拒绝，因为该实例没有配置 catalog routing。真实 Planprice 目录与 provider 仍需部署侧验收。

`agentRunWorkflow` 在 Activity 返回 `needs_approval`、`needs_input`、`waiting_external`、`unknown`、`failed` 或其他非执行状态后，不再每 30 秒轮询一次 AEEIS API，而是无限期等待对应的 `wake` Signal；审批、provider reconcile、外部 callback、retry 或 operator 控制会通过原有确定性 Workflow ID 唤醒它。这样长时 Run 的业务等待不会持续制造无效 Activity，也不会因为 polling 间隔隐藏状态变化；传输失败仍按 Activity retry policy 处理，Workflow history 仍按 100 个 tick Continue-As-New。

新增 Temporal workflow 回归覆盖“needs_approval 不轮询、收到 wake 后继续”，定向 11 个测试通过；随后完整本地回归为 71 个测试文件、592 个测试通过、65 个跳过，typecheck、build 和 diff check 通过。Temporal 生产 Worker/namespace 和真实 history replay 仍需部署侧验收。

# 2026-09-22 增量：一键本地演示入口

新增 `npm run demo:local`，由 `scripts/demo-local.mjs` 同时启动 Fixture Model 和 AEEIS，等待 `/health` 与 `/readyz` 就绪后输出工作台地址；演示默认使用独立的 `data/demo-local`，不会覆盖默认 `data/runs`，数据目录只能通过显式的 `AEEIS_DEMO_DATA_DIR` 覆盖；脚本还主动隔离 `DATABASE_URL`、Temporal、凭证和其他外部 `AEEIS_*` 配置，强制使用 development + File store；退出时会同时停止两个进程。该入口已用独立端口完成实际启动、`/readyz`、`/api/status` 和工作台 HTML 验收。Fixture Model 仍只用于协议和状态机演示，不代表真实模型能力。

后续补强：演示入口现在会校验 `aeeis-health/1`、`aeeis-readiness/1`、`/api/status` 的 Fixture profile/LocalDispatcher/Fixture Model，以及 Fixture Model 的开发健康响应；只返回 200 的 Temporal Worker、生产 AEEIS 或其他服务不会被误判为演示环境。重复运行时仅复用真正健康的同端口服务；脚本自己启动的子进程才会在退出时停止。该行为已用已有 Worker 占用 API 端口和独立端口的真实启动场景验证。

Compose smoke 入口同步校验 AEEIS API、AEEIS readiness 和 Temporal Worker readiness 的协议身份；目标地址指向本地演示或错误服务时会在业务操作前失败，并给出 `AEEIS_BASE_URL` 提示，避免把错误环境的失败结果误读为 Compose 回归。Compose 容器 healthcheck 也要求对应的 readiness protocol、状态和 Worker `RUNNING`，静态 `docker compose config` 已通过；完整容器 smoke 仍等待 Docker daemon 恢复后执行。

本地运行中的 Fixture AEEIS 已实际完成一次完整 Run：创建 Run → 精确计划审批 → DAG 执行 → 两个产物 → 独立审核 `accepted` → `succeeded`；`GET /api/runs/:id/graphs` 返回 2 个 Plan 节点、7 个 Execution 节点、8 个 Evidence 节点和 4 条 Evidence 边。该结果证明本地运行闭环，不代表真实模型或生产依赖质量。

新增 `npm run smoke:local`，对正在运行的 Fixture/LocalDispatcher 实例校验 `aeeis-health/1`、`aeeis-readiness/1`、精确计划审批、审核 `accepted`、产物和 Evidence Graph，并创建领域两节点 DAG，验证第一任务完成后自动解锁第二任务、两个 Run 均成功且 Goal 收敛为 `completed`；该命令不启动服务、不接触生产配置，适合作为本地演示后的快速验收。当前实跑输出为单 Run 2 个产物、8 个 Evidence 节点，以及 DAG 两个任务均 `succeeded`。

新增 `npm run smoke:local:restart`，启动隔离的 Fixture Model 与 AEEIS，在 Run 进入 `needs_approval` 后停止并重启 API，复用同一临时 File 数据目录，校验计划 hash、审批状态和最终审核结果均可恢复；该命令结束时清理临时进程和目录，用于验证本地持久化重启边界，不替代 Temporal 集群恢复和生产故障演练。

# 2026-09-22 增量：文件式部署密钥注入

新增 `src/config-secrets.ts`，在 `validateRuntimeConfig()` 和打开持久化存储之前读取受限的 `<NAME>_FILE` 配置。`AEEIS_*`、`TEMPORAL_*` 与 `DATABASE_URL` 支持 Docker/Kubernetes secret 文件；直接值与文件值同时存在、文件不可读、目录、空值或 NUL 字节都会 fail closed。新增 3 个配置测试（与启动配置 32 个回归一起通过），并更新 `.env.example`、README 和运维实现状态。该机制只负责把文件安全地转换为进程配置，生产密钥权限、轮换和外部 Secret Manager 仍需部署侧验收。

# 2026-09-22 增量：Agent Registry 规范化 PostgreSQL 存储

PostgreSQL Agent Registry 从单行 JSONB 的完整状态重写改为四类规范化表：Agent 生命周期条目、审计事件、声誉聚合和声誉观察。条目按稳定插入位置保存，审计和观察使用数据库序列保留原有顺序；`entriesSnapshot(limit)`、`auditSnapshot(agentId)` 和 `reputationSnapshot(agentId)` 现在在 PostgreSQL 内按范围过滤、排序和读取，应用层不会为一个 Agent Registry 解析整个审计历史。旧的 `aeeis_agent_registry` 行仍作为兼容镜像保留，启动迁移会在 advisory migration lock 内把旧 JSONB 状态一次性导入新表，后续事务同时更新规范化表和镜像，备份及回滚兼容性保持不变。

新增覆盖旧单行状态迁移、早期规范化 schema 的序列列升级、跨连接并发 reputation 写入、重启恢复、窗口外损坏记录不影响 bounded read，以及 schema 不完整时 readiness fail-closed 的 PostgreSQL 回归；本机 PostgreSQL 17 定向测试 9 个通过，随后 23 个 PostgreSQL 测试文件、67 个测试全部通过；完整本地回归为 70 个文件、589 个测试通过、65 个跳过，typecheck、build 和 diff check 通过。Registry mutation 现在在同一 advisory-locked 事务内对生命周期、审计和声誉表做增量 upsert/delete，并同步旧镜像；旧镜像本身仍是单行 JSONB，因此其兼容写入成本仍随状态增长。生产迁移、容量压测和真实备份升级仍需部署侧验收。

# 2026-09-22 增量：Planprice 目录与 provider 健康边界

`ModelCatalog` 新增可选只读 `health()`；`PlanpriceHttpCatalog` 支持同源、无凭证参数的
`AEEIS_PLANPRICE_HEALTH_URL`，只执行有界 GET、拒绝重定向，不调用模型、不刷新目录，也不进入
价格写入路径。`CatalogModelResolver.health()` 现在区分目录探针/读取失败、目录可达但没有满足
策略的模型，以及已选 provider 的健康失败，并在模型健康结果中保留 `catalog` / `provider`
子结果。`/readyz` 仍把模型作为 required dependency，`/api/status.modelHealth` 提供可诊断细节。
新增 Planprice health HTTP、重定向、目录/provider 故障区分、HTTP status 可见性和配置校验回归；
定向 4 个测试文件 104 个测试通过，完整本地回归为 70 个文件、589 个测试通过、65 个跳过；
typecheck、build 和 diff check 通过。真实 Planprice SLA、目录质量和供应商调用仍需部署验收。

# 2026-09-22 增量：隔离 PostgreSQL 全量回归

Docker Desktop backend 当前不可用，因此本轮使用本机 PostgreSQL 17 启动只监听
`127.0.0.1` 的临时测试数据库，运行 `npm run test:postgres` 后立即停止并删除临时集群。
23 个 PostgreSQL 测试文件、67 个测试全部通过，覆盖领域事务、Run 重连恢复、Agent
execution fencing、全局预算、RSI proposal claims/evolution、Projection、Knowledge、Room
membership、Task Scheduler、Agent Registry/Ledger、Project Source checkpoint、Run changefeed
和 bounded collection storage。该结果证明当前 schema/事务契约在 PostgreSQL 17 上可运行；Docker
Compose 全栈 smoke、生产数据库容量、备份上传和真实外部依赖仍需部署侧验收。

同轮在本机 PostgreSQL 17 上完成备份恢复演练：AEEIS 先初始化 27 张事实/投影表，
`npm run backup:postgres` 生成 46,585 字节 custom-format 归档和 SHA-256 manifest，
`npm run backup:verify` 校验归档可读；`npm run backup:restore` 在隔离数据库恢复并检查
关键表，随后 `npm run recovery:postgres` 在恢复库上启动 Fixture Model + AEEIS，
`/readyz` 返回 `ready`，最后自动删除恢复库。演练没有触碰源数据库；恢复后真实业务数据量、
备份存储权限、跨区域恢复和 Temporal history 恢复仍需生产演练。

同时修复 `scripts/test-monitoring.mjs` 的 Docker 调用边界：每个 `promtool`/Compose
校验现在有 `AEEIS_DOCKER_COMMAND_TIMEOUT_MS`（默认 15 秒）上限，daemon 不可达时快速
返回带命令和超时信息的失败，不再无限挂起 CI 或本地运维检查。当前机器 Docker backend
仍不可达，因此本轮只能验证超时失败路径；Prometheus 配置和告警规则的真实 promtool
校验需在 Docker 恢复后执行。

# 2026-09-22 增量：Brain 语义索引健康与 embedding 计费边界

Brain embedding provider 新增可选只读 `health()`；HTTP embedding 通过同源 `AEEIS_BRAIN_EMBEDDING_HEALTH_URL` 执行有界 GET，复用 Bearer token、拒绝重定向并拒绝 query/fragment。PostgreSQL Brain semantic index 的 health 同时检查索引表和 embedding health endpoint；失败只影响 optional semantic search，Brain canonical claim 写入和 lexical fallback 不受阻断。`/readyz` 增加 `brainSemanticIndex` optional check，`/api/status` 暴露 `brainSemanticIndexHealth`，工作台把 pgvector 配置和实际健康状态分开显示。新增 HTTP embedding、配置、readiness、PostgreSQL semantic health 回归；5 个测试文件 104 个定向测试通过，typecheck、build 和 diff check 通过。真实 embedding 服务质量、pgvector 容量和生产 SLA 仍需部署验收。

# 2026-09-21 增量：Temporal API readiness 纳入 Worker polling 状态

Temporal dispatcher 现在可通过 `AEEIS_TEMPORAL_WORKER_HEALTH_URL` 检查 Worker `/readyz`，并与 Temporal gRPC health 一起决定 API 的 required dispatcher readiness。只有 Temporal 可达但 Worker 未进入 `RUNNING` 时，API 不会把长时任务入口报告为 ready；探针只读、拒绝重定向、有界超时且不调用 Activity。生产 Temporal 配置要求 HTTPS Worker health URL，Compose 使用 `service_started` 启动顺序避免 API↔Worker 健康检查死锁；`AEEIS_TEMPORAL_WORKER_HEALTH_ALLOW_INSECURE_HTTP` 也严格限制为 `0/1`。新增 Worker 可达/停止和配置开关回归，Temporal/config validation 专项 35 个测试、build 和 diff check 通过。该边界仍不替代生产 Worker 容量、任务队列延迟和故障注入验收。

# 2026-09-21 增量：模型恢复保持 Provider 与完整 Pin 身份

修复 CatalogModelResolver 的缓存身份遗漏 provider 的问题：相同网关、模型名和 promptVersion 下，不同 provider 现在使用独立缓存和凭证。`forPin` 对缓存命中和重建结果都验证完整 Pin，不再向直接调用 resolver 的 RSI 提案链路返回不同版本的适配器；主 Runtime 原有的二次校验继续保留。重建不重新读取模型目录，不匹配的结果不会进入缓存。新增真实 HTTP 回归覆盖共享网关的凭证隔离、resolver 重建和不重新选模，并覆盖 model/endpoint/provider/promptVersion 变化的拒绝与配置恢复。模型路由、主 Runtime、RSI 提案、协作模型池和 Planprice 共 5 个测试文件、69 个测试通过，typecheck 通过。该修复不构成真实供应商或生产长时任务验收。

# 2026-09-21 增量：RSI Evaluator 健康可见性

独立 RSI evaluator 新增可选只读 `health()` 边界。HTTP evaluator 可通过 `AEEIS_RSI_EVALUATOR_HEALTH_URL` 配置同源 GET 探针，复用 Bearer token、拒绝重定向并限制为 3 秒；探针不会提交 replay/holdout/safety case，也不会消耗 evaluator 预算。`/readyz` 增加 `rsiEvaluator` optional check，`/api/status` 返回 `rsiEvaluatorHealth`，工作台把 RSI 状态与 evaluator 可用性分开展示。evaluator 暂时不可用不会阻断核心仓库、模型、dispatcher、domain 和 scheduler 的 required readiness；真正执行评测时仍由 durable evaluation attempt 和 reconcile 规则控制。生产 evaluator 的安全隔离、容量、质量和 SLA 仍需部署验收。

# 2026-09-21 增量：Projection Sink 健康可见性

Projection Sink 新增可选只读 `health()` 边界。HTTP sink 可通过 `AEEIS_PROJECTION_SINK_HEALTH_URL` 配置与业务 endpoint 同源的 GET 探针，复用 Bearer token、拒绝重定向并限制为 3 秒；健康探针不会发送 projection event。`/readyz` 增加 `projectionSink` optional check，`/api/status` 暴露 `projectionSinkHealth`，从而区分 durable outbox 已配置与外部 Feishu/Hermes/自定义 sink 可达。Feishu sink 仍只在实际投影时调用对应 API，外部投影故障不会阻断核心仓库、模型、dispatcher、domain 和 scheduler 的 required readiness。真实渠道权限、限流、容量和通知 SLA 仍需部署验收。

# 2026-09-21 增量：Agent Registry 健康可见性

Agent Registry 新增只读 `health()` 边界：File Registry 检查持久化文件可读性，PostgreSQL Registry 执行 `SELECT 1`；`/readyz` 增加 optional `agentRegistry` check，`/api/status` 返回 `agentRegistryHealth`。健康探针不触发生命周期变更、Discovery、Admission 或 Reputation 写入；Registry 故障不会改变外部 Agent 的 fail-closed admission 和 delegation 校验。新增 File/HTTP 回归；真实外部 Agent endpoint、企业 OAuth/SSO 和生产注册中心容量仍需部署验收。

# 2026-09-21 增量：Tool Gateway 健康可见性

`ToolGateway` 新增可选只读 `health()` 边界。toolkit_new Registry 适配器通过读取并校验 Registry manifest 检查依赖可达性，旧版 HTTP manifest/invoke 网关通过只读 manifest 检查；工具调用本身不会在健康探针中触发。`/readyz` 增加 `tools` optional check，`/api/status` 暴露 `toolsConfigured` / `toolsHealth`，探针复用统一超时和并发合并策略。服务启动时会把实际配置的 toolkit gateway 传入 HTTP 边界，避免“引擎能调用工具但运维面看不到工具依赖”的状态偏差。新增 Registry/HTTP readiness 回归；工具网关不可用不会阻断核心仓库、模型、dispatcher、domain 和 scheduler 的 required readiness。真实 toolkit Registry 的凭证、ACL、容量、账单和业务质量仍需部署侧验收。

# 2026-09-21 增量：Knowledge / Project Source 健康可见性

Knowledge Provider 与 Project Source Provider 新增可选的轻量 `health()` 边界。File、InMemory、PostgreSQL Knowledge 适配器以及 File/Git/Combined Project Source 适配器会检查各自的本地文件、数据库或 Git 依赖；HTTP Knowledge / Project Source 支持显式的同源只读健康端点（`AEEIS_KNOWLEDGE_HEALTH_URL` / `AEEIS_PROJECT_SOURCES_HEALTH_URL`），复用对应 Bearer token、拒绝重定向、3 秒超时；启动前和 adapter 构造时都校验 URL 边界。没有独立探针的远端 connector 会明确报告 `health probe unavailable`，不会用一次搜索代替健康检查。File 探针实际打开普通文件，Git 验证根目录和 HEAD，探针成功不等于资料内容或远端业务协议已经验证。服务把已配置的 provider 健康状态加入 `/readyz` 的 optional checks、`/api/status` 的 `knowledgeProviderHealth` / `projectSourcesHealth` 和 readiness metrics；这些资料源故障不会阻断核心仓库、模型、dispatcher、domain 和 scheduler 的 required readiness。新增 HTTP、Knowledge、Project Source 回归；完整本地回归为 68 个测试文件、558 个测试通过、62 个跳过，`typecheck`、`build` 和 `git diff --check` 通过。

# 2026-09-21 增量：Run 变更通知提示

Run Repository 新增可选 `subscribeChanges` 边界。File 适配器在 canonical Run、事件 projection 和索引完成 durable commit 后发布进程内轻量 change hint；PostgreSQL 适配器在 Run/事件事务提交成功后，以 best-effort 方式通过按当前 schema 哈希隔离的 `pg_notify` channel 发布 `runId + owner/tenant + lastEventSeq`。这是一次性的低延迟唤醒提示，不是 durable changefeed：提示不携带业务正文、不推进 cursor，丢失、重复或乱序都由原有持久化 scanner/cursor polling 收敛；订阅者失败也不会影响事实提交。RSI Proposal Pump 和 Collaboration Trigger Pump 收到 hint 后立即尝试一次有界扫描，通知唤醒最多每 250ms 尝试一次，RSI interval=0 时禁用自动 RSI pump；LISTEN 连接断开后按有界指数退避自动重建订阅，重连窗口仍由 durable scanner 覆盖。积压时提示只加速当前扫描页，不保证立即处理发生变化的 Run。File 已覆盖提交后通知、取消订阅和 subscriber failure；PostgreSQL 已覆盖跨仓库提交、回滚、取消订阅和 schema 隔离，跨实例连接容量、通知积压和长期吞吐仍需生产压测。

# 2026-09-21 增量：PrincipalDirectory 缓存与故障边界

PrincipalDirectory 现在由 `CachedPrincipalDirectory` 包装：同一 principal/tenant 的并发邀请请求共享一次目录查询，active 与不存在身份都使用有界 TTL 缓存，支持按 principal、tenant 或全量主动失效；目录异常不写入缓存，也不会用过期身份结果绕过 fail-closed 邀请策略。缓存只存在于 API 进程内，不改变 AEEIS membership 事实源；健康检查仍透传底层目录，目录配置继续是 `/readyz` 的 required dependency。新增并发合并、负缓存、失效和故障回归。生产部署可通过 `AEEIS_PRINCIPAL_DIRECTORY_CACHE_TTL_MS` 与 `AEEIS_PRINCIPAL_DIRECTORY_CACHE_MAX_ENTRIES` 调整边界，组织目录同步、跨实例失效广播和容量 SLA 仍需部署侧验收。

# 2026-09-21 增量：共享 Run 历史的存储侧分页

共享 Room 成员读取 `/api/runs/page` 时，PostgreSQL 现在通过 `RunRepository.pageVisible` 在数据库内先应用 tenant、owner/Goal membership、privacy 和稳定 `updatedAt + id` cursor，再执行 `LIMIT`；owner 自己的 Run 仍保留完整隐私可见性。`AeeisStore.getReadableGoals` 同时把 Goal 的 tenant/owner/Room 过滤下沉到 PostgreSQL，避免为了计算可见 Goal ID 再读取整个租户的 Goal 历史。File 适配器的 durable metadata index 也保存 Goal/privacy 字段并提供相同语义的 bounded page，旧的应用层 fallback 继续兼容不支持新接口的适配器。这样共享历史不会因 tenant 全量 Run 或 Goal 被载入 API 进程而随规模线性放大；新增 File、HTTP 和 PostgreSQL 回归覆盖分页、隐私过滤、cursor 和跨目标隔离。

补充：带 `limit` 的兼容 `GET /api/runs` 也复用同一存储侧过滤和限量路径；未提供 `limit` 时继续保留完整列表兼容语义，避免无意改变旧客户端行为。新增回归确认共享成员在超过 200 条历史时仍可读取完整未限量列表。

# 2026-09-21 增量：Readiness 不再加载完整 Run 历史

Run Repository 新增可选轻量 `health()` 探针：File 适配器检查数据目录，PostgreSQL 适配器执行 `SELECT 1`。`/readyz` 和 readiness 检查优先使用该探针；完整 Run 列表只在 `/metrics` 的状态计数采集器中读取，并使用独立的探针名称避免与 readiness 请求合并。这样频繁健康检查不会随着长时 Run 历史增长而解析完整 JSON/JSONB。旧适配器没有 `health()` 时仍回退原有 `list()` 兼容路径。

# 2026-09-21 增量：Reminder Timer 重连改为有界活动扫描

Reminder Store 新增 `listActivePage`，File、InMemory 和 PostgreSQL 适配器按 `updatedAt + id` 对 `scheduled`、`firing`、`failed` Reminder 做有界 keyset 分页；PostgreSQL 增加活动记录 partial index。API 重启后重新挂接 Temporal Reminder Timer 时优先逐页读取活动提醒，不再把已完成或已取消的完整历史全部载入内存；旧适配器仍回退原有列表路径。新增 File/InMemory 分页回归，PostgreSQL Reminder 回归保持通过。

# 2026-09-21 增量：Room 成员共享图读取与投影权限

Room 成员现在可以通过统一的领域服务边界读取所属 Room 的 Goal/Plan 图；撤销成员或跨租户访问仍返回不可见。共享成员读取执行快照、Goal Memory 和冻结 Context Manifest 时会过滤 confidential/private 内容，避免 Room read 权限扩大为个人或受限知识权限。Room 投影属于外部副作用并携带成员快照，只有 Room owner/editor 可以提交投影；viewer 即使具备资源 owner Principal 角色也会被拒绝。HTTP、Service 回归覆盖共享读取、撤销后的失效、隐私内容过滤、跨租户隔离和 viewer 投影拒绝。

# 2026-09-21 增量：Room 参与执行的角色边界

共享 Goal 的计划写入现在要求 Room owner/editor；viewer 只能读取 Goal/Plan/Memory/执行快照和 scheduler ledger；owner、editor 和 active agent 可以推进已有 Task 的合法状态转换。调度整张 DAG、创建或控制 Run、取消/重试和外部副作用仍要求资源 owner 或安装级 operator，agent 不会因为能推进 Task 就获得调度权限。scheduler ledger 按已通过 Room membership 校验的 Plan 返回原 owner 的 reservation，避免共享成员看到空白状态。HTTP 路由与 AeeisService 使用相同的 membership 校验，并覆盖 viewer 创建计划、agent 推进任务、撤销成员后的失效和跨租户隔离。

# 2026-09-21 增量：共享 Room 的 Run 观测边界

共享 Room 成员现在可以读取 Room Goal 关联的 owner Run、事件分页、SSE 事件流、运行解释和 Evidence Graph；Run 读取先通过 canonical Run tenant，再通过 Goal 的 active membership 判断，不会因为知道 Run ID 绕过 Room。Run 创建、控制、回调、RSI correction 和其他写入仍保持 owner/operator 边界。撤销成员或跨租户请求返回 Unknown，存储故障不会被误处理为无权限。HTTP 回归覆盖 owner Run 的共享读取、事件读取、Evidence Graph、撤销和跨租户隔离。

共享成员的 `/api/runs` 与 `/api/runs/page` 也会列出其 Room 关联的可读 Run，按 `updatedAt + id` 稳定排序后再限量和分页；没有共享 Room 时继续使用原有 owner-scoped 存储路径。共享列表、详情和事件流统一拒绝 confidential/private Run，避免 Room membership 把项目协作权限扩大为个人或受限执行上下文。

# 2026-09-21 增量：Temporal Worker 启动边界与内部 API 地址

新增 `src/temporal/config.ts`，Temporal Worker 在连接 Temporal、注册 Build ID 或开始监听前，先校验 Worker token、内部 API URL、HTTP 开发开关、Temporal 地址、namespace、task queue、健康端口、优雅退出时间和生产 Worker Versioning 要求。Compose 为 Worker 显式设置 `AEEIS_ENV=development` 与 `AEEIS_WORKER_ALLOW_INSECURE_HTTP=1`；生产必须使用 HTTPS、独立 Worker token 和 `AEEIS_TEMPORAL_USE_VERSIONING=1`。内部 API URL 会规范化去掉尾部 `/`，避免 Activity 拼接出 `//internal/...` 导致 Fastify 404 和 Temporal 非重试失败。新增 Worker 配置回归；重建后的 Worker `/readyz` 为 `ready/RUNNING`，完整 `AEEIS_SMOKE_TIMEOUT_MS=180000 npm run smoke:compose` 通过。

# 2026-09-21 增量：外部依赖启动边界校验

`src/config-validation.ts` 现在在打开 File/PostgreSQL store 之前统一校验 Knowledge、Brain embedding、Project Source、Projection sink、Feishu、OIDC、Toolkit、外部 Agent Card、Agent OAuth、Linear/Jira 和 Competition model pool 的配置边界。校验拒绝无效 URL、凭证/query/fragment 泄漏、不安全的非 loopback HTTP、半配置的成对端点和错误的 JSON 结构；开发夹具仍需通过显式 insecure HTTP 开关放行。各 adapter 保留运行时重复校验，避免配置在启动后被绕过。新增配置回归覆盖集成端点、Agent Card、OAuth 和 Project Source endpoint；全量本地测试为 64 个文件、507 个测试通过，`typecheck`、`build` 和 `git diff --check` 通过。

# 2026-09-21 增量：启动配置校验已前移到 `src/config-validation.ts`。服务会在打开持久化存储前校验 RSI proposal synthesis 的开关、隐私级别、调用/Token 预算、扫描批次、租约和周期参数；固定模型必须同时提供 endpoint 与 model，启用 synthesis 必须提供固定模型或 Planprice 路由；生产 synthesis 还必须配置独立 RSI evaluator。OwnHow 启用时必须显式绑定 `AEEIS_OWNHOW_RUNTIME`，反向配置也会被拒绝。对应回归测试覆盖非法配置、开发模式、固定模型和生产安全边界。本轮 `npm test` 为 63 个文件、494 个测试通过、53 个跳过；`typecheck`、`build`、`git diff --check` 和重建后的 Compose smoke 均通过，AEEIS/Temporal Worker readiness 均为 ready/running。

# 2026-09-21 增量：Reminder recurrence 新增基于 `@js-temporal/polyfill` 的 IANA 时区日历规则，支持 daily/weekly/monthly、夏令时缺失时刻跳过、重复时刻单次触发、月末缺失日期跳过和 misfire 后从下一匹配时间继续；原有固定 interval 格式保持兼容。File、PostgreSQL、Temporal timer 和工作台都复用同一规则计算器。投影完成后会重置本次 occurrence 的 attempts，并通过 claim fingerprint 拒绝过期租约的迟到结果覆盖新 occurrence；PostgreSQL 同步更新 `due_at` 索引列。新增日历/DST/月份/日期线和调度回归，提醒专项与构建通过。

# 2026-09-21 增量：模型 endpoint、Model health、Planprice、RSI evaluator 以及 catalog provider/health URL 的格式、凭证/query/fragment 泄漏和 HTTPS/loopback 开发例外现在也在打开存储前统一校验；provider URL 可使用非 loopback HTTP 仅当显式设置开发开关。新增 25 个配置回归，并重建 Compose 验证 catalog、OwnHow、Temporal 和跨容器 RSI smoke 仍通过。

# 2026-09-21 增量：在当前 Compose PostgreSQL 上实际执行了 `backup:postgres`、`backup:verify` 和 `recovery:postgres`。custom-format 备份通过 SHA-256 与 `pg_restore --list` 校验；恢复演练在隔离临时数据库中恢复 26 张表、启动恢复后的 AEEIS（Fixture Model + File/Local Dispatcher）并通过 `/readyz`，随后自动删除临时数据库。该结果证明开发数据库的备份恢复链路，仍不代表生产备份存储、密钥和容量演练已完成。

# 2026-09-21 增量：Compose 开发闭环现在启用 RSI proposal synthesis。Fixture reviewer 对专用 smoke 目标产生一次低置信度 `review.completed`，后台 RsiProposalPump 通过真实 HTTP 模型和独立提案预算生成带 Evidence refs 的 `proposed` candidate；smoke 会检查 synthesis attempt 已结算、候选已创建，随后仍由独立的评测、审批、Canary 和激活流程处理。该闭环只证明 RSI 状态机、证据绑定和持久化边界，Fixture 生成的改进内容不代表真实模型质量。

# 2026-09-21 增量：运行状态现在区分 Fixture 演示与未验证依赖。`AEEIS_DEMO_MODE=1` 仅允许开发环境，`/api/status` 返回 `executionProfile: fixture`，工作台会明确提示结果不代表真实模型能力；生产配置拒绝该开关。OwnHow 治理适配器新增 `status --json` 健康探测，`/readyz` 和 `/api/status` 会报告 CLI、state directory 和 JSON 协议是否真实可用，而不是仅根据对象注入判断已配置。Compose smoke 已覆盖该探测；Fixture 仍只证明协议和状态机，不证明真实模型、Skill 治理质量或生产 SLA。

# AEEIS 当前实现状态

2026-09-22 增量：补齐独立 Hermes Debate 入站桥接。新增 `POST /webhooks/hermes/events` 和 `hermes-debate-event/1` 协议，要求原始 body 使用带 key id 的 HMAC-SHA256（timestamp、nonce、签名时间窗），按显式 room → Debate 和 sender → Agent 映射准入；消息以 `hermes` provenance 写入 Debate Event Log，按 room/event/message 生成稳定 ID，重复投递只重放同一 `external.message` Trigger。Trigger 继承 Debate room 冻结的 participant、Context Pack、tenant 和 redaction，不能借 Hermes 消息扩大 Agent 准入或制造 Evidence；sender 映射存在但不在该 Debate participant 列表时，Feishu/Hermes 都返回显式 `sender_not_admitted` 并保持 webhook 幂等，不触发外部重试风暴。配置启动校验、HTTP raw-body 边界、错误签名、未知 room/sender、幂等和跨越权 Trigger 回归已覆盖；这完成了本地 Hermes bridge 的协议实现，但仍需在真实 Hermes/Feishu Skill、密钥轮换和生产群权限上验收。

2026-09-21 增量：Planprice catalog 路由新增显式 `AEEIS_MODEL_PRIVATE_DATA_ALLOWED` provider/model 策略映射。Planprice 本身只提供价格与可用性，AEEIS 不把供应商默认当作 private-safe；只有部署者显式声明为 `true` 的 provider/model 才能承载 `private` Run，省略时安全拒绝。该字段随 catalog row 进入排序稳定的 `catalogHash`，并覆盖集成与配置校验回归。

2026-09-21 增量：开发 Compose 现在把模型选择和技能治理接入到实际运行链路。`fixture-planprice` 提供 grouped LLM catalog 与汇率接口，AEEIS 通过 `AEEIS_PLANPRICE_URL` 选择并冻结 provider/model、归一化价格、`catalogHash` 和 provider health 结果；`fixture-ownhow` 通过 CLI 协议实现 `resolve`、`record`、`propose`、`apply`、`rollback` 和 `status`，AEEIS 启动时会检查 `AEEIS_OWNHOW_RUNTIME`，Run 的治理快照会保留 Skill method/version/plan/receipt。`npm run smoke:compose` 已强制检查 `modelRouting: catalog`、provider health 和 `skillGovernanceConfigured: true`。Compose 使用 `AEEIS_PLANPRICE_ALLOW_INSECURE_HTTP=1`、`AEEIS_MODEL_PROVIDER_ALLOW_INSECURE_HTTP=1` 以及既有 fixture HTTP 开关，仅为容器内开发服务；生产环境校验会拒绝这些不安全传输，真实部署必须提供 HTTPS、凭证和受治理的 Planprice/OwnHow 服务。最新验证：`npm test` 63 个文件、490 个测试通过、53 个跳过；PostgreSQL 21 个文件、55 个测试通过；`typecheck`、`build`、`git diff --check` 和完整 Compose smoke 通过。该验收仍只证明协议、状态机和跨容器边界，不证明真实模型质量、治理质量或生产 SLA。

2026-09-21 增量：开发 Compose 新增可复现的 `fixtures/project-sources.json`，由 `AEEIS_PROJECT_SOURCES_FILE` 注入 AEEIS，包含带租户、隐私分级和 SHA-256 内容 hash 的项目资料。`npm run smoke:compose` 现在实际验证项目源读取、证据绑定的 `project-pulse/1` 产物、`nextActions` 到 successor Plan 的投影，以及同一查询在持久化 checkpoint 上的重复读取；Combined provider 即使以完整 snapshot 表达 unchanged，也必须保持 `changed=false` 和来源上下文。Runtime 同时修复同一 Goal 启动多个独立 Run 时错误重建 Plan version 1 的问题：已有 Goal Plan 会自动创建 revision，并新增回归覆盖多 Run 版本唯一性。该闭环仍使用 Fixture Model，证明协议与持久化边界，不证明真实模型质量或生产项目连接器 SLA。

2026-09-21 增量：Reminder Store 新增 owner/tenant scoped keyset 分页 `listPage`。InMemory、File 和 PostgreSQL 适配器统一使用 `updatedAt DESC, id ASC` 排序与 `CollectionCursor`，PostgreSQL 直接使用 `(owner, tenant_id, updated_at DESC, id)` 索引和游标条件读取 `limit + 1` 行；status 过滤与 cursor 校验在存储边界保持一致。新增 `GET /api/reminders/page?limit=...&cursor=...&status=...`，旧的完整 `GET /api/reminders` 保持兼容，并覆盖 InMemory、HTTP 及可用 PostgreSQL 的分页回归。这样 Reminder 长历史读取不再要求 API 调用方反复跳过 offset；File/InMemory 仍受其本地存储模型限制，生产大规模容量仍需独立压测。

同日增量：Web 工作台新增 Reminder 面板，可创建一次性或有界 interval Reminder，按 status 查看最近记录，加载更早页面，并执行取消/重试。面板只调用 owner-scoped Reminder API，创建使用浏览器本地时间转换为带时区 ISO 时间，状态和渠道仍以 Reminder canonical store 为准。

本轮验证：本地全量测试为 63 个文件、488 个测试通过、53 个跳过；PostgreSQL 回归为 21 个文件、55 个测试通过；`typecheck`、`build` 和 `git diff --check` 通过。后续补充验证了 File 重启续页、相同时间戳排序、翻页间新增记录、状态筛选与同 owner 不同 tenant 的隔离，Reminder 专项为 10 个测试通过，PostgreSQL Reminder 专项为 4 个测试通过。游标描述实时列表中的位置，不是冻结快照；翻页期间发生状态变更的记录可能移动到前页，调用方刷新首屏可看到最新状态。

2026-09-21 增量：PostgreSQL 所有带资源标识的 advisory lock（调度恢复、Projection delivery、Grant ledger、Migration、Agent Registry、Brain、Trigger claim、Global Budget 和 Knowledge reindex）统一改用 namespaced SHA-256 前 64 位的双整数 key。这样不同租户、账户、策略或 Projection ID 不会因单个 32 位 `hashtext` 碰撞而意外共享锁；事务锁和跨连接 session lock 的释放语义保持不变。完整 PostgreSQL 回归、typecheck、build 和 diff check 通过。

2026-09-21 增量：Task Scheduler 的 PostgreSQL recovery lease 改用由 `aeeis-task-reconcile + owner + tenant` 的 SHA-256 前 64 位派生的双整数 advisory key，不再依赖单个 `hashtext` 32 位值。不同租户的恢复 sweep 因此不会因为低位哈希碰撞而互相跳过；lease 仍绑定数据库连接，断开连接会自动释放。PostgreSQL 调度回归、typecheck 和 build 通过。

同日增量：调度器现在直接复用共享的 `postgresAdvisoryLockKeys` helper，避免各适配器重复派生锁 key；新增 helper 的确定性、32 位范围和命名空间隔离回归。全量本地测试为 63 个文件、480 个测试通过、52 个跳过；PostgreSQL 回归为 21 个文件、54 个测试通过；typecheck、build、diff check 和重建后的 Compose smoke 均通过。

2026-09-21 增量：Task Scheduler 的 PostgreSQL recovery pump 新增 owner/tenant 作用域的非阻塞 advisory lease。多个 API/Worker 进程同时 tick 时，只有拿到该 scope lease 的进程执行 dispatch ledger 分页恢复；连接断开会自动释放 lease，File/InMemory 适配器保持单写者/测试语义。新增跨连接竞争、释放后重入和既有 scheduler 回归；这减少重复 reconcile，但不替代 Temporal Worker 容量、跨实例故障注入和正式部署验收。

2026-09-21 增量：Room projection reconciliation 现在使用 `updatedAt + id` keyset page。InMemory、File 和 PostgreSQL domain store 提供 bounded `getRoomsPage`，服务层为旧适配器保留 fallback；成员仓库新增 `listForRooms` 批量读取，分页投影按页加载成员后立即 flush，避免 Room 和 membership 的 N+1 读取。非法 cursor、稳定排序和成员边界有回归覆盖。后台 pump 不再一次性加载全部 Room aggregate，PostgreSQL Room projection 仍需在真实生产数据量和多进程压力下验收。

2026-09-21 增量：Evolution projection reconciliation 在每个候选分页批次内按 owner/tenant scope 缓存一次 traffic 读取，再为候选组装对应路由，避免随着 RSI candidate 数量增长对 activation store 产生 N+1 查询；candidate page、scope 边界和 snapshot 幂等语义保持不变。类型检查及 HTTP/projection 回归通过。

2026-09-21 增量：新增一等 durable Reminder。`src/reminders.ts` 提供 InMemory、原子 File 和 PostgreSQL 存储，记录 owner/tenant、dueAt、投影渠道、隐私级别、幂等键、attempt、lease 和 `scheduled → firing → projected` 状态；到期 claim 使用租约，进程中断后可恢复，投影失败按 nextAttemptAt 重试，取消/手工 retry 不会绕过状态边界。Reminder 支持有界 interval recurrence、IANA 时区的 daily/weekly/monthly calendar recurrence、maxOccurrences 和明确的 skip-misfire 策略；每次 occurrence 使用独立 `reminder:<id>:<occurrence>` outbox 幂等键，只有投影成功后才推进下一次。`ReminderPump` 通过 Projection Outbox 写入提醒事件，外部渠道仍是投影层；PostgreSQL claim 会按每条记录自己的 `maxAttempts` 做 SQL 过滤，与 File/InMemory 语义一致；新增 `GET|POST /api/reminders`、`GET /api/reminders/:id` 和 cancel/retry 动作、status/readiness/metrics 标记，以及 File/HTTP/PostgreSQL 回归。真实通知渠道 SLA 仍待实现。

同日增量：Reminder 在 Temporal runner 下新增 `reminderWorkflow` 和 `advanceReminder` Activity。创建、取消、retry 会启动或唤醒以 Reminder ID 确定的 Workflow；Workflow 只保存下一次 `wakeAt` timer，活动通过内部 worker-authenticated API 调用既有 ReminderPump，投影仍先写 Projection Outbox，取消、失败重试、有限 interval/calendar recurrence 和重复投影沿用原有事实源。新增 TestWorkflowEnvironment timer/wake、瞬时失败重试、永久错误 signal 恢复、Continue-As-New 和上一版 Reminder history replay 回归；Compose 将 Reminder interval pump 设为 0 并通过跨容器 smoke 验证 Temporal timer 到 `projected`。真实通知渠道 SLA 仍待实现。

同日增量：Reminder Timer 的 Temporal 唤醒改为 `signalWithStart`，用 `USE_EXISTING` 处理活跃 Workflow、用 `ALLOW_DUPLICATE` 允许取消/完成后的同 ID retry，消除多 API 进程在“先 signal、再 start”窗口中的竞态；Reminder 的领域状态、租约和 Projection Outbox 仍是唯一事实源。Temporal、Reminder 和 HTTP 回归通过。

同日增量：Reminder Pump 将并发 `pump()` / Temporal `advance()` 合并为同一个在途 Promise。Timer 在安全泵持有 claim 或等待投影时会等待既有结果，不再因忙碌状态读取到期 reminder 后短暂自旋；新增并发回归，Reminder 测试、typecheck、build 和 diff check 通过。

本轮最终验证：`npm test` 为 63 个文件、481 个测试通过、52 个跳过；PostgreSQL 回归为 21 个文件、54 个测试通过；`typecheck`、`build`、`git diff --check` 通过。重建镜像后的 Compose smoke 再次通过，API readiness 为 `ready`、Temporal Worker 为 `RUNNING`，Reminder Timer、两节点 DAG、外部 Agent、Competition/Debate、RSI replay/holdout/safety、traffic canary 和 activation 均完成。

2026-09-21 增量：Task Scheduler 的恢复扫描新增稳定的 `createdAt + dispatchId` keyset 分页。InMemory、File 和 PostgreSQL dispatch ledger 都提供有界 `listPage` 与轻量 `listScopes`；服务内恢复泵按 tenant scope 分页读取并继续调度，避免每次 tick 把完整历史 dispatch JSON/JSONB 载入内存。单 Plan 的 `reconcilePlan` 也按页恢复，只有兼容 HTTP 查询默认要求完整返回时才重新读取全量记录；依赖解锁在扫描结束后统一进行，避免新建后继 reservation 改变当前页遍历。游标版本、排序、非法 cursor 和禁止完整列表回归均有覆盖；旧的完整 `list` API 保持兼容。该改动改善长时任务恢复的扫描边界，但尚未替代生产 Temporal 容量和压力验收。

同日增量：服务启动时的 Scheduler 初始恢复优先调用 dispatch ledger 的 `listScopes`，不再仅为发现 owner/tenant 而读取完整历史；不支持 scope 查询的旧适配器仍保留完整列表回退。冷启动恢复与定时恢复因此共享同一有界分页路径。

同日增量：API 服务启动后的 Run 唤醒改用 Run repository 的稳定 `scanPage`，按 Run ID 上界分批读取并只通知仍处于可执行状态的 Run；不支持 bounded scan 的旧适配器才回退完整 `list`。暂停、等待输入、外部核查和审批中的 Run 不会被冷启动无条件唤醒。

同日增量：Projection snapshot pump 现在按最多 50 个 aggregate 分批写入 Projection Outbox；Run snapshot 在支持 `scanPage` 时按固定 Run ID 上界分页读取，Competition/Debate 使用现有稳定 cursor page，RSI candidate 使用新增的 `updatedAt + id` cursor page，避免每秒把全部 Run/协作/RSI 聚合和全部 snapshot payload 同时保留在内存。投影仍使用原有 snapshot digest + idempotency key，批次边界不会改变最终收敛语义。

2026-09-21 增量：外部 Agent Gateway 进一步区分传输结果不明与明确响应拒绝。传输中断、5xx、超时、限流或缺少最终帧继续进入 `unknown` 并要求 reconcile；4xx、认证、schema、Context Pack evidence binding 和 Grant 预算错误会生成受限分类诊断，并显示在 Run explanation 中。拒绝响应正文不会进入 Evidence；若远端副作用或费用仍无法核实，Grant/全局预算仍保持 unknown 结算边界。Context Pack 自身的 claim 现在必须引用同一 Pack 已冻结的 source、artifact 或其他 claim，禁止自引用和重复 claim ID。HTTP callback 对协议拒绝返回 400。新增 Gateway、HTTP、协议和 explanation 回归；当前本地全量为 61 个文件、468 tests passed、48 skipped，PostgreSQL 为 19 个文件、48 tests passed，typecheck/build/diff check 通过；重建后的 Compose smoke 再次通过，readiness 为 `ready`、Temporal Worker 为 `RUNNING`，DAG、外部 Agent、Competition/Debate 和 RSI promotion 均闭环。

2026-09-21 增量：新增 owner/tenant scoped `GET /api/runs/:id/explanation` 和工作台“为什么现在是这个状态”面板。该 `run-explanation/1` 投影从当前 Run 事实源聚合下一步动作、显式阻塞、计划任务计数、模型/Tool/Agent 执行计数、Evidence/Context Manifest 引用、治理冻结项和预算用量；不复制来源正文、模型 Prompt 或供应商凭证，也不成为新的事实源。`needs_approval`、`needs_input`、`unknown`、`waiting_external`、`paused` 和 `failed` 会分别给出可操作的人工下一步，unknown 继续要求显式核查。新增纯投影回归，typecheck、build、完整本地测试通过。

2026-09-21 增量：Project Pulse 审核通过后生成的 successor Plan 现在会在 Run 工作台的“当前交付”区域明确显示，并可按需读取其任务、依赖、状态和证据引用；这让报告 → 后续计划 → 长期目标调度的闭环在产品界面中可见。读取仍经过现有 owner/tenant 权限和领域计划快照 API，工作台不会把后续任务复制成另一份事实源。

同日增量：工作台顶部不再固定宣称单用户模式；`GET /api/status` 继续返回原有 `principal` 字符串，同时提供当前 `tenantId` 和 `roles`，UI 根据实际认证模式显示单用户、静态 Principal/Tenant 或 OIDC Principal/Tenant 隔离，并将身份信息放入可见提示。该改动只改善控制面可见性，不改变后端授权边界。

同日增量：Run 工作台新增“治理快照”，展示本次运行冻结的 OwnHow Skill method/version/plan/receipt、Skill outcome、Planprice Model Decision/catalog hash，以及 toolkit_new Tool manifest digest 和具体版本。数据直接来自 Run canonical record，便于审计和 RSI 归因；展示层不会复制或修改治理事实源。

这份清单用于防止把“设计存在”误报成“产品已完成”。状态只以当前仓库代码和测试为准。

2026-09-21 增量：JSON Domain store 新增带 SHA-256 校验的 domain-level journal。Goal/Plan/Task/Receipt/Projection Intent 的跨实体提交先以单条 fsync 日志记录落盘，达到条目数或 4 MiB 阈值后再原子压缩回 `domain.json`；snapshot 保存 journal sequence，重启只回放快照之后的记录。Receipt/Memory 历史在压缩时写入按 journal sequence 版本化的 sidecar，启动只装载热状态和 journal tail，首次历史查询再惰性读取；sidecar 缺失或引用非法时 fail closed，旧的无 sidecar 快照保持兼容。启动会创建稳定的快照路径，尾部半写入会截断到最后一条完整记录，缺失中间序号会 fail closed，快照替换成功但 journal 尚未清空的崩溃窗口会安全忽略旧前缀。新增崩溃重放、尾部截断、序号缺失、快照替换崩溃窗口、阈值压缩、sidecar 惰性读取、Receipt 恢复和重启后 Memory revision 合并测试；Goal Memory 的 File/InMemory/PostgreSQL 读取新增按 `updatedAt` 排序的存储层 limit，HTTP 和工作台默认取最近 50 条，未传 limit 仍保留完整历史兼容；此前全量回归为 60 个文件通过、458 个测试通过、48 个跳过，本轮新增 sidecar 定向回归为 8 个测试通过，typecheck 通过。大规模历史吞吐、sidecar 清理和生产容量验收仍待完成。

同日增量：Run 纠正入口现在要求 `baseVersion` 与该 Run 冻结的 active Evolution snapshot 完全一致；没有激活候选时必须使用对应 target 的 baseline version。旧 Run 的纠正不能借用新版本上下文创建候选，错误版本会在证据查询和候选创建前被拒绝；HTTP 回归覆盖 stale baseVersion 与有效纠正两条路径。

2026-09-20 增量：File Run repository 新增持久化、可重建的 `.runs.index.json` 元数据索引。正常重启时只校验索引条目与 canonical Run 文件的大小/mtime，分页、事件扫描和恢复扫描使用索引筛选后再读取命中的 Run；索引缺失、损坏或检测到文件变化时回退到 canonical 文件重建，Run JSON 仍是唯一事实源。索引更新使用临时文件、fsync、原子 rename 和目录同步；冷启动重建不会阻塞短 readiness 探针，索引发布失败也不会让已落盘的 canonical 写入返回半成功错误。新增 clean-restart、损坏索引和读取次数回归。当前 `npm test` 为 59 个文件通过、19 个跳过，446 个测试通过、48 个跳过；`npm run typecheck`、`npm run build`、`git diff --check` 通过；运行中的 API readiness 仍为 `ready`，Temporal Worker 为 `RUNNING`。这仍不构成 File 大规模容量或生产部署验收。

同日增量：Run 事件 SSE 增加每个 API 进程的并发连接预算，默认 100，可由 `AEEIS_MAX_SSE_CONNECTIONS` 调整；达到上限返回 429，正常结束、客户端断开、初始事件/权限校验失败和流错误都会释放 reservation，`/metrics` 暴露当前连接数与上限。非法 `Last-Event-ID` 不会消耗连接额度。全量回归现为 59 个文件通过、19 个跳过，447 个测试通过、48 个跳过；PostgreSQL 回归为 19 个文件、48 个测试通过。

同日增量：File Collaboration repository 已将 Competition/Debate 从单一 `collaborations.json` aggregate 迁移为 `competitions/<id>.json`、`debates/<id>.json` 两类 canonical record 文件和 `collaboration.index.json` 可重建索引。首次启动自动迁移旧 aggregate；正常重启只校验索引条目与文件大小/mtime，列表按索引先过滤排序后读取选中记录，索引损坏或文件变化时回退重建，canonical record 才是事实源；写入使用 fsync、原子 rename，索引发布失败不会使已落盘协作状态报错。现有协作、触发器、Competition/Debate 和集合回归全部通过。全量本地测试为 59 个文件通过、19 个跳过，449 个测试通过、48 个跳过。

同日增量：Competition/Debate 新增 owner/tenant scoped keyset cursor page（`GET /api/collaborations/competitions/page`、`GET /api/collaborations/debates/page`），File 适配器在索引层排序后只读取当前页 canonical records，PostgreSQL 使用 `updated_at + id` 条件和 scope index 执行分页；旧列表 API 保持兼容，工作台已切换到分页接口。非法 cursor/limit 在 HTTP 读取存储前被拒绝；新增 File/HTTP/PostgreSQL 分页回归。

## 最近一次本地端到端验收

2026-09-20 在现有 Compose 开发栈上新增并验收 Run 事件 SSE 流：`GET /api/runs/:id/events/stream` 在发送响应头前完成 owner/tenant 和 cursor 校验，按事件 `seq` 或标准 `Last-Event-ID` header 支持断点恢复，连接内发送 `heartbeat`，达到 `waitMs` 后发送 `timeout` 并结束；工作台选中 Run 后使用带 Authorization 的 fetch stream 消费事件，断线或 timeout 会按 cursor 续接，原有轮询仍作为兜底；跨租户访问、非法 heartbeat 参数、非法 Last-Event-ID 和续传均有 HTTP 回归。新增 Plan 历史分页 `GET /api/goals/:id/plans/page`，按 `version + id` 使用稳定 keyset cursor，File/InMemory/PostgreSQL 语义一致。最新全量本地测试为 59 个文件通过、19 个跳过，444 个测试通过、48 个跳过；PostgreSQL 回归、typecheck、build、diff check 通过；重建后的 Compose smoke 通过，API readiness 为 `ready`，Worker 为 `RUNNING`，两节点 DAG、Competition、Debate、外部 Agent、RSI traffic canary 和 activation 均完成。

2026-09-20 在运行中的 Compose 开发栈完成了以下验收：

本轮在同一开发栈新增并验收 Run cursor page 与事件 projection：`GET /api/runs/page?limit=2` 返回 owner-scoped `items` 与 opaque `nextCursor`，下一页按 `updatedAt DESC, id ASC` keyset 继续读取；`GET /api/runs/:id/events?limit=2&cursor=...` 从 File `.events.json` projection 或 PostgreSQL `aeeis_run_events` 表按 seq 分页，projection 缺失/落后时回退 canonical Run；非法 cursor 和缺少 limit 在 HTTP 边界返回 400。工作台首屏已改用 Run page，旧的 `/api/runs` 列表接口保持兼容。

- `npm run smoke:compose` 通过，覆盖 Temporal 两节点 DAG、审批、产物与 Reviewer、外部 Agent、Competition、Debate、RSI replay/holdout/safety、候选晋升和生产流量 Canary；最终 readiness 为 `ready`，Worker 为 `RUNNING`。
- 通过工作台对应的 HTTP 入口创建了一个真实 Run：Run 先进入 `needs_approval`，提交精确 `planHash` 后完成 `inspect → deliver`，最终为 `succeeded`，生成 2 个 Artifact、24 条事件，并保留模型调用和来源证据。
- 工作台的集合读取现在使用可选的有界 `limit`（运行/目标/Room/候选/Agent 默认最多 50 条，协作记录使用更小窗口）；这只限制界面读取量，不删除或裁剪 AEEIS 的 canonical 事实源。HTTP API 不传 `limit` 时继续返回完整列表，传入的值必须在 1 到 200 之间。

同一轮回归还完成了：`npm test`（59 个测试文件通过，442 个测试通过，47 个跳过）、`AEEIS_TEST_DATABASE_URL=postgresql://aeeis:aeeis@127.0.0.1:5433/aeeis npm run test:postgres`（19 个文件、47 个测试全部通过）、`npm run typecheck`、`npm run build` 和 `git diff --check`。运行中的限量 API 实测 `runs?limit=5` 和 `debates?limit=5` 均返回 5 条，Run page 首页和下一页均可读取，`/readyz` 为 `ready`；新版 Compose smoke 通过 Temporal DAG、Competition、Debate、RSI promotion 和 Worker readiness；本轮新增的 Run Event Scanner 通过 File/PostgreSQL 重启、部分 Run offset、后插入 Run、checkpoint CAS 和失败重放验收。

Run、Goal、Competition 和 Debate 的 `limit` 已下沉到 repository：PostgreSQL 在 owner/tenant 过滤后排序并执行参数化 `LIMIT`；Run 按 canonical `updatedAt`、Goal 按 `createdAt`、协作按 `updatedAt` 排序，同时间使用 ID 稳定排序。Run/Goal 有作用域与时间联合索引，历史 Run 行时间在启动迁移中与 canonical 状态对齐。File Run 在首次读取时串行重建轻量元数据索引，后续限量查询只读取命中的文件，写入在 rename 后更新索引，恢复备份不依赖文件 mtime。File 协作在持有单写入者锁期间缓存已提交状态，只复制选中的列表条目；JSON/Memory Goal 在复制前过滤、排序和截取。

工作台集合的 limit 已下沉到相应存储接口；Run 已增加 owner-scoped 稳定 keyset cursor page（`GET /api/runs/page`）、独立事件 page（`GET /api/runs/:id/events`）和有界 SSE event stream（`GET /api/runs/:id/events/stream`），File/PostgreSQL 都按 canonical `updatedAt + id` 或 event seq 继续读取，事件表/文件是可删除重建的 projection，Run JSON 仍是唯一事实源。SSE 在发送响应头前完成 owner/tenant 和 cursor 校验，使用 seq 作为恢复断点，发送 `heartbeat` 与有界 `timeout` 帧，断开后不保留后台订阅。工作台使用首屏 page，避免 offset 漂移和重复跳过历史。File Run 现在持久化可重建的元数据索引：干净重启时只校验索引条目和文件大小/mtime，限量查询只读取命中的 canonical Run；索引缺失、损坏或文件变化时才重建，canonical Run 仍是唯一事实源。File Collaboration 也已拆为索引加逐条 canonical record，并为 Competition/Debate 提供 cursor page；Goal Memory 的 File/InMemory/PostgreSQL 读取支持按 `updatedAt` 排序并在存储层执行 limit，工作台默认请求最近 50 条，未传 limit 的 API 仍保持完整历史兼容；JSON Domain 现在使用带 SHA-256 校验的 domain-level journal，先 fsync 单条事务记录并按阈值压缩回 `domain.json`，因此小提交不再重写无关历史，同时保留跨 Goal/Plan/Task/Receipt 的原子边界和尾部半写入恢复；启动只加载热领域状态并回放有限日志，Receipt/Memory 历史在首次查询时从 sidecar 惰性读取；工作台仍会读取所展示 Goal 的计划、记忆和调度详情，监控/后台恢复的完整扫描尚未优化，因此这些改动不构成大规模历史数据下的性能验收。

本轮存储读取回归：`npm test` 为 398 passed / 30 skipped；PostgreSQL 集成测试为 30 passed；`npm run typecheck`、`npm run build` 通过。新增测试覆盖跨 owner/tenant 的先过滤后限量、同时间排序、旧 Run 更新后重排、File 索引重建与读取次数、备份 mtime 不影响顺序、协作缓存返回值隔离、SQL 限量避免解析窗口之外的记录，以及 HTTP 校验失败时不读取存储。 最终缓存写入校验和返回值隔离调整后，50 个 File/HTTP/协作定向回归通过；新版 Compose 镜像已重新构建，本地四类 `?limit=2` 接口均返回 HTTP 200 和 2 条记录。

RSI candidate 列表也已下沉：repository 接受可选 `limit`，PostgreSQL 按 owner/tenant 过滤后用索引排序并截取；File 首次扫描建立轻量索引，后续仅解析所选候选文件，变更在 rename 后同步索引。候选新增可选 canonical `updatedAt`，repository 在变更时写入提交时间，并拒绝修改 ID、owner、tenantId 和 createdAt。旧 PostgreSQL 候选从原 updated_at 回填，旧 File 候选回退到 createdAt，不使用文件 mtime。未传 limit 时仍返回全部可见记录，默认按最近变更排序。

RSI 本轮验证：完整测试 399 passed / 31 skipped，PostgreSQL 31 个测试全部通过；typecheck、build 和 diff check 通过。新版 Compose 端到端 smoke 通过，两节点 DAG succeeded、RSI promoted、readiness ready、Worker RUNNING；本地 candidates?limit=2 返回 HTTP 200、2 条记录且均带回填后的 updatedAt。测试覆盖 File 重启/恢复 mtime、热索引只读取所选文件、同时间稳定排序、跨 owner/tenant 过滤、operator 修改归属失败、旧 PostgreSQL 时间回填可重复执行、窗口外无效记录不进入应用解析，以及 HTTP 在读存储前验证 limit。

Room 与 Agent Registry 的 limit 也已下沉。Room 查询先取得 principal/tenant 的 active membership IDs，再由存储合并 owner 条件，在 canonical tenant 过滤、更新时间排序之后限量；取消逐 Room 权限查询。PostgreSQL 新增 Room 更新时间迁移与索引、active membership principal 索引。单 Room 读取也拒绝跨租户的异常成员关系。Registry 保持插入顺序，本地在复制前截取，PostgreSQL 使用 JSONB lateral projection 只传回选中的卡片及对应声誉，不传输 audit 历史。Registry 仍要求安装级 operator 权限。

本轮完整测试 401 passed / 32 skipped，PostgreSQL 32 passed，typecheck/build/diff check 通过。Room 授权 ID 集合仍完整读取；当时 Registry PostgreSQL 仍为单行 JSONB，限量只减少传输和应用解析；后续已通过规范化表迁移补上逐 Agent 的数据库内读取。cursor 分页和大规模容量验收仍未完成。

Trigger Policy/Decision 和 Projection Outbox 也已支持存储层限量读取。Policy 按 updatedAt、Decision 按 startedAt、有限量 Projection 按 updatedAt 倒序并以 ID 稳定排序，PostgreSQL 将 owner/tenant、policyId/status 条件放在 LIMIT 之前；File 在单写入者锁下缓存已提交状态，只复制选中条目，写入通过 schema 校验、原子 rename 和 fsync，重启重新加载。未传 limit 的 API 仍返回完整可见集合。后台 deliverPending 独立选择最早的 pending/failed ID 并在存储层限量，不受工作台最近更新窗口影响，unknown/delivered 不进入批次。触发器 evaluate 仍读取作用域内完整策略；历史决策的幂等与 cooldown 检查现已改为存储层原子 claim，见下文。

本轮回归：402 passed / 33 skipped，PostgreSQL 33 passed，typecheck/build/diff check 通过。新版 Compose smoke 与 monitoring smoke 通过，DAG 两节点 succeeded、RSI promoted、readiness ready、Worker RUNNING；运行中的三个 limit=1 API 均返回 HTTP 200，Policy/Decision 各 1 条，Projection 当前为空。新增测试覆盖先过滤后限量、同时间稳定排序、缓存返回值隔离与重启、策略更新/删除、SQL 窗口外记录不进入解析、旧 pending/failed 分批投递、unknown 不重发、跨租户投递隔离及 HTTP 先校验再查询。File 缓存仍需启动时完整加载、写入时完整保存，这不代表大规模容量验收完成。

协作触发 cooldown 已下沉为原子准入：File 在单写入者队列内检查并写入，PostgreSQL 按 policy 取得事务 advisory lock、锁定策略行、复核策略快照，并只查询最近一条 started/triggered 决策。同一事件返回已有决策，不同并发事件在非零冷却窗口内只准入一个；数据库时钟限制未来事件时间，历史事件不会仅因墙上时间过期而触发。策略变更/停用/删除后的旧快照不能准入，canonical digest 避免 JSONB 字段顺序差异。事务在资源创建和模型执行前释放，写入失败回滚不消费冷却窗口。File 仍为单进程写入，完整策略读取和后台 Run 扫描尚未优化。

本轮验证：常规测试 408 passed / 39 skipped；PostgreSQL 39 passed；typecheck/build/diff check 通过。新增共享存储契约覆盖双连接不同事件并发、重复/越权事件、未来时间戳、精确冷却边界、旧事件重放、策略变更与删除、写入失败回滚、明确失败释放窗口、unknown 派发保留窗口及独立策略；服务测试断言 evaluate 不再读取历史列表；PostgreSQL 双 Pump 测试覆盖 cooldown=0 与 60 秒、进程重启和跨租户隔离。

API 与 Temporal Worker 已重新构建并启动，保留原有数据库卷。新版 `npm run smoke:compose` 通过：Competition completed、Debate closed、Run 事件自动触发 Debate、Temporal 两节点任务链和 RSI 评测/激活链路完成，最终 readiness ready、Worker RUNNING。该 smoke 继续使用 Fixture Model/Evaluator，仅验证本地协议闭环。

Task Scheduler 已修复 Run 创建后、执行器通知前的恢复窗口：queued reservation 不再仅凭 Run 存在就标记 dispatched；先向同一 Run ID 补发通知，再同步状态。现存 Run 的输入和预算保持冻结，不用恢复默认参数重新 create。连续通知失败保留 queued 和错误，unknown、暂停、等待输入/外部结果及终态不会隐式唤醒。常规回归 416 passed / 40 skipped、PostgreSQL 40 passed，typecheck/build/diff check 通过。新增测试覆盖连续失败、再次恢复后不重复通知、六类不可唤醒状态，以及关闭所有原连接后从 PostgreSQL 重建服务、恢复原 Run 并保留自定义预算；审批前模型调用数为零。这不等于生产 Temporal 集群的重启/压力验收。

该恢复修复已重建到本地 API/Worker，Compose smoke 通过：两个 DAG 节点 succeeded、RSI promoted，readiness ready、Worker RUNNING。

这证明当前版本已经是可操作的 Agent 控制面和运行时纵向切片。Compose 仍使用 `aeeis-fixture/1`，因此这条验收证明协议、状态机、持久化和治理边界可运行，不证明真实模型质量、供应商 SLA 或生产安全性。

| 能力 | 当前状态 | 证据 / 限制 |
|---|---|---|
| HTTP 可观测性 | 已实现并测试 | `/metrics` 暴露固定路由模板的请求状态码计数、请求延迟直方图、当前并发数、客户端中止计数和 readiness（总状态及各依赖检查）；标签不包含 Run/tenant 等高基数或敏感标识；请求完成与断开连接均只结算一次。repository、model、dispatcher、knowledge provider/reindex、project source provider 均使用共享的有界探针；异常和超时会明确标记，采集器失败不会阻塞指标响应，并通过 `aeeis_metrics_collection_success` 暴露；对应 collector 失败告警已加入。Knowledge/Project Source 属于 optional 资料增强依赖，没有独立远端探针时会明确报告 probe unavailable，不会用实际搜索冒充健康检查。readiness 探针合并并发检查。新增默认关闭的 Compose observability profile、9 条告警规则、promtool 等待/触发/恢复与健康场景回归及 CI 检查；本地真实抓取 smoke 和业务 Compose smoke 已通过。开发配置与生产 HTTPS/bearer-token/CA 模板均经 promtool 校验，生产 secret 挂载示例见 `monitoring/compose.production.yml`。HTTP 按实例聚合，共享事实库状态按 job 取最大值。告警通知、长期存储和多安装拓扑仍需部署验收 |
| 动态 Planner DAG | 已实现并测试 | `src/runtime/engine.ts`；规划结果需要精确 hash 审批；失败运行可显式 `replan`，旧 Plan 保留并生成新版本；`/api/runs/:id/graphs` 投影最新 Plan、Plan history、Execution、Evidence 视图，并通过 `planComparisons` 返回相邻版本的说明、任务增删、标题、执行要求和依赖差异及 before/after 快照；工作台可展开查看，依赖顺序变化不算结构变化；历史 Plan 不再套用当前版本的 Step 状态 |
| Room / Identity 领域边界 | Room 已实现并持久化，成员治理已接入 | `Room` 由 AEEIS 自己持有，File/InMemory/PostgreSQL 均支持 owner/tenant 隔离、Room → Goal 关联、更新/归档和 `GET|POST /api/rooms`、`GET|PATCH /api/rooms/:id`、`GET /api/rooms/:id/goals`；Room membership 已支持 File/PostgreSQL 持久化、editor/viewer/agent 角色、撤销和共享 Room 读取；权限已下沉到领域服务，owner 可归档和管理全部成员，editor 可读取/更新 Room 元数据及邀请、撤销成员，viewer/agent 只能读取并按既有规则参与，非 owner 不能归档或撤销 owner，任何入口都按租户和活动 membership 再校验；归档 Room 不能绑定新 Goal，旧 Goal 可继续没有 `roomId`；Projection pump 会从 canonical Room + membership 状态重发现快照，成员邀请、重新激活和撤销可通过幂等 Room projection 收敛到外部协作面；显式 `POST /api/collaborations/projections` 投影 Room 时同样读取最新 membership snapshot，并按 owner/tenant 阻断跨租户访问。Principal/Identity 的组织登录仍由外部 OIDC 提供；新增可选 PrincipalDirectory（内存、只读文件和 HTTPS adapter），目录启用后邀请会验证目标身份存在、同租户且 active，目录异常 fail closed；OIDC 组织目录同步、动态邀请策略和生产目录 SLA 仍待验收 |
| Goal / Plan / Task / Memory 领域服务 | 已接入本地 API 并持久化 | `src/application/aeeis-service.ts`、`src/adapters/json-store.ts`；支持 Goal、Plan、Plan revision、Task transition、Receipt、Memory、Context Manifest；Memory 现在保存 owner/tenant、classification、evidenceRefs、evidenceRunId、version 和 active/superseded/retracted 状态，`correct` 生成保留旧版本的修正版，`retract` 保留原因并从后续 Context Manifest 排除；新增 `POST /api/goals/:id/memories/from-run`，只允许引用同一 Goal Run Evidence Graph 中真实存在的 source/artifact/receipt/model evidence，并阻止把源 Run 隐私级别降级为更公开的 Memory；File/InMemory/PostgreSQL 对 Memory 修正和撤回做条件写入，旧快照按默认值兼容；Context Manifest 保存 owner/tenant/goal 归属并提供受权限保护的读取 API，返回记忆评分、版本、分类和证据引用；绑定 Goal 的 Run 会自动生成一次 Goal-linked Memory Manifest，并按 Run privacy 冻结可用记忆来源，记录 manifest ID、content hash 和 refs 到 Run context 和事件；Plan revision 按 Goal 维持唯一版本号，并在 PostgreSQL 并发冲突后重新分配版本；Run 的 failed/unknown/needs_input/cancelled 状态会同步到领域 Task Receipt；Task 转移将 Plan、Goal 完成状态及 Receipt 一次提交，并对读取的 Plan 快照做条件写检查；并发冲突重新读取和校验状态；JSON 领域事实源采用独占写锁、临时文件、`fsync`、原子替换和目录同步；Plan 节点保留可执行 instruction，并可以携带 evidenceRefs 与 evidenceRunId；Project Pulse 被审核接受后，结构化 `nextActions` 会幂等投影为带证据引用的 successor Plan，已完成 Goal 会在同一 Plan commit 中重新激活；`/api/goals/:id/runs` 将 Goal 关联到 Run，Planner 计划和节点执行会同步到领域 Plan/Receipt；新增 `/api/plans/:planId/tasks/:taskId/run`，可从 ready 领域任务创建确定性绑定的单任务 Run，重复请求复用同一 Run，把证据引用、审批和最终回执闭环回原 Task；新增 `GET /api/goals/page` 与 `GET /api/goals/:id/plans/page`，分别使用 `createdAt + id`、`version + id` 的 owner/tenant scoped keyset cursor，File/InMemory/PostgreSQL 实现一致，工作台首屏使用分页接口；原报告 Run 保留 `domainPlanId`，后续计划通过 `followUpPlanId` 关联；两套事实源仍保持明确边界 |
| 领域 Task Scheduler / DAG dispatch | 已实现并通过本地测试和 Compose Temporal DAG smoke | `src/task-scheduler.ts` 提供 InMemory、原子 File 和 PostgreSQL ledger；`POST /api/goals/:id/schedule`、`POST /api/plans/:id/schedule` 只为当前 ready 节点创建确定性 reservation，绑定唯一 Run/Workflow ID；服务 pump 和启动恢复会重新读取 Plan，成功节点解锁后继任务；`GET /api/plans/:id/scheduler`、`POST /api/plans/:id/scheduler/reconcile` 提供可见性和显式核查；`POST /api/plans/:planId/tasks/:taskId/control/:action` 支持 dispatch/pause/resume/cancel/retry/reconcile，并复用 Run 命令和领域 Receipt；失败任务只有在领域节点显式 retry 后才会复用同一 Run，unknown 不会被自动重发；Temporal runner 复用现有 `agentRunWorkflow`，dispatch ledger 记录其 Workflow 引用；`npm run smoke:compose` 已实跑两节点 `inspect → deliver` DAG，验证两个确定性 Run、审批、自动解锁、两个 Artifact/Reviewer accepted、Plan succeeded 和 Goal completed | dispatch ledger 与 Plan/Run 仍是独立提交边界，生产 Temporal Worker 部署、跨进程调度压力和 PostgreSQL 实例验收仍未完成 |
| 任务执行、证据和 Reviewer | 已实现并测试 | 仅能读取 Run 提供的来源；artifact 引用会校验 |
| File 持久化 | 已实现并测试 | Run/Collaboration 使用可重建索引与逐条事实记录；JSON Domain 使用带 SHA-256 校验的 domain-level journal，先 fsync 单条事务记录并按阈值压缩回快照，Receipt/Memory 历史使用按 sequence 版本化 sidecar 惰性加载，保留跨 Goal/Plan/Task/Receipt 的原子边界；所有 File 写入仍使用原子替换、fsync 和单写入者锁，尾部半写入可截断恢复 |
| PostgreSQL 持久化 | Run、Goal Domain、Brain、Grant ledger、Agent Registry、RSI candidate/activation、Competition/Debate、Knowledge、Project Source checkpoint、Task dispatch ledger 和 Projection Outbox 均有适配器，并已通过 PostgreSQL 17 回归验收 | `PostgresRunRepository`、`PostgresAeeisStore`、`PostgresBrainStore`、`PostgresGrantLedger`、`PostgresAgentDirectory`、`PostgresEvolutionRepository`、`PostgresEvolutionActivationStore`、`PostgresCollaborationRepository`、`PostgresKnowledgeProvider`、`PostgresProjectSourceCheckpointStore`、`PostgresTaskDispatchRepository` 和 `PostgresProjectionOutbox` 启动时创建表、索引并使用事务/JSONB 持久化；Context Manifest 额外维护结构化 `goal_id`、`owner`、`tenant_id` 列和范围索引，启动迁移兼容旧 JSONB 快照；Task 转移、Memory correction/retraction、Brain CAS、Grant 预算、Agent Registry 生命周期/声誉、RSI 生命周期、协作 aggregate 变更、项目源游标 CAS、调度 reservation 和投影状态变更锁定事实行；`npm run test:postgres` 在本机隔离 PostgreSQL 17 临时实例中 24 个测试文件、68 个测试全部通过，并覆盖迁移锁并发串行化/失败回滚、两个连接并发 claim、进程重启重放和 owner/tenant 隔离；`npm run backup:verify` 做只读 manifest、大小、SHA-256 和 `pg_restore --list` 校验，`npm run backup:restore` 在隔离临时数据库中恢复并检查关键表/行数，`npm run recovery:postgres` 进一步用 Fixture Model 启动恢复后的 AEEIS 并检查 `/readyz`；生产迁移、容量、真实依赖和凭证策略下的恢复演练仍未完成 |
| Temporal Workflow / Worker | 已实现并实跑，完成跨版本 history replay 验收 | Activity 已抽出为独立协议边界：网络/限流/5xx 使用有界指数重试，认证/配置/协议错误标记为 durable non-retryable；Workflow 仍按 Run 状态等待 signal，并每 100 个 tick Continue-As-New；Worker 支持稳定 Build ID、显式 `bootstrap`/`new-default`/`compatible`/`promote` 注册策略、未注册 Build ID 拒绝启动、显式 `TEMPORAL_NAMESPACE`、可选 Versioning、graceful drain/force shutdown 和独立 `/health`、`/readyz`；生产 Temporal 配置强制启用 Versioning，兼容发布必须指定旧 Build ID，namespace 未启用 Worker Versioning 时启动会明确失败；API Temporal 模式会检查 gRPC health service；`@temporalio/testing` 真实临时 Server/Worker 验收覆盖终态、wake signal、不可重试错误恢复、Activity retry、Continue-As-New 和“上一版 bundle 生成 history、当前 bundle replay”，Build ID rollout 有独立契约测试；`npm run temporal:replay` 可对导出的线上 history 做离线回放 | Compose 使用的 Temporal 1.24 namespace 默认关闭 Worker Versioning，因此开发栈只验证非版本化执行；Temporal 生产集群的实际兼容集迁移、Worker Deployment API（Temporal 新版部署模型）、生产 history 样本和正式安全验收仍需在目标基础设施上完成 |
| unknown / pause / cancel / restart | 已实现并测试 | 不明模型结果需要显式 reconcile；模型调用持久化稳定的 `model:<runId>:<callId>` provider 幂等键，恢复时复用原调用记录和 key；除“用同一幂等键重试”外，新增 owner-scoped `POST /api/runs/:id/model-reconcile`，运营人员可提交带 provider audit metadata 的 completed/failed 核查结果，校验 callId、幂等键和 input hash，completed 结果仍走原 planner/executor/reviewer schema 与证据校验且不重复调用供应商；在途调用于 pause/cancel 后返回时，核查会保持暂停或取消语义，取消结果只结算并丢弃，不会复活 Run；File 重启后 disposition 与暂存结果仍可恢复；外部 Agent 的异步 `accepted` 会进入 durable `waiting_external` 并保留 receipt，显式 reconcile 后才继续；服务重启发现未完成 Tool/Agent 调用时会生成 durable unknown Receipt 并强制 provider reconcile，避免盲重试；取消后的 Tool/Agent 核查使用持久化 `reconcileInFlight` 单飞锁，在事务内再次做 CAS 检查，跨 Engine/进程并发请求不会重复调用 provider，失败请求也不会释放其他请求持有的锁 |
| Brain claim、provenance、grant、撤销 | 核心语义已实现，并已接入 Runtime 的显式 `brainScope` 读取和有界 `brainQuery` 检索；支持可选 PostgreSQL/pgvector 语义侧索引 | `FileBrainStore` 提供原子持久化；配置 `DATABASE_URL` 时使用 `PostgresBrainStore`，以版本化 JSONB 状态和乐观 compare-and-swap 防止多进程静默覆盖，并持久化审计、导出和 scope 删除；Run 只在明确提供 scope 时读取，claim 以带 hash 的 Source 注入 Planner/Executor/Reviewer；配置 `AEEIS_BRAIN_EMBEDDING_URL` 后，`PostgresBrainSemanticIndex` 按 model 维护可重建的向量索引，语义结果只提供候选 claim ID，Runtime 会重新执行 owner/tenant、grant、classification 和 active 状态校验；embedding 或 pgvector 不可用时回退确定性词法检索，不阻断 canonical Brain 写入；operator 可通过 `GET/POST /api/brain/semantic-reindex` 查看配置并从 canonical claims 全量重建派生索引；冲突会显式返回 409，调用方需重新读取后重试；真实 embedding SLA、容量与生产 operator 流程仍待验收 |
| Agent 协议 | schema 与校验已实现 | Agent Card、Task Brief、Context Pack、Grant、Result Envelope；Context/Evidence 引用允许 Git/Connector 来源 ID；每条 claim 必须引用本次 Context Pack 已绑定的 source/artifact/claim，artifact 也必须属于本次 Pack，外部 Agent 不能仅凭伪造 ID 引入证据 |
| 外部 Agent Gateway | 已实现本地目录、HTTP sync/async/stream 委托端口（stream 支持 NDJSON/SSE 的 agent-progress/1 事件、绑定校验、单调序号和有界读取，并把 telemetry 持久化到 Run Timeline）、Context Pack/Grant 校验、Context Acknowledgement、幂等并发合并、unknown/accepted/reconcile、Result Envelope 验证、Context 过期和 Grant calls/tokens 预算校验，并接入 Runtime Executor；Run 创建时把获准 Agent 的能力、输入/输出 schema、隐私策略和 canonical Card digest 冻结到 `capabilityCatalog`，Card 在实际委托前重新校验，变更后拒绝继续；异步 accepted 会在 Run 中保留 pending delegation 和 `waiting_external` 状态；delegation receipt 持久化支持重启恢复；支持按 Agent ID 配置的 OAuth client-credentials token 缓存和 HMAC signed request/response 验证；新增无需用户 Bearer token 的 `POST /webhooks/agents/:runId/callback`，按原始 body 做 5 分钟 HMAC 校验，只返回接收确认并把最终结果交给同一 Runtime 状态机，旧的 owner-scoped API callback 仍保留；重复 callback 按 receipt 幂等；Grant Budget Ledger 在本地文件模式使用原子替换，配置 `DATABASE_URL` 时使用 PostgreSQL 行锁和 durable entries，在 reserve/settle 阶段原子记录 calls/tokens/money 使用量，重启后未完成 reservation 只能 reconcile，避免重复副作用和预算绕过；外部传输失败、5xx/超时/限流与明确的 4xx、签名、schema、证据绑定或预算拒绝会分类记录，拒绝的响应正文不会进入 Evidence，但只要远端副作用或费用仍无法核实时继续保留 unknown/reconcile 边界；Agent Registry 已支持持久化 Discovery → Admission → Revocation、operator-only 管理 API、生命周期审计日志、可带证据的多维 reputation 观察、最终委托结果自动形成 delegation observation、动态接入 Gateway 和撤销后的重新发现阻断；新增有界 HTTPS/loopback Agent Card URL discovery，发现仍不会自动 Admission；可通过 `AEEIS_AGENT_ALLOWED_HOSTS` 对 discovery 和委托 endpoint 施加精确主机 allowlist；配置 `DATABASE_URL` 且未显式设置 `AEEIS_AGENT_REGISTRY_PATH` 时，Registry 使用 PostgreSQL 事务 advisory lock，支持跨进程并发更新和重启恢复；Compose 新增跨容器 `agent.fixture`，可验证 HTTP Agent Card、Context Pack、Grant 和 Result Envelope 的真实网络边界 | 流式进度已接入 Web 工作台；企业 OAuth/SSO 策略和真实外部 Agent 的生产验收仍待完成 |
| toolkit_new | manifest、版本冻结、allowlist、幂等 invoke、Receipt、unknown/reconcile HTTP 端口已实现；新增对 toolkit_new Registry index/Manifest 与 `/api/v1/t/:slug` 的协议转换适配器，并用本地 HTTP fixture 验证；可选验证 Registry canonical digest、keyset 根签名和 index/manifest Ed25519 签名，生产环境默认要求 `AEEIS_TOOLKIT_VERIFY_SIGNATURES=1` 并配置独立 `AEEIS_TOOLKIT_ROOT_PUBLIC_JWK`；启动期会校验根变量是公开的 Ed25519 JWK，缺失或无效会拒绝启动，只有显式 `AEEIS_TOOLKIT_VERIFY_SIGNATURES=0` 才关闭生产要求；新增 `npm run smoke:toolkit`，在显式注入 Registry URL、API Token 和外部保存的根公钥后读取真实 Registry、冻结发布版本、调用真实 `/api/v1/t/:slug` 并检查 provider Receipt | live smoke 已能验收真实 Registry 的协议、签名和工具调用链路；生产凭证、ACL、容量、账单和工具业务质量仍未验收 ；toolkit_new 当前 Receipt 查询端点使用用户会话认证，不能作为 AEEIS bearer-token unknown/reconcile 的机器间接口；AEEIS 已支持显式 `AEEIS_TOOLKIT_RECONCILE_URL`，要求受控 gateway 接受 `tool-reconcile/1` 并返回 `tool-result/1`，未配置时未知结果保持 unknown |
| ownhow | CLI governance adapter 已实现；Run 创建时 resolve，结果进入 Planner/Executor/Reviewer 上下文，结束后 record；record 会把审核置信度映射为 OwnHow 的 `--confidence`，并标记 `--verified-by automated`，避免真实治理记录丢失验证来源；已用本地 OwnHow CLI 验证 resolve/record/status，并要求明确 runtime；空提案队列的 OwnHow informational exit 会转换为 `[]`；AEEIS API 暴露 proposal 查询、显式 apply 和 rollback 入口 | 真实外部生产部署、授权服务器和治理闭环未验收 |
| planprice | HTTP catalog adapter 已实现并用本地 Planprice 服务验收；读取 grouped 渠道价格与汇率、按 capability/隐私筛选并锁定 provider/model/endpoint/归一化价格决策；每次 Model Decision 保存排序稳定的 `catalogHash` 和 `catalogRetrievedAt`，可重建当时的候选目录指纹；生产启动校验会要求 Planprice 路由拥有非空 provider endpoint/key JSON，并校验 provider/health URL 的 HTTPS 与无凭证边界；新增同源只读 `AEEIS_PLANPRICE_HEALTH_URL`，`CatalogModelResolver.health()` 区分目录探针/读取失败、无满足策略的候选和 provider 健康失败，并在 `modelHealth.catalog/provider` 保留子结果；`npm run smoke:planprice` 会读取真实 grouped/exchange-rates、验证 USD 归一化和稳定 hash，并检查运行中 AEEIS 的 catalog readiness 及实际选中的 provider/model | 目录数据不等于调用凭证；真实模型调用、价格源更新时间 SLA 和供应商计费仍未验收 |
| 主模型预算 | 已实现并测试 | Run 固定保存可选 token/USD 停止阈值；Planprice 冻结输入和输出 USD 价格，缺价费用预算在创建前拒绝；Planner/Executor/Reviewer 回执用于重建已报告用量，取消、暂停、无效输出仍记账；缺失 usage 阻断预算 Run 的 retry/replan，unknown 复用同一调用 key 后只结算一次；共享 owner/tenant 全局账本会为模型调用预留 calls，并在 unknown 核查时要求 provider audit metadata，按真实 token/USD usage 结算且保留超预算核查证据。工作台展示阈值、目录估算和未确认调用数。单次调用可越过 Run 自身阈值，非供应商硬扣费上限；工具、外部 Agent、Competition/Debate、Knowledge/项目源连接器和 RSI evaluator 已接入全局合并账本，局部业务账本仍保持独立；真实供应商账单对账未验收 |
| 外部执行预算 | 已实现并通过本地契约测试 | `externalBudget` 对 Run 内 Tool / Agent 的 calls/tokens/USD 合计限额，与主模型预算独立；最终回执重建 `externalUsage`，unknown/accepted 占用调用名额，reconcile 替换原记录；缺报维度和非 USD 费用显式保留，所需用量缺报或超额时停止且拒绝 retry/replan；精确阈值允许主模型在自身预算内整理已有证据；accepted 延后至最终回执结算，重复/并发 callback 不重复应用；暂停/取消在途返回不会恢复执行；新增 `POST /api/runs/:id/reconcile-cancelled`，取消后可只核查遗留 Tool/Agent，回执计量但结果不会复活 Run。HTTP / 工作台均可设置并查看。未含 Competition/Debate、RSI evaluator 和连接器检索，未做供应商真实账单验收；单次外部调用仍可超额 |
| RSI | candidate/evaluation/approval 状态机、低风险直接晋升以及中高风险 shadow→canary→promotion rollout 闸门、带证据观察和 rollback、默认 replay/holdout/safety 三道审批门、File 持久化 Repository、HTTP API，以及 replay/holdout/safety/cost/shadow 有界评测编排已实现；Run correction→evidence-bound candidate 入口、隔离 evaluator 的有界 `run-shadow/run-canary` 观测采集、durable rollout attempt 和 `reconcile-rollout` 已实现；`evaluate-suite` 现在按 gate 持久化 reservation/result，重启或并发时不会重复调用，异常状态必须通过 `reconcile-evaluation` 显式核查；评测器回传的 token/USD usage 会汇总结算到共享全局账本并写入 evaluation attempt；新增独立 durable activation registry，校验 promoted candidate、base version、内容 hash；`profile`/`prompt` 使用文本适配，`skill`、`workflow`、`tool-policy`、`model-policy` 使用 typed JSON schema，激活版本在新 Run 创建时快照，workflow/tool/model policy 会在预算、计划、工具审批和模型选择边界执行，model policy 的最大输出价格会传入 Planprice 选择并要求可验证价格，回滚可恢复父版本；独立 HTTP evaluator 协议和开发 Compose Fixture Evaluator 已通过三道 gate 的真实请求验收；`npm run smoke:compose` 现在还通过跨容器流程验证 production traffic canary 的启动、Run 的稳定 bucket 快照、evidenceRefs 观察和停止 | 生产 evaluator、生产观测和真实候选部署仍需验收；Skill 的具体 OwnHow 版本部署、Workflow Versioning、工具策略与企业模型策略的生产接入仍需验收；durable production traffic canary 已按 tenant 保存 route、候选内容 hash、base release、比例和暂停/恢复/停止原因，以稳定 Run ID 确定性分桶，并将 route/bucket 冻结到 Run；route 支持带 evidenceRefs 的 durable production observations、重复 ID 防护和 `safety { minScore, maxFailedObservations, autoPause }` 自动暂停，达到阈值后需人工核查才能恢复或回滚；全量激活、回滚和撤销会停止受影响 route；阶段转换、晋升、激活和 traffic 操作仍是显式操作 |
| 协作模型预算 | 已实现并通过本地测试 | Competition Brief 和 Debate 创建请求支持 `modelBudget.calls/tokens/moneyUsd`；参与者与 evaluator/Moderator/Adjudicator 共用该协作预算。每次 attempt 持久化实际模型 Pin、供应商 usage 与当次配置的 USD 价格，aggregate 保存缺报维度；不采信生成内容中的费用。超额或缺报不应用结果，unknown 需显式核查；并发准入、迟到结果与 evaluator 已结算未评分的恢复已覆盖测试。静态模型池可按 Agent 配置价格；配置 `AEEIS_PLANPRICE_URL` 时协作角色复用同一 resolver，按 Context privacy 选择模型并使用归一化 USD 价格，同时保存 `catalogHash` 与 `catalogRetrievedAt` 目录审计指纹。工作台与 Projection 展示模型元数据和用量。局部预算仍独立于 Run；已增加可选的全局 tenant/window ledger，但真实供应商账单验收仍未完成 |
| 全局合并预算 | 已实现并通过本地测试 | `src/global-budget.ts` 提供 File/InMemory/PostgreSQL durable ledger；按 owner/tenant 与 UTC `none/hour/day/month` 窗口选择 account，calls 在派发前 reservation，tokens/USD 从 provider usage settlement，unknown 与缺报维度阻止后续预算调用；重复幂等键返回原 reservation，PostgreSQL 以 advisory lock + 行锁保护跨进程并发。`AEEIS_GLOBAL_BUDGETS` 已接入 Run 主模型、Run Tool/外部 Agent、Knowledge/项目源连接器、Competition/Debate attempt 和 RSI evaluator gate/rollout attempt；连接器若返回受信任 provider usage 则按真实 tokens/USD 结算，明确无计量的非计量 connector 才按显式零 token/零 USD 结算并消耗一个 call，usage 同时绑定到 response hash；失败、协议校验失败或结果不可信进入 unknown。`POST /api/budgets/global/reconcile` 允许作用域内 owner/operator 提交外部核查的最终用量；新增 `POST /api/budgets/global/import` 接收 `aeeis-billing-import/1` invoice batch，先做 account/tenant/reservation 预检，再逐条幂等结算并保留超预算行的账单证据；本地局部预算仍保留为更窄的约束，供应商专用账单抓取和生产容量仍未验收 |
| 多 Agent 竞争 | 隔离运行与独立评估接口已实现；`blindEvaluation` 会对评测器隐藏真实 Agent ID；候选完整性、成本上限、重复评分防护已加固；新增 File 持久化协作状态、候选提交→独立评测→选定/partial API；Competition Brief 可携带受控 Context Pack；新增可配置内部模型池、隔离候选运行、盲评和持久化编排 API；候选或 evaluator 失败会持久化为 `failed` 并保留 failure reason；participant 与 evaluator 均有 durable attempt、input hash、状态、结果和重启后显式 reconcile，避免重复调用；Competition 记录现在带 owner/tenant scope，HTTP 列表、读取、变更按作用域隔离，operator 才能跨租户查看；新增 File/PostgreSQL Collaboration Trigger Policy，按事件类型、来源、风险、审核置信度和 required diversity 创建带 policy/event 幂等键的 Competition/Debate 实例，支持 `dispatch=create|run`，跨租户事件拒绝，`run` 复用模型池和现有预算/Attempt/unknown 边界并持久化 `dispatchState`；新增 owner/operator 作用域的 Trigger Decision reconcile，可绑定崩溃窗口中已创建的资源，或明确区分创建失败与派发失败，`unknown` 不会自动重发；Run 生命周期中的 `task.completed`、`task.failed`、`review.completed` 现在由可重放的内部 Trigger Pump 自动转换为受 owner/tenant、context、evidence 和本次 Run `allowedAgents` 约束的事件；Pump 在重启后可重复扫描，依靠 policy/event 幂等键避免重复创建协作资源；Compose smoke 已使用跨容器 Fixture Model 实际跑通 Competition 的两个候选、独立盲评和 Debate 的两个 participant、Moderator、Adjudicator、Attempt 结算与 `held` 终态，并额外验证普通 external Agent Run 的 `review.completed` 由内部 Pump 自动创建 Debate；PostgreSQL 回归覆盖两个连接并发 claim、进程重启重放和 owner/tenant 隔离；可选全局预算已经覆盖 participant/evaluator attempt | 仍需接入真实生产模型池和外部 Agent endpoint；当前模型池只负责候选/评估层，不替代主 Runtime 的任务执行；RSI evaluator 已接入全局账本但连接器检索尚未接入 |
| Debate / 外部投影 | 有界 Debate 领域模型已实现，含轮次、单 Agent 和总消息数上限；新增持久化房间、消息和关闭 API，并校验上下文版本、重复消息和证据引用；每条消息会留下可审计的 Moderator policy 结果，关闭时由证据绑定的 Adjudicator policy 生成 `decided` 或 `held` 结论；内部模型池支持可选独立 Moderator / Adjudicator 模型角色，模型审核结果单独持久化且不能绕过 policy；participant、Moderator、Adjudicator 调用均有 durable attempt，unknown/started 只能显式 reconcile，避免重启后副作用重放；Debate Brief 可携带受控 Context Pack；内部模型池按已持久化轮次恢复，重启后跳过已发言 Agent，避免重复消息；Competition/Debate 支持 File 或 PostgreSQL repository；Projection outbox 支持 File 或 PostgreSQL repository，持久化 Debate、Competition、Goal、Plan、Task、Run 和 Evolution 快照，统一使用 hash/幂等键、失败重试和 unknown/reconcile，并支持并发去重和有界批量 drain；PostgreSQL delivery 使用跨进程 advisory lock 持有外部 sink 调用期间的租约，避免多个 pump 重复发送同一事件，进程崩溃后由连接断开释放锁并允许恢复；服务重启和周期 pump 会从 RSI/协作/Run canonical state 重新发现快照，目的地和版本幂等隔离；Feishu 投影现支持 Incoming Webhook 卡片和应用 API Bot，应用模式使用 tenant access token、chat_id、消息 UUID，并可通过 `AEEIS_FEISHU_ALLOWED_CHAT_IDS` 限制目标群；新增 Hermes 本地 CLI sink，复用 `hermes send --to ... --json` 并保留 unknown/reconcile；三种 channel sink 都拒绝 private 内容并默认拒绝 confidential 内容；Debate、Competition 和 Projection event 现在带 owner/tenant scope，HTTP 读取、投影和 reconcile 按作用域隔离 | Linear/Jira 具体 adapter、Hermes/Feishu 真实凭证与生产投影权限、模型角色的生产凭证/权限仍需接入验收 |
| Feishu / Hermes Debate 入站 | 已实现协议适配与测试 | Feishu 使用 `POST /webhooks/feishu/events` 捕获原始请求体并校验 Lark/Feishu 签名、nonce、时间窗和可选 verification token；Hermes 使用 `POST /webhooks/hermes/events` 接收 `hermes-debate-event/1`，按 key id、timestamp、nonce 对原始 body 做 HMAC-SHA256 校验。两者都要求服务端显式配置群/room → Debate 与 sender → Agent 映射，未映射来源不会进入 Debate；普通文本/消息转为无证据 `clarification`，结构化消息仍经过 contextVersion、参与者、轮次和 claim policy；消息保留 `origin` provenance，按 transport/event/message 生成确定性 ID 幂等；接收成功后通过稳定 event ID 调用受控 `external.message` Collaboration Trigger，重试不会重复创建协作资源；已覆盖类、HTTP 原始体、错误签名、挑战响应、重复投递和 Trigger 回调测试。生产 Feishu 应用权限、Hermes Skill 密钥轮换/身份映射和群权限仍需验收 |
| Web 工作台 | 开发版已实现 | 单用户本地模式；支持创建/归档 Room、查看成员、邀请 editor/viewer/agent、撤销成员、把 Goal 绑定到 Room、创建领域 Goal、将 Run 绑定到 Goal、查看 Plan DAG、Execution Graph、Evidence Graph、按事件顺序的执行 Timeline 和历史计划、调度整张或单个 DAG 任务，并在任务行执行 pause/resume/cancel/reconcile/retry 控制；新运行可选择内置 `Project Pulse`，直接从粘贴资料生成证据绑定的九类项目报告，并把审核通过的 nextActions 投影为后续 Plan；Goal 绑定 Run 的产物现在可在工作台直接通过受证据和隐私约束的 Memory writeback 保存为 Goal 记忆，下一次上下文会按版本和分类重新检索；支持 Brain 检索、RSI 候选及生产流量 Canary 的启动、调比例、暂停、恢复和停止，并展示每个 Run 的命中 route/bucket；创建 Run 时显式填写 `allowedAgents` 委托白名单；支持用 schema JSON 创建并运行 Competition/Debate，查看 Competition 详情、候选/evaluator 未知尝试的显式 reconcile、Debate 消息/裁决详情、未决尝试核查和关闭，并展示 Room、Competition、Debate、Projection Outbox 与 Agent Registry（发现、批准、撤销、审计）状态；Reminder 面板支持创建一次性/有界重复提醒、状态筛选、加载更早分页、取消和重试；集合面板通过 `limit` 读取最近记录，避免历史测试数据阻塞工作台加载，完整事实源仍可由不带 `limit` 的 API 查询；成员管理支持 Room owner/editor 的共享管理，但仍没有多租户组织目录、SSO 用户交互或完整 ACL，仍未迁移 React |
| Principal / owner scope | 第一版已实现 | HTTP API 支持本地静态 Bearer token 映射，也支持可选 OIDC RS256 JWT（issuer、audience、exp/nbf、JWKS `kid`、租户/角色 claims 和短期 JWKS 缓存校验）；Goal、Plan、Memory、Context Manifest、Run、RSI candidate/activation、Competition、Debate 和 Projection event 的读写边界按 principal 隔离，跨 principal 访问返回 404；operator 可执行安装级运维；默认无映射时保持 `owner` 单用户兼容。用户交互授权、组织策略和动态密钥轮换由外部 OIDC 提供商负责，尚未完成生产身份平台验收 |
| Domain → Projection transactional outbox | Goal、Plan、Task 创建/变更已实现；Run/RSI/协作快照支持周期 reconciliation | Goal/Plan 创建和 Task transition 会把 canonical 状态与 Projection Intent 在同一 InMemory/JSON/PostgreSQL domain commit 中落盘；服务 pump 以包含 destination 的 idempotency key 写入 Projection Outbox，崩溃恢复和重复 enqueue 可安全重试；Run、RSI、Competition、Debate 通过版本 hash 快照周期重发现，跨独立 repository 保持明确的 eventual consistency 边界；外部 sink delivery/reconcile 仍是独立阶段 |
| Knowledge Provider | 已实现可替换 Provider 端口、本地确定性索引、受 schema 校验的 JSON File adapter、HTTPS HTTP adapter 和 PostgreSQL adapter；PostgreSQL adapter 提供持久化 upsert/delete、全文索引、classification/audience ACL 过滤、`tenantId` 租户过滤和 Runtime 信任边界二次校验；配置 embedding endpoint 后可启用 pgvector cosine 索引，向量按 model 绑定，写入时生成并支持有界、按模型持久化游标的 `reindexEmbeddings` 回填；新增 durable embedding reindex operator job，提供入队、单批执行、状态查询、失败记录、stale lease 恢复、指标和可选进程内 pump，向量写入与 checkpoint 在同一事务提交，重启可从上次成功批次继续并支持显式 reset，查询失败或未回填时回退全文检索；记录可声明 audience ACL，Runtime 可通过 `knowledgeQuery` 检索，并校验租户、数量、分类、audience、重复 ID 和 content hash，再把受 privacy 分类策略过滤的知识引用注入 Planner/Executor/Reviewer Context Manifest；File adapter 按文件签名增量重载，缺少 `tenantId` 的旧记录按全局记录兼容 | 真实 embedding 服务、生产级租户策略、批处理 SLA、pgvector 容量治理和生产 operator 部署仍未完成 |
| Project Pulse Source Provider | 已实现并测试 | `FileProjectSourceProvider`、`HttpProjectSourceProvider`、`GitProjectSourceProvider`、`LinearProjectSourceProvider` 和 `JiraProjectSourceProvider` 从服务端配置导入 `document`/`task`/`message`/`code` 记录；Linear 通过 GraphQL issueSearch 接入安装级 API key、团队过滤和版本化分页游标；Jira 通过 REST JQL 搜索接入 bearer 或 basic auth、项目过滤和版本化 `nextPageToken`；两者完整扫描结束后才允许删除未见记录，并拒绝把本地哨兵游标发送给供应商；Git 只读取授权目录内已提交 blob 和有限提交变化，排除常见凭证、二进制与符号链接；HTTP 边界使用 `project-source-sync/1` 与 `project-source-results/1`，支持 Bearer token；同步回执带前后游标、请求/响应 hash、更新模式和 provider receipt（包括可选 provider usage），File/Git/HTTP/Linear/Jira/Combined provider 与 Run 均已接入；运行时可选启用 File 或 PostgreSQL durable checkpoint store，按 provider、租户、查询和隐私范围建立游标，并将已接收的规范化 records 与游标在同一 CAS/原子替换中持久化，服务重启自动恢复未变化上下文；Run 后续解析失败时，已同步资料仍可被重用，旧的 cursor-only checkpoint 会先重新取证；文件落盘包含目录同步，失败不会提前发布内存状态；多来源先提交子来源证据再合并，分页和快照不会因全局裁剪而消费未交付记录；结果按租户、隐私分级、有界数量、重复 ID 和 content hash 校验后进入 Context/Evidence 链路；启用项目源查询时，Runtime 注入内置 `Project Pulse` guidance，要求输出进展、阻塞、风险、决策、下一步和未知信息并绑定证据；最终终结产物强制使用经 schema 校验的 `project-pulse/1` 结构（九类栏目，条目必须引用已观察证据），审核接受后 `nextActions` 会生成带 evidenceRefs 的后续领域 Plan，并可重新激活已完成 Goal；项目源同步在全局账本中占用一个 connector call，若回执带有受信任 provider usage 则按真实 tokens/USD 结算，明确无计量的非计量 connector 才按显式零 token/零 USD 结算，失败、协议校验失败或结果不可信进入 unknown；请求不能指定任意文件路径、URL、Git 根目录、Linear 凭证或 Jira 凭证 |
| React、生产运维 | 开发版可观测性、容器入口和 Compose 全栈验收已实现 | 当前 UI 是 TypeScript DOM；工作台新增面向交付的导航和 Run 当前交付摘要，优先显示状态、计划、任务、产物、事件和审核结果，DAG、Execution Graph、Evidence Graph、协作和治理面作为可继续深入的细节；`/readyz` 区分存活与就绪，固定模型可用 `AEEIS_MODEL_HEALTH_URL` 实际探测 provider，Planprice 目录路由可用 `AEEIS_MODEL_PROVIDER_HEALTH_URLS` 探测内部 Agent 策略选中的 provider，`/metrics` 暴露 Prometheus 文本指标；已增加 `AEEIS_HOST`、`AEEIS_TRUSTED_HOSTS`、显式反向代理 `AEEIS_PUBLIC_HOSTS` / `AEEIS_TRUSTED_ORIGINS` allowlist（公开 Host 不会扩大 `/internal/` Worker 信任边界）、生产启动配置校验、Dockerfile、PostgreSQL + Temporal Compose 开发环境、显式开发用内部 HTTP 模型和 evaluator 开关、GitHub CI，以及生成 custom-format + SHA-256 manifest 的 `npm run backup:postgres`；GitHub CI 现在在单元/PostgreSQL 回归后自动启动 Compose 并执行跨容器 smoke，失败时保留服务诊断；Compose PostgreSQL + Fixture Model + Fixture RSI Evaluator + Temporal + AEEIS Worker 已完成 `/readyz`、两节点领域 DAG（Goal → Plan → 调度 → 两次审批 → 自动解锁 → Temporal 执行 → 两个 Reviewer accepted → Goal completed）和 RSI 三道 gate 闭环验收；投影层同时提供 Feishu Incoming Webhook 与 Feishu 应用 API sink，后者使用 tenant access token、chat_id 和消息幂等 UUID，均执行隐私边界检查；备份恢复与应用 `/readyz` 演练已在隔离 PostgreSQL 临时库通过；生产迁移、备份上传、密钥管理、真实依赖和安全验收仍缺失。`npm run demo:model` 提供仅用于本地协议闭环的 Fixture Model，不代表真实模型能力 |

测试命令：

```bash
npm run typecheck
npm test
npm run build
npm run test:postgres  # 需要 AEEIS_TEST_DATABASE_URL
```

`tests/local-e2e.test.ts` 使用显式本地 fixture model，只证明协议和状态机能完成一次闭环，不证明任何真实模型的质量。

跨存储 hash 使用递归 canonical JSON，避免 PostgreSQL JSONB 重排字段后误判 model pin、计划或证据发生变化。

工作台的协作区还提供 Trigger Policy/Decision 管理：可以创建、启停和删除策略，查看按 owner/tenant 过滤的决策，并对资源创建或派发结果不明的决策执行四种显式 reconcile。该界面只调用已有受权限保护的 HTTP API，不改变 Trigger Service 的事实源。

Reviewer 输出现在允许携带 0 到 1 的可选 `confidence`；它会作为 `reviewConfidence` 写入 Run 事件，供内部 Trigger Policy 做低置信度协作分流。未提供该字段的旧模型输出继续兼容。

RSI 证据驱动提案发现已实现：`src/rsi-proposal-pump.ts` 扫描可重放的 Run 事件，识别低置信度/需要修订的审核、失败和纠正信号；每个信号带 owner/tenant、Run/event ID 和 Evidence refs，并回写 `rsi.improvement.detected`。Reviewer 可以附带具体的最小改动，但 Pump 会再次校验所有证据引用。只有携带完整最小 change 且引用本 Run 证据的信号才创建 `proposed` candidate；候选使用稳定 signal ID 去重，重复 pump、进程重启和并发创建不会重复候选。新增 `FileRsiProposalClaimStore` / `PostgresRsiProposalClaimStore` 短租约，跨 PostgreSQL 进程原子 claim，有效租约期间同一信号只准入一个 worker；租约不阻止过期持有者继续运行，进程崩溃后租约过期可恢复，Run 事件和候选幂等仍是最终正确性边界。Pump 在 claim 后重新读取 Run，避免使用过期证据；退出时等待在途 pump 完成。新增可选 `DurableRsiProposalSynthesis`：只对允许的 privacy class 运行独立且有单独 token/call 预算的模型提案器，持久化输入 hash、模型 pin、证据引用、Planprice 目录、provider 幂等键、usage 和 global budget reservation；模型只能返回最小 proposal 或 null，未知结果进入 durable unknown，必须通过 `POST /api/runs/:id/rsi-proposal-synthesis-reconcile` 显式核查，迟到响应不会覆盖核查结果。提案器不能评测、审批、晋升或激活。新增 owner-scoped `GET /api/evolution/signals` 和工作台“RSI 改进机会”面板，区分待补全、待评测和已形成候选。Pump 不评测、不审批、不晋升、不激活，没有具体 change 的信号在未启用提案器时只保留为待分析机会。服务启动和定时泵由 `AEEIS_RSI_PROPOSAL_INTERVAL_MS`、`AEEIS_RSI_PROPOSAL_BATCH`、`AEEIS_RSI_LOW_CONFIDENCE_THRESHOLD`、`AEEIS_RSI_PROPOSAL_CLAIM_LEASE_MS` 以及 `AEEIS_RSI_PROPOSAL_SYNTHESIS_*` 控制；RSI 与协作 Trigger Pump 的持久化扫描 cursor 已实现（见下文）；其他后台扫描和容量压测仍待完成。

PostgreSQL 的 Run、Domain、Brain、Brain semantic index、Grant ledger、Agent Registry、RSI candidate/activation、Competition/Debate、Collaboration Trigger、Knowledge、Project Source checkpoint、Task dispatch、Global Budget、Room membership 和 Projection Outbox adapter 都在启动 DDL 与兼容回填期间使用事务级 advisory migration lock；多个 API/Worker 进程同时首次启动时会串行执行各自 schema bootstrap，事务失败或进程断开后锁自动释放。

RSI 提案器验证补充：HTTP Fixture Model 已支持提案协议，专项测试覆盖真实 HTTP 传输到 proposed candidate、默认拒绝 private 数据、unknown 的文件仓库关闭/重开及审计核查、全局账本暂时失败时阻止新调用直至结算。固定模型可设置 `AEEIS_RSI_PROPOSAL_SYNTHESIS_PRICES`，目录路由禁止套用静态价格；提案质量仍未经过真实生产模型验收。


RSI / 协作 Trigger 的有界重放：两类 Pump 共用 `RunEventScanner`，使用各自独立的持久化 checkpoint。每次最多读取 25 个 Run，并最多检查 RSI 100 / 协作 500 个事件；RSI 的 `AEEIS_RSI_PROPOSAL_BATCH` 在此模式下同时限制检查事件数，而不只限制命中的 signal 数。扫描使用 Run ID 的主键顺序和冻结本轮上界，部分 Run 保存事件 offset 与 endOffset，避免自身追加 RSI 事件或并发写入让一次巡检永远追尾。所有入批事件尝试后才提交 cursor；单条失败会记录错误并在下一轮重访，崩溃或 checkpoint 保存失败则重放本批。checkpoint 的 CAS revision 拒绝旧 worker 覆盖新进度，调用、候选与 Trigger Decision 的原有幂等机制仍是正确性边界，cursor 不能视为成功回执。

File 使用 `AEEIS_RUN_SCAN_CURSOR_PATH`（默认 `${AEEIS_DATA_DIR}/run-scan-cursors.json`）原子写入，单写入者约束来自同目录 Run repository；PostgreSQL 使用 `aeeis_run_scan_cursors`。全轮结束后从起点重扫，后插入或后来追加的事件最迟在后续巡检中出现；这不是低延迟事件订阅或增量 changefeed。PostgreSQL 通过主键范围和 LIMIT 限制返回记录，File 每批仍枚举/排序目录文件名但只读取元数据索引。两类 Pump 已接入 `scanEventsPage` + `eventsPage` 事件 projection：没有事件的 Run 不再解析完整 aggregate，有事件的 Run 只在读取投影事件后加载一次 canonical Run 以构建证据和权限上下文；Run aggregate 仍是唯一事实源，投影缺失/落后时 `eventsPage` 回退 canonical Run，旧 checkpoint 和 at-least-once 重放语义保持不变。事件投影扫描已用“禁止完整 `scanPage`、空 Run 不调用 `get`”测试覆盖。启动恢复新增 `scanRecoveryPage`，File 使用可重建元数据索引，PostgreSQL 在 JSONB 边界筛选 started/未核查 Tool/Agent 状态，只加载待恢复 Run；恢复仍对每个候选执行原有 unknown、预算、领域同步和 Project Pulse 收敛。启动恢复、监控和 Projection 的其他完整扫描保持原有行为。服务退出会等待 RSI 与协作 Trigger Pump 完成再关闭共享 cursor 仓库。
# 2026-09-21 增量：可选 PrincipalDirectory 与 Room 邀请 fail-closed

新增 `src/security/principal-directory.ts`，提供 InMemory、只读 JSON 文件、HTTPS 目录适配器和进程内 `CachedPrincipalDirectory`。认证仍由静态 Principal token/OIDC 负责，目录只负责回答目标身份是否存在、属于哪个 tenant 以及是否为 `active`。配置 `AEEIS_PRINCIPAL_DIRECTORY_URL` 或本地开发的 `AEEIS_PRINCIPAL_DIRECTORY_PATH` 后，`AeeisService.addRoomMember()` 会拒绝不存在、返回身份与请求不一致、跨 tenant、suspended/disabled 身份；目录网络或协议错误通过 `PrincipalDirectoryUnavailable` 映射为 HTTP 503，并且不会写入 membership。缓存会合并相同身份的并发查询，对 active/不存在结果执行有界 TTL，支持按 principal/tenant 主动失效；失效、clear、close 会对在途结果做版本隔离，过期结果不会作为目录故障时的授权回退。目录 URL、token、timeout、缓存边界和开发 HTTP 例外在启动配置阶段校验，生产环境禁止使用本地文件目录；已配置目录的健康探针是 `/readyz` 的 required check，没有 health adapter 也会明确报告 required failure，`/api/status` 暴露非敏感健康状态。未配置目录时保持现有本地开发兼容行为。新增目录/邀请与配置回归，包含 HTTP 503、membership 不写入、失效竞态和返回身份校验；生产目录同步、跨实例失效广播、组织级 ACL、邀请审批策略和容量 SLA 仍待验收。
# 2026-09-21 增量：Delegation Grant durable revoke

Delegation Grant 现在由 File/PostgreSQL Grant Registry 持久化其不可变绑定（digest、subject、issuer、task、resource refs、revocationRef、expiry）和状态历史。Gateway 在 delegate、reconcile、异步 callback 以及流式 progress 的请求前统一检查 Grant；撤销或到期后不会再发起新的 submit。已经跨远端边界的调用仍可针对原 receipt 做 provider reconcile 或接受迟到 callback，以结算真实用量；Grant ledger 在同一锁/CAS 边界内写入 durable authorization receipt，明确本次结算是 `authorized` 还是 `isolated`。撤销/过期已先生效时，结果会被标记为 `isolated`，不会进入任务观察、产物、Evidence Graph 或 Agent reputation；如果结算已在线性化点获准，后续撤销不会追溯改变该结果。撤销保留审计记录，不把远端副作用改写成取消，未知结果仍需 provider reconcile。新增 operator API `POST /api/agents/grants/:id/revoke`，并覆盖跨重启撤销、迟到 callback 隔离、新调用拒绝、撤销后结算和 revoke-vs-settlement 竞态；同样覆盖 provider 执行期间自然过期的 Grant。旧版仅有预算 ledger 的 File 文件会兼容读取，首次新请求会补建 Grant 注册；生产部署应使用新 schema 完成一次受控迁移。Run Repository 与全局预算仍是独立事实源，authorization receipt 是跨存储提交的恢复边界，Run 写回和全局结算必须继续按该回执幂等收敛。
# 2026-09-21 增量：Tool capability durable authorization receipt

Tool 调用现在在 Run 的同一持久化提交边界生成 AEEIS-side authorization receipt。Receipt 绑定冻结的 `approvedTools` manifest/version、任务、capability grant 和 provider idempotency key；在 Run 已取消、能力版本不匹配或外部预算停止结果应用时，远端 usage 仍保留但结果标记为 `isolated`，不会写入 Task observations、Artifact、Evidence Graph、Reviewer 外部证据或 RSI proposal evidence。活动 Run 中完成的已批准调用标记为 `authorized`。每个 provider 尝试先写入 durable `executionToken`，恢复时清除旧 token，只有持 token 的 Engine 可以提交结果；provider 请求只包含公开 Tool Invocation 字段，不泄露 execution token、receipt 或预算内部字段；预算 reservation 在 provider 边界前失败会释放 token；unknown 仍需沿原 idempotency key 显式 reconcile。Run 提交会在 token 校验后完成全局预算结算，恢复后返回的旧 provider 结果不会覆盖 canonical Run 或重复结算。File 与 PostgreSQL Run repository 的串行/行锁提交共同决定该结果，跨进程取消/返回竞态可重建。新增运行时回归覆盖正常授权、provider 字段隔离、跨 Engine 单飞、预算失败清理、恢复后迟到结果和取消后隔离；定向测试 66 个通过，完整单线程测试 67 个文件、549 个测试通过、55 个跳过，`typecheck`、`build` 和 `git diff --check` 通过。Compose smoke 尚未重跑，因为当前 Docker 引擎不可达。这是 Tool 的 Run-local admission boundary，不等同于外部 Agent Grant 的可撤销注册表，也不撤销已发生的工具副作用。
# 2026-09-21 增量：外部 Agent durable fencing 与竞态验证

外部 Agent 委托现在与 Tool 使用同一类持久化 execution token：跨独立 Engine 只有一个实例可以跨出 provider 边界；provider 请求会裁剪 AEEIS 内部 executionToken、receipt、reconcile 和全局预算字段。恢复期间会先把 pending delegation 变成带未知 receipt 的可核查状态，清除旧 token，并保留已经确定的全局预算账号；迟到的旧响应只能留下 accounting receipt，不能覆盖 canonical Run、写入 Task observation 或重复结算预算。同步 reconcile、异步 callback 和 accepted 结果共用 durable Run 提交边界，重复回调按 idempotency key 幂等处理；全局预算 reservation 在 provider 调用前失败时释放 token 并保存失败状态。旧 Run 快照缺少 privacy/allowedAgents 时，协作事件回放采用 fail-closed 默认，不会因后台 pump 反复报错。

新增 `tests/runtime-agent-fencing.test.ts` 与 `tests/postgres-agent-fencing.test.ts`，覆盖两个独立 Engine 竞争提交、提交阻塞期间抢占、running/paused/cancelled 恢复、迟到响应隔离、回调与 reconcile 竞争、预算预留失败和 pre-binding 崩溃窗口。File 契约 7 tests 通过；PostgreSQL 23 个测试文件、64 tests 通过。全量本地回归为 68 个文件、557 tests 通过、62 个跳过；`typecheck`、`build` 与 `git diff --check` 通过。真实 Agent provider、组织授权、容量和生产网络仍需部署侧验收。
# 2026-09-22 增量：Channel Identity 解析边界

Feishu/Hermes Debate 入站新增独立 `channel-identity/1` 事实源，区分外部平台 subject、tenant、稳定 AEEIS Agent subject、状态和验证 provenance。支持 InMemory、JSON 和 HTTPS resolver；HTTPS 返回的记录必须与请求的 channel、externalSubjectId、tenant 完全一致。resolver 配置后优先于旧的静态 sender map，未知、跨租户、非 Agent、suspended 或 revoked identity 都 fail closed；兼容静态映射只用于本地旧配置。Debate message 会保存当时的完整 identity snapshot 和原始 senderRef，后续映射变化不会改写历史 provenance。`/readyz` 与 `/api/status` 展示 resolver 健康状态，生产配置要求 HTTPS URL，JSON 文件仅限开发。新增 Feishu/Hermes、resolver 和配置回归；真实组织身份目录、轮换、跨实例缓存失效和生产 SLA 仍需部署侧验收。
# 2026-09-22 增量：Shared Session canonical event 事实源

Room 现在有独立的 `session-event/1` append-only 事实源，当前 Room 即 Shared Session 的边界。事件包含 room/goal、owner/tenant、actor、type（包括 `canonical_response`）、Context Manifest binding hash、完整 audience snapshot、evidence refs、content hash、sequence 和幂等键；外部 Debate、Feishu、Hermes 仍是输入或投影，不能成为规范答复的事实源。创建事件要求写入者是 Room owner/editor/agent，并且当前能读取绑定 Manifest；读取会重新验证 Manifest binding、audience digest 和实时 Room membership，因此后加入成员、撤销成员或角色变化后不能读取旧的受限事件。提供 InMemory、单写 JSON 和 PostgreSQL repository，支持稳定 sequence 分页和 idempotency conflict；HTTP 暴露 `GET|POST /api/rooms/:roomId/session-events`。新增领域和 HTTP 回归，PostgreSQL 真实并发/容量和跨区域事件恢复仍需部署侧验收。
# 2026-09-22 增量：Shared Session 事件投影边界

Projection Outbox 新增 `session_event` aggregate type。`POST /api/collaborations/projections` 在创建投影前通过 `SessionEventService.get()` 重新验证 Room membership、Context Manifest binding 和 audience digest；只有通过资源 owner/operator HTTP 边界的请求才能产生外部副作用。事件在创建时冻结 Context Manifest 中的最高 `classification`（旧事件默认 `internal`），Feishu/Hermes sink 会按同一 privacy policy 拒绝 private/confidential 事件，并将事件类型、发起者、内容和 Evidence 数量渲染为受控摘要。投影 payload 是 canonical `session-event/1` 快照，外部渠道仍不能成为 Shared Session 事实源。新增 HTTP 回归覆盖事件读取后投影、scope、幂等和敏感级别边界；`typecheck`、`build` 和 70 个定向测试通过。

# 2026-09-22 增量：完整回归

本轮工作台与 Shared Session 改动后，`npm test` 通过 75 个测试文件、626 个测试，23 个 PostgreSQL 文件因未注入测试数据库而跳过；`npm run typecheck`、`npm run build` 和 `git diff --check` 通过。PostgreSQL 17 隔离回归已单独通过 24 个文件、68 个测试。

# 2026-09-22 增量：Shared Session PostgreSQL 回归

在隔离的本机 PostgreSQL 17 临时实例上运行 `AEEIS_TEST_DATABASE_URL=... npm run test:postgres`，24 个 PostgreSQL 测试文件、68 个测试全部通过；新增的 `tests/postgres-session-events.test.ts` 也实际执行通过。该回归覆盖 Session Event sequence、幂等写入、租户范围和重启读取边界；生产容量、跨区域恢复和真实外部依赖仍需部署侧验收。

# 2026-09-22 增量：Shared Session 工作台时间线

Web 工作台的每个 Room 现在会读取并展示受当前成员权限约束的 `session-event/1` 规范事件时间线，显示 sequence、事件类型、actor、Goal、Context Manifest、audience digest 和 Evidence refs；分页事件可以继续加载，Shared Session 未配置或当前身份无权读取时明确显示不可用。展示层只读 Session Event 事实源，不把 Debate、Feishu 或 Hermes 消息伪装成 canonical event。`npm run typecheck`、`npm run build`、`tests/session-events.test.ts`（4 tests）和 `tests/http-runtime.test.ts`（56 tests）通过；Fixture `npm run smoke:local` 也通过。


# 2026-09-22 增量：Room 级多 Goal Shared Session Context

新增 Room 级 Context Manifest API（`POST|GET /api/rooms/:roomId/context-manifests`）。它只组合同一 Room 中已经发布、且对所有当前接收者可读的 Goal Manifest，冻结 `goalIds`、每个来源的 binding hash、Room audience snapshot 以及去重后的 Memory/Knowledge refs；不从 Room membership 推导新的 Goal 资料权限。`session-event/1` 的 `goalId` 现在可选：省略时事件绑定 Room 级多 Goal Context Manifest，仍经过所有来源、当前 audience 和 membership 的实时验证。Goal 与 Room 归属、Goal 脱离 Room、来源内容或受众变更都会使事件不可读；非 owner 读取仍过滤 confidential/private 内容。PostgreSQL session event 表兼容旧的非空 `goal_id` 记录，新记录允许 Room 级事件。新增 `tests/session-context.test.ts` 覆盖跨 Room、租户、角色、成员撤销、来源冻结、File 重启和旧 Goal 事件兼容；全量本地测试为 76 个文件、632 个测试通过、66 个跳过，`typecheck`、`build` 和 `git diff --check` 通过。大规模多 Goal 组合查询与生产跨区域恢复仍待部署侧验收。

# 2026-09-22 增量：Shared Session canonical response revision/retract

`session-event/1` 增加 append-only 的 `operation=publish|revise|retract`、`targetEventId`、`revision` 和 `retractionReason`。`POST /api/rooms/:roomId/session-events/:eventId/revise` 只能从当前可读的最新 `canonical_response` 追加下一版，`retract` 只能追加最新版本的撤回事实；旧事件不被删除或原地修改，分支修订、对已撤回事件继续操作和跨 Room/Manifest 目标都会拒绝。读取、分页和 Projection API 会验证目标关系与当前 ACL，投影摘要会携带操作和目标 ID。新增 Session Event HTTP/领域回归覆盖幂等、线性 revision、撤回、旧版本审计和投影边界；`npm run typecheck`、`npm run build`、`git diff --check` 通过，定向 63 tests 通过。生产投影 sink 的跨版本排序和容量仍需部署侧验收。
# 2026-09-22 增量：完整本地协议闭环

`npm run demo:full-local` 现在调用独立的 `scripts/smoke-full-local.mjs`，不再只覆盖普通 Run 和 DAG。该 smoke 在同一套无 Docker、动态端口的开发协议栈中验证：Planprice catalog routing、OwnHow Skill governance、RSI proposal synthesis、外部 Agent 委托与 Result Envelope、Trigger Policy 事件幂等、Competition、Debate、Project Pulse 项目源 checkpoint 与 successor Plan、两节点 DAG、RSI replay/holdout/safety 评测、审批、基线激活、production traffic Canary、流量观察、停止和新候选激活。首次使用空数据目录时，smoke 会先通过完整评测/审批/晋升/激活流程建立可审计的 RSI 基线，再验证新候选进入 Canary；不会把不可用的 `prompt/1` 伪装成活动基线。

独立验证已使用动态临时数据目录实际通过，Run/DAG、Competition、Debate、外部 Agent、Project Pulse 和 RSI 闭环均收敛到预期状态。Fixture 仍只证明协议、状态机、持久化和接入边界，不代表真实模型质量、真实 Feishu/Hermes 权限、生产 Temporal/PostgreSQL 容量或供应商 SLA。

# 2026-09-22 增量：整体实现审计与恢复回归

按设计基线逐项核对后，Goal/Plan/Task/DAG、Execution/Evidence Graph、Brain/Memory/Knowledge、Temporal 适配、Room/Shared Session、Toolkit/OwnHow/Planprice 边界、外部 Agent、Competition/Debate、Feishu/Hermes 入站与投影、受控 RSI、预算、提醒、观测和恢复脚本均已有对应实现与回归入口。当前可复现证据为：全量本地测试 76 个文件、634 个测试通过、67 个跳过；PostgreSQL 17 实例回归 24 个文件、69 个测试通过；`npm run smoke:local:restart` 实际验证 Run 在 API 重启后保留 `needs_approval`、计划 hash 和最终 Evidence 结果；`npm run demo:full-local` 实际验证无 Docker 完整协议闭环；`npm run typecheck`、`npm run build` 和 `git diff --check` 通过。

这份审计没有把真实模型质量、生产 Temporal/PostgreSQL 容量、Feishu/Hermes 组织权限、外部 Agent SLA、备份上传或跨区域恢复标为已完成；这些仍是部署侧验收项目。
