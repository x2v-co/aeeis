# AEEIS

> 一个由用户拥有 Brain、可持续推进任务、并以证据约束自我改进的 RSI Agent。

AEEIS 正在作为独立 Agent 开发，不是 `ai-chat-system` 的改版，也不是聊天界面。当前运行时已经能把真实目标交给模型：生成动态 DAG、等待用户批准、按任务读取本次授权资料、产生产物、独立审核，并在暂停、取消、重启和模型结果不明时保持可解释状态。

当前版本是开发中的可验证纵向切片，尚未宣称生产可用。工具网关、OwnHow Skill 治理、planprice 模型目录、Brain 持久化、多 Agent 协作和 RSI 自动评测仍在逐步接入。

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

也可以配置 `AEEIS_PLANPRICE_URL` 启用按能力、隐私策略和目录价格的模型选择；必须额外为选中的 provider 配置 `AEEIS_MODEL_PROVIDER_ENDPOINTS` 和 `AEEIS_MODEL_PROVIDER_KEYS`。工具和 Personal Method 治理分别通过 `AEEIS_TOOLKIT_*`、`AEEIS_OWNHOW_*` 接入。外部工具版本在 Run 创建时冻结，未知结果只能通过 provider reconcile 恢复。

外部 Agent 通过 `AEEIS_AGENT_CARDS` 注册（JSON 数组），Run 请求仍需显式提供 `allowedAgents`；Agent Card 只描述能力，真正的任务级权限由 AEEIS 生成的 Context Pack 和 Delegation Grant 决定。

开发环境可以使用 loopback HTTP；非 loopback endpoint 必须使用 HTTPS。模型调用不会自动重试，传输结果不明会进入 `unknown`，需要显式核查后才能再次调用。

## 当前 API

- `GET /health`
- `GET /api/status`
- `GET /api/runs`
- `GET /api/runs/:id`
- `POST /api/runs`
- `POST /api/runs/:id/approve|pause|resume|cancel|answer|retry|reconcile|dispatch`
- `POST /internal/runs/:id/advance`（仅 Worker token）

运行状态和事件保存在 `data/runs`；设置 `DATABASE_URL` 可切换到 PostgreSQL。设置 `AEEIS_RUNNER=temporal` 后，API 会把 Run 调度到 Temporal，Worker 使用 `npm run worker` 启动。

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
