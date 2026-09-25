# Planprice Migration 1.0.0

## 兼容接口到正式接口

1. Phase 1 保持 `/api/products/grouped?type=llm`、`/api/exchange-rates` 和既有 health，仅用于兼容沙箱和字段盘点。
2. AEEIS 兼容适配器不把数字 ID、slug 或组级 context_window 伪装成正式 offering 身份。
3. 正式目录切换到全量 `/v1/catalog/models`，历史审计使用 `/v1/catalog/snapshots/{catalogVersion}`。
4. 兼容接口至少保留一个双方签署的废弃窗口；正式 release manifest 发布后再开始计时。

## 汇率写接口隔离

生产目录 origin 为只读：写方法返回 405 和 `Allow: GET`。更新迁移到独立 HTTPS origin，例如 `https://manage.planprice.example/admin/v1/exchange-rates`；`/admin/v1` 只是路径，不能替代不同的 scheme/host/port。

管理 token 与 `catalog:read` 分离。删除 `EXCHANGE_RATE_API_KEY || 'demo-update-key'` 的默认回退，管理 Secret 缺失时禁止启用写服务。切换前先验证刷新任务和审计，切换后验证目录 token 无写权限、旧路径不重定向携带凭证。

G3 implementation evidence (2026-09-24): the Planprice public compatibility route
`/api/exchange-rates` is now read-only and returns `405` with `Allow: GET` for
write methods. Write handlers moved to `/api/admin/exchange-rates`; they require
the separate management host, `PLANPRICE_SERVICE_ROLE=admin`, and a random
`EXCHANGE_RATE_API_KEY` of at least 32 characters. Missing, demo, or catalog
tokens fail closed. Unit tests cover public host spoofing, wrong host/token, and
credential failure. This proves the code boundary; real production host,
secrets, and refresh-job evidence are still required before G3 sign-off.

## AEEIS 适配器 G3

以下不属于当前 G2 文档冻结的已实现能力：Bearer header、正式 `/v1` reader、offering 到 requestModel/endpoint 的映射、FX freshness/来源验证、缓存价与复杂 price_variants/constraints 的消费。G3 必须逐项以 contract test 和真实沙箱结果关闭；在关闭前，生产路由应拒绝无法解释的 offering 或成本预算。
