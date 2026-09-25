# AEEIS 验证矩阵

这份矩阵把设计能力和可复现的验证入口对应起来。Fixture 验证证明协议、状态机、持久化和权限边界可以运行；它不等同于真实模型质量、供应商 SLA 或生产安全验收。

| 能力 | 本地验证入口 | 当前证据 | 仍需外部验收 |
| --- | --- | --- | --- |
| 独立 Agent Runtime | `npm run smoke:local` | Run 经过精确计划审批、执行、产物、独立审核和 Evidence Graph | 真实模型质量与供应商限流 |
| 完整开发接入形态 | `AEEIS_FULL_DEMO_DATA_DIR=/tmp/aeeis-full-local-final npm run demo:full-local` | 动态启动 Planprice、OwnHow、RSI evaluator、外部 Agent、Fixture Model 和 AEEIS；`/readyz` 通过，`/api/status` 显示 `modelRouting=catalog`、Skill governance、RSI evaluator、Agent Gateway；随后验证 RSI proposal synthesis、外部 Agent Result Envelope、Trigger Policy 幂等、Competition、Debate、Project Pulse checkpoint/successor Plan、两节点 DAG、生产流量 Canary 和 RSI activation | 真实凭证、模型/Agent 质量、供应商 SLA 和生产网络 |
| Goal / Plan / Task / DAG | `npm run smoke:local` | 两节点 DAG 自动解锁，两个 Run 成功，Goal=`completed` | 跨实例调度压力 |
| File 重启恢复 | `npm run smoke:local:restart` | `needs_approval`、计划 hash 和最终结果在 API 重启后恢复；最近一次实际运行最终 `succeeded`、审核 `accepted`、Evidence 节点 8 个 | 生产磁盘、备份和故障演练 |
| Temporal 长时任务 | `npm test`、`npm run temporal:replay` | Signal 等待、Activity retry、Continue-As-New 和旧 history replay 有回归 | 目标 Temporal 集群、Worker Versioning、容量 |
| Brain / Memory / Knowledge | `npm test`、`npm run test:postgres` | provenance、privacy、版本、撤回、CAS、按 grant 的 Brain Bundle 导出与同 owner/tenant/scope 的 hash 校验幂等导入、Context audience snapshot、成员撤销后的读取失效、PostgreSQL 适配器和 lexical fallback | 真实 embedding、pgvector 容量、组织 ACL、生产备份/跨区域恢复和用户迁移演练 |
| Shared Session / Room Context | `npx vitest run tests/session-context.test.ts tests/session-events.test.ts`、`npm test` | Room 级多 Goal Context Manifest、来源 binding hash、跨 Room 拒绝、成员变化失效、Goal 脱离 Room 失效、Shared Session canonical event 读取与持久化、append-only revision/retract | 大规模 Room/Goal 组合容量、跨区域恢复和真实组织目录 |
| toolkit_new | `npm run smoke:toolkit` | Registry manifest、版本冻结、签名、Receipt、unknown/reconcile 协议 | 真实 Registry 凭证、ACL、账单和 SLA |
| OwnHow Skill 治理 | `npm test`、Compose smoke | resolve/record/propose/apply/rollback/status 和 Run 治理快照 | 真实 OwnHow runtime 与 Skill 质量 |
| Planprice 模型选择 | `npm run smoke:planprice`、Compose smoke | catalog、汇率、provider/model policy、catalogHash 和 health | 真实目录、供应商价格和账单对账 |
| 外部 Agent 开放世界 | `npm test`、Compose smoke | Agent Card、admission/revocation、Context Pack、Grant、OAuth、callback、stream、预算和 reconcile | 真实 OAuth/SSO、网络、外部 Agent SLA |
| Competition / Debate | `npm test`、Compose smoke | 独立 participant/evaluator、盲评、Moderator、Adjudicator、轮次和 durable attempt | 真实模型池、外部群权限和生产投影 |
| RSI | `npm test`、Compose smoke | signal、candidate、replay/holdout/safety、shadow/canary、activation、rollback | 真实 evaluator、候选质量、生产流量指标 |
| Feishu / Hermes 边界 | `npm test`、`npx vitest run tests/collaboration-projection.test.ts` | 原始体签名、群路由、sender mapping、幂等和 Trigger 边界；Projection 按 channel 路由 Feishu、Hermes CLI 和通用 fallback，并验证隐私、健康检查与 unknown/reconcile 边界 | Feishu 应用权限、Hermes 身份映射、CLI/平台凭证和送达 SLA |
| 观测与恢复 | `npm run test:monitoring`、`npm run smoke:monitoring` | 指标、readiness、告警规则、备份校验和恢复脚本 | Docker、Alertmanager、长期指标、跨区域恢复 |

## 当前发布判断

可以发布为开发演示和协议验证版本：

- `npm test`、`npm run typecheck`、`npm run build` 通过；
- 本地 Run、DAG 和重启恢复 smoke 通过；
- 关键事实源、权限边界、unknown/reconcile 和回滚路径已有持久化实现。

不能宣称生产就绪，直到至少完成以下项目：

1. 在目标 Docker/Temporal/PostgreSQL 基础设施上完成 Compose smoke、监控 smoke 和真实 history replay。
2. 接入并验收真实模型、Planprice、OwnHow、toolkit_new、RSI evaluator 和外部 Agent。
3. 完成 OIDC、多租户 ACL、Secret Manager、备份上传、容量压测、故障注入和跨区域恢复。
4. 用真实 Feishu/Hermes 权限和通知 SLA 验证投影、入站 Debate 及 unknown/reconcile。
