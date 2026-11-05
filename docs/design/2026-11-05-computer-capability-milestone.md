---
title: 下一个里程碑：先让 Bot 用上电脑，审批改为范围授权
date: 2026-11-05
status: 设计；切片 A（范围授权）已实现；切片 B 第一部分（远程沙箱、出口代理、浏览器）已实现
relates:
  - 2026-10-29-bots-that-act.md
  - 2026-11-04-agent-autoloop-borrow-plan.md
  - 2026-11-04-debate-consensus-with-tools.md
---

# 下一个里程碑：先让 Bot 用上电脑，审批改为范围授权

目标：**尽早交付电脑能力，同时减少审批打扰。从一个完整的真实任务做起。** 测试 VPS 已经就绪；连接器不是前提。

顺序：**VPS 执行流程 + 最小审批改造 → 真实任务验证 → 连接器与持续调度 → 多 Bot 隔离与产品化。** 先给自己团队用，现有租户隔离不放松。

## 0. 现状（从代码出发）

| 已经有 | 位置 | 差什么 |
|---|---|---|
| 每个 Run 一台 Docker 机器：`read/write/diff/glob/grep/python/shell/process/web-fetch`，后台进程、端口映射到 `127.0.0.1` | `local-tools.ts`、`docker-sandbox.ts` | 没有浏览器和截图；工作目录跟着 Run 走，不跟着 Bot |
| Docker 可以指向远程：`sandbox.context` / `DOCKER_HOST` | `dockerContextArgs` | 已经能经 `ssh://` 指向测试 VPS，但没测过，预览端口只绑在 VPS 的回环地址上 |
| 计划审批三档 `required / auto / yolo`，`duration: task / once`，批准时可调预算，计划有版本和 hash | `engine.ts` `approve`、`contracts.ts` | 每个 Run、每个计划版本都要批一次；重新规划后要再批 |
| 动作审批：`actionPolicy { allow, block }`、`approve-action once/always/deny/block`、来源与"读入外部文本后"规则 | `runtime/action-policy.ts` | 规则是按工具 ID 定的，不是按"做了什么"定的；容器里的 `shell` 带 `network` 时，能做的事比"在工作区里改代码"多得多 |
| 接管：人在 Bot 的机器上用同一套工具 | `takeoverTool` | 可以直接复用为"终端"视图的后端 |
| 结果不明的调用不自动重发，必须 reconcile | `run-reconcile.ts`、`unknown` 状态 | 外部执行器（Claude Code / Codex）还没有对应的 reconcile |
| 外部 Agent 接口 | `agent-gateway.ts` | 只支持 HTTPS 协议的远端 Agent；本地 CLI 适配器在借鉴计划第 6 项里因"沙箱方案未定"搁置 |
| `website-builder/1` 内置产物 | `contracts.ts` | 产物是一份结构化说明，不是能打开的预览 |

结论：电脑本身大部分已经有了。真正缺的是 **(1) 授权的形状**，**(2) 浏览器和能访问的预览**，**(3) 把现成的编程 Agent 放进这台机器，并且真正受授权约束**。

## 1. 范围授权代替逐个计划审批

### 1.1 授权对象

主人创建一份 **Work Grant**（`work-grant/1`），之后在这份授权内的 Run 不再逐个计划审批：

```ts
{
  grantId, owner, tenantId, botId,
  resources: {
    machine: 'vps-test-1',            // 哪台机器（服务端配置里的名字，不是地址）
    workspace: 'bot.web/site-a',      // 专属工作目录
    egressHosts: ['registry.npmjs.org', 'pypi.org', ...], // 机器能连出去的地址
    previewPorts: [3000, 5173],
    repos?: [...],                    // 第 5 节，连接器阶段才用
  },
  operations: ['read', 'analyze', 'draft', 'edit_workspace', 'run_tests', 'start_preview', 'browse_preview', 'replan', 'delegate:<agentId>'],
  budget: { modelUsd, externalUsd, wallClockMinutes },
  expiresAt,                          // 必填，最长 7 天
  status: 'active' | 'revoked' | 'expired' | 'exhausted',
}
```

