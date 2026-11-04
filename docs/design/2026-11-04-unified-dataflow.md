---
title: 主页与多 Bot 工作室的统一数据流
date: 2026-11-04
status: PR2 已实施，其他 PR 待实现（详见第 11 节）
relates:
  - 2026-10-21-aeeis-interaction-design.md
  - 2026-10-29-bots-that-act.md
---

# 主页与多 Bot 工作室的统一数据流

## 1. 背景与原则

老板反馈：任务板不能拖动；工作室只看到「客户反馈」；直接消息可以找 Bot，但与主页的 Bot 对话不统一；任务状态没有接上。另一个阻断是主页 Bot 页提示「这位 Bot 只记下讨论，不会自己做。要它做事，回到 AEEIS 说」。

产品原则是：**主页是精简界面，工作室是专业界面。用户从主页就能与每个 Bot 对接；需要任务细节、团队协作、操作和审批时进入工作室。两处共用对话、任务、Run 和审批，只是视图不同。** 同一条指令不能因为切换页面而再开一次 Run，同一个批准也不能因为换入口而放宽权限。

核查基线为 `x2v-co/aeeis`，`cursor/unified-dataflow-docs-bot-run`，HEAD `5c2b7b7`（当前与给定的 origin/main 基线一致）。下列文件行号均指这个提交，后续实现应按符号定位。本文是设计，不代表功能已完成；本步只新增文档和工作区摘要，没有修改业务代码、创建 migration 或执行数据库变更。

## 2. 先区分当前的三个界面

| 界面 | 实际入口与实现 | 当前数据来源 |
|---|---|---|
| 主页与主页里的群聊、任务板、工作室 | `/` → `public/index.html`、构建后的 `src/ui/app.ts`；路由 `src/runtime/http.ts:703` | Conversation、Room / SessionEvent、Run 等业务服务 |
| 「多 Bot 工作室 / 团队页」 | `/team/` → `public/team/index.html`、`public/team/app.js`；路由 `src/runtime/http.ts:716`、`:724` | 浏览器内存中的 `BOTS`、`CHANNELS`、任务与审批样例 |
| 设计演示稿 | `docs/design/demo/` | 单独的静态设计演示，不是业务存储 |

关键证据：`public/team/app.js:1` 明写所有操作都在客户端；`:80` 定义 `CHANNELS`；`:1608` 的发送只向数组追加消息，`:1622` 定时生成模拟回复，`:1635` 生成 `working` 任务，没有开 Run。`tests/team-channel-ui.test.ts:10` 也把 `/team/` 称为 sample，`:11` 验证它无需 API token。不能拿这个演示页可点的按钮当成后端已联通，也不能把主页已实现的频道能力算到团队页上。

## 3. 问题 0–4：核实、根因与改法

### 0. Bot 页不能直接下命令

**现象成立，主要阻断在前端。** `src/ui/app.ts:1260` 的 `conversationSendIntent()` 在 `rosterView() !== 'entry'` 时固定返回 `discuss`；`:5030` 再检查一次这个结果，表单在 `:5077` 使用它。因此普通 Bot 对话即使模型已就绪也只记录讨论。`:1301` 的提示和 `:3118` 的空态直接要求回 AEEIS。

其他需一起清理的入口约束：

- `src/ui/app.ts:494`–`:520` 禁用非 AEEIS 的 quick composer，并显示「先选 AEEIS」；`:1077` 再拦截旧 quick-run 提交。
- `src/ui/app.ts:3132` 仍称可以在这里明确开 Run，`:3138` 又称群聊/私聊可自动回复，与空态冲突；`:3140` 仍把批准导向 AEEIS。线索中的约 3133 行在本提交是角色栏，不是发送闸门。
- `src/ui/app.ts:4611`、`:4838` 把交付后的工作台展示限于 entry；`:7483` 把执行默认项说明藏在 Bot 页之外。这些是展示限制，需要逐个判断，不能批量删除所有 entry 判断。

**后端确实已有单 Bot Conversation 开 Run 的路径，但还缺背景注入。** `src/runtime/http.ts:2151` 将消息交给 `ConversationService.post()`，有 Run 则通知调度器并返回 202。`src/application/conversation-service.ts:908`–`:922` 检查执行意图、模型/调度器和任务是否仍活跃，没有限定 `agentId === 'aeeis'`；`:943`–`:972` 构造执行请求。`:111`–`:114` 把该 Conversation 的 Bot id 写进目标，`:958`–`:969` 已注入常驻嘱咐、已接受做法和讨论。它并没有查询 OwnedBot 的 `background`；构造依赖见 `src/runtime/http.ts:161`。`src/bot-team.ts:162`、`:379` 的背景只用于频道自动回复，不能据此认为执行 Run 已带背景。

**改法（方案 A，PR1）：** entry 与受支持的 Bot 页都允许发送 `execute`，复用同一 `post → Thread / Run → dispatcher`，无需等数据迁移。由服务端按 tenant、owner、agentId 查询有效 Bot，把名字、角色、背景作为有来源的不可信材料注入，常驻嘱咐沿用现有路径。不能依赖浏览器提交背景，不能把背景当执行授权。AEEIS 使用入口身份；OwnedBot 校验未退役、属于本人；外部准入 Agent 与演示 Bot 单独显示其执行能力，不能因删掉 UI 判断而被当作本地 Bot 执行。

普通用户的明确命令沿用现有用户来源与 `executionReview`；Bot 自主开的 Run 仍为 `origin: agent`，保留现有审批限制。quiet 表示不自主回复，不阻止主人明确派活。代别人发言、只记下、归属纠正、模型不可用、已有活跃 Run 等保护仍保留。材料容量校验应把背景也计入现有最多 20 槽限制，并对服务端保留的来源去重；重试沿用第一次落盘的请求快照。

Bot 页就地显示并操作计划、动作审批和补充问题：复用 `src/ui/app.ts:4229` 的计划卡、`:4262` 的开始/修改/取消按钮、`:4310` 的动作决策与 `:4350` 的批准接口；不是再写一套审批。后台回执不抢焦点；是否自动展开发送后的工作台是展示决策，审批卡不能依赖展开工作台才可用。

### 1. 团队页任务板无法拖动改变状态

**成立，缺少交互也缺少写入命令。** `/team/` 的 `public/team/app.js:1293`–`:1327` 只按内存 `task.status` 分列，卡片是 `data-action="open-task"` 按钮（`:1322`）；没有 draggable、drag/drop 或状态写 API。主页任务板同样在 `src/ui/app.ts:2346`–`:2363` 生成列与打开详情按钮，没有拖动处理。不存在一个已经接好但失效的 drop handler。

服务端现有任务动作是领取、分派、转交、验收、阻塞等，见 `src/channel-task-action.ts:9`、`:24`；输入 `src/channel-board.ts:10`–`:19` 没有目标列和版本，不能承接任意移列。已有验收也限定成功任务（`:96`），不能靠浏览器改 `status` 绕过。

