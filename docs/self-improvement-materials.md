# 自改进交付 A：材料转换（进行中）

> 对应方案：`docs/self-improvement-implementation-plan.md` §4（材料）、§12 交付 A。
> 状态：转换器 + 冻结目录核对已完成；**案例协议装配、私有 rubric、准入与 Langfuse 导入尚未完成**，真实模型基线未运行。

## 1. 本轮完成

方案 §4.3 说明：现有 `FileLogSource` 只接受「每服务一个 `.log`，每行 `时间\t级别\t正文`」；直接放 NDJSON 会被忽略。因此第一项开发工作是**保真材料转换器**。

- `src/evolve/materials/convert.ts`：NDJSON → 每服务 `.log`。
  - 原 `timestamp`/`severity_text`/`msg` 原样保留；
  - 其余字段（`trace_id`、`http.route`、`stack` 等）按键排序附入消息；多行值折叠成单行（` | `），不丢异常关键上下文；
  - 每个输出行记录到原始 NDJSON 行号的映射；任何一行不合法即整体失败（不静默跳过，避免少日志污染评分）。
- `src/evolve/materials/catalog.ts`：读取冻结清单 `fixtures/research/rsi-bootstrap/manifest.json`，核对 92 个文件 sha256/字节、检查 split 卫生（同 family 不跨 split），并提供首批选择。
- `src/evolve/materials/materialize.ts`：把案例物化到 `data/evolve/rsi-bootstrap/<caseId>/round-1/`，写 `logs/<service>.log`、`round-1/mapping.json` 与 `materials.json`（源 hash、逐服务 hash、视图 hash、归档附件 hash）。
- `scripts/evolve-materials.ts` + `npm run evolve:materials:{verify,convert}`。

隔离边界（方案 §4.3）：

- Agent 可见的日志视图**只含 `<service>.log`**；`mapping.json` 在同级 `round-1/` 下，不在日志视图内。
- 变更 diff、部署、flags、metrics、traces、patterns 只登记为「归档附件」且 `readable=false`，不进入日志视图——现有工具没有附件读取入口，保存了不等于 Agent 读到。
- 首批 `rcb-001`、`rcb-004`（train）与 `rcb-007`（validation）；全部案例 `reviewStatus=needs-review`，**未人工审定、未导入 Langfuse、不能直接交给现有 CLI 运行**。

## 2. 命令

```bash
npm run evolve:materials:verify                 # 核对冻结包 hash 与 split 卫生（只读）
npm run evolve:materials:convert                # 转换首批 3 例
npm run evolve:materials:convert -- --case rcb-001
npm run evolve:materials:convert -- --all
```

输出在 `data/evolve/rsi-bootstrap/`（`data/` 已被 gitignore，可重建）。

## 3. 尚未完成（交付 A 其余部分）

1. **案例协议装配**：把材料视图接进 `prediagnosis-case-v2` / `prediagnosis-truth-v2`（`case.json`、逐轮消息、私有 `truth.private.json`），或在控制器侧单独维护 train/validation 清单。需要先定 `split=train|validation` 与 `sourceTier=public_simulated` 的协议表达。
2. **私有 rubric**：按方案 §7.2 为每例起草（可见材料支持的必要事实、最小充分证据、干扰/反证、禁止断言），AI 起草部分标 `provisional`，须人工复核后才能发布质量结论。
3. **准入**：`candidate → qualified → admitted`，人工审定前不得进入正式运行。
4. **Langfuse dataset builder**：按 split 生成数据集，Agent 输入只含公开材料，私有标准留在评分侧。
5. **隔离**：holdout 材料当前仍在同一 checkout；正式搜索 job 需要独立读取授权，现有目录划分不构成进程权限隔离。

## 4. 限制

- 案例包是公开模拟／重建材料，应用内 commit 为虚构替身、diff 不是完整源码 checkout；不能据此声称真实生产根因或代码 SHA 核验能力。
- 本轮只做日志-only 基线准备；metrics/traces/attachments 未开放读取，相关评分项为不适用。
- 未发起真实模型调用；优化器与评分器未实现。
