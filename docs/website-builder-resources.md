# Plugin、Skill、Workflow 与 Tool 的版本治理

这份约定用于 AEEIS 接入 Toolkit/OwnHow 资源，当前以 `website-builder/1` 为首个完整闭环。它解决三个问题：一次 Run 到底使用了哪些资源、资源升级怎样进入新 Run、升级失败怎样安全回滚。

## 资源边界

```text
Plugin
 ├── Skill（Agent 的行为规范）
 ├── Workflow（可执行步骤和输入输出）
 └── Tool references（Toolkit 的实际能力）
```

Plugin 是安装、分发和命名空间单位；Skill 描述 Agent 如何工作；Workflow 描述步骤、依赖、输入输出和验收条件；Tool 执行读写、搜索、Shell、Process 或外部 API。用户或组织的 Personal Method 只能作为 OwnHow Overlay 保存，不能改写上游 Plugin/Skill 原文。

每个资源同时有语义版本和接口版本。语义版本用于发布与升级，接口版本用于判断能否组合。例如 `website-builder@1.2.0` 可以实现 `website-builder/1`，`website-builder@2.0.0` 应实现新的 `website-builder/2`，不应静默替换旧接口。

## Manifest、Lockfile 与 Run 快照

发布 Manifest 使用兼容范围，便于维护者表达意图；运行时必须把范围解析成一个具体版本和内容 digest。一个资源声明可以写成：

```json
{
  "requires": {
    "skills": [{ "id": "website-builder", "range": "^1.0.0", "interface": "website-builder/1" }],
    "workflows": [{ "id": "website-build", "range": "~1.2.0", "interface": "website-build/1" }],
    "tools": [{ "id": "read", "range": "^3.0.0", "interface": "read/3", "capabilities": ["workspace.read"] }]
  }
}
```

解析成功后形成签名 Lockfile。Lockfile 至少记录每个 Plugin、Skill、Workflow、Tool 的 `id`、具体 `version`、`interface`、`digest`、发布 `channel`，以及解析器版本。Toolkit 的现有 `toolkit.lock.resolution.v1`、Manifest digest 和 transport overlay 可以继续复用；transport overlay 只能改变镜像或传输地址，不能覆盖版本、digest、权限或依赖。

AEEIS 在创建 Run 时保存 `resourceSnapshot`：

```json
{
  "plugin": { "id": "aeeis.website-builder", "version": "1.0.0", "interface": "aeeis.website-builder/1", "digest": "…" },
  "skill": { "id": "website-builder", "version": "1.1.0", "interface": "website-builder/1", "digest": "…" },
  "workflow": { "id": "website-build", "version": "1.2.0", "interface": "website-build/1", "digest": "…" },
  "tools": [
    { "id": "read", "version": "3.0.4", "interface": "tool/read/1", "digest": "…" },
    { "id": "write", "version": "3.1.2", "interface": "tool/write/1", "digest": "…" }
  ],
  "lockfileDigest": "…",
  "policyDigest": "…",
  "resolverVersion": "aeeis-resource-resolver/1",
  "resolvedAt": "2026-09-28T00:00:00.000Z"
}
```

`allowedTools` 仍然是授权入口。请求中的 `resources.tools` 只能和 Toolkit 已批准的工具版本、digest 完全一致，不能借资源声明提升权限。没有资源注册中心时也可以传入已经解析好的资源引用；AEEIS 会校验它们并冻结快照。旧客户端不传 `resources` 时保持原行为，已有工具和 Skill 快照仍按旧字段保存。

## 解析和执行顺序

```text
discover → match → resolve → admission → freeze → execute → verify → receipt
```

1. Registry 发现候选 Manifest，并校验签名、租户和隐私策略。
2. Resolver 按接口版本、语义范围、平台和依赖关系选择唯一组合。
3. Admission 检查工具能力、OwnHow Skill 治理、AEEIS 权限和预算。
4. Freeze 把资源快照、Tool manifest digest、policy digest 写入 Run。
5. Execute 只接受快照中列出的版本；每个 Tool Receipt 绑定版本、能力授权、幂等键和 manifest digest。
6. Verify 在调用前重新读取只读 Manifest。清单 digest 改变时 Run 失败并要求创建新 Run。

## Website Builder Run 合同

首个可运行资源组合为：

```text
Plugin:   aeeis.website-builder/1
Skill:    website-builder/1
Workflow: website-build/1
```