- **只能由主人在工作台上创建、延长或撤销**，渠道消息、Bot、外部 Agent 都不能。撤销立即生效：进行中的 Run 在下一次调用前停住，进入 `paused`。
- Run 创建时引用授权并**冻结一份快照**（和现在冻结 `actionPolicy` 一样），带 `grantDigest`。之后改授权不影响已冻结的内容，撤销和过期除外。
- 预算是授权级别的账本：这份授权下所有 Run 共用，接到现有全局预算的同一套预留、结算、`unknown` 标记上。

### 1.2 计划什么时候不用再批

计划（包括重新规划出来的新版本）满足下面全部条件就由授权直接批准，`approval.actor = 'grant:<grantId>'`，事件 `plan.auto_approved` 带 `grantId`：

1. 每个节点要用的工具和 Agent 都落在授权的 `operations` 里；
2. 计划声明的预算不超过授权剩余预算；
3. 授权仍然 `active` 且没过期。

不满足就照旧 `needs_approval`，卡片写清楚超出的是哪一项（"要用 `delegate:codex`，授权里没有"）。**计划版本、hash、每次批准的依据照旧全部保留**，所以回看时能看到"v3 是授权批的，v4 因为要发消息由你批的"。

### 1.3 动作什么时候要问

在 `decideAction` 前加一层授权判断，按**动作的效果**分类，而不是按工具 ID：

| 效果 | 例子 | 授权内 | 授权外 |
|---|---|---|---|
| 只在工作区里 | 读写文件、跑测试、装依赖（走白名单出口）、起预览、用浏览器看自己的预览 | 直接执行 | 问 |
| 对外有影响 | 发消息、发布、推送代码、部署、购买、删除工作区外的东西、改权限或凭证 | **始终问**，授权不能覆盖 | 问 |
| 黑名单 | 主人 `block` 的引用 | 拒绝 | 拒绝 |

关键在于"只在工作区里"必须是**机器层面成立**的，不是工具自己声称的：

- 容器出口走一个只放行 `egressHosts` 的代理；没有代理时网络为 `none`。今天 `shell` 带 `network` 就能 `curl` 任何地址，这一条不改，"工作区内"就不成立。
- 容器里没有任何能对外产生影响的凭证（没有 git 推送凭证、没有 Feishu token、没有云账号）。需要这类动作时，Bot 提出请求，主人批准后由 **AEEIS 用自己的连接器执行**，凭证不进容器。

因此现有的"外部来源 / 读入外部文本后写操作要问"这条规则可以放宽到：**只约束对外有影响的动作**。外部文本（网页、预览里的内容、执行器的输出）能影响的最多是工作区里的文件，而工作区是隔离、可丢弃的。

### 1.4 结果不明先核对再重试

沿用现有原则，扩展到新的执行面：

- 工具调用、执行器会话、浏览器动作都先落 Attempt 再执行；重启后 `started` / `unknown` 不自动重发。
- 工作区内的动作用工作区状态核对（git 状态、进程列表、文件 hash）；核对清楚就继续，否则问人。
- 对外动作（第 5 节以后才有）一律先查对方系统的状态（消息是否已发、分支是否已推），查不清就问人，绝不盲目重发。

### 1.5 和现有三档的关系

`required / auto / yolo` 保留给没有授权的临时 Run。有授权的 Run 不看这三档：授权内自动，授权外问。`yolo` 下"对外动作直接拒绝"的规则不变。

### 1.6 实现（切片 A）

