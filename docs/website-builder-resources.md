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

验收入口见 [`docs/verification-matrix.md`](verification-matrix.md)。