**改法（PR3）：** 提供有权限、版本检查、幂等与审计的 `move` / `clear_override` 命令，再接鼠标拖动、触摸操作和键盘「移动到」菜单；两处任务板共用命令。移列是工作组织意图；需要执行、暂停、取消或批准的操作仍使用现有 Run 命令，明确告知其效果，不能用一次拖动悄悄授权执行。具体优先级见第 5 节。

### 2. 工作室只有「客户反馈」一个频道

**当前仓库不能复现“只有一个”的数量，但能确认演示数据与管理入口的问题。** 团队页硬编码了 `发布协作`（`public/team/app.js:82`）、`增长实验`（`:178`）、`客户反馈`（`:260`）三个频道。`:513` 遍历全部非 direct 频道，`:1901`–`:1909` 的 URL 参数只是选择频道，没有过滤成单个。「只有客户反馈」可能与实际部署提交、页面入口或资源缓存有关，代码不足以确定是哪一个；本步未访问部署环境，不能将猜测记为已证实根因。

团队页确实没有新建、改名、归档的真实频道管理，侧栏只有固定列表。**“后端没有新建频道 API”这条线索不成立：** `src/runtime/http.ts:973`–`:984` 已有 Room 列表、POST、PATCH（title / description / status）；`src/ui/app.ts:3529`–`:3541` 已有新建群聊，`:4172` 已有改名，`:3429` 已有归档。`src/application/aeeis-service.ts:58` 目前还通过 description 的「私聊 / 群聊」字符串派生 chat 类型，不能当成稳定的频道分类模型。

**改法（PR4）：** 团队页使用真实 Room 列表和既有 CRUD，在频道栏提供清晰的新建入口，允许按产品/主题命名和分类、改名、归档、查看归档；取消默认业务样例。补结构化频道元数据与乐观锁，不重复造 Room 存储。无频道时显示真实空态和新建按钮。验收前核对部署 SHA、实际 `/team/app.js` 内容和请求来源，解释三频道与单频道的差异。

### 3. 工作室私聊与主页 Bot 对话不是同一份数据

**成立，而且目前不止“两张表”。** 团队页 `public/team/app.js:400`–`:413` 创建 `dm-<演示 bot id>` 的内存 channel，发送仍走模拟函数 `:1608`，并不是数据库中的私聊 Room。团队页 `an / yan / …` 是演示身份，不能按名字猜成生产 Bot。

真实主页也存在两种模型：`src/ui/app.ts:3340`–`:3363` 走 `/conversations` 打开 Bot 生活线程；`:3390`–`:3425` 索引 description 为「私聊」的 Room、添加成员并打开 Room。`:3404` 已把已知 Bot 的新私聊入口转到生活线程，这是部分合流，但不绑定或迁移旧 Room。`src/conversations.ts:61`–`:75` 把消息、任务、常驻嘱咐存在 Conversation；`src/session-events.ts:285`–`:303` 把 Room 消息存在独立的 SessionEvent 表。`src/ui/app.ts:3985`–`:4047` 的频道投递还会再写一条 `intent: discuss` 的 Conversation 消息和一条房间回执，失败提示承认可能只写成功一边（`:4038`）。

**改法（PR2）：** 一个 `(tenant, owner, bot)` 只有一条 Conversation，绑定唯一的专业界面私聊 Room。**以 Conversation 为 Bot 私聊消息与任务的权威源**，Room 是同一对话的地址、成员和专业视图，不另存一份可独立修改的聊天正文。保留已有 conversationId、messageId、taskId、threadId、runId，避免破坏执行幂等与引用。旧真实 Room 导入与别名策略见第 4 节；团队页静态样例不能自动迁入用户数据。

### 4. Run 与任务板状态没接上

**团队页完全没接；主页已有动态映射，缺的是完整关联与统一刷新。** 团队页的任务是固定状态加模拟任务（`public/team/app.js:1635`–`:1652`），审批也在局部对象 `:321`，不引用 runId。

主页后端已经把任务的 `latestRunId` 读取为当前 Run：`src/application/conversation-service.ts:423`–`:443` 返回真实 `run.status` 及待批准/待输入；`src/runtime/http.ts:188`–`:193` 把这些数据供给 ChannelBoard；`src/channel-task-action.ts:279`–`:289` 已有 Run 状态到列的映射，成功后进待验收，验收后才完成。不能写成“后端完全没有状态联动”。

缺口有三处：一是任务必须先被频道事件引用才能出卡（`src/channel-board.ts:124`–`:133`、`src/channel-task-action.ts:299`–`:330`），主页直接开出的事未必属于任何频道任务板；二是主页 UI 在 `src/ui/app.ts:2330` 又依据 `handoffViews` 重算列，工作室 `:5747`–`:5754` 只补未缓存的 Conversation，可能保留旧任务状态；三是 `boardBehind()` 仅比较频道日志数量和末条 id（`:2204`–`:2209`），Run 更新不一定新增频道消息，不能靠它判断板是否过期。`:4663` 的单对话刷新也不等同于所有频道任务刷新。

**改法（PR3，团队页基础读路径由 PR2 接入）：** 显式记录任务所在 Room，Run 是执行状态唯一事实源，服务端输出统一 Board DTO（含真实 runStatus、自动列、手动覆盖和版本），客户端不再重算列。使用已有 Run change 通知作失效提示，配合有界扫描与重连刷新补漏，见 `src/runtime/repository.ts:34`–`:43`；不能假定内存订阅是可靠事件队列。历史 Run 的迟到事件不能把一次重试的新 Run 状态改回去。

## 4. 统一对话、Room、任务、Run

### 4.1 权威源与身份

| 对象 | 权威事实 | 两个界面的使用方法 |
|---|---|---|
| Bot | OwnedBot 或入口 AEEIS 的稳定 id，tenant / owner 隔离 | 同一个 Bot 的背景和常驻要求；显示名不是关联键 |
| Bot 私聊 | 原有 Conversation 消息、任务及 revision | 主页直接展示；工作室通过绑定的私聊 Room 展示同一消息 id |
| 私聊 Room | Room 的身份、状态、成员；新增绑定关系 | 一个用户与一个 Bot 的地址，不包含第二份可写消息正文 |
| 群频道 | 现有 Room + SessionEvent | 专业视图；主页摘要/任务入口引用相同事件，不复制整段私聊 |
| 任务 | ConversationTask，保留 taskId / threadId | 任务可被多个频道引用；各 Room 的看板控制独立，Run 事实共享 |
| Run | RunRepository 与 Thread 的已有执行链 | task.latestRunId 表示当前尝试；历史 Run 仍可查 |
| 审批与问题 | Run 的待审批计划 hash、动作幂等键、问题 | 两处展示相同数据，调用相同权限受控接口 |

不把 `contracts.ts` 中计划节点 Task 的生命周期与 ConversationTask、BoardColumn 混为一谈：一个对话任务可有多次 Run，一个 Run 又可包含多个执行步骤。

### 4.2 读写路径

新增共享的 `BotDialogueService`（名称为设计建议），主页与团队页都调用它；`ConversationService` 保持执行内核。

