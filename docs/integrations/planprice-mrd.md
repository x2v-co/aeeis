# AEEIS × Planprice 模型目录与价格服务 MRD

**提交对象：** Planprice 团队  
**需求方：** AEEIS 生态  
**版本：** 0.4（G1 MRD review passed）  
**日期：** 2026-09-23  
**范围：** 需求与协议设计；本次不实施接口、鉴权或部署变更。

## 1. 目标与交付门槛

AEEIS 的规划、执行、审核、协作和 RSI 角色需要按任务能力、上下文、隐私与预算选择模型。Planprice 提供模型、渠道、价格及来源事实；AEEIS 负责选择策略、调用配置、凭证、运行恢复和预算。首期成功标准是：选到确实可调用且计费条件适用的渠道，保存可重算的选择依据，目录更新不改变已启动 Run 的请求配置。

以下三个门槛必须分别判定：

| 门槛 | 通过条件 | 不代表什么 |
|---|---|---|
| G1：MRD review | 场景、边界、协议行为、现状差距和后续责任明确，无相互矛盾的需求 | 不代表接口已实现、Schema 已冻结或生产可用 |
| G2：正式契约冻结 | 双方签署第 7 节的版本化 OpenAPI、JSON Schema、测试向量和迁移附件 | 不代表线上鉴权、隔离与模型调用已验收 |
| G3：生产验收 | 按冻结契约完成双方实现、联调、生产鉴权、管理写接口隔离及真实模型验证 | 不保证供应商未来 SLA、权重不变或目录估价等于账单 |

本 MRD 的第 4～6 节为正式协议的设计约束。附件尚未交付、Bearer 尚未实现或管理接口尚未迁移属于 G2/G3 待办，不因这些实施任务未完成而阻塞 G1。本文 JSON 中的 `sha256:...` 为占位符，冻结附件必须使用真实值。**G1 结论：通过（2026-09-23）。**

产品边界：Planprice 不执行模型推理、不接收用户任务上下文或模型 Provider 密钥；不替 AEEIS 作隐私授权。价格源 benchmark 仅为决策参考。真实账单对账、签名基础设施、服务端分页和动态故障切换均不属于首版必交范围。

## 2. 使用场景与责任

1. **新 Run 选模**：AEEIS 从有效目录中筛选能力、上下文、地区和数据策略符合要求的 offering，再按本地策略比较成本。未知能力不能视为支持；private 数据必须经过本地显式准入。
2. **长时任务恢复**：恢复保存的 offering、requestModel、endpoint 映射、prompt/策略版本和价格证据，不重新选择“当前最便宜”的渠道。
3. **目录故障**：新 Run 只可使用尚未过期且验证通过的本地快照；没有则停止动态选模。既有 Run 保留原 Pin；重新请求最新目录不构成迁移授权。
4. **多角色及 RSI**：各角色可选择不同 offering，但每次选择均保存证据。切换模型产生新的 Pin 和显式迁移事件，不能覆盖旧记录。

Planprice 承诺目录事实、来源、快照身份与时间语义；AEEIS 承诺选模策略、实际 API 名映射、Secret、完整 Pin、预算和证据保留。Provider 的实际调用健康由 AEEIS 独立检查。

## 3. Phase 1 Compatibility Contract：现状与待办

本节依据本地代码核对，未声称已完成生产接口验收。兼容响应与正式 `/v1` Schema 不同，不可相互替换。

### 3.1 `GET /api/products/grouped?type=llm`

Planprice 返回 JSON 数组。以下为消费相关字段的示意摘录，数值仅用于说明：

```json
[
  {
    "id": 101,
    "slug": "sample-model",
    "context_window": 128000,
    "versions": [
      {
        "id": 201,
        "model_id": 101,
        "provider_id": 301,
        "model_slug": "sample-model",
        "providers": { "id": 301, "slug": "sample-provider", "region": "china" },
        "input_price_per_1m": 1,
        "output_price_per_1m": 2,
        "cached_input_price_per_1m": 0.1,
        "currency": "CNY",
        "price_unit": "per_1m_tokens",
        "is_available": true,
        "price_variants": [
          {
            "id": 401,
            "variant_key": "standard",
            "variant_name": "Standard",
            "input_price_per_1m": 1,
            "output_price_per_1m": 2,
            "cached_input_price_per_1m": 0.1,
            "currency": "CNY",
            "price_unit": "per_1m_tokens",
            "is_headline": true,
            "constraints_json": null
          }
        ]
      }
    ]
  }
]
```

