# AEEIS 当前实现状态

这份清单用于防止把“设计存在”误报成“产品已完成”。状态只以当前仓库代码和测试为准。

| 能力 | 当前状态 | 证据 / 限制 |
|---|---|---|
| 动态 Planner DAG | 已实现并测试 | `src/runtime/engine.ts`；规划结果需要精确 hash 审批 |
| 任务执行、证据和 Reviewer | 已实现并测试 | 仅能读取 Run 提供的来源；artifact 引用会校验 |
| File 持久化 | 已实现并测试 | 原子替换、fsync、单写入者锁 |
| PostgreSQL 持久化 | 已实现适配器 | 当前环境没有 PostgreSQL 服务，未做真实数据库验收 |
| Temporal Workflow / Worker | 已实现并实跑 | 本地 Temporal fixture Run 已完成；生产部署、版本迁移仍未验收 |
| unknown / pause / cancel / restart | 已实现并测试 | 不明模型结果需要显式 reconcile，避免盲重试 |
| Brain claim、provenance、grant、撤销 | 核心语义已实现 | `FileBrainStore` 已提供原子持久化、审计、导出和 scope 删除；尚未接入向量检索 |
| Agent 协议 | schema 与校验已实现 | Agent Card、Task Brief、Context Pack、Grant、Result Envelope |
| 外部 Agent Gateway | 已实现本地目录、HTTP sync/async/stream 委托端口、上下文/Grant 校验、幂等、unknown/reconcile、Result Envelope 验证，并接入 Runtime Executor；delegation receipt 持久化支持重启恢复 | 尚未接入 Web 工作台、生产签名/OAuth 适配器和真实外部 Agent |
| toolkit_new | manifest、版本冻结、allowlist、幂等 invoke、Receipt、unknown/reconcile HTTP 端口已实现 | 尚未绑定 toolkit_new 的部署实例和真实工具调用；生产凭证与 ACL 未验收 |
| ownhow | CLI governance adapter 已实现；Run 创建时 resolve，结果进入 Planner/Executor/Reviewer 上下文，结束后 record | Apply 仍需显式授权；真实 CLI 版本和治理闭环未验收 |
| planprice | HTTP catalog adapter 已实现；按 capability/隐私筛选并锁定 provider/model/endpoint/价格决策 | 目录数据不等于调用凭证；provider endpoint/key 仍需配置，真实服务未验收 |
| RSI | candidate/evaluation/approval/promotion/rollback 状态机、File 持久化 Repository、HTTP API，以及 replay/holdout/safety/cost/shadow 有界评测编排已实现 | 尚未绑定真实 replay、holdout、shadow evaluator 和生产观测数据；候选不会自动修改生产 Agent |
| 多 Agent 竞争 | 隔离运行与独立评估接口已实现；`blindEvaluation` 会对评测器隐藏真实 Agent ID；候选完整性、成本上限、重复评分防护已加固；新增 File 持久化协作状态、候选提交→独立评测→选定/partial API；Gateway 可承载外部委托，Executor 可按 allowlist 委派并收回结果 | 尚未接入真实内部 Agent pool、自动触发的竞争 Workflow 或外部 Agent endpoint；当前 API 由受信调用方提交候选和评测 |
| Debate / 飞书投影 | 有界 Debate 领域模型已实现，含轮次、单 Agent 和总消息上限；新增持久化房间、消息和关闭 API，并校验上下文版本与重复消息 | 飞书渠道、Hermes skill、Moderator/Adjudicator 自动运行尚未接入 |
| Web 工作台 | 开发版已实现 | 单用户本地模式；没有多租户、SSO 或完整 ACL |
| Knowledge Provider | 已实现可替换 Provider 端口、本地确定性索引、受 schema 校验的 JSON File adapter 和 HTTPS HTTP adapter；Runtime 可通过 `knowledgeQuery` 检索，并把受 privacy 分类策略过滤的知识引用注入 Planner/Executor/Reviewer Context Manifest | 尚未接入真实知识库部署、pgvector、增量索引和生产 ACL |
| React、生产运维 | 未实现 | 当前 UI 是 TypeScript DOM；生产部署、监控、迁移、备份和安全验收仍缺失 |

测试命令：

```bash
npm run typecheck
npm test
npm run build
```

`tests/local-e2e.test.ts` 使用显式本地 fixture model，只证明协议和状态机能完成一次闭环，不证明任何真实模型的质量。