- **授权对象**：`src/work-grant-store.ts`，`work-grant/1`，内存 / File / PostgreSQL 三种存储，同一份契约测试（含并发预留不超总额）。这一版的范围字段是 `tools`、`agents`、`budget { perRun, total }`（tokens 和/或 USD）和有效期（1–168 小时）；`resources`（机器、工作目录、出口、预览端口）随切片 B 加入，`botId` 随多 Bot 阶段加入。状态 `expired` / `exhausted` 由时钟和账本算出，不改记录。
- **接口**：`GET /api/work-grants`、`POST /api/work-grants`、`POST /api/work-grants/:id/revoke`，只对授权的主人可见。工作台「设置 → 授权」创建和撤销；发送框的「权限」菜单里列出有效的授权。
- **Run 引用授权**：请求带 `workGrantId`，不能同时带 `executionReview`。没写工具和代理时用授权里的；模型预算取请求、单 Run 上限、剩余额度三者中最小的，创建时预留，预留按全额计入总额（用不完也不退，下一切片再结算）。Run 冻结一份 `workGrant` 快照（含 digest）；之后只会追加 `revokedAt`。
- **计划**：每个计划版本（含失败后的重新规划）都对照快照判断。冻结的工具和代理都在授权内、授权未撤销未过期时，`approval.actor = grant:<id>`，事件 `plan.auto_approved` 带 `grantId`；否则等待批准，原因写明超出的是哪个工具或代理。授权 Run 的模型预算只来自授权，批准时不能改。主人自己要求修改计划（`revise-plan`）后的新版本仍然等主人批准。
- **动作**：`decideAction` 在黑名单之后加一条：授权有效时，**`containedTools`** 里的工具和授权里的代理直接执行（规则 `grant`），不论 Run 从哪里发起、是否已读入外部文本。`containedTools` 是授权工具与网关 `workspaceContainedTools()` 的交集，由 AEEIS 自己的网关代码给出，不读工具元数据，远程 toolkit 无法声明。现在本地网关给出的是：文件工具（read / write / diff / glob / grep）始终算；`shell` / `python` / `process` 只在容器 `network: none` 时算——容器有网络时它们能连任何地址，所以照旧要问。切片 B 加入 `network: proxied` 后，在该网络下它们（以及 `browser`）也算，见 2.2.1。其他动作走原有规则。
- **撤销与过期**：撤销后，该授权下未结束的 Run 写入 `revokedAt`、事件 `work_grant.revoked`，进行中的暂停；恢复后计划和动作回到普通审批。过期不暂停：之后的计划版本和工作区动作改为询问。

## 2. 一个 Bot，一台测试 VPS

### 2.1 机器

- AEEIS 通过 `docker --context vps-test-1`（SSH）在 VPS 上起容器，复用现有 `DockerSandbox`。不在 VPS 上额外部署 AEEIS 进程。
- **专属工作目录**：每个 Bot 一个持久卷，`grant.resources.workspace` 是卷里的子目录，挂到 `/workspace`。Run 结束不删；Run 之间用 git 提交记录区分。当前的"Run 结束导出快照"保留给产物导出。
- 镜像加上 Chromium + Playwright 和 Node / Python 常用工具链（`aeeis-sandbox:3`）。
- 出口代理放在 VPS 上，按授权的 `egressHosts` 生成规则。

### 2.2 终端、浏览器、截图

- **终端**：先做只读的实时输出——`process logs` 和 `shell` 的输出在工作台上流式显示；人要动手就用现有的接管，走同一套工具和记录。真正的交互式 TTY 放到产品化阶段。
- **浏览器**：新增本地工具 `browser`（容器里的 Playwright）：`open / click / type / screenshot / console / network-errors`。只能访问本机预览端口和 `egressHosts`。截图存为 Run 的 artifact，并作为证据引用。
- **预览可以访问**：VPS 上的反向代理把 `https://<随机名>.preview.<团队域名>` 转到容器的预览端口，链接带一次性令牌，只在团队网络（VPN / Tailscale）内可达，随 Run 或授权到期失效。（待定，见第 7 节。）

### 2.2.1 实现（切片 B 第一部分）