| 事实 | 当前行为与限制 | 兼容验收待办 |
|---|---|---|
| 数字 ID 与 slug | 数据库身份/展示标识，没有正式不可变公开 ID 保证 | 保留原始身份，不伪造 offeringId 或 catalogVersion |
| `versions[]` | 含多个渠道/模型变体，不能按“一个模型一个 Provider”解读 | 避免合并丢失价格条件 |
| 可用性 | Planprice SQL 只返回 `is_available=true`，价格变体另筛 `is_public=true`；AEEIS 若收到 false 会过滤，缺失值却当可用 | 不可用场景用 fixture；不得要求现有线上接口返回 false |
| 缓存/变体/约束/单位 | Planprice 已提供 `cached_input_price_per_1m`、`price_variants`、变体内 `constraints_json`、`price_unit`；AEEIS 尚未消费 | 读取并转换支持的单位；复杂或未知条件拒绝自动成本排序，不能静默用 headline 价 |
| 能力与上下文 | AEEIS 硬编码 `text/agent`，继承组级 context，不证明特定渠道支持 | 正式接入前核实渠道能力、上下文，不把当前假设当质量验收 |
| 调用名称 | AEEIS 当前将 `model_slug`（缺失则组 slug）作为模型名 | 核实供应商 API model 名，正式模式改为第 6 节映射 |
| 错误 | grouped 失败返回 500 与 `{ "error": "Failed to fetch grouped products" }` | 不把旧错误体当成 `planprice-error/1` |

AEEIS 目前只消费主要输入/输出数值价格，并做短期内存缓存和本地候选 hash；还未实现正式快照、来源标记、复杂计费、ETag 和鉴权。兼容联调允许已核实的标准价格 fixture，不应据此宣称所有渠道已支持。

### 3.2 `GET /api/exchange-rates`

当前 JSON 返回 `rates`、`allRates`、`lastUpdated`，还包括 `count`、`sources`。`rates` 是 USD 起始币对，`allRates[from][to]` 表示 `1 from = rate × to`。示例摘录：

```json
{
  "rates": { "CNY": 7.2 },
  "allRates": { "USD": { "CNY": 7.2 } },
  "lastUpdated": "2026-09-23T00:00:00Z",
  "count": 1,
  "sources": { "sample-source": "Data from sample-source" }
}
```

当前无活动汇率返回 503 `{error,hint}`，内部异常返回 500 `{error}`。`lastUpdated` 是结果中最近更新记录的时间，不能证明每个币对都同样新鲜。

AEEIS 只读取 `rates`，不验证 `lastUpdated`、逐币对有效期或来源；缺失 currency 目前按 USD 处理；已知非 USD 但缺有效正数汇率时返回未知价格，AEEIS 这一函数不回退为 1。Planprice 其他换算路径的未知汇率回退也需在生产验收时排查，不能透传为可信价格。

**待办**：缺 currency 拒绝比较；缺有效汇率拒绝跨币种比较；采用明确的逐币对新鲜度证据。当前接口无法提供此证据时，跨币种自动预算不算验收通过。默认汇率为 1、默认价格为 0 均禁止。

### 3.3 当前健康与写接口

- Planprice `GET /api/health` 执行 `SELECT 1`，成功为 200 `{status:"ok",database:"ok"}`，失败为 503 `{status:"error",database:"unavailable"}`。这是数据库可达性检查，不证明目录新鲜或 Provider 可用。
- AEEIS fixture 的 `/health` 只报告 fixture 存活；它与 Planprice `/api/health` 不同。AEEIS 用显式同源 health URL、只读 GET 和 HTTP 状态探测，目前无认证 header，也不解析健康正文。
- Planprice 当前 `/api/exchange-rates` 同一路径支持 POST/PUT，并使用 `EXCHANGE_RATE_API_KEY || 'demo-update-key'`。这是已确认的生产风险，迁移要求见第 4.8 节；本次 MRD 不修改线上服务。

### 3.4 Phase 1 验收范围

Planprice 提供完整兼容字段说明与脱敏响应样本，AEEIS 用真实数组形状验证多个 Provider、非 USD、复杂单位拒绝、空目录、500/503 和缺币种。`is_available=false` 仅通过 fixture 测试。时间校验、能力核实、来源标记和复杂价格消费列入 AEEIS 待办，不能由现有 smoke 结果推定完成。

Phase 1 沙箱可匿名联调；生产接入必须通过 G3，包含关闭默认写凭证。兼容接口保留到正式接口可迁移后，具体废弃窗口在 G2 发布附件中双方约定。

## 4. `planprice-catalog/1` 正式设计约束

### 4.1 端点和首版范围

```http
GET /v1/catalog/models
GET /v1/catalog/snapshots/{catalogVersion}
GET /v1/exchange-rates
GET /v1/health/live
GET /v1/health/ready
```

首版采用**全量目录、无服务端过滤、无分页**。当前端点返回调用身份有权获取的最新完整快照；历史端点返回其有权获取的指定完整快照。所有查询参数（包括 catalogVersion、cursor、limit、capability）均返回 400 `invalid_query`，筛选在 AEEIS 内完成。目录过大时需协商扩展版本及快照/分页摘要协议，不能静默截断。

历史快照重取是 G2 必备契约：至少保留 90 天，从 generatedAt 起算；延长由部署策略约定。过期但仍保留的快照可读，用于审计，不能为新 Run 选模；超过保留期或不存在返回 404。快照内容永久不可改，即使清理后也不得复用版本号。

