# AEEIS

> 一个由用户拥有 Brain、可持续推进任务、并以证据约束自我改进的 RSI Agent。

AEEIS 正在作为独立 Agent 开发，不是 `ai-chat-system` 的改版，也不是聊天界面。当前运行时已经能把真实目标交给模型：生成动态 DAG、等待用户批准、按任务读取本次授权资料、产生产物、独立审核，并在暂停、取消、重启和模型结果不明时保持可解释状态。

当前版本是开发中的可验证纵向切片，尚未宣称生产可用。核心运行时、Brain 读取、Knowledge、协作状态平面和受治理 RSI 候选已经接入；真实外部部署、生产观测和多用户控制面仍在建设。

Goal、Plan、Task、Memory 也由 AEEIS 自己持有，并通过 `/api/goals`、`/api/goals/:id/plans`、`/api/goals/:id/plans/revise`、`/api/plans/:id/tasks/:taskId/transition` 和 `/api/goals/:id/memories` 暴露；本地模式使用 `data/runs/domain.json`，配置 `DATABASE_URL` 后领域对象和 Run 一起写入 PostgreSQL。使用 `/api/goals/:id/runs` 启动时，Run 会保存 `goalId`，Planner 产出的计划会创建对应领域 Plan，节点执行会写入领域 Receipt。

## 本地运行

需要 Node.js 22 或更新版本。

```bash
npm install
npm test
npm run typecheck
npm run dev
```

服务默认监听 `http://127.0.0.1:4323`，工作台位于 `/`。没有模型配置时，页面只显示配置状态，创建运行会返回 `503`，不会生成模拟成功结果。

复制 `.env.example` 后配置一个 OpenAI-compatible endpoint：

```bash
cp .env.example .env
set -a; source .env; set +a
npm run dev
```

也可以配置 `AEEIS_PLANPRICE_URL` 启用按能力、隐私策略和目录价格的模型选择；AEEIS 读取 Planprice 的 `/api/products/grouped?type=llm` 渠道价格，并用 `/api/exchange-rates` 的汇率归一到 USD；没有可验证汇率时不会把本地币种数字直接拿来比较。必须额外为选中的 provider 配置 `AEEIS_MODEL_PROVIDER_ENDPOINTS` 和 `AEEIS_MODEL_PROVIDER_KEYS`。工具和 Personal Method 治理分别通过 `AEEIS_TOOLKIT_*`、`AEEIS_OWNHOW_*` 接入。启用 OwnHow 时要设置 `AEEIS_OWNHOW_RUNTIME`，或者在每个 Run 提供 `skillRuntime`，因为 OwnHow 的解析必须绑定具体宿主 runtime。对 toolkit_new，优先设置 `AEEIS_TOOLKIT_REGISTRY_URL`（指向 `/api/v1/registry`）；AEEIS 会读取 Registry index/Manifest，再把已批准的版本调用转换为 toolkit_new 的 `/api/v1/t/:slug` 请求，并保留自己的 allowlist、幂等键和 Receipt。旧的 `AEEIS_TOOLKIT_MANIFEST_URL` + `AEEIS_TOOLKIT_INVOKE_URL` 仍支持自定义网关。外部工具版本在 Run 创建时冻结，未知结果只能通过 provider reconcile 恢复。

Knowledge 可以通过 `AEEIS_KNOWLEDGE_URL` 接入受 HTTPS 保护的服务，也可以用 `AEEIS_KNOWLEDGE_FILE` 指向本地 JSON 数组。两种方式都必须返回或包含完整的 Knowledge Record（分类、来源、更新时间和内容 hash），Runtime 会在注入上下文前再次按 privacy 过滤，并校验数量、分类、重复 ID 和内容 hash。

外部 Agent 通过 `AEEIS_AGENT_CARDS` 注册（JSON 数组），Run 请求仍需显式提供 `allowedAgents`；Agent Card 只描述能力，真正的任务级权限由 AEEIS 生成的 Context Pack 和 Delegation Grant 决定。Gateway 会校验 Context Pack 过期时间、Context Acknowledgement、幂等并发和 Grant 的 calls/tokens/money 预算，并把预算账本持久化到 `${AEEIS_DATA_DIR}/agent-grants.json`，因此重启后已 reserve 的委托只能 reconcile。`signed_request` Agent 可在 `AEEIS_AGENT_SIGNING_KEYS` 中按 Agent ID 配置共享密钥，OAuth Agent 可通过 `AEEIS_AGENT_OAUTH_CONFIG` 使用 client-credentials token；HTTP 传输会验证 HTTPS、签名响应和结构化 Result Envelope。

OAuth 仅支持机器间 client-credentials。每个 Agent ID 配置 `tokenUrl`、`clientId`、`clientSecret` 和可选 `scopes`；`authMethod` 默认 `client_secret_basic`，也可选 `client_secret_post`。token 只在内存缓存，并发申请会合并；按服务商有效期提前刷新，不报告有效期则不缓存。不跟随 token endpoint 重定向，也不在认证失败后自动重发 Agent 任务。用户交互授权、SSO 和生产授权服务器仍未验收。

开发环境可以使用 loopback HTTP；非 loopback endpoint 必须使用 HTTPS。模型调用不会自动重试，传输结果不明会进入 `unknown`，需要显式核查后才能再次调用。服务重启发现未完成的 Tool/Agent 调用时，会恢复为带 Receipt 的 `unknown`，强制走 provider reconcile，不会直接再次发送副作用请求。

## 当前 API