- **测试机**：instabox 的 `agent-browser-lj1m`（Firecracker microVM，Debian 13，4 vCPU / 8 GiB，16 GiB 系统盘 + 20 GiB `/data`，自带 Docker）。SSH 经 instabox 网关，证书约一小时有效，用 `instabox ssh-cert` 刷新。免费套餐空闲 30 分钟或运行 8 小时会暂停，SSH 随之断开。
- **远程执行**：没有用 `docker --context`（本机没有 Docker CLI），改为 `sandbox.ssh: <Host 别名>`，`DockerSandbox` 把每个 `docker` 调用变成 `ssh -o BatchMode=yes <host> -- docker <逐个单引号转义的参数>`。本机 Unix socket 检查只对本地引擎保留。每次调用多一次 SSH 握手，超时统一加 20 秒。
- **出口代理**：`network: proxied`。每个 Run 一张 `--internal` 网络 + 一张出口网络 + 一个代理容器（同一镜像，`proxy.py`，无 capability、只读、`nobody`、128 MiB），代理在内部网络上的别名是 `aeeis-proxy`（容器名超过 DNS 单段 63 字符）。放行规则见 README；Run 释放时代理和两张网络一起删除。这一版的放行列表是部署级的 `sandbox.egressHosts`，不是每份授权一份；授权里的 `resources.egressHosts` 等到同一台机器上跑多份授权时再加。
- **工作区内**：`proxied` 和 `none` 下 `shell` / `python` / `process` / `browser` 都进入 `workspaceContainedTools()`；`bridge` 照旧不算。
- **浏览器**：工具 `browser`，每次调用开一个新页面，可选 click / type / press / wait，返回标题、状态码、可见文字、控制台错误、失败请求和截图（`artifacts/screenshots/`，路径 + SHA-256）。Playwright 默认让回环地址也走代理，已关闭，`127.0.0.1` 的开发服务器直连。
- **镜像**：`aeeis-sandbox:3` = Python 3.12 + Node.js 22 + Playwright 1.49.1 Chromium，2.3 GB。
- **在测试机上验证过**：`example.com` 经代理 403、绕过代理连 DNS 都解析不了；`pypi.org` 200、`pip download`、`npm install` 正常；`169.254.169.254` 403；容器里 `python3 -m http.server 3000`，浏览器打开、点按钮、截图并导出；释放后 VPS 上没有残留容器和网络。
- **还没做（第二部分）**：按授权的持久工作目录（现在仍是每个 Run 一个容器，结束时导出 `artifacts/`）；给团队看的预览链接——instabox 自带"仅持链接可访问"的 HTTPS 端口，可能替代第 7 节第 1 条里的反向代理 + VPN，需要先确认它能转到容器内端口。

### 2.3 在 AEEIS 里看和控制

工作台的 Run 页加一块"电脑"面板：当前步骤、最新截图、终端输出、改动的文件（`git diff`）、产物；按钮：暂停、继续、取消、接管。暂停 / 取消必须停掉容器里的进程和执行器会话，不只是停 AEEIS 的循环。

## 3. 复用现成的编程 Agent

把 Claude Code 或 Codex 当作 AEEIS 外部 Agent 接口下的一种**执行器**（这就是借鉴计划第 6 项，沙箱方案由本文第 1.3、2.1 节确定）：

- **跑在 Run 的容器里**，不在 AEEIS 主机上。命令和参数只由服务端配置决定，提示词作为单个参数传入，不经过 shell。
- **AEEIS 管**：任务说明和上下文包、授权、预算、任务状态、证据、结果审核。执行器只拿到一份任务说明，不拿到授权本身。
- **授权落在执行器真正的工具和凭证上**，不依赖执行器自觉：
  - 能碰到的只有容器：工作区、出口代理、预览端口；
  - 唯一的凭证是一把**短期、只能调模型、有额度上限**的 API key，按会话发放、结束即吊销；
  - 执行器自己的权限配置（Claude Code 的工具允许/拒绝列表、Codex 的 `workspace-write` 沙箱和无人值守审批模式）由授权生成，作为第二层，不作为唯一一层。
- **证据**：执行器的结构化输出流（每一步工具调用、用量）作为回执保存；会话结束时 AEEIS 自己采集 `git diff`、测试输出和截图，不采信执行器的自述。执行器的"已完成"只算 `reported`（与 Debate 设计的权威等级一致），AEEIS 复查后才算数。
- **预算**：按输出流里的用量实时累计，超过授权剩余额度就结束会话；同时有墙钟上限。
- **结果不明**：会话中断时记 `unknown`；重启后看工作区状态和会话日志核对，决定续跑或问人。

