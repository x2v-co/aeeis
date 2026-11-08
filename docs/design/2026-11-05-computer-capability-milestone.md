---
title: 下一个里程碑：先让 Bot 用上电脑，审批改为范围授权
date: 2026-11-05
status: 设计；切片 A–E 已实现，三个验收任务在测试机上通过
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
- **远程执行**：没有用 `docker --context`（本机没有 Docker CLI），改为 `sandbox.ssh: <Host 别名>`，`DockerSandbox` 把每个 `docker` 调用变成 `ssh -o BatchMode=yes <host> -- docker <逐个单引号转义的参数>`。本机 Unix socket 检查只对本地引擎保留。同一主机的 docker 调用复用一条 SSH 连接（`ControlMaster`），超时统一加 20 秒。热路径只有两次 docker 调用（检查容器、执行工具）；容器停过才重新启动代理、容器并探测工具服务。instabox 上实测：热调用从约 15 秒降到 1.4 秒，Run 首次调用从约 80 秒降到 14 秒（剩下的主要是到 instabox 网关的往返，单条命令约 0.6 秒）。
- **出口代理**：`network: proxied`。每个 Run 一张 `--internal` 网络 + 一张出口网络 + 一个代理容器（同一镜像，`proxy.py`，无 capability、只读、`nobody`、128 MiB），代理在内部网络上的别名是 `aeeis-proxy`（容器名超过 DNS 单段 63 字符）。放行规则见 README；Run 释放时代理和两张网络一起删除。这一版的放行列表是部署级的 `sandbox.egressHosts`，不是每份授权一份；授权里的 `resources.egressHosts` 等到同一台机器上跑多份授权时再加。
- **工作区内**：`proxied` 和 `none` 下 `shell` / `python` / `process` / `browser` 都进入 `workspaceContainedTools()`；`bridge` 照旧不算。
- **浏览器**：工具 `browser`，每次调用开一个新页面，可选 click / type / press / wait，返回标题、状态码、可见文字、控制台错误、失败请求和截图（`artifacts/screenshots/`，路径 + SHA-256）。Playwright 默认让回环地址也走代理，已关闭，`127.0.0.1` 的开发服务器直连。
- **镜像**：`aeeis-sandbox:3` = Python 3.12 + Node.js 22 + Playwright 1.49.1 Chromium，2.3 GB。
- **在测试机上验证过**：`example.com` 经代理 403、绕过代理连 DNS 都解析不了；`pypi.org` 200、`pip download`、`npm install` 正常；`169.254.169.254` 403；容器里 `python3 -m http.server 3000`，浏览器打开、点按钮、截图并导出；释放后 VPS 上没有残留容器和网络。
- **机器暂停 / 证书过期**：两者都让 `ssh` 以 255 退出。准备容器阶段（含新 Run 第一次调用前先探测主机）连不上 → 记为失败、没有执行；工具执行中断开 → 结果未知，只把这个 Run 挂起，下次调用先补做 `docker kill`，不再像本地引擎那样封锁整个网关。测试机上验证过：`instabox suspend` 期间调用失败且命令确实没跑，`resume` 后同一个 Run 继续、开发服务器仍在；过期证书报"拒绝登录"，`instabox ssh-cert` 后恢复。免费套餐运行 8 小时后会强制暂停并进入冷却期，期间无法唤醒，这一点代码绕不过去；证书续期用 `sandbox.sshLoginCommand`（如 `instabox ssh-cert`）：只在 ssh 报 `Permission denied (…)` 时运行并重试一次，测试机上删掉证书后 Run 照常继续。
- **等主机回来**：主机连不上时，工具运行前的准备（补做停止、检查/启动容器）按 2、4、8、16、30 秒退避重试，最多 `sshWaitSeconds`（默认 12 分钟，覆盖 devbox 上 instabox 保活的一轮）。工具本身从不重放。已知限制：本地网关串行执行工具调用，等待期间其他调用（含 `web-fetch`）排队；Run 页面不显示"在等主机"，只是这次工具调用耗时更长。
- **测试机选择**：比较过 instabox、腾讯云北京（经 Tailscale 德国中继，单次登录 8–10 秒；GitHub、Docker Hub 不通）和新加坡（直连 80 ms，但那台是 AEEIS 生产机，不放 Bot）。先用 instabox；之后换一台独立的新加坡 VPS 只需改 `sandbox.ssh`。
- **instabox 冷却期**：免费套餐连续撞 8 小时上限时冷却递增（5–20 分钟、60–75 分钟、120–135 分钟），付费套餐固定第一档。空闲暂停不欠冷却并重置计数，而保活每 10 分钟跑一次命令，机器永远不空闲，反而一直撞上限。所以 Bot 用的机器不放进保活，让它空闲暂停，AEEIS 的下一次调用会唤醒它。ssh 报 `cooling down until <时间>` 且晚于等待上限时立即失败并给出时间。