### 4.2 Offering 身份与状态

`offerings[]` 每项为一个模型版本、Provider、渠道、区域集合、价格变体的组合。六元组 `(modelId, modelVersion, providerId, channelId, regionSetId, pricingVariantId)` 唯一且绑定不可变 opaque `offeringId`；调用方不解析 ID 字符串。ID 不使用数据库数字键或可改 slug，迁库/改名不改变旧 ID，不复用被删除 ID。Provider 合并产生新 ID 和 alias 迁移记录，不能重写历史。元组任一项变化生成新 offeringId。

`regionSetId` 绑定排序去重的区域集合与适用规则；`pricingVariantId` 绑定币种、价格表及适用条件，价格表变更产生新变体 ID。普通重采集时间更新不改变元组，但产生新目录快照。

`versionStatus` 必填枚举：

| 值 | modelVersion | 含义 |
|---|---|---|
| `pinned` | 非空字符串 | 供应商提供可寻址的具体版本；仍不构成权重证明 |
| `rolling` | null | 供应商滚动别名，不能保证背后版本不变 |
| `unknown` | null | 无可靠版本证据，不能伪造版本字符串 |

`catalogStatus` 必填，取 `available/degraded/unavailable/deprecated`。后两者禁止新 Run 选择；degraded 由 AEEIS 显式策略决定。`runtimeStatus` 必填，取 `healthy/degraded/unhealthy/unknown`，仅是采集时参考值，非 unknown 时必须携带 `runtimeObservedAt` 和证据引用。该状态变化必须发布新快照，不能原地更新历史目录。AEEIS 另存实时 Provider 探测结果。

能力用小写标签，地区使用双方冻结的代码表，缺信息使用 null 或空集合，不能默认支持 agent。逻辑 modelId 不是供应商 API 请求名，调用映射见第 6 节。

### 4.3 正式目录示例

以下 Sample ID、价格和来源均为虚构示例。首版 `baseCurrency` 固定 USD，仅代表比较币种；实际计费币种取 `pricing.currency`。

```json
{
  "schemaVersion": "planprice-catalog/1",
  "catalogVersion": "cat_example_001",
  "generatedAt": "2026-09-23T00:00:00Z",
  "effectiveAt": "2026-09-23T00:00:00Z",
  "expiresAt": "2026-09-23T00:05:00Z",
  "baseCurrency": "USD",
  "offerings": [
    {
      "offeringId": "off_example_001",
      "modelId": "mdl_example",
      "modelVersion": "2026-05",
      "versionStatus": "pinned",
      "providerId": "prv_example",
      "channelId": "chn_standard",
      "regionSetId": "rgn_cn",
      "pricingVariantId": "price_example_001",
      "regions": ["cn"],
      "capabilities": ["text", "agent"],
      "contextWindow": 128000,
      "catalogStatus": "available",
      "runtimeStatus": "unknown",
      "runtimeObservedAt": null,
      "runtimeEvidenceRef": null,
      "pricing": {
        "currency": "CNY",
        "effectiveAt": "2026-09-23T00:00:00Z",
        "expiresAt": "2026-09-30T00:00:00Z",
        "components": [
          { "componentId": "input", "kind": "input", "unit": "token", "currency": "CNY", "priceStatus": "known", "pricePerMillion": "1", "conditions": {} },
          { "componentId": "output", "kind": "output", "unit": "token", "currency": "CNY", "priceStatus": "known", "pricePerMillion": "2", "conditions": {} }
        ],
        "provenance": {
          "sourceId": "source_example",
          "sourceUrl": "https://provider.example/pricing",
          "observedAt": "2026-09-23T00:00:00Z",
          "evidenceDigest": "sha256:..."
        },
        "normalization": {
          "status": "available",
          "currency": "USD",
          "componentPrices": { "input": "0.13888889", "output": "0.27777778" },
          "fx": {
            "base": "USD",
            "quote": "CNY",
            "rate": "7.2",
            "direction": "quote_per_base",
            "asOf": "2026-09-23T00:00:00Z",
            "expiresAt": "2026-09-24T00:00:00Z",
            "sourceId": "fx_source_example",
            "evidenceDigest": "sha256:..."
          },
          "rounding": { "scale": 8, "mode": "half_even", "stage": "converted_unit_price" }
        }
      }
    }
  ],
  "digest": "sha256:..."
}
```

### 4.4 价格 Schema 与归一化

正式 Schema 采用以下统一规则；不能把旧接口 number 格式直接套入正式协议：