1. `POST /api/bots/:id/dialogue`：按登录身份幂等解析/创建 Conversation 和 direct Room，返回 `{ conversationId, roomId, revision, bindingVersion }`。服务端验证 Bot、Room 成员和 owner；不接收客户端指定的 owner。
2. 主页继续用 `GET /api/conversations/:id`；专业私聊用 `GET /api/rooms/:id/dialogue`，经绑定服务读取同一个 Conversation DTO。消息分页补现有只返回最后 100 条的限制（`src/application/conversation-service.ts:452`），游标与消息 id 跨视图一致。
3. 两处发送最终调用同一个 `ConversationService.post()`，沿用 `Idempotency-Key`、expectedRevision、明确 task / newTask 和审批参数。未知结果重试原请求；切换视图不生成新键重发。专业入口不能额外复制一条消息再开一次 Run。
4. 已绑定 Bot 私聊的旧 `POST /rooms/:id/session-events` 不再接受第二份普通聊天写入：兼容层只将满足新协议的消息转交对话服务；不能无损转换的旧客户端返回明确的升级冲突。原 SessionEvent 历史 API 保留审计读取。频道消息、任务动作与 Bot 侧线程仍走 SessionEvent。
5. Bot 自动回复在绑定私聊里也走这个统一服务：正文写同一 Conversation，保留 speaker=agent、replyTo 和原触发键。执行发送 `execute` 只走 Run，不能再触发一次「回复后自动提议并开工」；讨论发送 `discuss` 才按 autonomy 回复。后台服务的 agent 发言不得转成用户授权。
6. 原有群聊消息仍保存在原频道，只以 source 引用投递给 Bot；新投递逻辑在服务端完成，按 `(roomId, eventId, botId, deliveryKind)` 去重。保留必要的 Bot 个人讨论记录时注明源事件，UI 合并来源后只显示一次，不把频道全文变成私聊授权。
7. 专业任务详情和批准读取同一个 Run。共享群聊中的他人不能因看到任务引用而读到个人 Conversation、背景、常驻嘱咐或整个 Run；继续按 Goal / Room 可读范围裁剪。现有 board owner 限制（`src/channel-board.ts:89`–`:90`）在本轮保留，不顺便扩大审批权。

第一阶段保持“私聊的消息正文以 Conversation 为准”；SessionEvent 可以记录引用型回执/动作，不能成为消息内容的第二个编辑入口。修订、撤回需要扩展 Conversation 消息的追加修订元数据，不能把旧 SessionEvent hash 改掉，亦不能让迁移输入变成一次 execute。

### 4.3 创建、旧数据回填与切换

用 007 的绑定、Room 别名和同步操作表支持重入。PostgreSQL 使用按 `(tenant, owner, bot)` 的事务锁/唯一约束；Room、Conversation、membership 跨适配器创建还需可恢复步骤，不能以为两个现有 `init()` 或两个 HTTP 请求是一个事务。绑定处于 ready 以前，不开放第二个写入口。

1. 先列清单，只报告 id、数量与冲突类型，不输出正文或敏感配置。扫描所有页，不依赖主页默认 Room 列表的 50 条上限（`src/ui/app.ts:6719`）。现有 Conversation 的 agent 唯一索引见 `src/adapters/conversation-store.ts:388`。无 agentId 的历史入口按既有 AEEIS claim 逻辑确认（`src/application/conversation-service.ts:986`–`:988`），有歧义就暂停该绑定，不按标题猜。
2. 已有 Bot Conversation 优先保留；没有则幂等创建。真实 direct Room 必须验证相同 tenant / owner、恰好该 Bot 一个有效对方成员、无额外历史受众风险。群聊、人与人的私聊、Bot 侧线程均不能自动并入。多个候选有同一合格受众时，选最早 createdAt、再按 id 的 Room 为主，其余登记 alias；成员或历史受众不一致的房间保持原样，列为人工处理冲突。
3. 用短暂的“此对话正在整理”写屏障冻结这些 Room 的旧消息入口与目标 Conversation 写入口；读仍可用。先记录原 revision、SessionEvent 高水位及绑定状态。支持每个绑定独立切换和重试，避免全库停写。最后检查高水位未变化才置 ready；否则继续增量导入。
4. 对旧 Room 事件按原 room sequence 还原 publish / revise / retract 链。将普通聊天导入 Conversation，保留原 actor、时间、回复、来源 eventId、hash 与修订/撤回记录。任务动作、审批和已存在 Run 引用只关联原 id；不重新审批、不重跑。导入仅走服务端 `import`，永不触发 Bot 回复/提议/Run。无法表示的事件类型保留引用型历史卡，不当成用户发言。
5. 已经从 Room 投递过的 Conversation 消息，只在能通过明确源 id 证实时复用；旧文本「来自群聊…」没有稳定关联时，不以文本相似度删除。保留两条并标来源待整理，比丢记录安全。源映射落 007 操作表，目标消息内部保存 source，崩溃在“消息已落盘、操作未完成”之间时也能找回同一条消息。
6. 成功后主 Room 与所有 alias 都解析到同一个 Conversation；旧链接可读且指向新地址。原始 SessionEvent 不删除、不重签，完整保留审计。新消息只写 Conversation。导入消息对执行上下文仍是不可信历史，撤回内容不得进入后续上下文。
7. `/team/` 内存样例没有服务端身份与持久历史，**不自动导入**；不把 `an` 按名字映射为 AEEIS。接入正式界面后使用真实 roster。将样例保留在单独 demo 路径供设计回归，不能在业务请求失败时自动切回假数据。
8. JSON / File 和内存适配器必须有相同绑定、别名、去重及恢复语义；不能只做 PostgreSQL。加密 Conversation 要通过 `openAggregate / sealConversation` 迁移（`src/adapters/conversation-store.ts:393`–`:401`），不能用 SQL 直接拼 JSON 正文。

回退首选关闭专业新入口，主页继续读写 canonical Conversation。已经切换后的新消息没有旧 SessionEvent 副本，不能声称回滚 DDL 就能恢复旧双写行为；需要恢复兼容版本，或在维护窗口导出并核验反向回填，见第 7 节。

## 5. 任务状态、手动拖动与审计

### 5.1 Run → 自动任务列

保留当前六列，失败/取消作为独立筛选区；服务端枚举穷尽 `src/runtime/contracts.ts:212` 的 12 个 Run 状态。`capture` 对应团队旧样例的 inbox，`doing` 对应旧 working；正式 API 只输出 canonical 名称。

| Run 状态 | 自动列 | 说明 |
|---|---|---|
| queued | ready（待领取） | 已排队，未开工 |
| planning | doing（进行中） | 正在规划 |
| running | doing | 正在执行 |
| reviewing | doing | Run 内部复核，不是人的验收 |
| needs_approval | blocked（阻塞） | 卡上显示计划/动作审批，保留安全优先级 |
| needs_input | blocked | 等人回答 |
| waiting_external | blocked | 等外部回执 |
| paused | blocked | 已暂停 |
| unknown | blocked | 结果未知，先核查 |
| succeeded | review（待验收） | 针对这个 runId 验收后为 done |
| failed | failed（失败筛选） | 保留错误与重试入口 |
| cancelled | failed（取消筛选） | 展示取消原因，不伪装成完成 |
| 无 Run：discussion / preparing | capture / ready | 属于任务准备状态，不是新增 RunStatus |
| unreadable | failed 中的不可读占位 | 不把读失败当成执行失败，不泄漏私聊内容 |

