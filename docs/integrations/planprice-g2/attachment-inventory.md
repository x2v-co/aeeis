# Planprice G2 附件清单（draft）

**对应 MRD：** v0.4（G1 MRD review passed）  
**契约草案：** `planprice-catalog/1.0.0-draft.1`  
**当前门槛：** G2 technical review passed；进入双方正式签署/发布流程  
**最后生成：** 2026-09-23

本清单是正式契约冻结的工作包，不表示 G2 已完成签署。每个文件的 SHA-256 由 `release-manifest.json` 记录；manifest 本身不对自己做递归 hash。

| 附件 | 主责 | 当前状态 | 说明 |
|---|---|---|---|
| `openapi/planprice-catalog-1.0.0.yaml` | Planprice 主责，AEEIS 核对 | draft | OpenAPI 3.1；全量快照、历史快照、FX、live/ready、只读写方法拒绝、错误与 headers |
| `schemas/catalog-1.schema.json` | Planprice | draft | JSON Schema 2020-12，完整目录根 |
| `schemas/offering-1.schema.json` | Planprice | draft | 六元 offering identity、状态和能力 |
| `schemas/pricing-1.schema.json` | Planprice | draft | 价格组件、来源、FX normalization |
| `schemas/fx-1.schema.json` | Planprice | draft | USD quote 与时间/来源证据 |
| `schemas/health-1.schema.json` | Planprice | draft | live/ready health envelope |
| `schemas/error-1.schema.json` | Planprice | draft | 错误 body 与 code 枚举 |
| `schemas/aeeis-model-pin-1.schema.json` | AEEIS | draft | routing mode、目录证据、调用映射和价格快照 |
| `schemas/mapping-1.schema.json` | AEEIS | draft | `offeringId → endpointRef/requestModel` |
| `vectors/digest-1.json` | 双方 | executable draft | RFC 8785/JCS UTF-8 SHA-256 向量 |
| `vectors/fx-1.json` | 双方 | executable draft | FX 方向、8 位 half-even 和 partial-price 拒绝 |
| `fixtures/compatibility/` | 双方 | draft | 当前 grouped/exchange-rates 真实形状 |
| `fixtures/catalog-1/` | 双方 | executable draft | 正式 catalog、rolling/null、mapping、Pin、health（ready/expired）、error（catalog/unauthorized）、304 headers、conditions 正负例 |
| `semantics-1.md` | 双方签署 | draft | Schema 之外的跨字段和时间语义 |
| `migration-1.md` | 双方签署 | draft | 兼容端点、Bearer、管理 origin 迁移 |
| `release-manifest.json` | 双方签署 | draft | 附件版本、hash、负责人和 gate |

## 当前 G3 缺口

以下项目明确不伪装为已完成：

- AEEIS 的旧 `PlanpriceHttpCatalog` 兼容模式仍保留旧协议语义；正式 v1
  `PlanpriceV1Catalog` 已发送 Bearer header 并消费目录、快照和 FX 证据；
- 正式 v1 路由已完成 offering → endpoint/requestModel/mappingVersion 映射，
  并将完整 pricing snapshot 写入 Model Pin；
- AEEIS 已实现 `offeringId → endpointRef + requestModel + mappingVersion` 的
  v1 生产映射，并在正式 Model Pin 恢复时拒绝缺失或变化的映射；
- Agent 路由已拒绝缺价或过期 normalization；cached-input 和复杂
  `price_variants/constraints_json` 仍需单独的计费场景验收；
- Planprice 已迁移公开 exchange-rates 写方法、删除默认 `demo-update-key`，
  并在生产验证公开写 405 与管理 origin 隔离；
- 真实目录 origin、Bearer token、管理隔离和 conditions 枚举已有生产或
  fixture 证据，剩余是历史保留、429 退避和真实 web-search/web-fetch 运行证据。

## G2 通过条件

双方确认上述 OpenAPI/Schema/semantics/migration 的版本和 hash；所有正式 fixture 通过 Schema 与跨字段校验；digest/FX 向量在双方实现得到一致结果；变更产生新的契约 release manifest。G2 通过后才开始 G3 实现和真实沙箱验收。

## Fixture 覆盖矩阵

| 场景 | Fixture |
|---|---|
| pinned model version | `fixtures/catalog-1/catalog.json` |
| rolling model with null version | `fixtures/catalog-1/catalog-rolling.json` |
| ready health | `fixtures/catalog-1/health-ready.json` |
| expired catalog health / HTTP 503 body | `fixtures/catalog-1/health-expired.json` |
| retryable catalog failure | `fixtures/catalog-1/error-catalog-unavailable.json` |
| bearer authentication failure | `fixtures/catalog-1/error-unauthorized.json` |
| HTTP 304 header semantics | `fixtures/catalog-1/http-304-headers.txt` |
| supported non-empty pricing conditions | `fixtures/catalog-1/conditions-valid.json` |
| rejected/unsupported pricing conditions | `fixtures/catalog-1/conditions-invalid.json` |