- 金额和汇率为十进制定点字符串，禁止指数、负值、NaN、Infinity；使用规范形式（无多余前导/尾随零，零为 `"0"`），最多 18 位小数。未知金额为 JSON null；`"0"` 表示已知免费。
- `pricing.currency` 与每个 component.currency 必须一致，币种为大写 ISO 4217 代码。v1 不允许在一个 offering 中混合币种；无法拆清条件的复合费用不得参与自动预算。
- unit=token 时必须有 pricePerMillion（字符串或 null），禁止 unitPrice；其他 unit 必须有 unitPrice（字符串或 null），禁止 pricePerMillion。已知非负价对应 priceStatus=known；null 对应 unknown。省略仅用于不适用字段。
- priceStatus 只有 known/unknown，**不定义 expired 值**。过期由调用时刻与 expiresAt 比较推导；不能为历史快照改写状态。所有时间为 UTC RFC 3339 `Z`；有效区间为 `[effectiveAt, expiresAt)`，汇率为 `[asOf, expiresAt)`。
- components 必须覆盖适用费用。kind 至少覆盖 input、output、cached_input、cache_write、reasoning、tool、subscription、other。批处理是条件/变体，缓存创建 TTL、阶梯区间（下界含、上界不含）、套餐准入、最低消费、附加费用分别进入有类型的 conditions。未知 conditions、重叠而无优先级的档位、计费是否包含 reasoning 不明时，客户端拒绝自动计费，不能把未知附加费算零。
- provenance 必填，包含 sourceId、无凭证 HTTPS sourceUrl、observedAt、evidenceDigest。源证据由 Planprice 保留至少 90 天并提供给获授权的审计；observedAt 是采集时间，不能当作供应商价格生效时间。
- 删除冗余 input/output 快捷价格，components 是唯一价格事实源。字段枚举、conditions 子类型和计费包含/排除规则以 G2 JSON Schema、计费语义附件冻结；未识别变体可展示，但不能自动消费。

normalization 为必填对象，status=available 或 unavailable，currency 固定 USD，componentPrices 的键与 componentId 一致，每个值为字符串或 null。源币种非 USD 且缺有效 FX 时，fx=null、status=unavailable、全部转换价=null。仅一项价格已知时保留该转换价，未知项为 null，status 仍为 unavailable。

available 要求本价格表所有组件可转换且其条件可被明确解释，不表示任何请求都具备套餐资格。新 Run 仍须验证条件及所有时间有效性；任一适用费用未知、只有 input 或 output 一项已知、FX 过期或复杂条件不被 AEEIS 支持时，带 money budget 的 Run 在发送前拒绝，不以单项已知价排序或补零。无 money budget 的调用也不能把成本标为已知。

FX 方向固定 `1 base = rate × quote`，base=USD、quote=实际价格币种，`USD单位价 = 原币单位价 / rate`。归一化使用十进制精确除法，每个转换单位价只舍入一次到 8 位小数，half_even；展示不得回写原始价。USD 本币采用显式 identity FX（USD/USD、rate="1"、sourceId="identity"、direction="quote_per_base"），时间沿用价格区间；这是同币种恒等式，非未知汇率回退。

本示例 1÷7.2→0.13888889，2÷7.2→0.27777778。AEEIS 保存原价、完整 FX、舍入规则与结果并重算校验。成本为固定归一价乘已报告计费量再求和；token 单位除以 1,000,000，金额账本若需压到 8 位，用向上舍入避免预算低估。估算不构成供应商硬扣费上限。

### 4.5 汇率正式接口

`GET /v1/exchange-rates` 返回 schemaVersion=`planprice-exchange-rates/1`、base=`USD`、generatedAt 和 `quotes[]`。每个 quote 使用第 4.3 节 fx 的全部字段（包括逐币对时间、来源和证据摘要），同一 quote 币种只出现一次；不再用一个全局 lastUpdated 推定全部新鲜。

最新接口仅发布有效正数币对；所需币对缺失则归一化不可用，不能回退到 1。无任何可用币对时返回 503 catalog_unavailable。目录内嵌实际采用的 FX 副本，汇率接口后续变化不改写旧目录；重算历史 Pin 不依赖最新汇率接口。

### 4.6 完整快照、digest 与缓存

1. 同一 catalogVersion 对应一个完整不可变 payload，所有授权读者得到相同内容。租户专属目录必须使用不同版本；不得在同一版本下按请求身份裁剪内容。runtimeStatus、价格或有效期变更都发布新版本。
2. digest 固定为 `sha256:` 加 64 位小写 hex：去掉响应根部 digest 和可选 signature，其余全部字段执行 **RFC 8785 JCS → UTF-8 → SHA-256**。不做额外 Unicode 规范化。发布前 offerings 按 offeringId、components 按 componentId、regions/capabilities 排序去重；客户端验证响应中的实际数组顺序，不重排来“修复”摘要。
3. 当前和历史端点在同一版本返回相同 payload。SHA-256 证明内容一致性；HTTPS 和访问控制提供在线来源身份，本地 hash 不等于来源签名。独立离线来源证明需要后续签名与信任根扩展，G1/G2 不冒称已具备。
4. `ETag: W/"sha256:<hex>"` 是整个快照语义表示的弱 ETag，涵盖所有被摘要覆盖的字段；不指代单个 offering。没有分页/过滤，因此不需要 responseDigest。签名扩展前须重新确定其表示与 ETag 规则。
5. 鉴权与快照读取权限检查先于 If-None-Match；匹配返回 304、无 body、保留 ETag/Cache-Control/Vary/X-Request-Id。304 不延长 payload expiresAt，不能把过期目录变新鲜。
6. 目录响应统一 `Cache-Control: private, no-cache, must-revalidate`、`Vary: Authorization, Accept`；AEEIS 的应用层副本按 origin、授权主体/权限版本和 catalogVersion 隔离。token 轮换清理对应缓存；只可供同一授权上下文在有效期内恢复使用。
7. 首版不允许 stale-while-revalidate 为新 Run 选模；本地有效上限是目录、适用价格、FX 的 expiresAt 最小值。读取失败不覆盖有效快照为空；本地筛选无候选与服务返回合法空目录分别记录。
8. 当前目录缺失、未生效或过期返回 503 catalog_unavailable，不返回旧目录或 304。历史端点可在保留期内以 200/304 返回过期快照用于审计；这不是新的路由许可。有效完整目录无 offering 时返回 200 和空数组。

