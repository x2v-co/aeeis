---
title: 对照 Rakazo 后的五项优先改进
subtitle: 把多 Bot 前台建立在服务端的事实源、按动作的审批和可验证的真实模型质量之上
status: draft-for-review
created: 2026-10-27
audience: [product, runtime, frontend, operations]
references:
  - https://github.com/elie222/rakazo
  - https://github.com/elie222/rakazo/blob/main/VISION.md
  - https://github.com/elie222/rakazo/blob/main/docs/agent-verification.md
  - https://github.com/elie222/rakazo/blob/main/docs/content-encryption.md
  - ./2026-10-21-aeeis-interaction-design.md
  - ./2026-09-18-aeeis-design-baseline.md
---

# 对照 Rakazo 后的五项优先改进

## 背景

[Rakazo](https://github.com/elie222/rakazo) 是一个开源的 Grok Bot 替代品（TypeScript，Apache-2.0）。它和 AEEIS 的重心不同：

- **Rakazo** 是围绕「会动手的长期 Bot」做的完整产品。每个 Bot 有自己的对话、记忆、例程和一台可操作的电脑，入口覆盖网页、桌面、移动端和消息软件。
- **AEEIS** 是一套受治理的执行引擎：按精确 plan hash 批准、证据图、Temporal 持久运行、经评测的 RSI。多 Bot 前台（#87–#110）正在这套引擎之上搭建。

本文不打算照搬 Rakazo。下面五项是对照之后，AEEIS 在继续扩展多 Bot 前台之前最值得先补的部分。每项都写明现状、目标、设计要点、影响范围和验收标准。电脑操作（浏览器、桌面、接管）、语音和移动端不在本文范围，见末尾「暂不纳入」。

AEEIS 现有的强项保持不变，并作为这五项的约束：精确 plan hash 批准、证据引用与独立审核、Temporal 持久运行、带回放/留出/安全评测和灰度的 RSI、带版本和证据的 Brain 主张、领域 DAG 调度和幂等的投影出箱。

## 建议顺序

| 顺序 | 项目 | 理由 |
|---|---|---|
| 1 | 频道逻辑下沉到服务端 | 修掉 #109/#110 评审和实测里反复出现的一类问题（分页缺口、轮询、靠文本前缀推断状态），也是后面几项的基础。 |
| 2 | 按动作审批：Allow/Block 清单和「外部文本可操纵」规则 | 第 3 项会引入来自外部的运行，必须先有动作级的边界。 |
| 3 | 消息渠道入口，以及定时和 Webhook 例程 | 让 Bot 能被消息软件找到、能按时或按事件开始工作。 |
| 4 | 真实模型评测层 | 可与 1–3 并行。把手工的 rNN 复测变成可重复的评测。 |
| 5 | 静态加密和行级安全 | 在多用户或托管部署之前完成。 |

---

## 1. 频道逻辑下沉到服务端

### 现状

- #109 和 #110 的任务板、领取、验收、阻塞、频道内取消都在浏览器里计算：`src/ui/app.ts` 读取房间会话事件，按 `task_update` 正文的前缀（「领取：」「验收通过」「阻塞：」等）推断每件事的状态。
- 会话事件按 `sequence` 升序分页，前端只渲染第一页。实测在约 570 条事件的频道里，消息流显示最早的 50 条，再直接接上新消息，中间的积压不显示（见 #110 评论）。
- 「先写下的领取有效」、进行中上限等规则只在前端检查。两个标签页或两个客户端可以各自写下互相冲突的记录。
- `src/ui/app.ts` 已有约 5,900 行（#110 之后约 6,500 行），状态推断与渲染混在一起。

### 目标

前端只表达意图、渲染状态；频道的编排、授权、校验、并发和分页由服务端负责。重启后，任务板状态能从持久化记录完整重算。

### 设计要点

- **结构化的任务动作。** 新增版本化的频道任务动作（例如 `channel-task-action/1`），字段包括 `kind`（`claim`、`assign`、`transfer`、`refuse`、`accept`、`request_changes`、`block`、`unblock`、`cancel`、`restore`）、`taskRef`（对话 id + 任务 id）、`agentId`、`reason`、`idempotencyKey`。它可以作为会话事件的结构化载荷，也可以是独立的追加表。任何情况下都不再从正文文本推断语义。
- **服务端规则。** 在同一事务里检查「先领取者有效」、进行中上限（按 agent id）、只有成功的任务才能验收、撤回只作用于对应的动作。冲突返回 409，并说明谁已领取。
- **任务板投影。** 新增 `GET /api/rooms/:id/board`，返回各列、领取人、验收状态和「已读到哪里」的游标。投影可以从动作日志重建。
- **消息分页。** 会话事件接口增加从最新往前读的分页（例如 `?before=<sequence>&limit=50`）。前端默认显示最新一页，提供「查看更早的消息」。增量刷新只取 `after=<上次的 sequence>`。
- **兼容。** 已有的文本前缀 `task_update` 事件做一次性迁移，或只读兼容；新写入只用结构化动作。

### 影响范围

`src/session-events.ts`、`src/runtime/http.ts`（新路由）、新的 `src/channel-board.ts`（服务与投影）、File 和 Postgres 两套存储、`src/ui/app.ts`（删除前端推断逻辑，只调用新接口）。

### 验收

- 两个客户端同时领取同一件事，只有一个成功，另一个收到 409。File 和 Postgres 都有测试。
- 重启后，任务板状态和重启前一致。
- 在超过 1,000 条事件的频道里，消息流显示最新的消息；每次刷新只发增量请求，不重读已读过的页。
- `src/ui/app.ts` 中不再有按正文前缀推断任务状态的代码。

---

## 2. 按动作审批：Allow/Block 清单和「外部文本可操纵」规则

### 现状

- 审批在**计划层**：`settlePlanApproval`（`src/runtime/engine.ts:127`）按审核档处理精确 plan hash。`required` 等待主人批准；`auto` 在模型给出 `needed:false` 且 `frozenRunCanClear`（`:112`）通过时放行；`yolo` 直接放行。
- 计划批准之后，执行阶段只受创建时冻结的 `allowedTools` / `allowedAgents` / 预算约束。单次工具调用（`this.tools.invoke`，`src/runtime/engine.ts:2945`）和外部代理委托（`this.agents.delegate`，`:3100`）不再单独询问。
- `yolo` 在服务端没有额外限制。

### 目标

保留计划层的精确批准，在其上增加**动作层**的边界：有副作用的动作在执行前按主人的清单决定是放行、询问还是拒绝。来自外部、可能被不可信文本操纵的运行，即使在最宽松的档位也不能自动执行写操作。

### 设计要点

- **动作策略清单。** 主人级别的 `actionPolicy`：`allow` 和 `block` 两个列表，条目是精确的工具引用（`toolId@version`）、代理 id 或投影渠道。清单在创建 Run 时冻结，并记录 digest。清单只从批准卡片和设置页增长，不按猜测的类别自动扩展。
- **动作分类。** 只读动作（读取资料、`sources.*`、只读工具）不询问；写动作、外部委托、发送投影属于需要判断的动作。
- **决定规则**（按顺序）：
  1. 在 `block` 中：拒绝，不出卡片，所有档位一致。
  2. Run 的来源是外部（Webhook、例程、消息渠道入口、其他主人的代理），或不可信内容已进入本次上下文、且动作是写操作：`required` 和 `auto` 询问，`yolo` 拒绝（`yolo` 不能停下来等人）。
  3. 在 `allow` 中：放行。
  4. 其他情况：`required` 询问；`auto` 由审批模型判断，模型出错或不确定时询问；`yolo` 放行。
- **询问的形态。** 复用现有的等待机制：Run 进入 `needs_approval`，`approval.kind = 'action'`，记录 `pendingAction`（工具引用、规范化参数的 hash、幂等键）。批准卡片提供「仅这一次」「以后都允许」（加入 `allow`）和「阻止」（加入 `block`）。Temporal 已经是由信号驱动的等待，不需要轮询。
- **与计划批准的关系。** 计划批准仍然决定「做哪些步骤」；动作审批决定「这一步里的这个副作用能不能发生」。`frozenRunCanClear` 保留。

### 影响范围

`src/runtime/contracts.ts`（`actionPolicy`、`pendingAction`、Run 来源字段）、`src/runtime/engine.ts`（在 `tools.invoke` 和 `agents.delegate` 之前插入决定点）、`src/integrations.ts`（工具的只读/写声明）、`src/runtime/http.ts`（动作批准接口）、`src/temporal/workflows.ts`（唤醒信号）、工作台和任务行的批准卡片。

### 验收

- `block` 中的工具在三个档位下都不会被调用，也不出卡片。
- Webhook 或例程发起的 Run 在 `yolo` 下调用写工具时被拒绝，在 `auto` 下停在 `needs_approval`。
- 「以后都允许」写入 `allow` 后，同一工具在后续 Run 中不再询问；修改清单不影响已冻结的 Run。
- 动作批准后，工具以原幂等键执行，重启和重试不会重复执行。

---

## 3. 消息渠道入口，以及定时和 Webhook 例程

### 现状

- 对外以**投影**为主：`RoutingProjectionSink` 把状态摘要发到 Feishu、Hermes CLI 或通用 HTTP sink（`src/collaboration-projection.ts`），Debate 有 Feishu/Hermes 入站（`src/feishu-debate-ingress.ts`、`src/hermes-debate-ingress.ts`）。用户不能在消息软件里直接和某个 Bot 对话。
- 已有渠道身份解析接口 `ChannelIdentityResolver`（`src/security/channel-identity.ts:47`）。
- 提醒（`src/reminders.ts`）支持按 IANA 时区的日历重复规则和不补发风暴的追赶语义，但只投影通知，不开始工作。协作触发器（`src/collaboration-triggers.ts`）只响应 AEEIS 内部事件。

### 目标

- 主人可以在 Feishu（先做）以及之后的 Telegram、Slack 里和自己的 Bot 对话，消息进入这个人的生活线程。
- 主人可以为一个人设定例程：按时间表，或在收到 Webhook 时，用主人写好的提示开始一件工作。

### 设计要点

- **渠道入口契约** `ChannelIngress`：校验签名，用 `ChannelIdentityResolver` 把外部身份解析成 principal，再把消息写成对话消息。入站消息默认是讨论（`intent: discuss`），不会因为入站而执行。回复复用现有投影出箱，保留幂等和 unknown/reconcile 语义。
- **例程**作为领域对象：`{ owner, tenant, agentId, name, prompt, trigger: schedule | webhook, schedule?, runOptions, executionReview }`。时间表复用提醒的日历规则和追赶语义：同一例程最多保留一件待处理的追赶运行，迟到的运行告诉模型原定时间和实际时间。
- **不可信载荷与主人指令分开。** Webhook 载荷只作为标记为不可信的资料进入 Run；例程提示只能来自主人保存的例程，不能被载荷改写。
- **来源标记。** 例程、Webhook 和渠道发起的 Run 记录来源，并据此适用第 2 项的「外部文本可操纵」规则。没有第 2 项之前，这类 Run 一律使用 `required`。
- **Webhook 端点。** 每个例程有独立的密钥（HMAC 签名），以投递 id 作为幂等键，重复投递不重复开始工作。

### 影响范围

新的 `src/channel-ingress.ts` 和 Feishu 适配器、新的 `src/routines.ts`（服务、存储、调度），复用 `src/reminder-schedule.ts` 的时间计算和 Temporal 定时；`src/application/conversation-service.ts`（入站消息和来源字段）、`src/runtime/http.ts`（Webhook 路由）、Postgres 迁移、生活线程里的例程设置界面。

### 验收

- 在 Feishu 里给 Bot 发消息，消息出现在这个人的生活线程里，标明渠道和说话人，不会开始执行。
- 例程按时间表开始一件工作；服务离线多个周期后只补一件，并说明迟到。
- 同一 Webhook 投递重放两次，只开始一件工作；签名错误返回 401。
- Webhook 载荷里写的「忽略之前的指令」不会改变例程提示，也不能绕过第 2 项的规则。

---

## 4. 真实模型评测层

### 现状

- 测试使用 Fixture 模型，验证的是协议和状态机，不代表真实模型质量。
- 真实模型的问题靠手工复测发现和修复（r48–r81，以及 `docs/pulse-retest-set.md`、`docs/fillable-pdf-retest-set.md` 和 `tests/fixtures/r79/`）。这些复测没有统一的、可重复运行的入口。
- RSI 评测器（`src/evaluation.ts`、`src/rsi.ts`）对候选做回放、留出和安全评测，但它服务于候选晋升，不是日常的质量回归。

### 目标

把真实模型的任务质量变成可重复、可比较的评测，并且不影响默认的确定性测试。

### 设计要点

- **分层。** 保持现有分层不变：`npm test` 和 `npm run verify` 永远不需要付费推理。新增 `npm run test:evals -- --live --model <pin>`，只在本地或手动工作流里运行。
- **用例来自已有的复测集。** 把 Pulse、fillable-pdf 和 rNN 复测整理成 `evals/cases/*.json`：输入资料、目标、工具和预算、以及可判定的检查（产物 schema、证据引用都存在且可解析、未知项如实报告、没有占位引用、在时间预算内结束或给出明确限制）。
- **评分。** 优先使用确定性检查；需要判断质量的项目可以选用独立的评审模型，评审结果单独记录，不和确定性检查混在一起。
- **报告。** 输出 JSON 报告到被忽略的 `test-report/evals/`，记录模型、提示版本、token 和费用（复用现有用量记账），便于比较两次运行。
- **缺少凭证时报告「未运行」**，不能当作通过。
- **与 RSI 的关系。** 同一批用例可以作为 RSI 回放套件的来源，但两者的执行入口分开。

### 影响范围

新的 `scripts/evals.mjs` 和 `evals/cases/`、`package.json` 脚本、`docs/verification-matrix.md`（补充这一层）、`.gitignore`。不改动运行时代码。

### 验收

- 没有模型凭证时，`npm run test:evals -- --live` 以明确的「未运行」状态退出，CI 不运行它。
- 至少把现有 Pulse 和 fillable-pdf 复测集转成用例，并在一个真实模型上产出报告。
- 同一模型和用例运行两次，报告可以逐项比较。

---

## 5. 静态加密和行级安全（多用户之前）

### 现状

- owner/tenant 的隔离在应用代码里检查（例如 `src/application/aeeis-service.ts` 里的 `validatePrincipal` 和各处的 owner/tenant 比较）。PostgreSQL 没有行级安全。
- 各 Postgres 适配器各自用同一个连接串创建 `pg.Pool`（例如 `src/adapters/conversation-store.ts:390`、`src/adapters/postgres-brain-store.ts`、`src/adapters/postgres-agent-ledger.ts`），应用和迁移使用同一个数据库身份。
- 对话、资料、产物、Brain 主张、Goal 记忆和会话事件在数据库和文件中都是明文。`src/config-secrets.ts` 只负责从 `_FILE` 读取部署密钥。

### 目标

数据库转储、备份或磁盘被复制时，不泄露用户内容；即使某处应用代码漏了 tenant 检查，数据库也不会返回其他租户的数据。

### 设计要点

- **数据库角色分开。** 迁移使用 owner 角色；应用使用不拥有表的 `aeeis_app` 登录，行级安全对它生效。
- **按租户的行级安全。** 对带 `tenant_id` 的表启用 RLS，策略比较 `current_setting('aeeis.tenant_id')`。新增共享的连接辅助函数，在每个事务里 `SET LOCAL aeeis.tenant_id`，各适配器改用它，不再各自创建连接池。owner 级别的细分仍由应用代码负责。
- **内容加密。** 使用信封加密（AES-256-GCM）：每个租户一把数据密钥，主密钥来自 `AEEIS_CONTENT_ENCRYPTION_KEY_FILE` 或 KMS。加密 Run 的资料和产物正文、对话消息、Brain 主张内容、Goal 记忆和会话事件正文。
- **hash 必须对明文计算。** AEEIS 大量依赖内容 hash（plan hash、`contentHash`、证据引用、Context Manifest digest）。加密必须发生在计算 hash 之后，绝不能改变现有 digest，否则审批、证据和幂等语义都会失效。
- **迁移。** 先支持双读（明文和密文都能读），再用后台任务逐步加密存量数据。File store 可以选择加密，开发模式默认关闭。

### 影响范围

`src/adapters/postgres-store.ts` 和各 Postgres 适配器、新的数据库连接辅助模块、新的 `src/content-encryption.ts`、`src/config-validation.ts`（生产模式要求加密密钥和分开的角色）、迁移、`docs/operations/runbook.md`（密钥轮换和备份）。

### 验收

- 用 `aeeis_app` 登录、不设置 `aeeis.tenant_id` 时，查询租户表返回空。
- 一个租户的 API 调用即使绕过应用层检查，也读不到其他租户的行（针对 Postgres 的测试）。
- 数据库转储里看不到对话、资料和记忆的明文。
- 加密前后，同一份内容的 plan hash、`contentHash` 和 Manifest digest 完全一致。
- 生产模式缺少加密密钥或仍使用 owner 角色连接时，拒绝启动。

---

## 暂不纳入

以下是 Rakazo 有、AEEIS 目前没有的能力，价值明确，但不在这五项之内，等前面的边界就位后再单独评估：

- 电脑操作：浏览器（页面文本和元素引用）、图形桌面、用户接管，以及运行中请求受保护输入（登录、两步验证）。
- 多种沙箱提供方（E2B、Daytona 等）及其统一契约和离线一致性测试。
- 应用集成目录（Composio、Pipedream）和用户自装的 MCP / OpenAPI 工具来源。
- 语音、桌面和移动客户端、多语言界面。
- Bot 之间委托、短期子代理，以及 Bot 管理自己创建的 Bot。
- 演示录制生成操作手册（teaching / playbook）。
- 一键安装脚本和预构建的多架构镜像。

## 开放问题

1. 第 1 项的结构化动作，是放进会话事件的载荷，还是独立成一张追加表？前者复用现有的受众和 Manifest 绑定，后者查询和迁移更简单。
2. 第 2 项中「不可信内容已进入上下文」如何判定：按资料来源（`untrusted` 标记）一刀切，还是按每次模型调用实际看到的内容？
3. 第 3 项先接哪个渠道？Feishu 已有身份解析和 Debate 入站，改动最小；Telegram 对个人用户最常见。
4. 第 5 项的主密钥默认来自文件还是 KMS？单机部署是否允许不加密启动并给出警告？
