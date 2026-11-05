# 从 agent-autoloop 借鉴的改进计划

> 来源：2026-11-04 对 [KKKKhazix/agent-autoloop](https://github.com/KKKKhazix/agent-autoloop)（main，2026-11-04）的对比阅读。
> 状态：提案。每一项独立成 PR，可按优先级挑选。第 2 项已实施（见该节"实施结果"）。

## 背景

agent-autoloop 是本机运行的事件调度中台：规则把事件派给命令行 Agent（Claude Code、Codex、ACP 或任意 `{prompt}` 命令），Agent 在最后一条回复里附上回执，需要人决定时发卡片，等待期间不占进程。内核约 1,650 行、零运行时依赖，所有状态由 SQLite 追加式事实日志推导。

它和 AEEIS 的定位不同：它不规划、不审核、不积累证据，信任 Agent 的结论。AEEIS 不需要学它的产品形态，但它在**边界和可验证性**上有几处做法比我们更硬，值得借鉴。下面只列这些。

## 1. 外部事件不能决定执行边界（P0）

**它的做法。** 外部文本（issue 标题、正文）只写进本地数据文件，提示词里只放校验过字符集的类型、ID 和链接；只有 `rules.json` 决定哪个 Agent、在哪个目录、带什么权限运行。事件里出现 `cwd`、`agent`、`access` 字段直接拒绝。

**AEEIS 现状。**

- `collaboration-trigger-event/1`（`src/collaboration-triggers.ts`）允许事件携带 `goal`（最多 8000 字符）、`context.claims[].text` 和 `allowedAgentIds`。`allowedAgentIds` 目前只用于收窄 policy 的参与者（`collaboration-triggers.ts:374`），方向是安全的；但这一点没有被测试或文档固定下来。
- `external.message` 由 Feishu / Hermes ingress 产生，`goal` 和 claims 里的文本最终会进入 Competition / Debate 参与者的上下文。
- Run 资料已有 `material` 标记和外部来源边界，RSI 合成器提示词也声明来源是不可信数据；但 trigger 路径没有统一走这条边界。

**计划。**

1. 写一份不变量并加测试：trigger event 中的任何字段只能**收窄** policy 已声明的 Agent、工具、预算、隐私级别，不能放宽或新增。`allowedAgentIds` 中出现 policy 之外的 ID 时应拒绝匹配而不是忽略。
2. 审计 `goal` 和 `context.claims[].text` 从 trigger 到 Competition Attempt / Debate participant 提示词的路径：确保它们以 `material`（带来源、hash、外部边界说明）进入，而不是拼进系统或任务指令。
3. 在 schema 层显式拒绝执行边界字段（`cwd`、`workspace`、`toolPolicy`、`actionPolicy`、`budget` 等），即使未来有人放宽 `.strict()` 也会失败。

**完成标准。** `tests/collaboration-triggers.test.ts` 覆盖"事件不能放宽 policy"；一个 Feishu `external.message` 的端到端测试断言其文本只以 material 形式出现在参与者上下文中。

**核实结果（2026-11-04）。**

- 已固定：`tests/collaboration-triggers.test.ts` 的"lets an event narrow but never widen the policy execution boundary"断言参与者、`maxRounds`、`maxCost`、`blindEvaluation`、`dispatch` 都来自 policy；事件携带这些字段或 `cwd`、`actionPolicy`、`modelBudget` 时被 `.strict()` schema 拒绝。第 3 步不需要另写拒绝列表。
- 修订第 1 步：`allowedAgentIds` 中多出的 ID 保持忽略。参与者只取自 policy，多出的 ID 不授予任何东西；拒绝匹配没有安全收益。
- `context.classification` 来自事件，但三个来源都不能借此降级：pump 用 `run.privacy ?? 'private'`，Feishu / Hermes ingress 用 Room 冻结的 classification（缺省 `private`），HTTP 调用方必须就是事件 owner。
- **已解决（2026-11-04）：** Feishu / Hermes 的 `external.message` 原先把消息正文直接作为新 Competition / Debate 的 `goal`。现在 `goal` 取自 Room 目标，正文只放在单独的不可信 `externalInput` 字段，参与者提示说明不执行其中指令、不作为证据；`externalInput` 只允许出现在 `external.message` 上，且 `channel` 必须与事件 `source` 一致；它只能由进程内、验签后的 Feishu / Hermes ingress 带入；任何 HTTP 路由（包括持 worker token 的内部路由）和直接创建 Competition / Debate 的请求体都不接受该字段，也不能以 `feishu` / `hermes` 作为事件来源或发送 `external.message`。所有模型看到的发送者 ID 都被匿名化。评审、主持、裁决等所有角色的系统提示都声明其不可信。Room 没有目标时，ingress 使用一个只指向该输入的固定目标。Debate 的目标设计同时改为参与者用工具补齐信息差，因此这条边界是前置条件，见 [Debate：用各自知识和工具反馈达成共识](2026-11-04-debate-consensus-with-tools.md)。

## 2. 自动派生链的跳数熔断（P0）

**它的做法。** Agent 回执中产生的事件可以继续派发 Agent，跳数单调递增，跨人工问答和定时跟进都不重置，Agent 无法清零。超过 8 跳时内核记录事件、停止派发、发通知卡。

**AEEIS 现状。** 自动派生的入口至少有：

- `task.completed` / `task.failed` / `review.completed` → Trigger Policy → Competition / Debate（`dispatch: 'run'` 时自动运行），由 `src/collaboration-trigger-pump.ts` 驱动；
- Project Pulse `nextActions` → successor Plan（`src/runtime/engine.ts` 的 `projectPulseNextActions`，`reopenGoal: true`）；
- RSI proposal pump 由低置信度审核触发。

这些链路各自有幂等键和预算，但没有一个跨链路的"派生深度"。预算能限制花费，限制不了一个低成本的回环。

**计划。**

1. 在 Run、Competition、Debate、Plan revision 上增加只读的 `lineage: { rootId, depth }`，由创建方从父对象计算（`depth = parent.depth + 1`），API 和模型输出都不能写入。
2. Trigger event 携带来源对象的 `depth`；pump 在派发前检查上限（默认 8，可配置，不可由事件覆盖）。超过上限时写 `trigger.decision` 为 `blocked_depth`，并在对话 / 工作台里显示一条需要用户处理的通知。
3. successor Plan 继承来源 Run 的深度；用户手动在"长期目标"里调度时深度归零（人工介入是合法的新根）。

**完成标准。** 构造 `task.completed → competition → task.completed → …` 的回环测试，第 9 跳被拦下并留下可查询的 decision；File 与 PostgreSQL 两种存储都覆盖。

**实施结果（2026-11-05）。**

- `src/lineage.ts` 定义 `lineage: { rootId, depth }`。Run、Competition、Debate 记录和 Plan 都有可选的只读 `lineage`；没有 lineage 的记录视为深度 0 的根。只有创建方通过受信参数写入：`CollaborationService.createCompetition / createDebate(input, scope, trusted)`、`AeeisService.createPlanRevision(..., { lineage })`、`AgentEngine.create(..., trusted)`。请求体和模型输出都过 `.strict()` schema，带 `lineage` 直接 400。
- `collaboration-trigger-event/1` 新增 `lineage`（来源对象的位置）。只有 Run pump 通过新的 `evaluateDerived()` 带上它（取自来源 Run，`lineageOf(run)`）；`evaluate()`（HTTP 和 worker 路由）和 `evaluateExternalMessage()`（Feishu/Hermes ingress）遇到 `lineage` 一律拒绝，外部消息和 HTTP 事件都是新根。
- Trigger Service 先算出待创建资源的 lineage（`depth = 来源 depth + 1`），超过上限就以同一个 policy/event 键写入 `state: 'blocked_depth'` 的 decision（带 lineage 和原因），不创建、不派发；该 decision 是终态，reconcile 不能复活。上限来自 `AEEIS_MAX_DERIVATION_DEPTH`（默认 8，1–1000），事件不能覆盖。
- 通知：pump 把被拦下的派生写到来源 Run 的 `derivationBlocked` 并追加 `derivation.blocked` 事件（重放不会重复）。Run 列表摘要带上它；工作台收件箱显示"自动派生已停止"，属于 S1，会走浏览器通知和 `/api/push` 推送；`explainRun().attention.kind` 为 `inspect_derivation`。`POST /api/runs/:id/derivation-block/acknowledge` 只隐藏通知，不恢复链路。
- Project Pulse：`projectPulseNextActions` 给 successor Plan 写 `lineage = 来源 Run + 1`；超过上限时不建 Plan，同样在 Run 上留 `derivationBlocked`（`kind: 'project_pulse'`）。用户在"长期目标"里手动建 / 修订 Plan、手动调度任务都不带 lineage，即新根。
- 测试：`tests/derivation-depth.test.ts` 的回环测试在 File 与 PostgreSQL 存储上各跑一次：Competition 深度 1/3/5/7、派生 Run 深度 2/4/6/8，第 9 跳得到可查询的 `blocked_depth` decision；另有 HTTP / worker / ingress / 请求体不能写 lineage 的测试，以及 Pulse successor Plan 继承深度和超限被拦的测试。
- 未做：RSI proposal pump 还没接入 lineage；目前也没有生产代码从 Competition / Debate 结果自动派生 Run（测试里由执行器模拟），以后加这条路径时用 `AgentEngine.create(..., { lineage: childLineage(lineageOf(parent)) })`。

## 3. File 存储的崩溃与随机模拟（P1）

**它的做法。** `sim/random.ts` 用一个种子复现 20 万步的丢包、崩溃、重复请求；`sim/crash.ts` 做 1,000 次 `SIGKILL`，断言已确认的写入一条不丢；另有变异测试确认这些检查真能抓到错误。

**AEEIS 现状。** `tests/json-domain-journal.test.ts` 覆盖了 journal 的校验和恢复，`npm run smoke:local:restart` 覆盖"等待审批时重启"。没有对 File Domain store（journal + 快照 + sidecar 压缩）做反复强杀。

**计划。**

1. 新增 `scripts/crash-domain-store.mjs`：子进程循环执行随机领域事务（跨 Goal / Plan / Task / Receipt），每次事务确认后向父进程报告；父进程在随机时刻 `SIGKILL`，重启后断言所有已确认事务都在、未确认事务要么完整要么不存在、快照压缩可重入。
2. 种子化：失败时打印种子，`node scripts/crash-domain-store.mjs <seed> <iterations>` 可复现。
3. 默认 CI 跑少量迭代（例如 50 次），`AEEIS_VERIFY_FULL_LOCAL=1` 时跑 1,000 次。
4. 写完后故意注入一个错误（例如跳过 `fsync` 或压缩时先删旧 journal），确认脚本能失败，再撤回。

**完成标准。** 在本机跑通 1,000 次强杀无丢失；注入错误的一次能稳定复现失败。

## 4. 一条命令看一次 Run 的完整经过（P2）

**它的做法。** `agent-autoloop why 1` 按时间输出一轮的规则版本、触发事件、领取者、提问、回答和结果。

**AEEIS 现状。** 工作台能看到 DAG、事件和 Evidence Graph；`scripts/fetch-run.mjs` 能拉 debug bundle（JSON）；`scripts/run-admin.mjs` 只有 `cancel` / `reconcile`。排查时仍要在工作台和 JSON 之间来回切。

**计划。** 给 `run-admin.mjs` 增加 `why <runId>`：复用 `src/runtime/run-debug.ts` 的脱敏输出，按时间打印计划版本与批准、每个任务的开始 / 结束 / 重试、外部动作审批、提问与回答、审核结论、预算用量、派生关系（含第 2 项的 lineage）。不新增服务端接口。

**完成标准。** 对 `npm run smoke:local` 产生的 Run 输出可读的时间线，token 被脱敏。

## 5. 回执格式错误时只重写最后一条（P2）

**它的做法。** 回执 JSON 无效时，在同一会话里让 Agent 只重写最后一条回复，不重做已完成的工作；仍失败则保留原结论并告诉用户回执未生效。续接旧会话中途失败算作失败，几分钟后在同一会话重试，而不是新开会话重做。

**AEEIS 现状。** 外部 Agent 通过 `agent-task/1` 返回 Result Envelope；结构化产物校验失败时的修复逻辑见 `docs/fixes/repair-artifact-type.md`。需要确认两点：外部 Agent 的 Envelope 校验失败是整任务重跑还是只修复输出；修复失败时用户能否看到"结论在、结构化部分未生效"。

**计划。** 先调研现有行为并记录；如果是整任务重跑，为 `agent-task/1` 增加 `repair` 请求（携带原 `taskId`、校验错误、上一次输出 hash），由 Agent 只返回修正后的 Envelope。

**完成标准。** 调研结论写入本文件；如需改动，fixture agent 覆盖"第一次 Envelope 无效、修复后通过"和"修复也失败"两种情况。

## 6. 本地 CLI Agent 适配器（P3，可选）

**它的做法。** `use: "command"` 加命令数组即可接入任何"接收提示词、打印最后回复"的 CLI；`{prompt}` 作为单个参数传入，不经过 shell。

**对 AEEIS 的意义。** Agent Gateway 目前要求外部 Agent 实现 HTTP 协议并使用 HTTPS。在本机开发和单用户部署中，一个受限的 command 适配器能让 Claude Code / Codex 直接作为 Competition 参与者或 delegate。

**前提。** 必须放在 `docker-sandbox` / `sandbox-workspace` 边界内，凭证不经过 AEEIS，命令和工作目录只由服务端配置决定（与第 1 项同一原则）。安全设计没确定之前不实施。

## 不借鉴的部分

- **无界面、只靠卡片。** AEEIS 的计划审批、DAG 编辑和证据查看需要工作台。
- **信任 Agent 结论。** AEEIS 的独立审核和 Evidence refs 是核心，不放松。
- **零依赖内核。** 值得欣赏，但 AEEIS 已依赖 Temporal 和 PostgreSQL 提供持久执行和多用户隔离，不为此重写。

## 建议顺序

1 → 2 先做（都是边界问题，改动小，测试明确）；3 在下一次改动 File store 之前完成；4、5 按排查需要穿插；6 等沙箱方案确定后再评估。