### 4.7 读取鉴权与适配待办

生产 `/v1` 目录、历史快照、汇率和 ready 使用 Bearer，scope=`catalog:read`；历史访问继续校验目录归属权限。仅 development/sandbox 可明确选择 none，**生产内网也不例外**。live 例外见第 4.9 节。

拟增加 AEEIS 配置 `AEEIS_PLANPRICE_AUTH_MODE=none|bearer`、`AEEIS_PLANPRICE_TOKEN`（Secret），正式生产配置必须 bearer，缺 token 启动失败。发送 `Authorization: Bearer <token>` 到目录、历史、汇率和 ready 的同源 HTTPS 端点，禁止重定向、URL token 和日志记录凭证。mTLS 不属于本版交付范围。

当前适配器没有这些配置或认证 header。实现及无 token、错误 token、权限不足、轮换、日志脱敏测试是 G3 待办，不能把本文配置当成当前可用环境变量。

### 4.8 管理写接口迁移

迁移必须先配置管理服务与更新作业，验证后再切断旧写路由，避免价格源无法更新：

1. 部署 `https://manage.planprice.example/admin/v1/exchange-rates` 等管理服务，独立于只读目录 origin。origin 指 `(scheme, host, port)`，本设计要求管理 host 不同且均为 HTTPS；`/admin/v1` 本身只是路径，不能形成 origin 隔离。
2. 管理服务使用独立管理 Secret/scope、网络访问控制和写入审计；缺管理 Secret 禁止启用写接口。管理读写不接受 catalog:read 凭证。
3. 更新内部刷新任务到管理服务，验证价格/汇率仍可发布，再让目录 origin 的 POST/PUT/PATCH/DELETE `/api/exchange-rates` 和 `/v1/exchange-rates` 返回 405，`Allow: GET`。旧写路由不以重定向转发凭证。
4. 删除两处 demo-update-key 默认回退，并检查其他默认写凭证；通过代码扫描和隔离测试证明默认值不可认证。管理 Secret 仅在 Secret 系统配置，审计不记原值。
5. G3 验证公开写方法 405、错误管理 token 401、目录 token 无管理权限、管理作业正常及轮换。改回公开默认凭证不属于回滚方案。

### 4.9 健康端点确定语义

两端点均 `Content-Type: application/json`、`Cache-Control: no-store`，不调用模型、不触发价格刷新。

| 端点/条件 | 鉴权 | HTTP / body |
|---|---|---|
| live，进程可应答 | 匿名，任何环境 | 200 `{schemaVersion:"planprice-health/1",status:"alive"}`，不暴露数据库/租户 |
| live，进程不可应答 | 同上 | 连接失败/超时；负载均衡可能返回 502/503，不冒充应用健康 JSON |
| ready，未认证/无权 | 与目录一致 | 401/403，使用第 5 节错误封套，鉴权在依赖检查前执行 |
| ready，数据库/快照读取正常，当前目录有效 | 与目录一致 | 200 health 封套，status=ready、catalog.ready=true、database.ready=true |
| ready，数据库不可用 | 与目录一致 | 503 health 封套，status=not_ready、reason=database_unavailable、database.ready=false、catalog.ready=false |
| ready，数据库正常，但目录缺失/未生效/过期 | 与目录一致 | 503 health 封套，status=not_ready、reason=catalog_missing/catalog_not_effective/catalog_expired、catalog.ready=false |

ready 封套必填 schemaVersion、status、reason（正常为 null）、checkedAt、database.ready 和 catalog `{ready,catalogVersion,expiresAt}`；没有可读取快照时后两项为 null。全部时间使用 UTC。有效空目录仍为 ready，AEEIS 自己报告“无候选”；offering 的 Provider 不健康不影响 Planprice ready。目录整体有效不代表每个价格/汇率有效，AEEIS 在选模时逐项校验。503 health 正文是健康端点特例，不用 planprice-error 封套；Retry-After 按第 5 节规则。

