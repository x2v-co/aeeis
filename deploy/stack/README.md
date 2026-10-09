# AEEIS 单机全栈部署（deploy/stack）

ADR-0001 规定 AEEIS 分两套**完全独立**的栈：海外 `aeeis-sg` 为主，国内在 kk-cn 上跑 `aeeis-cn`。两套用的是同一份 compose，区别只在 `stack.env`。

```text
宿主机 (tailnet only)
└─ compose project = $AEEIS_STACK
   ├─ netns              alpine:3.20 sleep，只持有网络命名空间和对外端口（K8s pod 模式）
   │   ├─ api            Fastify API，监听 :4323，AEEIS_ENV=production，Temporal runner
   │   └─ worker         Temporal Worker，/readyz 在 :4324
   ├─ temporal           temporalio/auto-setup:1.29.7（PG 存储，ns=aeeis，Worker Deployment versioning）
   ├─ temporal-postgres  Temporal 的持久化库和可见性库
   ├─ postgres           AEEIS 事实源（启动时自动建表、升级 schema）
   └─ backup (profile ops)  一次性 pg_dump 任务
```

## 关键设计

- **Worker→API 不需要 TLS。** api 和 worker 都通过 `network_mode: service:netns` 共享同一个网络命名空间，所以 Worker 访问 API 用 `http://127.0.0.1:4323`，API 探测 Worker 用 `http://127.0.0.1:4324/readyz`。两者都是 loopback，生产校验（`src/temporal/config.ts`、`src/config-validation.ts`）原样放行，不用开任何 insecure 开关。网络命名空间由 `netns` 容器持有，它的镜像（`AEEIS_NETNS_IMAGE`）和 AEEIS 镜像分开固定，所以普通发版不会重建它；api 或 worker 重启也不会把它带断。（只有 netns 自身被重建时，api/worker 会被 compose 一起重建。）这样也就不需要内部 Caddy TLS。
- **只暴露在 tailnet 上。**
  - API 绑 `AEEIS_BIND_IP`（宿主机的 tailnet IP），另外发布到 `127.0.0.1:${AEEIS_LOOPBACK_API_PORT:-4323}`，给同机的 Toolkit CN staging 用。
  - Worker health 只在网络命名空间内部监听，不对外发布，由 `bin/health.sh` 在命名空间内探测。
  - Temporal gRPC **不发布**到宿主机（CLI 用 `docker compose exec temporal temporal ...`）。确有远端客户端需要时，另写一个 `compose.override.yml` 只把 7233 发布到 tailnet IP，并评估 Temporal 无认证的风险。
  - 注意：Docker < 28 时，发布到 127.0.0.1 的端口可被同一 L2 网段的主机通过路由访问到（Docker 已知问题）；API 本身强制 bearer token，tailnet 主机上风险可接受，升级到 Docker 28+ 可消除。
  - 宿主机防火墙（ufw）仍只对 `tailscale0` 放行。
- **版本管理用 Temporal Worker Deployment。**
  - deployment 名等于 `AEEIS_TASK_QUEUE`，Build ID 是 `$AEEIS_STACK-<git sha>`。
  - 默认行为是 `AUTO_UPGRADE`：单机上只有一个 worker build，`PINNED` 的 workflow 在换版后再也不会被 poll，会永久挂起。
  - 每次发版由 `bin/deploy.sh` 调 `bin/promote.sh` 设置 Current Version。不做这一步，新版 worker 收不到任务。
  - replay 门禁内置在 `bin/deploy.sh`：取最近 `AEEIS_REPLAY_SAMPLE`（默认 20）条 agentRunWorkflow/reminderWorkflow history，用候选镜像在 `--network none` 容器里回放，失败或无法列出 workflow 都拒绝发版。首次部署无 history 时自动跳过；`AEEIS_SKIP_REPLAY=1` 只用于紧急情况。
- **密钥。** 四个随机密钥放 `stack.env`（0600）。模型 key 推荐用文件：`secrets/model-key`（owner 1000:1000，0400），以 `AEEIS_MODEL_API_KEY_FILE=/run/aeeis-secrets/model-key` 引用；同一密钥的直接值和 `_FILE` 不能同时设置（即使为空）。
- **Projection 投递（重要限制）。** Reminder 触发后只写 projection outbox，目前**没有自动投递 pump**：要调用 `POST /api/collaborations/projections/deliver-pending`（smoke 脚本就是这么做的）。自动投递和 Telegram sink 是后续 PR（计划 C3）。
- **数据分区。** CN 的备份只能留在 CN 境内（本机加 CN 对象存储或第二块盘）；SG 的备份上传 R2。

## 文件

