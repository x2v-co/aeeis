# Planprice Contract Semantics 1.0.0

这是 G2 附件草案，补充 JSON Schema 无法单独表达的跨字段规则。

- 当前目录端点是全量快照，不接受过滤、分页或 `catalogVersion` 查询参数；历史版本使用 `/v1/catalog/snapshots/{catalogVersion}`。
- `catalogVersion` 在至少 90 天保留期内不可变，不复用。`expiresAt` 只影响新的路由许可，不修改历史 JSON。
- `offeringId` 对 `(modelId, modelVersion, providerId, channelId, regionSetId, pricingVariantId)` 六元组唯一；六元组任何一项变化都生成新 ID。
- `versionStatus=pinned` 要求非空 `modelVersion`；`rolling/unknown` 要求 `modelVersion=null`。rolling 只冻结请求映射，不冻结供应商权重。
- `pricing.currency` 必须等于所有价格 component 的 currency；v1 不允许一个 offering 混合币种。
- token component 使用 `pricePerMillion`，其它 unit 使用 `unitPrice`；未知使用 null + `priceStatus=unknown`，零仅表示已知免费。
- 每个 component 的 `conditions` 必须是 `pricing-conditions/1` 的 typed object，首版支持 `standard`、`tier`、`cache`、`reasoning`、`minimum_spend`、`batch` 和递归的 `composite`；空 object 和未知 kind 均无效。`tier.tiers` 的 `upToUnits` 必须严格递增，最多一个 `null` 且只能位于最后；`cache.ttlSeconds` 不得为负；`reasoning.multiplier` 与 `minimum_spend.amount` 必须为正数，后者币种必须等于父 pricing；`batch.discountMultiplier` 必须位于 `(0,1]`；`composite` 非空且最大嵌套深度为 3。
- Planprice 可以提供这些条件事实，但 AEEIS v1 只解释 `standard` 并将其用于无条件 money budget；`tier`、`cache`、`reasoning`、`minimum_spend`、`batch` 或含有它们的 `composite` 在没有专门解释器和跨字段验收前必须拒绝自动成本排序/带 money budget 的发送。上述跨字段规则属于本 G2 语义附件，由 validator 的 `conditionsSemantics` 执行。
- priceStatus 不包含 expired；是否过期由调用时刻与 `[effectiveAt, expiresAt)` 计算。历史快照不可被重写。
- normalization 使用 `1 base = rate × quote`，以十进制计算，转换单位价一次性 half-even 舍入到 8 位。任何适用费用未知、FX 过期或只知道 input/output 一项时，带 money budget 的 Run 必须拒绝发送。
- digest 对去掉根 `digest`（和未来签名封套）后的响应使用 RFC 8785 JCS、UTF-8、SHA-256，表示完整快照；首版没有 responseDigest。
- Model Pin 的 `catalogDigest` 是完整目录快照 digest；`catalogHash` 是 Pin 实际候选 offering 子集的独立 digest。候选集以 `candidateOfferings[]` 保存每个 offering 的 ID 与独立 `offeringHash`，按 offeringId 排序后做 JCS/SHA-256；两者必须分别可重算，但数值相同本身不构成错误。
- ETag 是整个快照的弱表示，304 不延长目录、价格或 FX 的有效期。授权检查先于条件请求。
- live 匿名返回最小 alive JSON；ready 使用 `catalog:read` Bearer，目录缺失、未生效或过期返回 503 固定 health JSON；两者 `no-store`。
- `modelId` 不是供应商请求名。AEEIS 必须用部署映射把 offeringId 解析为 endpointRef、requestModel、mappingVersion 和 credentialRef。