## 5. HTTP 与错误协议

JSON 数据与错误都使用 `Content-Type: application/json`；只接受未指定 Accept、`*/*` 或包含 application/json 的 Accept，其余返回 406。v1 不做运行时 Schema 版本协商，未知 URL 版本返回 404。不兼容响应体的 schemaVersion 是客户端协议校验失败，不伪装成服务端 422。

| code | HTTP | retryable | 条件 |
|---|---:|---|---|
| invalid_query | 400 | false | 任意不支持查询参数或非法路径参数 |
| unauthorized | 401 | false | 缺少/错误 token；带 WWW-Authenticate: Bearer |
| forbidden | 403 | false | 有效身份但无读取权限 |
| snapshot_not_found | 404 | false | 有权限范围内快照不存在/已清理；无权探知归属的版本也返回此值 |
| resource_not_found | 404 | false | 未知端点/URL 版本 |
| method_not_allowed | 405 | false | 不支持的方法，带 Allow: GET |
| not_acceptable | 406 | false | Accept 不支持 JSON |
| rate_limited | 429 | true | 请求超出读取配额 |
| upstream_unavailable | 502 | true | 为本次读取必需的上游服务失败 |
| catalog_unavailable | 503 | true | 本地有效目录/汇率不可提供或服务暂不可用 |
| internal_error | 500 | false | 未分类程序异常；可识别的暂态依赖失败必须归入 502/503 |

429 必须带正整数秒 Retry-After；502/503（含 ready 503）仅在服务能给出明确恢复估计时带正整数秒，否则省略。无 Retry-After 的可重试错误由客户端指数退避和 jitter，受整体超时/次数约束；不自动重试 401/403/500。

所有应用响应带 X-Request-Id。传入值仅接受 `[A-Za-z0-9_-]{1,64}`，无效/缺失则生成 UUID；错误 JSON requestId 与返回 header 相同，成功和健康 JSON 不要求重复该字段。日志和响应禁止包含密钥、任务内容、SQL 和堆栈。错误响应 `Cache-Control: no-store`。

```json
{
  "schemaVersion": "planprice-error/1",
  "code": "catalog_unavailable",
  "message": "No valid current catalog",
  "retryable": true,
  "requestId": "req_example"
}
```

客户端遇到代理返回的非 JSON 502/503、重定向或畸形成功体，记录 HTTP 与 protocol/transport failure，不将其解释为空目录；304 为缓存控制特例，不需 JSON body。

## 6. AEEIS Model Pin 与调用映射

正式模式部署配置必须显式维护 `offeringId → {endpointRef, requestModel, mappingVersion, credentialRef}`，endpointRef 再解析受信任的无凭证 HTTPS endpoint。requestModel 是供应商 API 实际接受的 model 字段，不能默认等于 modelId/slug。没有映射则 offering 不可调用。credentialRef 仅为内部 Secret 引用，不进入公开 Pin；同 Provider 的不同渠道不共享默认凭证。

Pin 必须保存以下内容（字段是否在现有运行时已实现不由此表推定）：

| 字段 | 冻结内容 |
|---|---|
| schemaVersion / routingMode | aeeis-model-pin/1；正式为 catalog，兼容为 compatibility，固定为 static |
| offeringId 与六元身份、versionStatus | 使用完整目录身份；static/compatibility 缺正式身份用 null，不生成假 ID |
| catalogVersion / catalogDigest / catalogRetrievedAt | 完整快照版本、上游摘要、接收时间；保存验证过的原始快照或 durable artifact 引用 |
| catalogHash / candidateOfferings / routingPolicyVersion | AEEIS 实际候选集指纹、候选 offering ID 与各自 offeringHash，以及选择算法/隐私策略版本；候选集按 offeringId 排序后做 JCS/SHA-256，独立于上游 digest |
| pricingSnapshot | 完整 pricing 副本，包括所有原币 components、单位/条件、provenance、有效区间、normalization 及其 FX 方向、数值、来源、证据摘要、asOf/expiresAt、舍入规则 |
| endpointRef / resolvedEndpointHash / mappingVersion / requestModel | 冻结实际请求配置；endpoint 规范化为 URL.href（无 userinfo/query/fragment）后 UTF-8 SHA-256；恢复不得只按当前 reference 悄悄换 endpoint |
| promptVersion / selectedAt | prompt 身份及选择时间 |

恢复依赖版本化的本地 endpoint 映射；hash 只用于校验，不能反推出 endpoint。Secret 可以在同权限边界内轮换，不能改变 Provider/渠道；映射不匹配须停止恢复并显式迁移。价格过期不改写旧 Pin，长任务预算是否允许沿用旧估价由已冻结策略决定；供应商实际账单可能变化，不能宣称冻结了计费。

modelVersion=null、versionStatus=rolling/unknown 时只保证请求配置冻结，不保证供应商权重不变。即使 pinned，也只代表供应商暴露了版本标识；强不可变需求由本地策略要求供应商进一步保证，否则拒绝该渠道。

