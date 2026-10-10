# 自改进启动案例包（本地评审草稿）

已冻结 RootCauseBench 的九条原始资料及 oracle，供 ticket-doctor 自改进方案的数据适配、评分设计与人工审查使用。**当前不是 ticket-doctor 可直接执行的 benchmark，也未进行真实模型评测或导入 Langfuse。**

来源：[edgedelta/root-cause-bench](https://github.com/edgedelta/root-cause-bench)，固定 commit `c2f9b4aae67b092803c7c7d85e3e27facb528f0f`。资料适用 Apache-2.0，保留 [LICENSE](LICENSE) 与 [上游原始 README](upstream-README.md)。派生中文任务由公开告警字段生成，转换来源写入 [manifest](manifest.json)。

这些资料属于公开模拟／重建事故。应用内 service、host、commit 标识为虚构替身，diff 不是完整源码 checkout；不能用于宣称真实生产根因、代码 SHA 核验或全仓库检索能力。

## 布局

```text
public/rcb-001/...          原始告警、日志、指标、trace、变更资料
private/rcb-001/...         原始 ground_truth，只有评分侧可读
tasks/rcb-001.json          派生中文工单，不含答案及故障家族名
manifest.json              来源、split、hash、转换记录（控制器侧）
LICENSE                    原始 Apache-2.0 许可证
upstream-README.md         原始来源说明（不能交给 Agent）
```

每个 case 只开放自己的公开资料；整个包、private、manifest 和 README 都不能整体挂载给 Agent。候选生成模型只读取训练反馈；搜索控制器调用 validation 评测用于择优；holdout 在候选固定后由独立验收流程读取。路径分目录并不自动提供进程权限隔离，后续实现必须做读取白名单或独立挂载。

这个仓库里的本地资料包尚未隔离 holdout。正式搜索环境只能获得净化后的代码与 train／validation 制品，不能获得包含完整材料的 checkout 或 Git 历史；保留材料由另一验收 job 授权读取。现有可信 harness 持有 truth，也不代表已完成独立评分进程隔离。

## 用途分配

| ID | split | 原始场景 |
|---|---|---|
| rcb-001 | train | payment-nil-deref-panic |
| rcb-002 | train | checkout-latency-n-plus-one |
| rcb-003 | train | inventory-connection-pool-exhaustion |
| rcb-004 | train | auth-jwt-validation-regression |
| rcb-005 | validation | recommendation-memory-leak |
| rcb-006 | validation | grpc-deadline-too-tight |
| rcb-007 | validation | dashboard-db-schema-missing-table |
| rcb-008 | holdout | payment-refund-poison-batch |
| rcb-009 | holdout | tls-cert-expiry |

同一家族的派生变体不可跨 split。九例规模只够建立流程和发现明显失败，不足以支持稳定泛化结论；公开数据也不能保证底座模型从未见过。

## 如何使用

1. 校验 manifest 每条 hash，并检查源 commit 与 Git blob hash。保留原件，不编辑 oracle。
2. 把 NDJSON 日志保真转换成现有 FileLogSource 的每服务 `.log` 格式；记录原件行号映射。首个基线日志-only，提交 diff 先存档，未开放读取的内容不评分；后续需实现明确的只读附件入口及引用协议。
3. 先以训练资料制作评分正反例；人工检查原 oracle、派生必要事实及反证。当前 `reviewStatus` 为 needs-review，不代表标准已审定。
4. 审定后按实际可见资料指定允许判断深度。若没有读取指标／trace 的工具，这些证据相关评分项必须不适用，不能根据私有答案要求 Agent 猜出来。
5. 完成适配与隔离后，再生成现有 eval 数据协议和 Langfuse dataset；不能直接把这里的任务 JSON 当成已有 schema。

实施细节见 [技术方案](../../../docs/self-improvement-implementation-plan.md)。本包未包含 solution 脚本，也没有执行上游测试或 Docker 环境。
