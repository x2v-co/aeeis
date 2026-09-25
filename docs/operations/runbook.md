# AEEIS 运维手册（开发版）

这份手册描述 AEEIS Runtime、Temporal Worker、调度器、投影和 RSI 控制面的基本处置路径。生产环境还需要把具体的部署、密钥、告警和供应商联系人补入组织内部值班手册。

## 1. 先判断服务状态

- `/health` 只表示 HTTP 进程存活。
- `/readyz` 表示必需依赖是否可用，包括领域仓库、模型和 dispatcher；返回 `503` 时不要把流量切入该实例。
- `/api/status` 用于查看模型路由、Temporal、DAG scheduler、Brain、Knowledge、Project Source、Tool Gateway、Agent Registry、RSI evaluator、External Agent、RSI、Projection 和运行模式；若已配置 Knowledge、Project Source、Tool Gateway、Agent Registry、RSI evaluator 或 Projection Sink，`knowledgeProviderHealth` / `projectSourcesHealth` / `toolsHealth` / `agentRegistryHealth` / `rsiEvaluatorHealth` / `projectionSinkHealth` 会显示其轻量探针结果。资料源、工具网关、Agent Registry、RSI evaluator 和 Projection Sink 健康检查是 optional，不会把核心 Agent readiness 伪装成失败或成功。
- `/metrics` 用于确认 HTTP 请求、运行、调度、投影和未知结果是否持续增长。HTTP 指标按方法、固定路由模板和状态码统计，并提供延迟直方图与当前并发数；不会把 Run ID、租户 ID 或原始 URL 放入标签。

Knowledge 和 HTTP Project Source 可通过 `AEEIS_KNOWLEDGE_HEALTH_URL` / `AEEIS_PROJECT_SOURCES_HEALTH_URL` 配置只读 GET 健康端点。地址必须与业务端点同源、使用 HTTPS（loopback 开发例外）、不含凭证/query/fragment；探针复用对应 Bearer token、禁止重定向，3 秒超时。未配置独立探针会明确显示 unavailable；该检查不搜索资料、不推进游标、不验证业务返回内容。File 探针确认普通文件可打开读取，内容格式仍在使用时验证。

配置 toolkit_new Registry 或旧版 HTTP Tool Gateway 后，`/readyz` 会读取只读 manifest 并显示 `tools` optional check，`/api/status` 返回 `toolsHealth`。探针只验证 manifest 协议和网关可达性，不执行工具、不产生副作用；失败时核心 readiness 仍由仓库、模型、dispatcher、domain 和 scheduler 决定。

Agent Registry 的 `agentRegistry` optional check 只验证本地 Registry 文件或 PostgreSQL 连接可读，不执行 Discovery、Admission、Revocation 或 Reputation 写入。

HTTP Projection Sink 可通过 `AEEIS_PROJECTION_SINK_HEALTH_URL` 配置同源只读 GET 健康地址。地址必须与 sink endpoint 同源、使用 HTTPS（loopback 开发例外）、不含凭证/query/fragment；探针复用 sink Bearer token、禁止重定向，最多等待 3 秒。健康检查不发送事件、不改变 outbox 状态。Feishu 应用/Webhook sink 没有独立健康调用时会明确显示 probe unavailable，不能用一次投影成功代替持续可达性。

HTTP RSI evaluator 可通过 `AEEIS_RSI_EVALUATOR_HEALTH_URL` 配置同源只读 GET 健康地址。探针不会提交评测 case，不产生 evaluator 账单或 evidence；没有独立探针时显示 probe unavailable。

先保存时间、实例、响应头中的 `x-request-id`、Run ID、Goal ID、Plan ID、Task ID、principal/tenant、最近 receipt 和相关 trace/request ID，再进行恢复操作。AEEIS 会接受符合格式的上游 request ID；非法或过长的值会被替换为新的 UUID。

查看 HTTP 指标时，先比较 `aeeis_http_requests_total` 的状态码分布，再查看 `aeeis_http_request_duration_seconds_bucket`、`_sum` 和 `_count`。`status="aborted"` 表示客户端在响应完成前断开；这种请求仍会从 `aeeis_http_requests_in_flight` 中释放。`/metrics` 自己的抓取会短暂计入并发数，不能把单次抓取中的 `1` 误判为泄漏。HTTP 计数器和直方图属于单个 HTTP 应用实例，重启后清零，应使用 `rate()` 并保留 Prometheus 的 instance 标签。断开连接只结束 HTTP 计量，不会取消已经发出的模型或工具调用；业务执行结果仍以持久化 Run/Receipt 为准。Prometheus 示例：