静态模型不需 Planprice；catalogVersion/catalogDigest 为 null，但 requestModel、endpoint 映射、prompt/策略和明确配置的价格证据仍需保留。固定与兼容模式不宣称拥有正式快照验证能力。

## 7. G2 契约冻结附件与责任

以下是**待交付附件清单**，本次 MRD 不声明文件已存在，也不要求实现生产代码后才通过 G1。附件统一以契约 release（首版 1.0.0）发布，manifest 记录文件 SHA-256、双方确认版本及变更日志。

| 附件（约定交付名） | 责任方 | 冻结条件 |
|---|---|---|
| openapi/planprice-catalog-1.0.0.yaml | Planprice 主责，AEEIS 核对 | OpenAPI 3.1，覆盖全部路径、鉴权、健康、错误及 304/缓存 headers |
| schemas/catalog-1.schema.json、offering-1.schema.json、pricing-1.schema.json、fx-1.schema.json、health-1.schema.json、error-1.schema.json | Planprice 主责 | JSON Schema 2020-12，固定 required/null/枚举、单位互斥、versionStatus、conditions 子类型、source 及嵌套对象；跨字段/时间/引用约束配语义校验附件 |
| schemas/aeeis-model-pin-1.schema.json、mapping-1.schema.json | AEEIS 主责 | 覆盖调用名、映射身份、完整价格/FX 证据、三种 routingMode |
| vectors/digest-1.json、vectors/fx-1.json | 双方共同 | 原始 JSON、JCS UTF-8 bytes、预期 hash；属性重排不变、数组篡改失败、Unicode/数字边界；汇率方向、8 位 half_even 边界、已知单价/缺价/过期验证 |
| fixtures/compatibility/、fixtures/catalog-1/ | Planprice 与 AEEIS | 真实形状脱敏样本、不可用 fixture、多渠道、多价格条件、rolling/null、鉴权、健康过期、HTTP 错误和 304 不延寿样例 |
| semantics-1.md、migration-1.md、release-manifest.json | 双方签署 | 复杂计费包含关系、跨字段校验、ID alias、90 天保留、兼容废弃窗口、部署映射和接口切换责任 |

这些附件可用本地校验器和 fixture 校验，不依赖线上凭证。所有正式示例必须通过 Schema 与语义检查，双方对 digest/FX 测试向量得到一致结果后才算 G2 通过。后续破坏性字段/语义变更需要新 Schema 主版本和独立迁移，不能在同一版本静默扩义。

## 8. G3 生产验收与分阶段实施

| 事项 | 主责 | 可检验证据 |
|---|---|---|
| 兼容接入修正 | AEEIS | 第 3 节缺字段/单位/汇率时间/能力/来源待办完成或在支持范围内明确拒绝；不把 fixture 当真实供应商验收 |
| 正式目录及快照 | Planprice | 实际全量读、历史重取、摘要一致、版本不复用、保留与权限检查；过期当前目录 503 |
| Bearer 与健康 | 双方 | 有效/错误/缺失 token、ready 401/403、live 匿名最小响应、过期 ready 503、日志无 token |
| 管理写接口隔离 | Planprice | 独立 host、公开写 405、默认凭证删除、目录 token 无管理权、更新作业与轮换正常 |
| 路由与 Model Pin | AEEIS | offering 到 requestModel/endpoint 的实际调用验证，预算缺价拒绝，重启恢复及映射变化拒绝 |
| 缓存与异常 | 双方 | 304 不延有效期、授权前置、429 退避、故障不写空目录、过期 FX 不选模 |
| 真实运行 | AEEIS | 固定测试模型的普通 Run、web-search/web-fetch、usage 和 RSI 相关路径验证；fixture 结果单独列示 |

实施顺序：先完成兼容接口梳理与 G1；再共同交付 G2 附件；随后开发正式目录与 AEEIS 适配、部署隔离并完成 G3。签名、区域服务等级、服务端分页和运营通知在后续增量中单独评估，基础 Bearer/管理隔离不能推迟到已投产之后。

## 9. 本轮收敛记录与待决交付事项

v0.4 对评审九项意见的处理：唯一 HTTP 映射；G1/G2/G3 分离及附件清单；健康鉴权与过期固定；全量目录消除分页 digest 冲突；完整 FX、舍入、单项价格拒绝与 JCS 固定；versionStatus/provenance；origin/none 语义统一；兼容字段与适配器事实纠正；offering→requestModel 映射及滚动模型保证边界。评估结论为 **G1 MRD review passed**，没有新的 G1 阻塞项。

在本 MRD 初版发布时，后续按 G2/G3 推进：交付并签署 OpenAPI、JSON Schema、digest/FX 测试向量、fixture 和迁移附件；实现并验收 Bearer 与管理 origin 隔离；确认目录/管理 origin、测试凭证、套餐 conditions 枚举；补充 `catalogVersion` URL-safe 规则和 runtime evidence 格式。实际实施结果已在第 10 节回填。若后续发现本文条款互相矛盾、无法实现或责任缺失，再回到 MRD 修订。