`accepted` 必须绑定被验收 runId，重试换 Run 后自动失效；现有 BoardDecision 的裸布尔值不能沿用到下一次成功。提议、交接中、负责人、WIP 与列是独立维度，保留原任务动作语义。

### 5.2 手动覆盖规则

新增 `move` 与 `clear_override`（结构化 task action 新版本，兼容旧记录）。请求含 `{ conversationId, taskId, toColumn, expectedVersion, expectedRunId, expectedRunRevision, reason, idempotencyKey }`；没有 Run 时显式传 null。owner 权限、Room 活跃、任务归属、WIP 和可读性均由服务端检查。版本过期返回 409 和刷新提示，UI 恢复服务端列；不无限自动重试。

- 无 Run 的任务可以在 capture / ready / doing / blocked 间组织，doing 显示「手动进行中 · 尚未执行」；拖动本身不创建 Run。移到 review / done / failed 不允许伪造执行结果；done 必须是当前 succeeded Run 的验收。
- 有活跃 Run 时，允许在不会掩盖等待/结果的组织列之间覆盖；拖回 ready / capture 若表达停工，必须先明确暂停现有 Run，否则拒绝。取消、继续、批准仍是独立命令；手动拖到 blocked 可以登记阻塞说明，若需暂停，先在明确操作中调用暂停接口，成功后再记录 move，失败不假装已暂停。
- 同一 Run 内普通进度事件（planning → running → reviewing）保持手动覆盖；**需要人、外部等待、暂停、结果未知和终态等权威边界事件优先**，强制显示自动列，并记录覆盖被清除的原因。手动覆盖不能藏起待批准或失败。
- 新 Run 成为 latestRunId 时，清除上一次尝试的覆盖和验收。旧 Run 的迟到事件只更新历史，不参与当前列。读取时以当前 Run 的 revision 与 id 校验；不能单靠时间戳“最后写入胜出”。
- succeeded 后拖入 done 等价于对当前 Run 验收；done → review 是撤销验收，需原因。其他不允许的落点给出理由及可用操作，不在客户端强行挪卡。权限不足者可查看但无拖柄。
- 覆盖按 `(roomId, conversationId, taskId)` 生效；同一任务被两个频道引用时，执行事实共用，各频道的整理意图独立。主页任务显示当前 Run 状态；从某频道打开时同时显示该频道的覆盖标记，避免被误解为 Run 已改变。

### 5.3 原子性、刷新与审计

008 的表保存显式 Room 任务关系和可重建控制投影；不可变 task action SessionEvent 是手动操作审计事实。move 要与其对应控制投影更新同一个 PostgreSQL 事务提交，使用可接收事务 client 的存储方法；不能复用当前会自行提交的 `append()` 然后再单独写控制表。锁顺序固定为 Room → task control，避免多任务拖动死锁；Run 读取只取快照，不在 Run 锁中重入其他仓库。File 适配器以持久操作日志恢复半完成步骤，内存实现同样按任务串行。

动作记录 actor、来源界面、from / to、自动列、reason、runId、Run revision、expectedVersion、新 version、幂等键及时间；正文原因随 SessionEvent 既有加密保存，控制表仅存引用。自动清覆盖使用 `(task, runId, runRevision, cause)` 去重，写系统动作而不冒充用户验收。冲突拒绝也记录结构化操作日志，不包含消息正文。

Run 仍是实时事实源，控制表只缓存 run revision / 覆盖，不复制 RunStatus 成为另一个可写任务状态。GET board 读取最新 Run 并应用同一规则，即使泵尚未运行也不能显示过期覆盖。`subscribeChanges()` 仅加速失效；重启/丢通知通过有界 scan 和按版本重算恢复。界面在可见时轮询统一 Board DTO（可先沿用 2 秒节奏），切换 Room、网络重连、审批/重试成功后立即重取。SSE 可以作为优化，不能只改正在打开的 `currentId`。服务端返回版本/ETag 含控制版本及各当前 Run revision；频道最后一条消息 id 不足以表达板版本。

任务关系回填从已有结构化 taskAction 和 legacy citation 解析，保留房间 ACL。新任务在提交创建时登记私聊/源频道关系；崩溃后由扫描 Conversation 消息 source 与频道引用补漏。未指定群频道的主页任务只属于该 Bot 私聊板和主人总览，不自动广播给全部频道。PR3 可先在现有真实 Room 与引用上实现；PR2 的私聊绑定完成后补登 direct Room 关系。

## 6. 频道管理与权限

Room 是频道的基础，新增元数据而非第二套 Channel 消息表。频道可以用产品名、主题命名，`category = product | topic | general`，可选 topicRef；名称不要求全租户唯一，链接使用 Room id。新增分类使用结构字段，旧 description 只是描述；现有「私聊 / 群聊」兼容回填后，修改描述不能改变聊天类型。

| 能力 | 规则 |
|---|---|
| 新建频道 | 已认证 owner 角色创建自己拥有的 group Room；成员选择须验证同 tenant 和 Bot 准入 |
| 看列表/历史 | Room owner 或有效成员；viewer 可读，移除成员后即撤销 |
| 发消息 | active Room 的 owner / editor / agent；viewer 不可写 |
| 改名/分类/主题 | Room owner / editor，expectedRevision 乐观锁 |
| 归档/恢复 | 仅 Room owner；归档阻止新消息和新任务动作，历史可读，活跃 Run 不因此取消 |
| 管理成员 | 继承现有 owner / editor 规则；绑定的 Bot 私聊固定为 owner + Bot，不允许加人变群聊 |
| 拖动/验收/审批 | 本轮保留看板 owner 操作边界；Run 审批仍按现有权限，不由 Room editor 自动取得 |

既有依据：`src/application/aeeis-service.ts:64`–`:88` 允许 owner/editor 修改、仅 owner 归档；`:199`–`:205` 检查事件写权限及归档；`:222`–`:228` 管理成员。PR4 要使 POST 的权限与设计明确一致，不能仅在按钮上隐藏。归档不停止既有 Run，Run 状态仍在个人收件箱可见；归档 Room 不写新的普通 task action，系统恢复/内部投影走专门受控路径，不能借此开放用户写入。

## 7. Migration 草案、RLS 与回滚

### 7.1 当前执行与编号规则（已核实）

目录目前是 `001-run-shares.sql` 至 `006-channel-noise.sql`。**未发现扫描目录、按编号排序执行或保存 schema version 的统一执行器，也没有 schema_migrations 表。** 实际机制：