- `GET /health`
- `GET /readyz`（依赖未就绪时返回 503，供部署和长时任务监控使用）
- `GET /metrics`（Prometheus 文本格式的运行、RSI、投影和依赖指标）
- `GET /api/status`
- `GET /api/skills/proposals`、`POST /api/skills/proposals/:id/apply`、`POST /api/skills/:methodId/:version/rollback`（启用 OwnHow 后可用；apply 要求显式 `approvalRef`）
- `GET /api/runs`
- `GET /api/runs/:id`
- `POST /api/runs/:id/corrections`（把带证据引用的用户纠正转为受治理 RSI candidate）
- `GET /api/runs/:id/graphs`
- `POST /api/runs`
- `POST /api/runs/:id/approve|pause|resume|cancel|answer|retry|reconcile|replan|dispatch`（`replan` 会保留旧计划并生成新的版本）
- `POST /internal/runs/:id/advance`（仅 Worker token）
- `GET /api/evolution/candidates`
- `GET /api/evolution/candidates/:id`
- `POST /api/evolution/candidates`，以及 `/:id/evaluate|evaluate-suite|approve|start-shadow|run-shadow|record-shadow|start-canary|run-canary|record-canary|reconcile-rollout|promote|rollback`
- 配置 `AEEIS_RSI_EVALUATOR_URL` 后，额外支持 `/:id/evaluate-suite`，按 replay、holdout、safety（以及可选 cost/shadow）套件逐门运行隔离 evaluator
- `GET|POST /api/collaborations/competitions`，以及 `/:id/candidate|begin-evaluation|score`
- 配置 `AEEIS_COMPETITION_AGENT_MODELS`、`AEEIS_COMPETITION_EVALUATOR_BASE_URL` 和 `AEEIS_COMPETITION_EVALUATOR_MODEL` 后，额外支持 `POST /api/collaborations/competitions/:id/run`：候选模型并发隔离运行，独立评估器只接收盲化候选，结果持久化回 Competition。
- `GET|POST /api/collaborations/debates`，以及 `/:id/message|close|run`；配置内部模型池后，`run` 按轮次驱动 Debate 并在达到边界或形成 decision 时关闭房间。
- `GET|POST /api/collaborations/projections`，以及 `/:id/deliver`、`/deliver-pending`；投影 outbox 以幂等键持久化 Debate/Competition 快照，配置 `AEEIS_PROJECTION_SINK_URL` 后可投递到飞书/Hermes 等渠道；也可配置 `AEEIS_FEISHU_WEBHOOK_URL` 使用内置飞书 Incoming Webhook 卡片适配器，私有内容会被拒绝。

运行状态和事件保存在 `data/runs`；设置 `DATABASE_URL` 可切换 Run、Goal、Plan、Receipt、Memory 和 Context Manifest 到 PostgreSQL，启动时会创建所需表和索引。设置 `AEEIS_RUNNER=temporal` 后，API 会把 Run 调度到 Temporal，Worker 使用 `npm run worker` 启动。

创建 Run 时可以提供 `knowledgeQuery`、`knowledgeMaxItems` 和 `brainScope`。配置 Knowledge Provider 后，Runtime 会按 Run 的 privacy 级别检索知识，并把命中的记录作为带 hash 的来源交给 Planner、Executor 和 Reviewer；填写 `brainScope` 时，Runtime 会按 owner 授权读取对应 Brain claims、留下 read 审计并把 claim hash 作为来源；没有配置对应 Provider 时会明确失败。

RSI candidate API 只管理有证据的变更候选：低风险候选可以在 `proposed → evaluating → approved → promoted` 后显式晋升；中高风险候选必须经过 `approved → shadowing → canarying → promoted`，每个阶段都要记录带证据的观察，失败会进入 `held` 并可回滚。Run 的 `/corrections` 入口会校验纠正引用是否来自该 Run 的真实上下文、产物、Receipt 或模型调用，再创建绑定 correction 引用的 candidate。默认必须分别通过 replay、holdout、safety 三道评测门。它不会自动修改生产 Agent。

配置隔离 evaluator 后，`run-shadow` 和 `run-canary` 接收 `{ "cases": [{ "id": "case.1", "input": {} }] }`，每批最多 100 项，逐项预留 attempt、调用并落盘；遇到失败或无有效证据即停止批次。case ID 在同一候选阶段内不可重复。attempt 保留输入 hash、时间和观察结果，调用中断后的 `started` 记录会阻止新调用和阶段晋升。`reconcile-rollout` 接收 `attemptId`、`outcome`（`completed` 或 `failed`）、必填 `reason`；完成结果还必须提供 `passed`、`score` 和 `evidenceRefs`。该入口记录操作者核查结论，不重新调用 evaluator。这里的 canary 是隔离评测模式，实际生产流量分配和候选部署尚未实现。

竞争 API 把候选结果和独立评测拆成两个阶段，并持久化成本、评分、选定候选和 `partial` 状态；评测者不能是参赛 Agent。启用 `blindEvaluation` 时，评测视图只暴露 `candidate_1` 这类匿名键，最终映射只保存在 AEEIS 状态中。Debate API 持久化房间和消息，强制参与者、轮次、单 Agent 消息数、总消息数和上下文版本边界。Projection outbox 只发送带 hash 和幂等键的结构化快照，渠道投递失败会保留 failed 状态并可重试；渠道消息不是 canonical 状态。

## 设计边界

AEEIS 自己持有 Goal、Plan Graph、Execution Graph、Evidence Graph、权限、Context Manifest、Receipt 和 RSI Candidate 的语义。Temporal 只负责耐久执行；toolkit_new 提供工具能力；ownhow 提供 Skill 治理；planprice 提供模型目录和价格数据。所有外部结果先经过版本、授权、证据和 Receipt 校验。

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

## License

Apache-2.0。产品名称和商标归其所有者所有。