### 2.2.2 实现（切片 B 第二部分）

- **授权工作目录**：`sandbox.workspaceVolumes: true` 时每份授权一个持久 Docker 卷，挂到 `/workspace`，这里用的是卷而不是 Bot 卷的子目录（第 7 节第 3 条按授权）。工作目录标识通过 `invoke` 的第二个参数传递，不进入 `ToolInvocation`，远程 toolkit 看不到。同一时间只给一个 Run 用：上一个 Run 最多等 60 秒释放（等待在网关队列之外，因为释放本身要走队列），超时后本次调用失败并指出占用的 Run。新 Run 开始时把上一个 Run 已导出的 `artifacts/` 移到 `.previous-artifacts/`，否则每次导出都会带上旧产物，迟早超过快照上限。卷不随 Run 或授权删除。
- **预览链接**：`sandbox.previewPorts` + `sandbox.previewCommand`（这里回答第 7 节第 1 条：先用平台自带的私有端口，不自建反向代理和 VPN）。`proxied` 网络不能发布端口，所以由 Run 的代理容器监听这些端口、转给内部网络上的 `aeeis-run`，只发布到机器的 `127.0.0.1`；`process` 的 `preview` 动作运行 `publish`，返回链接，Run 释放时运行 `unpublish`。预览失败是工具结果，不会停容器。链接带令牌，出现在工具结果里，Bot 和能看 Run 的人都能看到。
- **测试机**：Docker 把镜像放在 containerd 里，`/var/lib/docker` 和 `/var/lib/containerd` 都通过 fstab 绑定挂载到 `/data/storage`，路径不变。
- **在测试机上验证过**：两个 Run 共用授权工作目录（文件保留，产物归档，占用时拒绝，别的授权看不到）；开发服务器经代理和 instabox 私有链接访问：无令牌 401、带令牌 200、重复调用同一链接、释放后 404；释放后无残留，卷保留。
- **还没做**：卷的配额和清理界面；代理容器重启后发布端口可能变化，链接需要新 Run；Run 页面展示链接属于切片 C。

### 2.3 在 AEEIS 里看和控制

工作台的 Run 页加一块"电脑"面板：当前步骤、最新截图、终端输出、改动的文件（`git diff`）、产物；按钮：暂停、继续、取消、接管。暂停 / 取消必须停掉容器里的进程和执行器会话，不只是停 AEEIS 的循环。

实现（切片 C）：

- **停下工作**：`ToolGateway.interruptRun(runId, freeze | thaw | halt)`，绕过网关队列（队列可能正被要停的那次调用占着）。暂停用 `docker pause`，进程和内存都留着；取消用 `docker kill`；撤销授权也冻结；接管和交回会解冻。结果写进 Run：`machine.interrupted`，或连不上主机时 `machine.interrupt_unconfirmed`，不把没确认的停止说成已停止。容器还没建好就被暂停时，下一次工具调用不会开始，返回失败且什么都没执行。
- **看**：`sandbox/observe.py` 独立于工具服务（后者一次只处理一个请求，长命令期间排不上），通过 `docker exec` 读最新前台命令、后台进程、`git status` / `git diff` 或最近改动的文件，有大小上限。看不会启动或解冻任何东西。截图读 AEEIS 这边已导出的文件，不碰远程主机。
- **API**：`GET /api/runs/:id/computer` 和 `/computer/screenshots/:name`，只给 Run 的所有者：终端输出可能有密钥，预览链接带令牌，所以分享链接的读者看不到。结束的 Run 不连主机。
- **在等主机**：等待写到状态目录的文件里，所有 AEEIS 进程都能显示；进程中途死掉留下的旧记录会被忽略。
- **页面**：Run 页控制按钮下面的"电脑"折叠块，5 秒看一次，只在 Run 进行中、折叠块打开、页面可见时才看，因为每次都走 SSH，在 instabox 上算活动，一直开着机器就不会空闲暂停。
- **在测试机上验证过**：一条每秒打时间戳的命令被冻结 6.8 秒，时间戳里正好有 7 秒的空洞，之后接着跑完；页面按钮暂停 / 继续 / 取消都生效；取消后 1 秒内 Run 变成已取消，5 分钟的命令立即结束，容器 `Exited (137)`。
- **还没做**：冻结期间超过工具超时的调用会变成结果未知；执行器会话的停止放到切片 D；取消后代理容器留到 Run 释放；手机窄屏只做了基本适配，没有逐项检查。

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

