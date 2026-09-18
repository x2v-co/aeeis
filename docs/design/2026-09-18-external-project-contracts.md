---
title: AEEIS 外部项目接口契约
status: proposed-architecture
created: 2026-09-18
tags: [aeeis, toolkit-new, ownhow, planprice, temporal, contracts, integration]
---

# AEEIS 外部项目接口契约

## 总原则

外部项目提供能力平面，AEEIS 保持任务和语义控制平面。所有接口都以稳定 ID、版本、来源、授权和 Receipt 为核心，不允许通过数据库直连共享内部表。

## toolkit_new

### 提供

- Tool Registry 与 Tool manifest；
- Connector、Sandbox 和 Artifact；
- Capability 定义与工具执行；
- Tool Receipt、成本、延迟、错误和副作用记录。

### AEEIS 发送

- `task_id`、`run_id`、purpose；
- 输入 Artifact 引用和 Context Manifest；
- AEEIS 已批准的 Capability 引用；
- idempotency key、预算和超时。

### AEEIS 接收

- schema 化输出、Artifact 引用和 Tool Receipt；
- `completed / failed / unknown` 状态；
- 外部副作用的 verification 结果。

AEEIS 负责判断该 Tool 结果是否足以推进业务任务、是否写回 Brain/Task，以及是否需要人工审批。

## ownhow

### 提供

- Skill / Method 的发现、解析和版本信息；
- Receipt、Proposal、Apply、Rollback 机制；
- 方法的依赖、适用范围和变更记录。

### AEEIS 负责

- 根据 Goal、Context、Profile 和历史表现选择方法；
- 把用户纠正和真实 Outcome 形成 Personal Skill Profile；
- 运行 replay、holdout、安全和成本评测；
- 决定候选保持私有、提交团队版本，或申请公共版本晋升。

一次 Receipt 或 Proposal 不能自动改变 AEEIS 的运行版本；Apply 必须绑定授权、版本和回滚点。

## planprice / aiplans.dev

### 提供

- Model、Provider、价格和计费单位；
- Benchmark、上下文限制、能力标签；
- Availability、区域和时间信息。

### AEEIS 负责

- 依据任务质量、隐私、延迟、预算、可用性和历史表现做 Model Decision；
- 记录候选模型、最终模型、路由理由、fallback 和预算消耗；
- 在相同 Skill/Profile/Eval 上重新验证新模型；
- 不把目录中的 benchmark 当作真实任务保证。

Model Catalog 数据变化不能悄悄改变已启动 Run；长时任务使用启动时锁定的 Model Decision，除非明确触发迁移策略。

## Temporal

Temporal 仅承担执行耐久性：Workflow、Activity、Timer、Signal、Retry、Heartbeat、Child Workflow、Continue-As-New 和 Worker Versioning。AEEIS 将 Run、Step、Checkpoint、Approval、Evidence 和用户可见状态映射到 Temporal，但不把 Temporal History 当作业务数据库。

## 外部任务与知识系统

外部任务系统只通过投影 API 或事件同步 Goal/Task 的允许字段；外部知识系统只通过 Connector 产生 Source/Claim/Artifact 引用。AEEIS 负责授权过滤、规范化、版本、撤销、引用和写回。

当前实现将知识系统抽象为 `KnowledgeProvider`：Provider 只返回带 classification、source、content hash 和 score 的知识记录，Context Manifest 再按 audience 和允许分类形成最小上下文。AEEIS 不把 Provider 返回的内容当作指令；真实向量索引（如 pgvector）可以替换 Provider，而不改变任务、授权和 Evidence Graph 语义。

## 统一 Receipt 要求

所有外部调用都返回可验证 Receipt，至少包括：

```text
receipt_id
provider / component
request_hash / response_hash
input_refs / output_refs
capabilities_used
started_at / completed_at
status
cost / latency
schema_version
```

Receipt 是 Evidence Graph 的节点，也是 RSI 评测和争议调查的输入。

## 失败与升级

接口需要区分：协议不兼容、权限拒绝、限流、瞬时失败、业务失败、数据冲突、状态未知和安全拒绝。AEEIS 根据错误类型决定 retry、补偿、人工审批或停止；不能把所有错误都包装成统一的自然语言失败。