1. 每个适配器 `init()` 执行内嵌 SQL，例如 `src/channel-noise.ts:83`–`:99` 与 `src/adapters/migrations/006-channel-noise.sql:1` 同步；Conversation 在 `src/adapters/conversation-store.ts:407` 执行自己的 migration；Room 在 `src/adapters/postgres-store.ts:38`–`:47` 初始化。
2. `src/adapters/postgres-migration.ts:6`–`:23` 使用 owner 连接，在事务内取 `aeeis:migration` + 适配器 lockName 的 advisory lock、执行幂等 DDL、授权 app role 并提交，失败回滚。**这是每个适配器的并发锁，不是按 001→006 的全局排序或版本记录。** 不同 lockName 也不保证相互先后。
3. 本仓库数据库存储的调用顺序来自 server 启动代码，所有新存储要在 `databaseSecurity.finalize()`（`src/server.ts:597`–`:599`）之前 init。当前 Temporal worker 的 activities 调 API，不持有这些数据库存储（`src/temporal/worker.ts:24`–`:33`），不应为了 migration 给它加一套数据库初始化；测试构造路径也要显式 init。文件编号是 SQL 副本的人工顺序，现有测试检查文件与常量相等，例如 `tests/channel-noise.test.ts:142`–`:145`。

因此拟用 007、008、009，不能只增加 SQL 文件就认为上线会执行。新适配器仍导出 SQL 常量并调用同一迁移锁，测试副本一致、并发 init、重复 init 和失败回滚。新表之间避免跨 PR 的 FK / DDL 顺序依赖；关联 id 在服务层校验 tenant / owner / Room。没有全局版本号的“减一”回滚步骤。

以下是 SQL 草案，不是本步要执行的 SQL。`state jsonb` 指经既有内容加密封装保存的聚合，不允许直接装入明文背景、聊天或密钥。

### 7.2 007-bot-dialogues.sql（PR2，新增 3 表）

```sql
CREATE TABLE IF NOT EXISTS aeeis_bot_dialogues (
  tenant_id text NOT NULL,
  owner text NOT NULL,
  bot_id text NOT NULL,
  conversation_id text NOT NULL,
  room_id text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('preparing', 'backfilling', 'ready', 'conflict')),
  version bigint NOT NULL DEFAULT 0,
  state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, owner, bot_id),
  UNIQUE (tenant_id, owner, conversation_id),
  UNIQUE (tenant_id, owner, room_id)
);
CREATE TABLE IF NOT EXISTS aeeis_bot_dialogue_room_aliases (
  tenant_id text NOT NULL,
  owner text NOT NULL,
  alias_room_id text NOT NULL,
  canonical_room_id text NOT NULL,
  bot_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, owner, alias_room_id),
  CHECK (alias_room_id <> canonical_room_id)
);
CREATE TABLE IF NOT EXISTS aeeis_bot_dialogue_operations (
  tenant_id text NOT NULL,
  owner text NOT NULL,
  operation_key text NOT NULL,
  bot_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ensure', 'import', 'delivery')),
  source_id text NOT NULL,
  target_id text,
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'conflict')),
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, owner, operation_key),
  UNIQUE (tenant_id, owner, bot_id, kind, source_id)
);
CREATE INDEX IF NOT EXISTS aeeis_bot_dialogue_operations_pending_idx
  ON aeeis_bot_dialogue_operations (tenant_id, owner, updated_at, operation_key)
  WHERE status = 'pending';
```

binding.state 保存回填高水位、原 revision、冲突/恢复信息；operations.state 保存来源、目标映射、请求摘要、重试与租约等恢复元数据，不另复制消息正文。operation_key 由服务端稳定生成，不能让每次后台扫描随机生成新键。File 适配器用同样 schema 的原子快照与操作日志。aliases 只能指向已验证的 canonical Room，不允许环或跨用户别名。

007 必须为上述三表分别安装下列策略模板，且把三表加入 `TENANT_POLICIES`，不能只靠业务 WHERE：

```sql
-- 将 <table> 分别替换为上面三张 aeeis_bot_dialogue* 表。
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aeeis_tenant ON <table>;
CREATE POLICY aeeis_tenant ON <table>
  USING (current_setting('aeeis.system', true) = 'on'
         OR tenant_id = current_setting('aeeis.tenant_id', true))
  WITH CHECK (current_setting('aeeis.system', true) = 'on'
              OR tenant_id = current_setting('aeeis.tenant_id', true));
```

回滚 SQL（停用新写入口/泵、导出并核验映射后，由 owner 在维护窗口执行；DROP 只撤结构，不能撤已导入消息）：

```sql
BEGIN;
DROP TABLE IF EXISTS aeeis_bot_dialogue_operations;
DROP TABLE IF EXISTS aeeis_bot_dialogue_room_aliases;
DROP TABLE IF EXISTS aeeis_bot_dialogues;
COMMIT;
```

应用数据回滚：保留 canonical Conversation 和原 Room/SessionEvent。不能按导入 id 无条件删消息，因为新任务可能已经引用它们；只能逐条确认没有后续引用的导入记录，并追加撤销标记。若要恢复旧 Room 写入口，先反向导出切换后的新增/修订消息、核验数量与来源并暂停 canonical 写入，否则保留单写兼容版本。回滚前不丢 alias/operation 映射。

### 7.3 008-task-board-controls.sql（PR3，新增 2 表）

```sql
CREATE TABLE IF NOT EXISTS aeeis_room_tasks (
  tenant_id text NOT NULL,
  owner text NOT NULL,
  room_id text NOT NULL,
  conversation_id text NOT NULL,
  task_id text NOT NULL,
  source_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, owner, room_id, conversation_id, task_id)
);
CREATE INDEX IF NOT EXISTS aeeis_room_tasks_task_idx
  ON aeeis_room_tasks (tenant_id, owner, conversation_id, task_id);
CREATE TABLE IF NOT EXISTS aeeis_task_board_controls (
  tenant_id text NOT NULL,
  owner text NOT NULL,
  room_id text NOT NULL,
  conversation_id text NOT NULL,
  task_id text NOT NULL,
  version bigint NOT NULL DEFAULT 0,
  observed_run_id text,
  observed_run_revision bigint,
  override_column text CHECK (override_column IN ('capture', 'ready', 'doing', 'blocked', 'review', 'done')),
  accepted_run_id text,
  last_action_event_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, owner, room_id, conversation_id, task_id),
  CHECK ((observed_run_id IS NULL) = (observed_run_revision IS NULL))
);
```

room_tasks 是明确的任务可见关系，不存任务正文或状态；source_id 指向创建消息/原 citation。controls 是动作投影，原因与 actor 等在 SessionEvent 的结构化 action 中审计。覆盖/验收按第 5 节检查，不能只靠 SQL CHECK 验证合法状态。接口 DTO 同时返回自动列和有效列。

008 对 `aeeis_room_tasks`、`aeeis_task_board_controls` 分别应用 007 展示的相同 RLS 模板，并加入 `TENANT_POLICIES`。服务层还必须验证 Room 可读、Conversation/Run 权限；同 tenant 的另一个 owner 不能凭 id 修改或看到对话。

回滚 SQL：

```sql
BEGIN;
DROP TABLE IF EXISTS aeeis_task_board_controls;
DROP TABLE IF EXISTS aeeis_room_tasks;
COMMIT;
```