推荐把较长流程拆成 `website-discover/1`、`website-build/1`、`website-qa/1` 和 `website-publish/1`。一个完整 Run 应经历：读取项目结构、修改文件、启动预览、构建或 QA、输出产物。最终 `artifactType` 必须是 `website-builder/1`，结构化结果至少包含：

- `changedFiles`：实际修改过的文件路径；
- `preview`：预览状态和 URL（如果尝试过）；
- `validation`：构建、测试或 QA 的状态；
- `artifacts`：可下载产物路径；
- `blockers` / `unknowns`：未完成或无法核验的部分；
- 每一项都引用实际观察到的 source、Tool Receipt 或依赖 Artifact。

只有 Runtime 真实收到 Tool Receipt、产物文件或预览状态时，Run 才能宣称对应动作完成。模型说“已完成”不能代替执行证据。

## 升级、发布和推送

升级采用四阶段通道：`dev → canary → beta → stable`。

1. **Publish**：构建不可变 Artifact，生成 Manifest、SBOM、签名和 digest。提升接口版本或删除字段必须增加 major 版本。
2. **Resolve candidate**：在隔离环境中把候选版本和依赖解析成 Lockfile，检查 Skill/Workflow/Tool 接口、权限和平台兼容性。
3. **Evaluate**：运行 replay、holdout、回归、权限边界和 website-builder smoke；检查真实 Tool Receipt、预览、验证和产物。失败候选停留在 `proposed`，不能进入流量。
4. **Canary/approval/promotion**：先进入 canary，观察错误率、unknown/reconcile、预算和产物质量；经负责人显式批准后晋升 beta 或 stable，并推送签名 Registry index。推送内容应包含变更摘要、依赖 Lockfile digest、验证 Run IDs、回滚目标和生效时间。

稳定通道只改变“新 Run 的默认解析结果”。正在运行的 Run 永远使用自己的 `resourceSnapshot`；升级不会修改旧 Run 的 Skill、Workflow、Tool、权限或 transport。要复现实验，直接使用旧 Lockfile digest 创建 Run。

## 回滚和撤销

回滚是一次新的发布或通道指针变更，不能删除历史版本：

- 一般回滚：stable 指针回到上一个已验证 Lockfile，停止新候选流量；旧 Run 继续完成。
- 安全撤销：从 Registry 标记版本 revoked，阻止新 Run 解析；仍在执行的 Run 按安全策略暂停或隔离，禁止静默换版本。
- Tool unknown：沿用同一幂等键执行 reconcile；不能因为升级而重发或换 Tool 版本。
- OwnHow Skill 回滚：生成新的 Skill 版本或 Overlay，保留原始版本和 Correction/Proposal/Approval/Activation 链。

每次回滚都要有原因、审批人、受影响 channel、旧/新 Lockfile digest 和验证证据，并写入 AEEIS Receipt 与 Brain decision claim。

## Brain 和维护流程

Brain 只保存已批准的治理结论，例如“`website-build/1.2.0` 要求 `read/3` 和 `write/3`，升级前必须通过 preview/build/QA smoke”。Claim 必须带 owner、tenant、scope、classification、kind、content、sourceRefs 和 confidence。Brain 不保存密钥、完整工具输出或未经批准的个人偏好。

建议的日常维护流程：

1. 更新上游 Plugin/Skill/Workflow/Tool Manifest；
2. 在 dev 解析并生成 Lockfile；
3. 运行兼容性和 website-builder Run 验收；
4. 提交文档、Manifest digest、验证报告和 Brain claim；
5. 晋升 canary，观察后再批准 beta/stable；
6. 需要升级时只更新 channel 指针，保留可复现的旧 Lockfile；
7. 发现问题时执行回滚或撤销，生成新的状态记录。

## Registry 的实现边界和匹配规则

上面的 Manifest 和 Lockfile 必须由一个受信任的 Registry 产生。请求方可以提交
兼容范围或已经解析好的引用，但不能自己定义资源的 digest。Registry 至少保存以下
不可变记录：`releaseId`、资源类型和 ID、语义版本、接口版本、内容 digest、依赖范围、
解析后的 Lockfile digest、签名、SBOM、发布者、channel 和状态（`published`、
`revoked`）。同一个 `id@version` 只能对应一个 digest；如果内容变化，必须发布新版本。

解析器按下面的顺序匹配，任何一步失败都拒绝创建 Run：