实现（切片 D，Claude Code）：

- **凭证**：普通 API key 做不到"按会话、有额度、结束即吊销"，所以容器里根本不放真 key。每个 Run 的代理容器里有一个模型中继：执行器拿到的是只在本次会话有效的令牌，`ANTHROPIC_BASE_URL` 指向 `http://aeeis-proxy:3129`；中继只放行 `/v1/messages` 和 `count_tokens`，换上真 key 转发给配置的上游，并从响应里累计用量。真 key 经 `docker exec` 的 stdin 送进代理进程的内存，不进命令行、环境变量或 Docker 记录。**它仍然在 VPS 的内存里**，VPS 的 root 能拿到，所以这里用一把专用、在控制台设了消费上限的 key。
- **预算**：用量按 `输入 + 输出 + 写缓存 + 读缓存 / 10` 累计（代理循环每轮都重读上下文，读缓存价格约十分之一）。上限取授权预算的 90%，留给停下时还在进行的那次调用。到上限后中继返回 403（不用 429，客户端会重试 429），AEEIS 结束会话。
- **运行**：`--tools` / `--allowedTools` 来自配置，`--setting-sources user` 忽略项目里的设置，不用 `--dangerously-skip-permissions`。提示词走 stdin，argv 不经 shell。容器和出口代理才是边界，工具列表是第二层。
- **接入**：`ClaudeCodeTransport` 实现 `AgentTransport`，卡片 endpoint 是 `aeeis-executor://claude-code`，`RoutedAgentTransport` 分流，所以授权、预算账本、审批都走现有路径。Run 的身份用 `DelegationContext` 单独传，不放进 `DelegationRequest`，因为 HTTP 传输会把请求整个发出去。
- **证据**：输出流逐段保存到 AEEIS 这边，会话结束时 AEEIS 自己取 `git status` / `git diff`。结果的 `claims` 是空的，`unresolved` 里写明"执行器自述，AEEIS 未验证"，费用的 tokens 用中继的数，不用执行器自报。
- **停止**：暂停冻结容器，执行器一起冻结，且不占墙钟上限；取消杀掉容器，会话记 `unknown`；连不上主机超过 15 分钟记 `unknown`。`reconcile` 只读会话结果，绝不重新启动。
- **预算来源**：引擎发出的委派只有 `calls: 1`，没有 token 预算，所以执行器的预算取 Run 还剩多少：`externalBudget` 余额和 `modelBudget - 模型已用 - 外部已用` 中较小的，再和委派自带的上限取最小。同一份授权额度不能既给规划用又给执行器用一遍。
- **在测试机上验证过（真实 key，Haiku）**：修 bug 任务通过，AEEIS 自己跑测试 `pass 1 fail 0`，改动只有一行；2 万 token 预算的超大任务在 18016 token 停下，中继拒绝 1 次，进程退出，结果 `partial`；会话中暂停机器再恢复，会话继续，流里只有 1 次启动；会话中断开机器的外网 30 秒再恢复，同样只启动 1 次并完成。完整路径：真实 engine、Work Grant、Agent 网关和真实 Claude Code，授权批准计划，`agent.completed`，用量记入外部花费。输出流里没有 key。
- **还没做**：Codex；模型价格没有进中继，money 预算只看执行器自报的 `total_cost_usd`；AEEIS 的结果审核还没有接到执行器的结果上（切片 E）；一次调用超过 10% 余量时结果会被网关拒绝，转为人工核查。

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

实现（切片 E）：