先停用 move 命令、导出当前控制/关系。SessionEvent 动作审计不删除；保留能解码新 action 的兼容版服务，不能将带新 schema 的历史交给不识别它的旧二进制。旧页面可退回自动 Run 映射；回退版本需先支持忽略/展示未知动作。已有「暂停 Run / 验收」等副作用不随 DROP 自动撤销。

### 7.4 009-channel-metadata.sql（PR4，新增 1 表）

```sql
CREATE TABLE IF NOT EXISTS aeeis_channel_metadata (
  tenant_id text NOT NULL,
  owner text NOT NULL,
  room_id text NOT NULL,
  category text NOT NULL DEFAULT 'general'
    CHECK (category IN ('product', 'topic', 'general')),
  revision bigint NOT NULL DEFAULT 0,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, owner, room_id)
);
```

state 保存经过加密的 topicRef / 分类说明等；title、description、status 仍以原 Room 为准，不能在此复制第二份。Room 更新与 metadata revision 一并用事务/CAS 提交（扩展现有 Room commit 接口）；JSON 版本采用持久操作记录。旧 Room 缺 metadata 按 general 读取，惰性回填。类型字段在现有 Room state 中显式补齐，按既有 description / chat 解析，歧义保留为未分类，不能因为后来改描述改变类型。

009 对 `aeeis_channel_metadata` 应用 007 的相同 RLS 模板，加入 `TENANT_POLICIES`。

回滚 SQL：

```sql
BEGIN;
DROP TABLE IF EXISTS aeeis_channel_metadata;
COMMIT;
```

回退前导出分类；Room 标题、状态和消息保留，不“撤销”归档或改名。兼容读取继续接受已有显式 chat，避免回到依赖可编辑描述来识别私聊。

### 7.5 RLS、加密和合入时计数

策略沿用 006（`src/adapters/migrations/006-channel-noise.sql:8`–`:12`）和 `src/adapters/postgres-pool.ts:65`–`:83` 的 tenant / system 范式。RLS 负责 tenant 隔离，owner、Room 成员与审批范围仍在服务层；不把这些租户表放入 `INSTALLATION_TABLES` 逃避隔离。沿用 owner 执行 DDL、非 owner 且无 BYPASSRLS 的 app role（`:111`–`:125`），以及 finalize 授权；不新增全局公开策略或把 system 开关暴露给请求体。

现有硬断言是 `tests/channel-noise.test.ts:144` 的 **34 张 TENANT_POLICIES**，不是数据库实建表总数；`applyRowLevelSecurity()` 只对实际存在的表启用（`src/adapters/postgres-pool.ts:97`–`:108`）。按建议顺序：PR2 +3 → 37，PR3 +2 → 39，PR4 +1 → 40。PR1 不变。若 PR4 或 PR3 先合，则基于已合代码计算 `34 + 已合新增表`；不能把断言直接固定成最终 40 提前放行，也不能删除计数检查。回滚版本同步移除对应策略项/计数，避免启动 init 重建已 DROP 表。

每个新表都加跨 tenant 的 SELECT 不可见与 INSERT/UPDATE WITH CHECK 拒绝测试、同 tenant 异 owner 服务测试、system 后台恢复测试、app-role 权限检查。SQL 副本一致测试、首次与重复启动、并发 API/Worker init、旧数据回填失败恢复均需覆盖。正文、主题说明、迁移错误详情走内容加密；关系 id 明文仅用于索引，不得将正文塞进 source_id、operation_key 或普通日志。

## 8. PR 拆分、依赖、测试与验收

以下是后续实施 PR 的范围，本次只交付文档，不开始 PR1 业务修改。每个 PR 都可单独合入并有实际用户可验收的效果；正式团队页的最终整体验收需要所有相关 PR。

### PR1：设计文档 + Bot 页直接执行（方案 A）

- **文件：** 本文；`src/ui/app.ts`、必要时 `public/index.html`；`src/application/conversation-service.ts`、`src/runtime/http.ts`（注入 Bot 查询依赖）、`src/owned-bots.ts`（只在需要查询接口扩展时）；测试 `tests/conversations-ui.test.ts`、`tests/conversations.test.ts`、`tests/bot-team.test.ts`。不引入 migration，不接 `/team/` 模拟数据。
- **内容：** Bot 页发送可开 Run；服务端背景与常驻嘱咐一并注入；默认执行选项可见；审批/问题卡可直接处理；清理互相冲突的文案与旧 quick composer 限制。复用已有路由，不另建 Bot 专用执行引擎。
- **依赖：** 无，先独立修复最明显的工作阻断。PR2 必须保持这个接口与执行语义；不要在 PR1 偷做 Room 绑定。
- **测试：** 非 AEEIS Bot 发送 execute 返回同一 Bot 的 Run；模型实际输入含背景/常驻嘱咐且无其他 Bot 内容；旧 runOptions 材料与服务端来源冲突、槽位满、退役/外部 Bot、quiet 明确派活；只记录/纠正/代言不执行；活跃 Run 不重复；未知结果用同一键恢复一次；切换 Bot 不串卡；Bot 页计划与动作批准、拒绝、回答沿用原权限，跨 tenant 拒绝。
- **验收：** 在主页点有效 Bot，发一件任务，Bot 页出现真实 Run 及计划卡；required 档就地点开始/拒绝，任务按原规则推进。agent 自主来源审批限制保持原行为。刷新后仍能看到该任务与结果。

### PR2：统一主页对话与工作室私聊数据流

- **文件：** `src/conversations.ts`、`src/application/conversation-service.ts`；新增 `src/application/bot-dialogue-service.ts`、`src/bot-dialogues.ts` 及对应 File / memory / Postgres 适配器；`src/session-events.ts`、`src/bot-team.ts`、`src/channel-ingress.ts`（按实际入口调整）、`src/runtime/http.ts`、`src/server.ts`；007 SQL 与 `src/adapters/postgres-pool.ts`；`src/ui/app.ts`、`public/team/app.js` / `index.html`，必要的共享 API/DTO 模块与构建脚本。`src/temporal/worker.ts` 只核对活动兼容性，本方案无需修改其数据库初始化。
- **内容：** 第 4 节绑定、回填、单写及别名；把 `/team/` 的 roster、Room、私聊、任务详情、审批、产物基础读写都接真实 API，删除模拟发送/审批/任务回退。团队页任务板暂可只读已有自动列；频道 CRUD 入口留 PR4、拖动留 PR3。认证复用登录身份，不将 token 放 URL；未连接时给真实连接状态。设计样例如需保留移到独立 demo。
- **依赖：** 存储模型不依赖 PR1；为减少 `ConversationService` 冲突建议 PR1 先合，但 PR2 可在基线实现并保留原执行 API。PR2 内必须先基础存储 init、再受控回填、最后切入口；绑定未 ready 不双写。正式团队页的数据源接入是 PR2 必须完成的工作，不能只建关联表。
- **测试：** 新增 `tests/bot-dialogues.test.ts`、`tests/postgres-bot-dialogues.test.ts`；扩展 `tests/team-channel-ui.test.ts`、`tests/conversations-ui.test.ts`、`tests/postgres-row-level-security.test.ts` 和 RLS 计数。验证两处同 message/task/run id、同键只一 Run；旧 Room 多页、重复导入、alias、revision/retract/reply、身份冲突、跨 tenant/owner、回填崩溃各阶段、服务重启、加密往返；自动回复与 execute 不重复开工；内存/File/Postgres 同合同。原先只测试假审批的团队页用真实 API fixture 替换，不能继续凭内存改变验证通过。
- **验收：** 主页给 Bot 发话，团队页相应私聊立刻可见；团队页发话，主页同一记录可见；任务和批准引用同一 Run。刷新/重启保留；旧真实私聊在两处可读且无重复执行；普通群聊内容没有漏进其他私聊；真实业务服务断开时不出现模拟完成。

