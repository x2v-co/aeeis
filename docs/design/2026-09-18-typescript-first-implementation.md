---
title: AEEIS TypeScript-first 实现决策
status: implementation-decision
created: 2026-09-18
tags: [aeeis, typescript, architecture, rust, implementation]
---

# AEEIS TypeScript-first 实现决策

## 决策

Phase 0–1 全部使用 TypeScript，后续根据真实 profiling 结果决定是否把局部性能敏感模块迁移到 Rust。

```text
Node.js + TypeScript
React + TypeScript
Temporal TypeScript SDK
PostgreSQL + pgvector
JSON Schema / TypeBox 或 Zod
```

## 原因

AEEIS 当前最大的风险是任务模型、Brain 权限、Context Manifest、Temporal 长时运行、多 Agent 协议和用户价值是否成立，而不是 CPU 性能。统一 TypeScript 可以减少跨语言接口、构建和调试成本，更快获得真实运行数据。

模型调用、外部 API 和 Temporal 等待通常不会因为 Rust 获得显著收益。Rust 应在确认本地 Agent、Sandbox、Connector、文件解析、索引、加密或资源隔离存在实际瓶颈后再引入。

## 代码边界

```text
packages/contracts       协议、JSON Schema、事件类型
packages/domain          Goal、Task、Grant、Plan、Receipt 状态机
packages/agent           Planner、Context、协作与竞争
apps/api                 API 与权限入口
apps/worker              Temporal Workflow / Activity
apps/web                 DAG、Timeline、运行状态界面
packages/integrations    toolkit_new、ownhow、planprice、渠道适配
packages/evaluation      Replay、Holdout、RSI 评测
```

Temporal Workflow 只处理确定性编排；模型、数据库、工具和外部 Agent 调用放到 Activity。领域模型与基础设施适配分离，避免业务规则绑定 Node.js API。

## Rust 引入条件

只有在 profiling 证明以下问题之一成立时，才引入 Rust：

- 本地常驻 Agent 的 CPU 或内存占用过高；
- 高并发 Connector 或 Sandbox 成为瓶颈；
- 大规模文件解析、索引或加密影响延迟；
- 执行节点需要更强资源隔离；
- 进程启动时间或资源上限影响用户体验。

跨语言边界使用 JSON Schema 或 Protobuf，并通过版本化兼容性测试，使未来的 Rust Process、WASM 或 gRPC Service 可以替换局部模块而不改变 AEEIS 核心语义。

## 当前反目标

不做全 Rust，不为了语言性能提前拆分服务，也不以“以后可能需要 Rust”为理由引入跨语言复杂度。先完成产品闭环和真实运行数据，再根据证据优化。
