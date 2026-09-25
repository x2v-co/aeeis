# AEEIS 2000 元/年采购单与上机清单

本文是小规模单机部署的采购单。它不执行购买，也不包含任何云厂商凭证；采购完成后，将公网 IP、区域、系统版本和 SSH 登录方式交给部署人员即可开始上机。

## 采购规格

只购买一台亚洲区域 VPS：

- 2 vCPU，4 GiB RAM；
- 60–80 GiB NVMe 或同等稳定 SSD；
- 月流量至少 1 TB，IPv4 1 个；
- Ubuntu 24.04 LTS 或 Debian 12；
- 支持磁盘快照、重装、反向 DNS 和控制台救援；
- 支持按月或可退款的短周期付款，先不要购买多年套餐；
- 年度机器预算 1,200–1,600 元，至少保留 300 元应急余额。

优先级顺序是：稳定磁盘 I/O、可恢复性、网络质量、IPv4、价格。不要为 GPU、突发 CPU、独立数据库或 Kubernetes 付费；模型调用走外部 API。

## 购买前向供应商确认

下单前确认以下问题，并把答案保存到采购记录：

1. 数据中心所在国家/地区和跨境出网限制；
2. 是否允许运行 Docker、Temporal 和 PostgreSQL；
3. 快照是否包含数据盘，快照保留多久，恢复是否需要停机；
4. 机器故障、磁盘损坏、IP 被封时的 SLA 和处理渠道；
5. 是否能导出镜像或把磁盘迁移到其他实例；
6. 出网流量、IPv4、快照和磁盘扩容是否另收费；
7. 账单是否支持月付、自动续费关闭和发票/收据留存。

## 采购后立即做的事

1. 创建非 root 管理用户，导入 SSH 公钥，禁用密码 SSH 和 root SSH。
2. 开启自动安全更新；防火墙只开放 22（限制到管理 IP）、80 和 443。
3. 设置主机名、时区、NTP、磁盘告警和资源告警；确认剩余磁盘至少 50 GiB。
4. 安装 Docker Engine、Compose plugin、`pg_dump`/`pg_restore` 客户端和 Caddy。
5. 将 AEEIS 镜像、配置模板和部署脚本放在独立目录；生产 `.env`、数据库密码、模型 key、Worker token 权限设为 `600`。
6. 保留现有 Nginx 继续提供公网静态页；API、Worker、Temporal gRPC、PostgreSQL 只监听 Docker 私网或 Tailscale/回环地址，公网不暴露 AEEIS API。没有 Prometheus 时停用 Node Exporter；如果保留，9100 只允许 Tailscale 或本机访问。
7. 创建外部备份位置。最省成本的方式是每日把加密 PostgreSQL dump 拉回已有个人电脑或另一台已有设备；不能只存 VPS 本地。

## 上机验收顺序

按以下顺序执行，每一步失败就停止，不要继续开放公网流量：

1. `docker compose config` 检查配置渲染结果，确认没有 Fixture URL、默认密码或 demo mode。
2. 启动 PostgreSQL 和 Temporal，创建 AEEIS 数据库、Temporal 数据库、namespace、task queue。
3. 启动 API，检查 `/health`、`/readyz` 和 `/api/status`；生产模式必须显示真实模型和 Temporal dispatcher。
4. 启动 Worker，检查 `/readyz` 的 `workerState=RUNNING`，并核对 task queue、namespace、Build ID。
5. 启动 Caddy，检查 HTTPS、Host allowlist、安装级 token/OIDC 和 SSE 长连接。
6. 执行一个最小 synthetic Run：Goal → Plan → DAG Task → Temporal Activity → Receipt/Evidence → Review。
7. 重启 API 和 Worker，确认 Run 继续推进；对故意制造的超时只执行原始幂等键 reconcile。
8. 执行 `npm run backup:postgres`、`npm run backup:verify`，把 dump 和 manifest 复制到异地位置。

## 采购决策记录

| 项目 | 选定值 |
| --- | --- |
| 供应商 | 待选择 |
| 区域 | 待选择 |
| 实例规格 | 2 vCPU / 4 GiB / 60–80 GiB NVMe |
| 年度价格 | 待报价，目标 1,200–1,600 元 |
| 公网 IPv4 | 待确认 |
| 快照/恢复 | 待确认 |
| 异地备份位置 | 个人电脑或已有对象存储 |
| AEEIS 域名 | 待配置 |
| 预计采购日期 | 待定 |