### PR3：任务状态联动与拖动

- **文件：** `src/channel-task-action.ts`、`src/channel-board.ts`、`src/session-events.ts`；新增任务关系/控制存储及适配器、008 SQL；`src/runtime/http.ts`、`src/server.ts`、`src/adapters/postgres-pool.ts`；`src/ui/app.ts`、主页样式、`public/team/app.js` / `styles.css`。恢复泵放在持有存储的 API 进程，按既有 Run changefeed 接口消费，不另建可写 RunStatus，不给 Temporal worker 新增数据库职责。
- **内容：** 第 5 节统一 Board DTO、任务关联、Run 事件失效+恢复、手动覆盖/审计、验收绑定 runId、鼠标/触摸/键盘操作。主页直接 Run 任务加入主人总览；已有 Room 任务立即受益。
- **依赖：** 后端和主页任务板可在 PR2 前合，不引用 007 表；PR2 未合时 direct Room 的自动关联延后，仍处理已有 citations。团队页目前是样例，真实拖动接线必须在 PR2 的真实数据适配层上做：如 PR3 先合，团队页接线作为默认关闭的真实 API 适配代码，PR2 启用并跑组合验收；不得把改静态 task.status 当完成。推荐 PR2 后合入 PR3，免除这部分过渡。PR1 无硬依赖。
- **测试：** `tests/channel-board.test.ts`、`tests/channel-upgrades.test.ts`、`tests/conversations-ui.test.ts`、`tests/team-channel-ui.test.ts`；新增 `tests/task-board-controls.test.ts`、`tests/postgres-task-board-controls.test.ts`，更新 RLS 测试/计数。穷尽 12 个 Run 状态、每个合法/非法移列、required/auto/agent 审批不绕过、同任务重试 Run、验收失效、迟到/重复/乱序事件、无新频道消息时刷新、双窗口冲突、取消/归档竞争、WIP、键盘和指针、断网恢复；验证动作审计和投影同事务，进程退出后可恢复。
- **验收：** 主页发起任务，在有权访问的专业任务板看见 queued → doing → blocked → review，验收后 done；拖动刷新后仍在正确列且可追溯；正在等批准/失败时不会被手动覆盖藏住；重试产生新 Run 后旧覆盖不影响它；团队页/主页详情显示同一真实状态。

### PR4：频道管理

- **文件：** `public/team/app.js` / `index.html` / `styles.css`，`src/ui/app.ts`、`public/index.html`；`src/contracts.ts`（显式 Room 类型/版本输入）、`src/application/aeeis-service.ts`、`src/adapters/postgres-store.ts`、其他 domain store 适配器、`src/runtime/http.ts`；新增 metadata 存储、009 SQL，`src/server.ts` 中的 init 与 RLS 清单。
- **内容：** 复用 Room CRUD，补产品/主题分类、显式类型、乐观锁；两处提供新建、改名、归档/恢复、归档列表和成员权限反馈，真实空态；不制造与主页不同的频道目录。
- **依赖：** schema、服务与主页管理功能可独立合入，无 007/008 FK；团队页管理入口使用 PR2 的认证与 Room 列表适配层。推荐 PR2 后接 UI；若 PR4 先合，只启用主页管理与后端，团队接线随 PR2 开启。与 PR3 功能互不依赖，但共同修改 UI、HTTP、RLS 计数，合入前要重基线。
- **测试：** `tests/room-membership.test.ts`、`tests/http-runtime.test.ts`、`tests/team-channel-ui.test.ts`；新增 `tests/channel-management.test.ts`、`tests/postgres-channel-metadata.test.ts`。分类与 legacy description 回填、分页、新建成员失败补偿、改名版本冲突、重复提交、owner/editor/viewer/agent 和跨 tenant 矩阵、归档只读且 Run 不被取消、恢复原 id、归档私聊不另建第二 Conversation、加密与 RLS。
- **验收：** 建两个不同产品/主题频道，主页与工作室显示同一 Room；改名同步，归档后不再列于活跃频道且历史可读，恢复后原链接有效；无权限账户看不到/不能改；全新用户没有「客户反馈」等伪数据。

### 合入与 migration 冲突处理

建议顺序为 PR1 → PR2 → PR3 / PR4。PR3、PR4 可以并行开发；后端不使用彼此的新表。上述“可独立合入”指每个 PR 在现有真实主页上能工作、默认打开的功能有完整依赖；团队页最终组合必须有 PR2，不能承诺四个 PR 在任意顺序都立刻实现完整工作室。

预留 007=PR2、008=PR3、009=PR4 便于讨论。编号不控制执行：如 008 先合且无结构依赖，服务仍只初始化本 PR 的存储；若维护者要求仓库文件连续编号，则**在合入前**按主线下一空号重编号，并同步 SQL 引用、常量一致测试和本文，不能仅改文件名。若其他 PR 抢占 007，也按此处理，不覆盖既有 migration；已经发布的编号与 SQL 不改，修复另加下一号。合并 RLS 清单时用集合并集重算计数，并再次跑双 CI，避免不同 PR 都以 37/36 等过期数字断言。

### 每个 PR 的 CI 门槛

`.github/workflows/verify.yml:12` 的 quality 运行 `npm run verify`；`:24` 的 postgres 在 PostgreSQL 17 下同样运行 verify，开启 Postgres 阶段。`scripts/verify.mjs:6`–`:16` 包含 typecheck、串行全测、build，并按开关加入 `npm run test:postgres`；`scripts/test-postgres.mjs:8`–`:11` 自动发现 `tests/postgres-*.test.ts`。新增 Postgres 测试必须符合命名，不能本地 skip 就称数据库验证通过。

每个 PR 必须 quality + postgres 都绿；数据库迁移 PR 还要在测试中验证 fresh schema、现有 006 状态升级、重复/并发启动和所述回滚后的兼容行为。本次纯文档检查不代替这些未来门槛，也不宣称已在本步跑过未来测试。

## 9. 风险与未决问题