```promql
sum by (status) (rate(aeeis_http_requests_total[5m]))
histogram_quantile(0.95, sum by (le, route) (rate(aeeis_http_request_duration_seconds_bucket[5m])))
max_over_time(aeeis_http_requests_in_flight[5m])
```

## 2. Run 状态处置

### `unknown`

先读取 Run timeline 和 provider receipt，确认原始 `callId`、幂等键、input hash 及供应商审计信息。只使用同一幂等键重试，或调用对应的 model/tool/Agent reconcile 接口提交明确的 `completed` 或 `failed` 结果。不能通过重新创建 Run 来绕过未知状态。

### `waiting_external`

检查外部 Agent 的 delegation receipt、callback 事件、Grant 预算和 Agent Card 版本。若供应商已经执行但回调丢失，使用外部 Agent reconcile；若无法确认执行结果，保持等待并升级到供应商或人工审计。不要盲目再次委托。

### `paused`

确认暂停原因、是否有在途调用以及 owner/tenant 授权。恢复前先处理所有 `unknown` 或等待中的外部调用；恢复后观察同一 Run 的 timeline 和 receipt 是否继续单调推进。

### `failed` / `cancelled`

读取失败原因和最后一个 canonical receipt，区分可重试的暂时依赖故障、需要人工 reconcile 的未知结果和不可重试的协议/授权错误。取消后的调用结果不得复活 Run。需要重新执行时创建有明确来源和幂等语义的新 Run。

## 3. DAG 调度与 Temporal

查看 `GET /api/plans/:planId/scheduler`，确认 reservation、dispatch ledger 和后继节点状态。调度器卡住时先执行一次 `POST /api/plans/:planId/scheduler/reconcile`，再检查是否存在重复 reservation 或孤立 Run。

Temporal Worker 异常时检查 Worker `/health`、`/readyz`、namespace、task queue、Build ID 和版本策略。生产发布前必须对代表性的线上 history 执行 `npm run temporal:replay`；发生 Worker 版本不兼容时停止 promotion，使用兼容 Build ID 处理旧 history。

## 4. Projection Outbox

检查 projection event 的 destination、状态、attempt、hash 和最后错误。失败事件可以由 pump 按原幂等键重试；`unknown` 事件需要先确认外部 sink 是否已经收到，再执行 reconcile。不要删除 canonical 状态来“清理”投影积压。Feishu 或其他 sink 的凭证轮换后，先做单条低风险事件验证，再恢复批量 drain。

## 5. RSI 回滚

发生质量、成本、安全或回归告警时，立即停止 candidate 的 production traffic canary，保留当前 bucket、route snapshot 和观察证据。把 candidate 标记为 held 或 rolled back，恢复上一条已批准的 activation，并核对新旧版本的模型、Skill、Tool 和 policy digest。回滚完成后保留 incident、评测结果、线上样本和决策人记录，禁止直接删除候选。

### RSI 提案调用核查

提案器是可选的辅助发现步骤，不能绕过评测、审批、晋升或激活。开启后，检查 `GET /api/evolution/signals` 中的 `synthesis.state`、`inputHash`、`idempotencyKey` 和 `settled`。`started` 或 `unknown` 都表示供应商结果未确认；服务重启或请求超时后不要重新创建 Run，也不要再次发送相同请求。先从供应商日志取得原始 attempt 的结果和 usage，再向 `POST /api/runs/:id/rsi-proposal-synthesis-reconcile` 提交绑定核查。核查会追加事件并保留原始 `unknown` 记录；较晚到达的响应会被丢弃。若返回具体 proposal，AEEIS 仍会重新验证 evidence refs、base version、proposed version 和 typed activation schema，然后才允许进入普通 RSI candidate 流程。设置全局 `moneyUsd` 预算时，动态路由必须有 Planprice 的 USD 价格；固定模型可以设置 `AEEIS_RSI_PROPOSAL_SYNTHESIS_PRICES`。缺少价格时，调用会在发送前拒绝。