| 检查 | 规则 | 失败处理 |
| --- | --- | --- |
| 接口 | Plugin、Skill、Workflow 和 Tool 的 interface major 必须与依赖声明完全相同 | `interface_mismatch` |
| 版本范围 | 具体版本必须满足 Manifest 的 semver range；预发布版本只能由相同 channel 请求 | `version_unsatisfied` |
| 依赖 | Workflow 引用的 Skill/Tool，以及 Plugin 的子资源，必须来自同一个解析结果 | `dependency_conflict` |
| 内容 | Registry 返回的 digest、签名和 SBOM 必须与下载内容一致 | `digest_mismatch` |
| 能力 | Tool 的实际 capabilities 必须覆盖 Workflow 所需能力，且是 Run allowlist 的子集 | `capability_denied` |
| 策略 | privacy、租户、平台和 OwnHow runtime 必须通过 admission | `policy_denied` |

因此，Run 创建应是 `resolve(range) → verify(signature) → admission → freeze`。冻结后
只把 Registry 返回的具体引用写入 `resourceSnapshot`，并额外保存
`registryRevision`、`lockfileDigest` 和 `policyDigest`。Runtime 恢复 Run 时重新读取同一个
`releaseId`/digest 做存在性和撤销检查；如果旧 Artifact 已归档，应从内容仓库恢复，不能用
当前 channel 的同名资源替代。若安全撤销策略要求暂停存量 Run，状态应变为 `isolated` 或
`paused` 并生成事件，不能静默换版本继续运行。

## 升级和推送协议

发布工具应该把一次升级作为不可变的 `ReleaseCandidate`，而不是直接覆盖 Registry 文件：

1. 在 `dev` 生成新 Artifact、Manifest、SBOM、签名和候选 Lockfile；校验所有依赖的
   interface、capability 和 policy。
2. 用 replay、holdout、权限边界、Tool Receipt、Website Builder preview/build/QA smoke
   生成带 Run ID 的评测报告。报告和候选 Lockfile digest 一起写入 candidate。
3. 通过带 `expectedRegistryRevision` 的 CAS 推送把候选提升到 `canary`。推送请求必须带
   `idempotencyKey`；重复请求返回原始发布结果，不能产生第二个 release。
4. 观察 canary 的失败率、unknown/reconcile、预算和产物质量后，负责人显式批准提升到
   `beta` 或 `stable`。每次提升都追加审计事件，记录旧/新 channel pointer、审批人、评测
   Run IDs 和生效时间。

`stable` 指针只决定以后新 Run 的默认解析结果。运行中的 Run、重试和 unknown reconcile
始终使用其冻结的 Lockfile 与 Tool version；升级推送不能修改它们。回滚也是一次 CAS
   指针更新，指向上一个已验证的 Lockfile，不删除当前或历史 Artifact。`revoke` 与回滚
   不同：revoke 会阻止新 Run 解析该版本，并按安全策略暂停或隔离仍在运行的 Run。

发布工具至少应提供以下可审计操作：

```text
resource resolve --channel stable --plugin aeeis.website-builder --lock lock.json
resource verify --lock lock.json --registry-revision 1842
resource promote --candidate rc_… --from dev --to canary --expected-revision 1842
resource promote --candidate rc_… --from canary --to stable --approval approval_…
resource rollback --channel stable --to-lock sha256:… --reason incident_…
resource revoke --release release_… --reason security_…
```

每条命令都应返回 `registryRevision`、旧/新 Lockfile digest 和审计事件 ID；这些值写入
AEEIS 的发布 Receipt，并作为后续 Brain decision 的证据。这样可以在服务升级、推送失败或
多实例并发发布后，依据同一个 revision 和 Lockfile 重放、恢复或回滚。

当前 Runtime 提供 `InMemoryResourceRegistry` 和 `FileResourceRegistry` 实现。部署时可设置
`AEEIS_RESOURCE_REGISTRY_FILE=/path/resource-registry.json`，文件格式为
`{"schemaVersion":"resource-registry/1","revision":"…","manifests":[…]}`。
Run 创建会调用 `resolve`，把 Registry 返回的 `releaseId`、具体版本和 digest 写入
`resourceSnapshot`；每次规划、执行 Tool、review 和恢复 Run 前都会调用 `verify`。
Registry 中同一 `kind + id + version` 不能有多个 digest，`revoked` release 会拒绝新调用或
继续执行。未配置 Registry 时保留旧客户端兼容模式，但生产环境应启用 Registry 并开启签名
和 SBOM 校验的远程实现。

验收入口见 [`docs/verification-matrix.md`](verification-matrix.md)。