1. **实际部署差异。** 当前源码有三个静态频道，与老板只见一个不符。待部署核对实际 URL、SHA 与资源缓存后补证；不能靠修改种子列表解决数据统一。
2. **私聊受众与导入。** 原 Room 可能曾加过人、跨 owner 或已经投递过一次。需以完整历史受众检查决定是否可自动合并；保留冲突房间，不能因“现在只剩一个成员”把共享历史当成个人私聊。
3. **正文权威源选择。** 本方案选择 Conversation，保护既有 Run/Thread/常驻嘱咐及幂等链；代价是需要给 Conversation 增加修订/撤回和 Room 视图适配。若未来要改为 SessionEvent 权威，应另立设计并迁移执行快照，不能在 PR2 中途保留两个可编辑正文源。
4. **跨存储一致性。** PostgreSQL 新动作投影必须同事务；文件模式和 Room/Conversation 跨边界创建依赖可恢复日志。需在各落盘阶段故障注入；不能仅凭 HTTP 幂等认为写两处永远一致。
5. **演示转正式的工作量。** `/team/` 目前所有任务/审批都是模拟，PR2 必须覆盖其基础业务操作和身份。如果无法一次完成全部展示模块，未接模块明确禁用或显示未支持，不能继续模拟操作成功。
6. **共享频道中的个人任务。** 私聊任务不自动共享；群聊只显示已有权限范围内的状态/产物。是否允许 editor 操作别人的任务或审批，是后续权限设计，本轮默认 owner 保持现状。
7. **用户感知。** 手动「进行中」与真正 Run running 不相等，必须同时显示执行状态；完成依然需要成功+验收。团队旧样例的百分比不是真实进度，改用有证据的步骤完成数。
8. **规模与恢复。** 长期 Conversation 聚合会变大；回填、消息分页、Run 扫描与 Room 列表都要有界，不能一次全量开所有 Bot 记录。拆分消息表可作为后续性能项目，不能为本轮统一再建一份正文副本。
9. **归档语义。** 本设计采用“归档 Room 只关闭协作入口，不取消活跃 Run”，个人收件箱继续收审批。是否在归档前提示仍有活跃工作，实施时确定文案；停止工作必须由明确取消动作完成。

## 10. 本步交付与后续完成标准

本步交付此设计与 `/workspace/aeeis-unified/doc-summary.md`，不执行 PR1 业务变更。后续完成统一的标准是：同一 Bot 从两个界面发/读消息引用相同 messageId，任务指向相同 taskId / runId，审批操作落在同一个 Run；重启、重试、迁移与手动拖动后仍满足这个不变量。

## 11. PR2 实施记录（2026-11-04）

本分支实现 PR2；PR1 的执行意图闸门、PR3 的拖动与任务控制、PR4 的频道管理不在此处实现。

- `BotDialogueService` 按真实 Bot id 和登录身份解析唯一 Conversation / direct Room。主页通过状态能力 `botDialogueRouting` 使用该绑定，旧 Bot Room 链接按成员身份解析；未部署绑定服务的旧服务仍沿用原 Conversation 协议。`/team/` 已替换为正式 API 界面，不再提供内存业务样例或失败时的演示数据回退。
- 007 的三表与本文草案一致；存储 init 内嵌同一 SQL，启动在 RLS finalize 之前初始化。当前 `TENANT_POLICIES` 为 **37** 项。关系表只保存 id、阶段、高水位、哈希和恢复元数据，不保存聊天、背景或错误正文。Postgres 使用独立连接池上的 owner 范围 advisory lock；跨适配器副作用前后的 checkpoint 分别持久提交，不能依赖外层锁事务回滚已经落盘的 Conversation。
- 回填是按 Bot 首次解析触发的受控惰性操作。扫描不使用前端 Room 列表上限，SessionEvent 分页为 200；只接受同 tenant / owner、唯一有效 Bot 对方、无额外历史成员且所有历史 audience 恰为主人与该 Bot 的真实私聊。显式 `chat=group` 优先于可编辑 description。受众冲突置为 `conflict`，保留旧 Room 并阻止目标 Conversation 的新消息，不以名字、文本相似度或静态演示身份推断归属。多个未认领 AEEIS 历史也拒绝猜测。主人可以用 `GET /api/bot-dialogues` 检查仅含 id、数量和冲突类型的整理清单。
- 迁移只调用聚合 import，不调用 post、模型、审批或 dispatcher。源事件 id/hash/actor/time、reply 与追加的 revise/retract 来源保存在 canonical Conversation，原 SessionEvent 审计不变。视图和后续执行上下文应用撤回；原任务动作、决策及 Run 引用按历史引用卡保留，不重新执行。引用卡不会凭历史文本生成新的任务或批准。
- binding ready 以前有 owner 范围写屏障；主页发送、专业私聊发送、旧 Room 写入和 Bot 后台写入共享屏障。绑定后旧 SessionEvent 普通消息、修订/撤回和成员更改返回明确冲突；原历史可读。绑定、别名、导入与投递映射在 memory / File / Postgres 有相同恢复合同。File 单写者锁及 fsync 原子快照遵循现有适配器约定。导入沿用现有 Conversation 的 **1000 条原始消息 / 100 项任务 / 8 MiB** 上限；超过容量保留 checkpoint 和原历史，需要后续分段存储方案，不能丢弃或截断历史来强行切换。
- 核查发现 FileConversationStore 原先直接 JSON 读写，并未像 Postgres 使用已有 `openAggregate` / `sealConversation`；PR2 同步补齐这两个路径，兼容未加密旧文件。新增 `room` 来源与追加修订元数据，禁止通过第二份 SessionEvent 正文编辑 canonical 私聊。频道投递在服务端按原事件 / Bot / deliveryKind 去重，来源材料是讨论而非执行授权。
- 讨论回复写回同一 Conversation，保留 agent speaker、replyTo 与确定性触发键；只有明确 `discuss` 的新消息参与后台补漏，历史导入、频道材料和 `execute` 不触发该回复链。后台 sweep 跳过旧私聊 SessionEvent。专业发送可明确开 Run，沿用原有 canExecute、task/newTask、revision 与 Idempotency-Key 规则，没有改变主页 PR1 闸门。
- `/team/` 复用 `aeeis.token` 的请求头认证，token 不进 URL。真实 roster、所有可读 Room、消息分页、任务详情、Run 审批/拒绝/修改计划/回答问题及 Run 产物读取均调用已有权限接口；直聊任务自动列由服务端输出，群聊使用既有 Board DTO。产物的基础写入是 **Conversation 内追加的主人编辑草稿**（支持后续版本与 CAS），不覆盖 Run 的证据产物。未知发送结果保留原 body / key（sessionStorage 按身份恢复），刷新或重试不重造执行请求。频道管理与拖动只显示后续版本说明。

007 回滚仍按第 7.2 节 SQL：先停止专业新入口和后台新协议写入、备份三表及 canonical Conversation，再 `BEGIN; DROP TABLE IF EXISTS aeeis_bot_dialogue_operations; DROP TABLE IF EXISTS aeeis_bot_dialogue_room_aliases; DROP TABLE IF EXISTS aeeis_bot_dialogues; COMMIT;`。应同时回退 init / RLS 清单，避免重建；保留能读取新增消息来源、修订与草稿的兼容版本。DDL 回滚不会把切换后的新消息复制回旧 SessionEvent，不能恢复旧双写行为。007 SQL 注释也列出了该回滚语句。
