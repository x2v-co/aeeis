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
| toolkit_new | 端口与 HTTPS HTTP adapter 已实现 | 尚未绑定 toolkit_new 的部署实例和真实工具调用 |
| ownhow | CLI governance adapter 已实现 | 尚未在 AEEIS Run 中自动选择 / 记录；Apply 仍需显式授权 |
| planprice | HTTP catalog adapter 已实现 | 目录数据不等于调用凭证；provider endpoint 仍需配置 |
| RSI | candidate/evaluation/approval/promotion/rollback 状态机已实现 | 尚未接入真实 replay、holdout、shadow evaluator |
| 多 Agent 竞争 | 隔离运行与独立评估接口已实现 | 尚未接入真实内部 Agent pool 或外部 Agent endpoint |
| Debate / 飞书投影 | 有界 Debate 领域模型已实现 | 飞书渠道和 Hermes skill 尚未接入 |
| Web 工作台 | 开发版已实现 | 单用户本地模式；没有多租户、SSO 或完整 ACL |
| React、pgvector、生产运维 | 未实现 | 当前 UI 是 TypeScript DOM，索引层尚未接入 pgvector |

测试命令：

```bash
npm run typecheck
npm test
npm run build
```

`tests/local-e2e.test.ts` 使用显式本地 fixture model，只证明协议和状态机能完成一次闭环，不证明任何真实模型的质量。
