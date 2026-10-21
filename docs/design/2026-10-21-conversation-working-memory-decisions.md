# 2026-10-21 决策记录：单入口多任务路由 + 任务工作记忆 v1

> 来源：跨机器共享记忆 `~/brain/daily/2026-10-21.md` 的归档副本，入库以便与代码同库留存。
> 对应实现已在分支 `feat/pi-model-adapter-poc` 的提交 `7a1932c` 落地并推送（原文写于提交前，“本轮未提交代码”一语已过时）。
> 设计原则与验收用例另见 [task-working-memory.md](../task-working-memory.md)。

## AEEIS：单入口多任务路由 + 任务工作记忆 v1

- 工作分支：`/Users/kl/workspace/x2v/aeeis-pi-adapter` 的 `feat/pi-model-adapter-poc`；本轮未提交代码。
- 用户已批准方向：一个自然入口 conversation 保持聊天连续性；每个主题有独立 task conversation（映射到既有 AEEIS Thread）；每次显式执行创建独立 Run。讨论焦点不是执行状态，切换焦点不启动、暂停、恢复或取消 Run。
- 路由优先级：显式 task / reply 引用、无歧义名称、当前焦点、模糊则澄清；多任务可讨论但不能在一次执行里猜目标。通知带 task 身份但不抢焦点。归属纠正采用 append-only audit event，只影响后续消息和新执行，历史执行不可变。
- 工作记忆采用“分层索引 + provenance summary + bounded search + 原文读取”：summary 是不可信派生上下文，不是证据权威；新 Run 显式 opt-in（`workingMemory.enabled=true`），旧 Run 保持原行为。压缩是 Run pinned model 的独立 durable `compaction` call，占用正常 calls/token/time/global budget；权限、source/receipt/delegation 和 plan generation 会实时复检。
- 已实现 File/Postgres conversation store、ConversationService/API、恢复、owner-only working-memory inspection API、UI 任务/焦点/澄清/回复/纠正/执行/原文检查，以及普通 Run 视图的原始记忆脱敏。
- 本地验证：strict tsc + production tsc + build 均通过；定向 155 passed / 6 Postgres skipped；全量串行和默认并行均为 2441 passed / 133 skipped / 0 failed。
- Browser preview 离线验收：临时数据目录、清洗环境、loopback fixture model（4413）和 AEEIS（4412），无 `.env`/DATABASE_URL/Temporal/生产或付费模型；UI 完成双任务路由、显式执行、计划批准、Run 成功、工作记忆索引/搜索/原文和 sibling 节点 0 命中。浏览器 console 无错误。
- 发现并修复本地 fixture 的误判：普通 executor 的 source fidelity 文本包含 `fillable-pdf/1`，导致 fixture 误入 PDF 分支；现在只在专属 “This Run uses the fillable-pdf/1 contract” 提示下进入。
- Postgres conversation adapter 有测试但本机无数据库，仍为 skipped；未部署、未调用付费模型、未恢复 Grok Bot 迁移。