| 文件 | 作用 |
|---|---|
| `compose.yml` | 正式栈 |
| `compose.smoke.yml` | 冒烟用 overlay：在同一网络命名空间里加 Fixture Model 和 Fixture Projection Sink（走 loopback，仍是 production 校验） |
| `stack.env.example` | 配置模板，复制成 `stack.env` 后 `chmod 600` |
| `bin/deploy.sh` | 构建镜像 `aeeis:<sha>`（或 `AEEIS_DEPLOY_IMAGE=... --no-build`）→ replay 门禁 → 写 `.candidate.env` → `up -d` → 等新 build 的 worker ready → promote → 等 API ready → 旧的存为 `.previous.env`，候选转正为 `.current.env` |
| `bin/promote.sh` | `temporal worker deployment set-current-version`，带重试（`AEEIS_PROMOTE_TIMEOUT_S`，默认 180s），并回读确认 Current Version |
| `bin/smoke.sh` | 跑一个 Run 和一个 Reminder，再对两条 workflow history 做 replay |
| `bin/replay.sh <wfId>...` | 导出 history，用 `AEEIS_REPLAY_IMAGE`（默认当前镜像）回放 |
| `bin/backup.sh` | 默认先停 worker/api/temporal（`AEEIS_BACKUP_QUIESCE=full`，约 30s–2 分钟停机），pg_dump aeeis、temporal、temporal_visibility 三个库（缺一即失败），校验 sha256，恢复服务并等 ready，按保留天数清理，可选执行上传命令。三份 dump 必须**一起**恢复 |
| `bin/health.sh` | 在命名空间内探测 API `/readyz`（带 token）和 Worker `/readyz`，再从宿主机打 `http://$AEEIS_BIND_IP:端口/health`；输出一行 JSON，失败时退出码非 0 |
| `secrets/` | 只读挂进 api/worker 的 `/run/aeeis-secrets`，放 `_FILE` 引用的密钥文件（已 gitignore） |
| `temporal/dynamicconfig.yaml` | 打开 Worker Deployment versioning API |
| `systemd/*` | `aeeis-stack@`（启动前最多等 5 分钟直到 `AEEIS_BIND_IP` 出现在网卡上）、`aeeis-backup@`（.timer，每天 03:30）、`aeeis-health@`（.timer，每 5 分钟）；实例名用 `aeeis-cn` 或 `aeeis-sg` |

## 资源

单机全栈（空闲时）大约占 1.2–1.8 GB 内存：Temporal 约 300–500 MB，两个 PG 各 100–200 MB，API 和 Worker 各约 150–300 MB。磁盘 ≥20 GB 起步，Temporal history 按 retention 30 天计算。kk-cn（8C/8G）和 `aeeis-sg`（4C/8G）都够用。

---

## P2a：AEEIS-CN 部署到 kk-cn

前提：kk-cn 已装 Docker Engine 和 compose plugin，并配置国内镜像加速；ufw 已对 `tailscale0` 放行 4323（9月30日已经放行）。

```bash
# 0. 旧 worker 已在 10-09 disable，不要再 enable
systemctl is-enabled aeeis-cn-worker   # 应为 disabled

# 1. 代码
sudo mkdir -p /opt/aeeis-cn && cd /opt/aeeis-cn
sudo git clone https://github.com/x2v-co/aeeis.git aeeis   # CN 拉 GitHub 可能要走代理或镜像
cd aeeis && sudo git checkout <要部署的 commit>
cd deploy/stack

# 2. 配置（只在本机生成，不要出现在聊天或日志里）
sudo cp stack.env.example stack.env && sudo chmod 600 stack.env
#   AEEIS_STACK=aeeis-cn  AEEIS_TASK_QUEUE=aeeis-cn
#   AEEIS_BIND_IP=100.110.2.20
#   AEEIS_PUBLIC_HOSTS=100.110.2.20,kk-cn,<MagicDNS FQDN>
#   四个密钥分别用 openssl rand -hex 32 生成
#   模型选 CN 的 provider（等用户定），key 写入 secrets/model-key：
#     sudo install -o 1000 -g 1000 -m 400 /dev/stdin secrets/model-key   # 从剪贴板粘贴后 Ctrl-D
#   AEEIS_BACKUP_DIR=/var/backups/aeeis
#   AEEIS_DOCKER_BUILD_ARGS 按需加 npm 镜像；node/postgres/temporal/alpine 镜像要能经加速器拉到

# 3. 冒烟：空库加 fixture，验证 Run、Reminder、replay
sudo AEEIS_STACK_SMOKE=1 ./bin/deploy.sh
sudo ./bin/smoke.sh
# 4. 切到真实配置（去掉 smoke overlay；fixture 容器由 --remove-orphans 清掉）
#    API readyz 会检查真实模型；模型 key 没配好这一步会失败（.current.env 不会被改）
sudo ./bin/deploy.sh --no-build

# 5. systemd：开机拉起、备份、健康探测
sudo cp systemd/aeeis-*@.service systemd/aeeis-*@.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable aeeis-stack@aeeis-cn
sudo systemctl enable --now aeeis-backup@aeeis-cn.timer aeeis-health@aeeis-cn.timer
# 6. 告警：给三个 unit 挂上 /etc/systemd/system/<unit>.d/10-notify.conf（和其他机器同一份）
#    unit 名以 aeeis- 开头，自动按路由 aeeis-* 发到 x2v_alerts [aeeis]
# 7. 恢复演练
sudo ./bin/backup.sh && ls -l /var/backups/aeeis/
#    把最新目录的三个 dump 恢复到一个临时 postgres 容器（createdb + pg_restore --no-owner），检查表数
```

