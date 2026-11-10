# 文档目录与接手路线

> 最后同步：2026-11-10。当前暂停功能开发；工程实现、待验收项与历史方案分开阅读。易变事实以 [状态源](status.json) 为准，当前源码优先于时点设计稿。

## 从哪里开始

| 目的 | 阅读入口 |
|---|---|
| 了解项目与启动方式 | [项目 README](../README.md)、[产品使用](usage.md) |
| 暂停后恢复开发 | [会话交接](session-handover.md)、[开发者上手与代码地图](contributor-onboarding.md)、[交接规程](handover.md#七交接规程) |
| 查看做了什么、还差什么 | [开发状态](status.json#development)、[路线图](roadmap.md)、[开发 backlog](backlog.md) |
| 接续自改进主路径 | [自改进交接](self-improvement-handover.md)、[自改进状态](status.json#self_improvement)、[GEPA 适配器说明](../tools/evolve/README.md) |
| 服务器换机与数据保留 | [资源与迁移清单](deployment-inventory.md)、[Langfuse 运维手册](self-host-langfuse-runbook.md) |

当前恢复顺序是依赖与环境复验、材料重建、搜索保障、真实 GEPA 搜索、固定候选后的独立验收、人工审核发布或保留基线。C 的适配器已经实现，真实搜索仍未执行；工程接入和历史测试不能代替真实效果验收。

## 状态、清单与决策

- [状态源](status.json)：版本、测试静态数量、迁移头、功能、自改进与暂停状态。
- [会话交接](session-handover.md)：当前暂停快照、本机验证限制和恢复步骤。
- [项目交接与规程](handover.md)：目标、已实现能力、长期边界和收尾约定。
- [开发者上手](contributor-onboarding.md)：环境准备、代码目录、开发入口。
- [路线图](roadmap.md)：阶段与下一步顺序。
- [开发 backlog](backlog.md)：保留任务编号的逐项状态及验收条件。
- [后续技术方案](handover-technical-plan.md)：已实施记录和剩余工作的方案；历史草案需结合当前代码阅读。
- [问题与决策](open-questions.md)：已经确认的约束与决策历史。

## 产品、接入与架构

- [产品使用](usage.md)、[飞书接入](feishu-channel.md)、[飞书触发设计](feishu-trigger-design.md)。
- [Go 适配器](../adapters/go/README.md)、[长连接设计](adapter-longconn-design.md)：长连接已实现，真机验收仍待完成；钉钉/Slack 仅骨架。
- [Host/Runner](host-runner-design.md)、[接口与协议](interface.md)、[并发设计](concurrency.md)。
- [会话持久化](session-log-design.md)、[证据 UID 与恢复](evidence-uid-design.md)。
- [可靠性说明](interview-reliability.md)：用于理解租约、恢复和投递边界。

## 观测、部署与备份

- [Langfuse 运维手册](self-host-langfuse-runbook.md)、[部署说明](../deploy/langfuse/README.md)。
- [观测实施记录](langfuse-observability-implementation-plan.md)、[官方 tracing SDK 迁移记录](langfuse-sdk-migration.md)。
- [资源与迁移清单](deployment-inventory.md)：代码、运行数据、密钥、服务与迁移步骤。
- [迁移导出脚本](../scripts/migrate-export.sh)、[迁移恢复脚本](../scripts/migrate-restore.sh)：脚本已入库，不代表已经导出服务器数据。

GitHub 保存源码、锁定依赖清单、冻结材料、复核记录和文档；密钥、数据库、运行产物及 Langfuse 服务端数据需另行保留。含密钥的迁移包走加密通道，不提交 Git。

## 当前评测与自改进

- [离线评测 MVP 工作单](eval-implementation-plan.md)：现有 `src/eval/` 和 `npm run eval` 等入口。
- [Langfuse 原生评测实施记录](langfuse-eval-implementation-plan.md)：现有 `src/eval/lf/`；语义人工复核仍有待办。
- [自改进交接](self-improvement-handover.md)：恢复时首先阅读。
- [GEPA 自改进实施方案](self-improvement-implementation-plan.md)：A–F、搜索、验收及人工发布边界。
- [A 材料与标准](self-improvement-materials.md)、[B 评测桥梁](self-improvement-bridge.md)。
- [冻结基线](self-improvement-baseline.md)、[冻结搜索配置](self-improvement-search-config.md)。
- [C 适配器与命令](../tools/evolve/README.md)、[Linux 环境安装脚本](../scripts/evolve-env-setup.sh)。
- [冻结案例来源与许可](../fixtures/research/rsi-bootstrap/README.md)、[复核记录约定](../evolve/reviews/README.md)。

自动优化只允许修改 `diagnosis_rules`。基础 prompt、工具、材料、答案与评分器冻结；holdout 留给候选固定后的独立验收。当前预算仍为监控模式，完整 D 发布回滚、语义裁判校准及 E 真实案例仍待完成，F 有限回放延后。

## 历史设计与被取代的方案

| 文档 | 阅读边界 |
|---|---|
| [旧评测设计](eval-design.md) | 旧 v1/v2 harness 已移除；历史成绩不代表当前实现或质量 |
| [早期规则迭代协议](evolve-protocol.md) | 条目化/delta 等方向记录；当前 GEPA 第一版仅优化规则全文 |
| [预诊断评测背景方案](pre-diagnosis-evaluation-plan.md) | 自改进前的方案背景，路径和状态需以现有实现核对 |
| [早期证据作用域设计](evidence-scope-design.md) | 已由稳定 UID 与两阶段提交方案吸收，以证据 UID 文档和代码为准 |

新增文档同步本目录；易变事实先更新状态源，再同步 README、清单与交接入口，并运行文档检查。
