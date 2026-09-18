---
title: AEEIS 商业化、运营、社区与开源策略
status: proposed-strategy
created: 2026-09-18
tags: [aeeis, commercialization, operations, community, open-source, open-core]
---

# AEEIS 商业化、运营、社区与开源策略

## 总体判断

AEEIS 不应从“再做一个 Agent SaaS”开始，而应围绕一个明确价值建立：

> AEEIS 帮用户持续推进真实项目，并且越使用越懂这个用户，同时保留 Brain、任务状态、权限和进化历史的控制权。

因此，AEEIS 的商业、运营、社区和开源策略都应服务于“长期可靠的个人化 Agent”，而不是通用聊天或 Agent 数量。

## 商业定位

现阶段不把 AEEIS 做成独立的通用聊天产品。更合理的产品关系是：

```text
Toolkit：工具供给和开发者入口
AEEIS：有状态、个人化、持续执行层
aiplans.dev：模型与价格基础设施
Brain：用户拥有的长期资产
```

首个商业切入点建议是面向小型 AI 团队、技术负责人、独立开发者和项目负责人的“项目持续推进 Agent”，覆盖：

- 持续读取文档、代码、任务和消息；
- 生成项目状态、风险和阻塞；
- 自动拆解、跟进和提醒任务；
- 等待外部事件后继续执行；
- 发起审批；
- 生成日报、周报和决策记录；
- 学习用户的工作方式。

用户购买的不是“自进化”或“多 Agent”概念，而是减少重复解释、减少人工跟进和降低项目失控概率。

## 商业阶段

```text
Dogfood
  → Design Partner
  → Private Preview
  → Product
```

| 阶段 | 目标 | 商业形态 |
|---|---|---|
| Dogfood | 验证真实任务是否持续产生价值 | 不收费 |
| Design Partner | 与少量真实团队共同打磨 | 付费试点或服务合同 |
| Private Preview | 固定场景、邀请制扩张 | 订阅制 |
| Product | 稳定产品与生态 | Pro、Team、Enterprise |

进入付费试点前，至少需要证明一个场景能连续稳定运行，显著减少人工跟进或重复解释，迁移给多个相似用户，并且任务失败、审批、恢复和回滚可解释。

## 产品与收入结构

### 产品层级

1. **个人 Pro**：个人 Brain、项目 Agent、有限长时任务、模型路由和跨渠道入口。
2. **Team**：共享 Room、团队任务 DAG、多 Agent 协作、审批、审计和团队 Skill。
3. **Enterprise / Private**：私有部署、数据边界、SSO、合规、专属连接器、SLA 和管理控制台。

### 收入来源

- 基础订阅；
- 活跃项目或 Agent 额度；
- 模型与工具实际成本的透明传导；
- 私有部署和托管服务；
- 连接器、Skill 和企业工作流定制；
- 认证、评测和治理服务；
- 后期的生态分成。

不以“每条消息”作为主计费单位。用户购买的是持续任务能力和长期资产，模型成本可以单独透明呈现。

## 运营模型

AEEIS 的运营重点是 Agent Operations，而不是传统客服。早期需要建立五条闭环：

1. **运行运营**：监控长时任务、失败、阻塞、审批、unknown 状态和外部系统异常；
2. **质量运营**：分析 Run Receipt、用户纠正、人工接管和最终结果；
3. **成本运营**：管理模型、Tool、存储、任务时长和外部 Agent 成本；
4. **信任运营**：处理权限、撤销、隐私事件、Agent 声誉和结果争议；
5. **进化运营**：将失败归因到 Brain、Skill、Tool、Model 或 Workflow，再进入评测和回滚流程。

建议固定复盘节奏：每周复盘真实任务失败和人工接管，每周审核高风险权限和外部 Agent，每月评估模型/Skill/Tool 版本表现，每月确认哪些能力可以自动化以及哪些必须保留人工审批。

## 社区策略

AEEIS 不先建立泛泛的“AI Agent 社区”，而围绕下面的主题建立社区：

> 如何让长期运行的 Agent 可靠地完成真实工作，并且能够解释、恢复和持续改进。

社区分为四层：

1. **Dogfood 用户组**：分享任务案例、失败和使用反馈；
2. **Design Partner Council**：参与产品方向、权限设计和商业验证；
3. **Builder 社区**：开发 Skill、Connector、Workflow 和 Evaluator；
4. **研究与协议社区**：讨论 Agent 协作、任务协议、Receipt、评测和开放世界信任。

适合共享的是脱敏后的 Skill、Workflow 模板、Eval 格式、Connector、任务协议、失败模式和解决方案。个人 Brain、项目原文、私有任务和运行上下文默认不进入社区。

社区增长飞轮：

```text
真实任务
→ 稳定工作方法
→ Skill / Workflow / Eval
→ 社区复用
→ 更多真实运行
→ 更好的工具与治理
```

## 开源策略

采用“协议优先、核心渐进开放、托管能力商业化”的 Open Core 路线。

### 适合开放

- AEEIS Agent Protocol；
- Agent Card、Task Brief、Context Pack、Result Envelope；
- Capability Manifest 和 Receipt Schema；
- Brain Schema 与导出格式；
- 本地运行器和 CLI；
- DAG 可视化组件；
- Eval Harness；
- Connector SDK；
- 基础 Skill/Workflow 示例；
- 协议兼容性测试套件。

### 适合商业化

- 托管版 Control Plane；
- 多租户身份、授权和企业策略；
- 托管 Brain Relay；
- 高级模型路由和成本优化；
- 企业级审计、合规和 SSO；
- Agent 声誉、发现和计费网络；
- 高级 Eval、RSI 管理和自动晋升；
- 托管连接器与运营服务。

开源的目的，是建立信任、降低迁移成本、吸引开发者，并让 AEEIS 协议成为生态入口。用户应能导出自己的 Brain、Task、Receipt 和 Artifact，避免被托管服务锁定。

## 开放顺序与仓库定位

```text
内部验证协议
→ 发布 Schema 和示例
→ 发布本地 SDK / Reference Runtime
→ 建立 conformance test
→ 吸引 Connector / Skill 贡献
→ 再决定是否开放更多 Runtime
```

GitHub 仓库 `https://github.com/x2v-co/aeeis` 作为公开的设计与协议仓库启动。当前仓库的主要内容是设计文档、协议草案、领域模型和开放路线，不暗示已经具备生产可用的 Agent Runtime。

仓库贡献以 RFC、Issue、协议示例、评测用例和 Connector/Skill 提案为主。私人 Brain 数据、客户任务、未经脱敏的运行日志和内部凭证不得进入仓库。

## 当前反目标

- 不先做通用 ChatGPT 克隆；
- 不先做开放 Agent Marketplace；
- 不把“自动进化次数”当作核心指标；
- 不在没有真实需求簇前大规模买流量；
- 不让社区贡献直接进入生产 Skill；
- 不把私人 Brain 数据变成训练或社区资产；
- 不在协议和任务稳定性完成前承诺开放世界自治。

## 成功标准

商业成功不是注册用户数量，而是：

- 一个高频任务在真实用户中持续运行；
- 用户重复解释和人工修改逐步下降；
- 任务失败和审批可以解释、恢复和审计；
- 至少有多个相似用户愿意持续使用；
- 社区贡献可以复用但不会扩大隐私和安全边界；
- 开源协议带来生态使用，托管和企业能力带来收入。