`attemptId`、`inputHash`、`idempotencyKey` 必须原样取自该 signal 的 synthesis 摘要；用供应商确认的真实 token 数替换示例数字。证据不足时可以确认 `proposal: null`；如果供应商确认失败，使用 `outcome: "failed"` 并省略 `output`。不要用零值猜测未知费用。

```json
{
  "attemptId": "<attempt id>",
  "inputHash": "<frozen SHA-256>",
  "idempotencyKey": "<frozen provider key>",
  "outcome": "completed",
  "output": {"proposal": null},
  "usage": {"inputTokens": 123, "outputTokens": 45},
  "reconciliation": {
    "source": "provider",
    "reference": "<provider receipt id>",
    "reason": "Provider confirmed the final response"
  }
}
```

`completed` 但未 `settled` 表示结果已保存、账本仍待结算：修复持久化故障后由 Pump 继续结算，不会再次请求模型，也不会在结算完成前为本 Run 开始另一条信号调用。若 `error` 表示超额或缺报用量，则保留拒绝结果，不发布该候选。

## 6. Agent 撤销与密钥轮换

发现外部 Agent 行为异常或凭证泄露时，先撤销 Agent Registry admission 和相关 Delegation Grant，再轮换 OAuth/HMAC 凭证。保留已经发出的 Grant、Context Pack digest、callback receipt 和撤销时间；对在途 Run 使用 reconcile 或取消，不用新凭证重放旧请求。轮换后验证 Agent Card、签名、权限和最小预算，再逐步恢复流量。

## 7. 备份、恢复与演练

使用 `npm run backup:postgres` 生成 custom-format 备份和 SHA-256 manifest，使用 `npm run backup:verify` 做只读校验。用显式的恢复管理员连接串运行 `npm run backup:restore` 或 `npm run recovery:postgres`，恢复到隔离数据库并检查关键表、行数和 `/readyz`。生产备份必须上传到独立、加密、受访问控制的存储，并定期演练包含真实依赖、凭证策略和 Temporal history 的恢复流程。

## 8. 事故记录

每次事故至少记录：开始/结束时间、影响范围、租户和 Run 范围、检测信号、最后可靠 receipt、处置命令、是否触发 reconcile/rollback、数据是否外泄、根因、修复、回归测试和后续 owner。涉及安全边界、隐私或凭证的事故按 `SECURITY.md` 私下报告。

## 9. Prometheus 观测 profile

开发环境可以用 `docker compose --profile observability up -d --build` 启动 Prometheus，控制面仍由 AEEIS 自己提供 `/metrics`。配置文件位于 `monitoring/prometheus.yml`，告警规则位于 `monitoring/alerts/aeeis.yml`；默认规则覆盖控制面不可达、控制面不就绪、HTTP 5xx、p95 延迟、Run/Task/Projection unknown 和 embedding reindex 连续失败。

生产环境使用 [monitoring/prometheus.production.yml](../../monitoring/prometheus.production.yml) 模板：通过 HTTPS 抓取，使用 secret 挂载 `bearer_token_file` 和 CA 文件。token 必须对应 AEEIS 的 installation `operator` Principal；反向代理可以提供网络隔离，但不能替代 AEEIS 自身的 Principal 校验。Prometheus 的 `up` 只表示抓取端点可达；业务 readiness 仍应同时探测 `/readyz`，不能用一次成功抓取代替依赖就绪检查。启动前运行 `npm run test:monitoring`，它会用 promtool 同时校验开发配置和生产模板。

Prometheus 界面只绑定本机 `http://127.0.0.1:9090`，profile 默认关闭，数据保存到独立 Compose volume。当前只计算并展示告警状态，没有配置 Alertmanager 或发送通知。运行 `npm run test:monitoring`（需要 Docker）可在离线时间序列上验证规则的等待、触发、恢复和健康空闲场景；运行 `npm run smoke:monitoring` 验证真实 target、规则和当前 HTTP 指标。后者可以识别旧镜像缺少指标的情况。CI 会启动该 profile 并执行这两个命令及业务 Compose smoke。

