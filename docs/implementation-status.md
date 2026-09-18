# AEEIS 当前实现状态

这份清单用于防止把“设计存在”误报成“产品已完成”。状态只以当前仓库代码和测试为准。

| 能力 | 当前状态 | 证据 / 限制 |
|---|---|---|
| 动态 Planner DAG | 已实现并测试 | `src/runtime/engine.ts`；规划结果需要精确 hash 审批；失败运行可显式 `replan`，旧 Plan 保留并生成新版本；`/api/runs/:id/graphs` 投影最新 Plan、Plan history、Execution、Evidence 视图 |
| Goal / Plan / Task / Memory 领域服务 | 已接入本地 API 并持久化 | `src/application/aeeis-service.ts`、`src/adapters/json-store.ts`；支持 Goal、Plan、Plan revision、Task transition、Receipt、Memory、Context Manifest；Run 的 failed/unknown/needs_input/cancelled 状态会同步到领域 Task Receipt；Task 转移将 Plan、Goal 完成状态及 Receipt 一次提交，并对读取的 Plan 快照做条件写检查；并发冲突重新读取和校验状态；JSON 领域事实源采用独占写锁、临时文件、`fsync`、原子替换和目录同步；`/api/goals/:id/runs` 将 Goal 关联到 Run，Planner 计划和节点执行会同步到领域 Plan/Receipt；两套事实源仍保持明确边界 |
| 任务执行、证据和 Reviewer | 已实现并测试 | 仅能读取 Run 提供的来源；artifact 引用会校验 |
| File 持久化 | 已实现并测试 | 原子替换、fsync、单写入者锁 |
| PostgreSQL 持久化 | Run 与 Goal Domain 均有适配器 | `PostgresRunRepository` 和 `PostgresAeeisStore` 启动时创建表、索引并使用事务/JSONB 持久化；Task 转移在同一事务内锁定 Plan/Goal 并写入回执；当前环境没有 PostgreSQL 服务，未做真实数据库验收；可设置 `AEEIS_TEST_DATABASE_URL` 运行集成测试 |
| Temporal Workflow / Worker | 已实现并实跑 | Activity 已抽出为独立协议边界：网络/限流/5xx 使用有界指数重试，认证/配置/协议错误标记为 durable non-retryable；Workflow 仍按 Run 状态等待 signal，并每 100 个 tick Continue-As-New；本地 Temporal fixture Run 已完成；生产部署、版本迁移仍未验收 |
| unknown / pause / cancel / restart | 已实现并测试 | 不明模型结果需要显式 reconcile；模型调用持久化稳定的 `model:<runId>:<callId>` provider 幂等键，恢复时复用原调用记录和 key；服务重启发现未完成 Tool/Agent 调用时会生成 durable unknown Receipt 并强制 provider reconcile，避免盲重试 |
| Brain claim、provenance、grant、撤销 | 核心语义已实现，并已接入 Runtime 的显式 `brainScope` 读取；Brain grant、state 和 API query 均做 schema 校验 | `FileBrainStore` 提供原子持久化、审计、导出和 scope 删除；Run 只在明确提供 scope 时读取，claim 以带 hash 的 Source 注入 Planner/Executor/Reviewer；尚未接入向量检索 |
| Agent 协议 | schema 与校验已实现 | Agent Card、Task Brief、Context Pack、Grant、Result Envelope |
| 外部 Agent Gateway | 已实现本地目录、HTTP sync/async/stream 委托端口、Context Pack/Grant 校验、Context Acknowledgement、幂等并发合并、unknown/reconcile、Result Envelope 验证、Context 过期和 Grant calls/tokens 预算校验，并接入 Runtime Executor；delegation receipt 持久化支持重启恢复；支持按 Agent ID 配置的 OAuth client-credentials token 缓存和 HMAC signed request/response 验证；新增持久化 Grant Budget Ledger，在 reserve/settle 阶段原子记录 calls/tokens/money 使用量，重启后未完成 reservation 只能 reconcile，避免重复副作用和预算绕过 | 尚未接入 Web 工作台、企业 OAuth/SSO 策略和真实外部 Agent 的生产验收 |
| toolkit_new | manifest、版本冻结、allowlist、幂等 invoke、Receipt、unknown/reconcile HTTP 端口已实现；新增对 toolkit_new Registry index/Manifest 与 `/api/v1/t/:slug` 的协议转换适配器，并用本地 HTTP fixture 验证 | 尚未绑定 toolkit_new 的部署实例和真实工具调用；生产凭证与 ACL 未验收 |
| ownhow | CLI governance adapter 已实现；Run 创建时 resolve，结果进入 Planner/Executor/Reviewer 上下文，结束后 record；已用本地 OwnHow CLI 验证 resolve/record/status，并要求明确 runtime；AEEIS API 暴露 proposal 查询、显式 apply 和 rollback 入口 | 真实外部生产部署、授权服务器和治理闭环未验收 |
| planprice | HTTP catalog adapter 已实现并用本地 Planprice 服务验收；读取 grouped 渠道价格与汇率、按 capability/隐私筛选并锁定 provider/model/endpoint/归一化价格决策 | 目录数据不等于调用凭证；provider endpoint/key 仍需配置，真实模型调用和价格新鲜度 SLA 未验收 |
| RSI | candidate/evaluation/approval 状态机、低风险直接晋升以及中高风险 shadow→canary→promotion rollout 闸门、带证据观察和 rollback、默认 replay/holdout/safety 三道审批门、File 持久化 Repository、HTTP API，以及 replay/holdout/safety/cost/shadow 有界评测编排已实现；新增 Run correction→evidence-bound candidate 入口、隔离 evaluator 的有界 `run-shadow/run-canary` 观测采集、durable rollout attempt 和 `reconcile-rollout` | 真实 evaluator 和生产观测仍需部署与验收；阶段转换和晋升仍是显式操作，候选不会自动修改生产 Agent |
| 多 Agent 竞争 | 隔离运行与独立评估接口已实现；`blindEvaluation` 会对评测器隐藏真实 Agent ID；候选完整性、成本上限、重复评分防护已加固；新增 File 持久化协作状态、候选提交→独立评测→选定/partial API；Competition Brief 可携带受控 Context Pack；新增可配置内部模型池、隔离候选运行、盲评和持久化编排 API；候选或 evaluator 失败会持久化为 `failed` 并保留 failure reason；participant 与 evaluator 均有 durable attempt、input hash、状态、结果和重启后显式 reconcile，避免重复调用；Gateway 可承载外部委托，Executor 可按 allowlist 委派并收回结果 | 仍需接入真实生产模型池、自动触发策略、预算计量和外部 Agent endpoint；当前模型池只负责候选/评估层，不替代主 Runtime 的任务执行 |
| Debate / 飞书投影 | 有界 Debate 领域模型已实现，含轮次、单 Agent 和总消息上限；新增持久化房间、消息和关闭 API，并校验上下文版本与重复消息；Debate Brief 可携带受控 Context Pack；内部模型池按已持久化轮次恢复，重启后跳过已发言 Agent，避免重复消息；新增带 hash/幂等键、失败重试状态的渠道无关 Projection outbox 与 HTTP sink，并支持并发去重和有界批量 drain；新增 Feishu Incoming Webhook 卡片适配器，拒绝 private 内容并默认拒绝 confidential 内容 | 飞书应用级 Bot、Hermes 具体 adapter、独立 Moderator/Adjudicator 和生产投影权限仍需接入验收 |
| Web 工作台 | 开发版已实现 | 单用户本地模式；支持创建领域 Goal、将 Run 绑定到 Goal、查看 DAG/历史计划和 RSI 候选；没有多租户、SSO 或完整 ACL |
| Knowledge Provider | 已实现可替换 Provider 端口、本地确定性索引、受 schema 校验的 JSON File adapter 和 HTTPS HTTP adapter；Runtime 可通过 `knowledgeQuery` 检索，并在信任边界再次校验数量、分类、重复 ID 和内容 hash，再把受 privacy 分类策略过滤的知识引用注入 Planner/Executor/Reviewer Context Manifest | 尚未接入真实知识库部署、pgvector、增量索引和生产 ACL |
| React、生产运维 | 开发版可观测性已实现 | 当前 UI 是 TypeScript DOM；`/readyz` 区分存活与依赖就绪，`/metrics` 暴露 Prometheus 文本指标；生产部署、迁移、备份和安全验收仍缺失 |

测试命令：

```bash
npm run typecheck
npm test
npm run build
```

`tests/local-e2e.test.ts` 使用显式本地 fixture model，只证明协议和状态机能完成一次闭环，不证明任何真实模型的质量。