### 数据迁移（可选，盘点后决定）

aeeis-server 上的 `aeeis-postgres` 如果有需要保留的 CN 数据：

1. 在 aeeis-server 上执行 `pg_dump -Fc`，经 tailnet 拷到 kk-cn（不出境）。
2. 先恢复到一个**临时库**，用新镜像连上它启动一次 API（启动时会自动升级 schema），检查表和行数。
3. 停掉 api 和 worker，`pg_restore --clean` 到正式库，再执行 `bin/deploy.sh --no-build`。

### 从备份恢复整栈

`dc stop worker api temporal` → 三个库分别 `pg_restore --clean --if-exists`（aeeis 进 `postgres`，temporal 和 temporal_visibility 进 `temporal-postgres`）→ `dc up -d`。不要只恢复其中一个库。

Temporal history 不迁移：旧栈上运行中的 workflow 先在旧栈收尾或终止。devbox 那份 09-24 dump（33 个测试 run）不导入。

### 切流和验收

- Toolkit CN staging 也在 kk-cn 上，`AEEIS_BASE_URL` 直接用 `http://127.0.0.1:4323`（compose 已发布 loopback 端口），Toolkit 接受 loopback HTTP。
- toolkit_cn 生产在 toolkit 主机上，需要 HTTPS：在 kk-cn 上执行 `tailscale serve --bg --https=443 http://100.110.2.20:4323`，然后把对应 FQDN 加进 `AEEIS_PUBLIC_HOSTS`。
- 验收条件：
  - `bin/health.sh` 连续 7 天为绿。
  - 至少完成一次真实 Run 和一个日历 Reminder。
  - replay 通过。
  - 备份每天都生成，恢复演练通过。
- 验收后：aeeis-server 上的 AEEIS 执行面先冷备 `aeeis-postgres`，再停 temporal、worker、fixture，只保留 nginx 静态壳。

---

## P2b：AEEIS-SG 部署到 aeeis-sg（等机器）

步骤和 P2a 相同，差别如下：

- `AEEIS_STACK=aeeis-sg`，`AEEIS_TASK_QUEUE=aeeis-sg`，`AEEIS_BIND_IP=<aeeis-sg tailnet IP>`。
- 模型用海外 provider。`AEEIS_MODEL_PRIVATE_DATA_ALLOWED` 只对自有 key 放开 private 数据。
- 备份：`AEEIS_BACKUP_UPLOAD_CMD='rclone copy "$1" r2-aeeis:aeeis-backups/aeeis-sg/$(basename "$1")'`。R2 token 只给这个 bucket 的读写权限。
- 镜像拉取不用国内加速，构建也不需要 npm 镜像。
- 切流：toolkit_global 的 `AEEIS_BASE_URL` 改指 aeeis-sg（`tailscale serve` HTTPS）；本机开发改连这里的 staging namespace（需要另建 ns 和 queue）。
- 之后进入 ADR P7：brain-hub 的 schedule 迁成 AEEIS Reminder/Run，需要先补 Telegram projection sink。

---

## 日常运维

```bash
cd /opt/<stack>/aeeis/deploy/stack
./bin/health.sh                               # 一行 JSON
. bin/_lib.sh && dc ps                        # 也可以 dc logs -f api worker
# 升级（replay 门禁自动执行）
git fetch && git checkout <sha> && ./bin/deploy.sh
# 手动回放某几条：AEEIS_REPLAY_IMAGE=aeeis:<sha> ./bin/replay.sh <run id> aeeis-reminder-<id>
# 回滚：.previous.env 记着上一个镜像；checkout 那个 sha 后 ./bin/deploy.sh --no-build
#   新版本产生的 history 不一定能在旧代码上回放；紧急回滚才用 AEEIS_SKIP_REPLAY=1
```

已知限制：

- `temporalio/auto-setup` 是官方的便捷镜像，每次启动都会做 schema 检查和升级，适合单机。规模变大后改成 `temporalio/server` 加 admin-tools 跑 schema job。
- Temporal 只有单节点，没有 HA。恢复靠 pg_dump：quiesce 后三个库在同一时刻导出，恢复后运行中的 workflow 会回到导出时的状态。
- 没有自动 projection 投递 pump，也没有 Telegram sink（见上）。
- `bin/*.sh` 和 systemd 会用 bash `source` 读取 `stack.env`，值要兼容 shell（JSON 或带空格的值用单引号）。