## 4. 第一个验收场景：做一个网站

> 用户提需求 → Bot 在 VPS 上写代码 → 起预览 → 用浏览器检查并修复 → 交付能打开的预览、源码和验证结果。授权内的工作全程不需要逐步审批。

具体流程：

1. 主人在工作台创建授权：Bot、`vps-test-1`、工作目录、npm 出口、预览端口、预算、24 小时。
2. 发需求（工作台或群里 @Bot）。计划由授权批准。
3. 执行器在工作区写代码、装依赖、跑测试，`process start` 起开发服务器。
4. Bot 用 `browser` 打开预览，截图，检查控制台错误和需求清单；有问题就交回执行器修，最多 N 轮。
5. **AEEIS 独立审核**：审核者自己打开预览、截图、核对需求清单，不看执行器的结论。
6. 交付：预览链接、源码（工作区 git 仓库的打包和 diff）、验证报告（测试结果、每条需求对应的截图、剩余问题）。

验收标准：从提需求到交付，人只做了"创建授权"和"看结果"两件事；预览链接在团队网络内能打开；审核者的结论有截图证据。

## 5. 连接器按真实任务加

优先 Feishu 和代码仓库，不作为电脑能力的前提。连接器动作就是 1.3 里"对外有影响"的那一类：

- 授权可以显式包含某些对外动作，例如 `repo.push:branch=bot/*`、`feishu.reply:room=<id>`。不在列表里的对外动作照旧问。
- 凭证留在 AEEIS，由 AEEIS 执行，容器里看不到。
- 结果不明时先查对方系统（第 1.4 节）。

## 6. 衡量

每个 Run 记录，按授权和 Bot 汇总，在工作台上看：

| 指标 | 定义 |
|---|---|
| 完成率 | 交付且审核通过的 Run / 启动的 Run |
| 免返工验收率 | 主人第一次看结果就接受的比例 |
| 人工介入次数 | 计划审批 + 动作审批 + 回答提问 + 接管，按类型分开 |
| 耗时 | 从提需求到交付的墙钟时间，以及其中等人的时间 |
| 费用 | 模型 + 执行器 + 外部费用，按授权账本 |

这些都能从现有 Run 事件推出来，不需要新存储；第一步只做一个导出 + 工作台上的一张表。

## 7. 待定

1. **预览怎么对团队开放**：推荐 VPS 上的反向代理 + 团队 VPN，链接带一次性令牌；备选是 AEEIS 自己代理预览（不需要 VPN，但 AEEIS 要转发任意 HTTP）。
2. **先接哪个执行器**：推荐先接 Claude Code（结构化输出流现成，工具允许/拒绝列表粒度细），Codex 第二个，接口相同。
3. **工作目录按 Bot 还是按授权**：推荐按授权（一份授权一个子目录），同一个 Bot 的不同项目互不干扰。

## 8. 落地切片

| 切片 | 内容 | 依赖 | 验证 |
|---|---|---|---|
| **A. 范围授权**（已完成，见 1.6） | `work-grant/1` schema、存储（File + Postgres）、工作台创建/撤销；计划按授权自动批准；`decideAction` 按效果分类；授权账本 | 无，可以马上做 | 单元 + 双存储契约测试：授权内重新规划不再等审批，超范围仍问，撤销后停住 |
| **B. VPS 机器** | `docker --context` 指向 VPS；Bot 持久卷；出口代理；`aeeis-sandbox:3` 加浏览器；`browser` 工具和截图证据；预览反向代理 | VPS 访问 | 在测试 VPS 上起容器、起预览、截图，外部地址连不出去 |
| **C. 电脑面板** | Run 页的截图、终端输出、diff、暂停/取消真正停进程 | B | 浏览器里点一遍 |
| **D. 执行器** | Claude Code 适配器（容器内、短期 key、输出流回执、预算截停、reconcile） | B | 夹具任务：改一个文件、跑测试；断网和超预算各一次 |
| **E. 网站验收** | 第 4 节完整走一遍，记第 6 节指标 | A–D | 真实需求做 3 个，看指标 |

A 和 B 互不依赖，可以同时进行。