HTTP 错误率和 p95 按 `job, instance` 分别计算，避免健康实例掩盖故障；durable Run/Task/Projection 和 reindex 指标按 job 取最大值，避免同一事实库被多个 API 实例抓取时重复累加。多个独立安装应使用不同 job，或为规则增加安装维度。`*_total` 名称的这些 durable 状态指标是 gauge，不应对它们使用 `rate()`。HTTP `aborted` 属于结束的请求并计入总量，不算 5xx。无请求时不产生错误率告警。

规则阈值是开发初值：不可达 2 分钟、5xx 超过 5% 持续 10 分钟、HTTP p95 超过 2 秒持续 10 分钟、unknown 和 reindex 故障持续 15 分钟。同步执行和流式请求可能合理地超过延迟阈值，正式部署前应按路由 SLO 调整；unknown 告警是人工核查信号，不能据此自动重发外部调用。生产抓取必须使用 HTTPS 和 operator 凭证；仅靠反向代理不能替代已启用的 AEEIS Principal 验证。Worker readiness、告警通知送达和生产存储容量仍需部署侧验收。


生产观测容器可独立于开发 Compose 部署。先复制生产模板到部署配置目录，把 `targets` 和 `server_name` 改为实际 HTTPS 主机名，并将该主机加入 AEEIS 的 `AEEIS_PUBLIC_HOSTS`。准备可信 CA PEM 与 operator token 文件（只包含 token，不含 `Bearer ` 前缀），确保容器用户可读且宿主机访问受限，然后执行：

```bash
AEEIS_PROMETHEUS_CONFIG_FILE=/absolute/deployment/prometheus.yml \
AEEIS_METRICS_TOKEN_FILE=/absolute/secrets/aeeis-metrics.token \
AEEIS_METRICS_CA_FILE=/absolute/secrets/aeeis-ca.crt \
docker compose -f monitoring/compose.production.yml up -d
```

这是单独的监控部署，不会启动 AEEIS 或开发夹具；默认端口与开发观测容器相同，部署时选择其中一套。OIDC 模式使用带 operator 角色、匹配 issuer/audience 的有效访问 token，由部署侧负责到期前更新文件；这里不实现交互登录或自动续期。token 有安装级 operator 权限，不是专用只读 metrics 权限。模板和文件挂载校验通过，不代表真实证书、服务端授权或网络已验收。

readiness 的 repository/model/dispatcher/knowledge 检查并发执行，等待上限默认 5 秒。未完成的底层检查不会因下一次轮询而重复发起；超时只结束等待，不会强制取消适配器 I/O，底层调用持续挂起时需修复连接或重启进程。domain、taskScheduler、brain、evolution、collaboration 的 readiness 项仍只确认配置存在。指标 collector 失败时保留 HTTP 与 readiness 指标，并输出 `aeeis_metrics_collection_success{collector="…"} 0`，不把未知存储状态伪造为零；应先处理采集故障再判断业务状态计数。


## 10. RSI / 协作触发巡检

两类 Pump 的 checkpoint 分别名为 `rsi-proposal-pump` 和 `collaboration-trigger-pump`。PostgreSQL 存在 `aeeis_run_scan_cursors` 中；File 默认存在数据目录的 `run-scan-cursors.json`，可用 `AEEIS_RUN_SCAN_CURSOR_PATH` 配置。`revision` 表示已尝试批次的提交版本，`afterId` / `throughId` 表示本轮 Run ID 范围，`resume.offset` / `endOffset` 表示部分 Run 的事件范围。cursor 为 `{}` 表示上一轮已结束、下次从头巡检。正常空闲也会继续巡检，不应把 revision 变化当作产生了新候选或新协作任务。

出现处理错误时先查看对应 Run/event 和 Pump 日志。单条错误不会挡住其他 Run，会在下一轮重访；cursor 保存失败会保留旧位置并重放，重复调用由 durable attempt、signal ID 和 Trigger Decision 幂等拦截。不要把 cursor 前移来掩盖处理错误。未知供应商调用仍必须按原有 reconcile 流程核查，清理 checkpoint 不能授予再次调用供应商的权限。

恢复备份时保留 cursor 可继续扫描；丢失 cursor 会从头重放，领域事实和幂等回执必须完整恢复。此实现限制每批读取量，不保证固定发现延迟；持续检查单个 Run 的大小、全轮巡检时长和 Pump 错误，并对实际数据容量验收。
