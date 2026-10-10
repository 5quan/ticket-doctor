# 自改进交付 A：材料与标准（进行中）

> 对应方案：`docs/self-improvement-implementation-plan.md` §4（材料）、§6（协议）、§12 交付 A。
> 状态：材料转换、冻结目录核对、案例装配（case-v2/truth-v2）、暂定 rubric、数据集 builder 已完成；
> **rubric 未经人工复核、案例未准入（qualified）、未导入 Langfuse、未运行真实模型**。

## 1. 已完成

方案 §4.3：现有 `FileLogSource` 只接受「每服务一个 `.log`，每行 `时间\t级别\t正文`」；直接放 NDJSON 会被忽略。因此先做保真转换，再装配协议。

| 模块 | 作用 |
|---|---|
| `src/evolve/materials/convert.ts` | NDJSON → 每服务 `.log`：原 `timestamp`/`severity`/`msg` 原样，附加字段（`trace_id`/`http.route`/`stack`…）按键排序入消息，多行折叠单行；逐行记录原始 NDJSON 行号；非法行整体失败 |
| `src/evolve/materials/catalog.ts` | 读冻结清单 `fixtures/research/rsi-bootstrap/manifest.json`，核对 92 文件 sha256/字节，检查 split 卫生（同 family 不跨 split），首批 `rcb-001/004/007` |
| `src/evolve/materials/materialize.ts` | 物化到 `data/evolve/rsi-bootstrap/<caseId>/round-1/logs/`，写 `mapping.json`、`materials.json` |
| `src/evolve/materials/rubrics.ts` | 三例的**暂定**私有 rubric（`provisional=true`）：允许结论、必需事实、禁用断言、证据需求、回写要求 |
| `src/evolve/materials/build-cases.ts` | 装配 `prediagnosis-case-v2` + `prediagnosis-truth-v2`（`data/eval-v2/public|private/<caseId>`），合并 catalog，写 `cases-manifest.json` |
| `src/evolve/materials/dataset.ts` | 通用数据集 builder：**只纳入 admitted**，其余显式跳过（当前 0 条） |

协议扩展（本次新增）：

- `CaseSplit` 增加 `train` / `validation`（保留原有 `development/holdout/engineering`）。
- `SourceTier` 增加 `public_simulated`（公开模拟／重建材料），与 `synthetic_engineering`、`reproduced_history` 区分。
- `validateCaseDescriptor(..., { requireAdmitted })` / `loadCase(..., { requireAdmitted })`：默认仍要求非工程案例 `admitted`；只有制作侧校验草稿才传 `requireAdmitted:false`，**运行路径不放宽**。

隔离边界（方案 §4.3）：

- Agent 可见日志视图**只含 `<service>.log`**；`mapping.json` 在同级 `round-1/` 之外，私有 rubric 与 `root-cause.md` 在 `private/`。
- 变更 diff、部署、flags、metrics、traces、patterns 只登记为归档附件 `readable=false`，不进日志视图。
- 首批 `rcb-001`、`rcb-004`（train）与 `rcb-007`（validation）；全部 `reviewStatus=needs-review`、`admission=qualified`、`review.provisional=true`。

## 2. 命令

```bash
npm run evolve:materials:verify                 # 核对冻结包 hash 与 split 卫生（只读）
npm run evolve:materials:convert                # 转换首批 3 例
npm run evolve:materials:convert -- --all       # 全部 9 例
npm run evolve:materials:build                  # 装配 case-v2/truth-v2 + catalog + 数据集清单
```

输出：材料在 `data/evolve/rsi-bootstrap/`，协议案例在 `data/eval-v2/`（`data/` 已被 gitignore，可重建）。

## 3. 尚未完成

1. **人工复核 rubric**：当前为 AI 起草（`provisional`），需人工确认事实、因果与允许结论后才可置 `admitted`；未复核不得用于质量结论或发布门禁。
2. **准入**：`candidate → qualified → admitted`；需人工复核记录与批准清单。
3. **Langfuse 导入**：`buildBootstrapDataset` 已能产出 admitted 案例的 dataset item（`ticket-doctor-rsi-bootstrap-v1`），但尚未推送/同步到服务器。
4. **多轮 / 补证 / 反证材料**：首批为单轮 log-only；方案 §4.4 的 FastAPI 历史故障与多轮材料未做。
5. **隔离**：holdout 材料仍在同一 checkout；正式搜索 job 需要独立读取授权，现有目录划分不构成进程权限隔离。

## 4. 限制

- 案例包是公开模拟／重建材料，应用内 commit 为虚构替身、diff 不是完整源码 checkout；不能据此声称真实生产根因或代码 SHA 核验能力。
- 本轮只做日志-only 基线准备；metrics/traces/attachments 未开放读取，相关评分项为不适用。
- 未发起真实模型调用；优化器未实现。