## 10. 实施验收回填（2026-09-24）

本节记录本 MRD 对应的实现结果；原有第 3～8 节仍是需求、协议和验收标准的
正式来源，生产证据明细见 `planprice-g3-status.md`。

- **G2：技术评审通过。** OpenAPI、8 个 JSON Schema、digest/FX 向量、兼容与
  正式 fixture、迁移语义和 release manifest 已交付；`npm run g2:validate`
  通过。
- **G3：Planprice 集成门通过（2026-09-24）。** 正式目录和历史快照、Bearer
  读鉴权、ready/live 健康语义、公开写接口隔离、`304`/429/过期处理、
  offering 到 `requestModel`/endpoint 映射、Model Pin 恢复校验、真实普通 Run
  以及真实 web-search/web-fetch Run 均已完成生产证据。
- **快照保留：** VPS 已启用 90 天清理服务和 timer，精确边界测试通过；当天
  生成的快照不能冒充已经存活 90 天，首个可观察日期为 `2026-12-23`，后续由
  运维记录补充。
- **RSI 范围：** RSI proposal/evaluation/activation 的本地与 Compose 验证已
  通过；生产独立 RSI evaluator 尚未对外暴露，故不把 fixture 结果写成真实
  生产 RSI 证据。该项作为 AEEIS 自身的后续运维门跟踪，不阻塞 Planprice
  catalog/pricing 集成门。

### 最终上线回填（2026-09-24）

最终生产抓取由 run `36027095244` 完成。Moonshot（4 个价格）、智谱（4 个
价格）、XycAi、Anthropic 和 Mistral 均成功；OpenAI 受到上游 Cloudflare
挑战时沿用最后一次正确快照，没有把不完整数据发布出去。整次抓取错误数为
0，符合“失败时保留最后正确目录”的约定。

本次发布的 v1 目录证据为：

```text
catalogVersion=cat_20260924162744_d7769a437f5e
digest=sha256:12a4072df69fffd8f0c7e718f5185643d29e0054aff53507a5b51d2d0eda794
offerings=587
fxQuotes=6
expiresAt=2026-09-24T22:27:44.341Z
```

生产审计结果为 `0 critical`（251 条 warning，均不阻塞上线）。线上健康检查
`https://aiplans.dev/api/health` 返回 HTTP 200，内容为
`{"status":"ok","database":"ok"}`。因此，Planprice 的 G3 生产集成门已有
完整上线证据；每日 6 次的 systemd 调度保持不变。

### 定时 VPS 抓取复验（2026-09-25）

部署后的第一轮完整 VPS 日常抓取已在 `ubuntu@100.86.48.56` 上直接复验。
`planprice-scraper.service` 返回 `Result=success`、`ExecMainStatus=0`，并在
发布目录后正常结束。审计、Arena、benchmark、coding-agent 和目录发布步骤均
完成；plan kind 回填仍有非阻塞 warning，因此继续沿用上一版 selector。

本轮发布了更新后的不可变目录：

```text
catalogVersion=cat_20260924164825_04e343e79cd7
digest=sha256:5631f9e1391d66c62527660cd901407b0903137bf49f16ec0a4a9225385ae870
offerings=587
fxQuotes=6
expiresAt=2026-09-24T22:48:25.306Z
```

VPS 上同时保留了带时间戳的快照和 `current.json`。`planprice-api-scraper.timer`、
`planprice-scraper.timer` 与 `planprice-snapshot-cleanup.timer` 均为 enabled；
API 抓取继续使用每日 6 个窗口（Asia/Singapore 的 `01,05,09,13,17,21:15`），
日常全量刷新和 90 天清理也保持启用。

在 `2026-09-24T16:51:04Z`，带 Bearer 的生产请求对
`/v1/health/live`、`/v1/health/ready`、`/v1/catalog/models` 和
`/v1/exchange-rates` 均返回 HTTP 200；ready 报告
`database.ready=true`、`catalog.ready=true`，且目录版本和未过期时间与上面一致。
生产 API 容器内的 `npm run g3:preflight` 也通过，configuration、ready 和
catalog 三项均为 true；live adapter smoke 通过，选中
`provider_openrouter/google/gemini-2.5-flash`，Provider health 正常，记录的
目录版本/digest 与上面一致，mapping version 为
`mapping-2-provider-20260924`。生产 AEEIS 数据库仍保留已验收的真实 Run：
`run_9e5e7977-54c4-4dd7-8b05-de6c0b177318` 为 `succeeded`、3 个 artifact、
review 为 `accepted`；`run_094a086e-75b2-45e8-88aa-4c5f48541730` 同样为
`succeeded` 且 review 为 `accepted`，并持久化了 `web-search` 与 `web-fetch`
receipt。这次复验补齐了 Planprice G3 的定时刷新上线证据。