- **已有的**：`website-builder/1` 产物合同和审核的修订循环（最多两次）。缺的是审核者真的去看：原来的审核是模型读产物文字，Bot 写"预览已就绪"它无从核对。
- **验收需求**：Run 带 `acceptance`（1–30 条能看得出对错的需求），同时作为资料交给规划和执行。
- **独立检查**：进入审核前，`ClaudeCodeTransport.verify` 在同一容器里开一个全新的会话，只有 `Bash / Read / Glob / Grep`，只看到请求和需求，看不到执行者的报告。它用 `/opt/aeeis/browse.py` 亲自打开页面，每条需求给出结论。预算是 Run 剩余额度的 30%，花费计入 Run。
- **不轻信检查者**：通过要有说明；声称的截图必须真实存在；没给结论或读不出结果都算没确认；检查前后项目的 git 状态变了则结论作废。
- **修订循环**：检查没过时用同一个 `settleReview`，和审核共用修订次数，没通过的需求作为问题交回；用完次数后 Run 失败，模型审核者不能推翻。检查本身跑不起来时不消耗修订，直接失败。检查通过后模型审核者仍会看，并拿到检查结果。
- **交付**：检查通过后打包 `source.tar.gz`（排除 `node_modules`、`.git`），发布预览，并让机器再保留 `keepHours`，否则 Run 结束 15 秒内释放，链接随之失效。结果在 Run 页的"电脑"折叠块里，源码经 `/api/runs/:id/computer/source` 下载。
- **指标**：`run-metrics.ts` 从 Run 的持久记录算完成、无返工通过、修订次数、人工介入、耗时和费用；`GET /api/runs/:id/metrics`。授权批准不算人工介入。
- **检查通过后**：模型审核者的意见记为 `review.advisory`，不能再把工作退回。它读的是文字，检查者开过真实页面。

验收结果（2026-11-06，instabox `agent-browser-lj1m`，每项 50 万 token 的授权，Bot 用 Haiku，Claude Code 用 Sonnet）：

| 任务 | 结果 | 修订 | 人工介入 | 耗时 | Bot 模型 tokens（入 / 出） | Claude Code 费用 |
|---|---|---|---|---|---|---|
| 1. AEEIS 介绍页 | 通过（4/4 条需求） | 0 | 0 | 4.5 分钟 | 111,029 / 16,385 | $0.09 |
| 2. 指标报告页 | 通过（3/3） | 0 | 0 | 3.9 分钟 | 86,951 / 9,713 | $0.15 |
| 3. 反馈看板（含服务端和测试） | 通过（5/5） | 1 | 0 | 5.9 分钟 | 70,282 / 10,631 | $0.18 |

每项都交付了能打开的私有链接（无令牌 401、带令牌 200）和含真实文件的源码包。

读这张表时要知道：

- **这是修完问题后的一轮，不是第一次就成功。** 真实运行之前发现并修复了：读取输出流遇到超长行（截图 base64）时空转 20 分钟；委派的 goal 超过 2000 / 4000 字符时整个 Run 失败；启动会话的回复带着 1 MB 快照，在慢链路上超时；源码包把 `artifacts/` 下的项目排除成空包；模型调用形状混乱或版本写错时 Run 直接失败；Bot 重复做检查者的工作，一个简单页面花掉 32 万 token。
- **任务 2 第一轮没过是验收需求写错了。** 平均时长应是 13 分 20 秒，需求写成 12 分 20 秒。检查者连续三轮不放行，Bot 也指出了矛盾；改正需求后一次通过。
- **任务 3 的 1 次修订发生在 `review.advisory` 之前**：检查已全部通过，模型审核者仍把工作退回。这一项没有在修复后重跑。
- **规划模型走的是测试脚本里的直连适配器**，不是生产的 `HttpModelAdapter`：后者固定用 `json_object`，Anthropic 的兼容接口不接受。
- **Run 记录是内存仓库**，不是生产部署；运行时这台 Mac 到 instabox 的链路很慢（SSH 登录 8–25 秒）。
- **交付报告里的 `limitations` 仍可能写着"未验证"**：它来自 Bot 在检查之前的文字，和检查结果矛盾，需要在页面上以检查结果为准。
- **费用不完整**：`costUsd` 为空，因为测试脚本的规划模型没有价格；总额看 Anthropic 控制台。

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
