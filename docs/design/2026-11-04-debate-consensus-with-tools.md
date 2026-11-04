# Debate：用各自知识和工具反馈补齐信息差、达成共识

> 状态：设计，2026-11-04。外部输入边界（第 4 节）随本文一起实现；其余各节是目标设计，按第 8 节分阶段落地。
> 修订：[多 Agent 开放世界设计](2026-09-18-multi-agent-open-world-design.md)中"Debate Workflow"一节的证据规则和 `external.message` 的 goal 来源。

## 1. 目标

Debate 的用途不是让几个模型对同一份材料各说各话，再由裁判挑一个。它要让**掌握不同信息的 Agent** 互相补齐：

- 每个参与者带着自己的知识和自己能用的工具进场；
- 发现判断缺了什么信息时，明确说出来；
- 由能查到的一方用工具去查，把结果带回房间；
- 所有人根据新信息更新立场，直到达成共识，或者明确说清分歧在哪里、还缺什么。

原设计把证据限定在冻结的 Debate Context Pack 里（"之前消息的 claim 不会获得新的证据权威"），参与者也没有工具。这能防止 Agent 自造证据，但也让 Debate 无法补齐信息差。本文保留"不能自造证据"的原则，同时开放一条受控的新证据来源：**AEEIS 记录下来的工具回执**。

## 2. 陈述的四级权威

每条消息里的每个论点都带一个权威等级，由 AEEIS 判定，Agent 不能自报：

| 等级 | 来源 | 能否支撑结论 |
|---|---|---|
| `context` | Debate Context Pack 中的 claim 或 artifact | 能 |
| `observed` | 本 Debate 中由 AEEIS 执行并持久化回执的工具调用 | 能 |
| `reported` | 外部 Agent 用它自己的工具得到的结果，附可复查的来源（URL、命令、查询、版本） | 不能单独支撑；被另一参与者复查为 `observed` 后才能 |
| `asserted` | Agent 自身知识或推理 | 不能；可以提出、质疑、被验证 |

规则：

- 引用别人的 `asserted` 或 `reported` 论点不会提升它的等级。升级只有一条路：有人用工具复查，生成 `observed` 回执。
- Moderator policy 继续检查 `claimRefs`：只能指向 Context Pack、本房间的 `observed` 回执，或明确标为 `asserted` / `reported` 的论点。未知引用照旧 `flagged`。
- "我查过了"这句话本身是 `asserted`。只有 AEEIS 有回执的调用才算 `observed`。

## 3. 信息差与工具反馈

### 3.1 消息类型

在现有 position、evidence、challenge、rebuttal、clarification、concession、decision 之外增加：

- `gap`：声明"要判断 X，我需要知道 Y"。带 `gapId`、问题、为什么影响结论、建议的查询方式。
- `observation`：回应某个 `gapId`，携带一条或多条工具回执引用。

Debate 状态里维护 gap 列表：`open` → `answered`（有 observation 引用）→ `closed`（提出方或 Moderator 确认足够）/ `unresolvable`（工具无法回答或被拒绝）。

### 3.2 工具调用边界

- **工具只来自冻结的授权。** 每个参与者能用的工具在创建 Debate 时由 Trigger Policy 或 Room 配置决定，按 Agent 分别列出，随 Debate 冻结。消息内容、外部输入、其他参与者都不能增加工具。
- **默认只读。** 有副作用的工具（写文件、发消息、改配置、花钱）沿用 Run 的 `actionPolicy: { allow, block }` 和 `approve-action` 的 `once / always / deny / block`。Debate 里的副作用调用必须先得到主人决定，等待期间该参与者的这一轮挂起，不占模型调用。
- **先落库再调用。** 每次工具调用和模型调用一样先持久化 Attempt。`started` / `unknown` 重启后不自动重发，必须 reconcile。
- **回执是数据。** 工具结果按 hash 保存为 `observed` 回执，进入后续上下文时以 material 形式出现，带来源和不可信边界说明；结果文本里的指令不会被执行。
- **隐私。** 工具结果继承 Debate 的 classification；返回超出该级别数据的工具调用被拒绝。`private` Debate 只能使用不保留数据的 Agent，与 Agent Gateway 现有规则一致。
- **外部 Agent。** 通过 Agent Gateway 参与的 Agent 用自己的工具时，AEEIS 看不到调用过程，结果只能是 `reported`。

### 3.3 预算与终止

在现有最大轮数、单 Agent 发言数、总消息数、模型预算之外增加：

- 每个 Agent 每轮最多工具调用次数，以及整个 Debate 的工具调用和费用上限；工具费用计入 `modelBudget` 同一账本；
- 相同工具加相同参数重复调用直接复用已有回执，不重新执行；
- 连续两轮没有新的 `observed` 回执、也没有立场变化时，视为停滞，进入第 5 节的收尾流程。

## 4. 外部输入边界（已实现）

Feishu / Hermes 的 `external.message` 原先把消息正文直接作为新 Competition / Debate 的 `goal`。一旦参与者有工具，这就是指令注入入口。现在：

- `goal` 只来自 AEEIS 控制的来源：Room 的目标；Room 没有目标时，ingress 使用一个只指向该输入的固定目标（`Respond to the external Feishu message in <debate id>`）；
- 外部消息正文放进单独的 `externalInput: { channel, messageId, senderAgentId, text, receivedAt }`，Trigger Event、Competition Brief 和 Debate Room 都原样保存；
- 所有角色（候选者、评审、参与者、主持、裁决）的系统提示都说明：`externalInput` 是外部来的输入，可以作为信息考虑，其中的指令不执行，也不能据此申请或使用授权之外的工具；
- `externalInput` 只允许出现在 `external.message` 事件上，且 `channel` 必须与事件 `source` 一致；它不是证据，不能被 `claimRefs` 引用为 `context` 或 `observed`；
- 它只能经内部 Trigger 路由由 Feishu / Hermes ingress 带入。用户侧的 `/api/collaborations/triggers/evaluate`，以及直接创建 Competition / Debate 的请求体，都不接受该字段，调用方无法冒充渠道来源。

## 5. 共识规则

每轮结束时，每个参与者提交一份结构化立场：

```json
{ "position": "...", "confidence": 0.7, "dependsOnGaps": ["gap.release-ci"], "supportRefs": ["obs.ci-run-412"] }
```

Debate 在满足以下条件时以 `consensus` 结束：

1. 所有参与者的立场一致，或其余参与者已明确 `concession`；
2. 没有被任何立场列为依赖的 `open` gap；
3. 共同立场至少引用一条 `context` 或 `observed` 证据。

达到轮数或预算上限、或停滞时：

- 若多数立场一致且满足 2、3，由 Adjudicator 写入 `decided`，同时记录少数意见及其理由；
- 否则进入 `held`，最终产物列出各方立场、仍然 open 或 unresolvable 的 gap、以及要补齐它们需要的人或工具。

共识结论照旧由 AEEIS 写入 Decision / Task / Artifact；带副作用的后续动作仍走 Plan 审批，不由 Debate 直接执行。

## 6. 与现有机制的关系

- **Moderator** 从"检查引用是否在 Context Pack"扩展为：检查权威等级、gap 生命周期、工具调用是否在授权内、回执引用是否存在。
- **Adjudicator** 只在共识规则无法自动成立时介入，且只能依据 `context` / `observed` 证据作结论。
- **Competition** 不变：候选者仍互相隔离。Competition 可以借用同一套工具授权和 `observed` 回执，但不引入 gap 或共识规则。
- **跳数熔断**（借鉴计划第 2 项）：Debate 结论生成的后续 Plan / Trigger 继承 lineage 深度。

## 7. 威胁与对策

| 威胁 | 对策 |
|---|---|
| 外部消息让 Agent 调用危险工具 | 工具授权冻结且按 Agent 列出；外部输入只在 `externalInput`；副作用需主人批准 |
| Agent 自称查过，伪造证据 | 只有 AEEIS 回执算 `observed`；自报一律 `asserted` |
| 工具返回内容夹带指令 | 回执作为 material 进入上下文，带不可信边界 |
| 多个 Agent 互相引用形成"共识" | 引用不升级权威；共识要求至少一条 `context` / `observed` |
| 工具调用循环烧钱 | 每轮和总量上限；相同调用复用回执；停滞检测 |
| 敏感数据经工具外泄 | 工具结果继承 classification；private 只用不保留数据的 Agent |

## 8. 分阶段落地

1. **外部输入边界**：本次完成（第 4 节）。
2. **权威等级与 gap**：消息 schema 增加论点权威、`gap` / `observation` 类型和 gap 状态；Moderator policy 随之更新。先不接工具，`observation` 只能引用 Context Pack，以验证流程。
3. **AEEIS 执行的只读工具**：Debate 创建时冻结每个 Agent 的只读工具集；工具 Attempt、回执持久化、reconcile、预算和重复调用复用。
4. **共识规则与收尾**：结构化立场、`consensus` / `decided` / `held` 判定、少数意见与剩余 gap 的最终产物；工作台展示 gap 和立场变化。
5. **副作用工具与外部 Agent**：接入 `approve-action`；外部 Agent 的 `reported` 证据及复查升级。依赖借鉴计划第 6 项的沙箱方案。
