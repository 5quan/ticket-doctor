# 评测 v2 使用说明（预诊断多轮闭环）

> 状态：本期新增能力，实施记录见 `docs/status.json`。方案全文由需求方持有；本文只写
> 准备、运行、复核、重评分、比较与失败处理。旧入口 `npm run eval` 保持不变，两者结果
> 目录互不影响。

## 0. 它测什么

预诊断 Agent 的五件事：材料范围是否正确、结论是否有证据支持、缺料是否补问、反证是否
调整、回写是否可核验。工程验收标准是"评测能正确揭示失败"，不是诊断分数高。

## 1. 目录与数据协议

工作目录在 `data/eval-v2/`（不入版本库，可随时重建）：

```text
catalog/catalog.json        # case 清单（工程条目自动 upsert，手工条目保留）
public/<case>/              # 公开材料：case.json + 各轮消息文本 + 各轮材料视图
private/<case>/             # truth.private.json（逐轮标准）+ script.json（脚本引擎）
candidates.json             # 外部历史候选资格记录（FastAPI 7/12/5）
candidates/<case>/          # 资格报告
runs/<suite-id>/            # 每次运行：manifest.json + summary.json + 逐 trial trace/outputs/score
```

工程自测 case 由生成器落盘（合成材料，只验 harness，不声称真实诊断质量）。

## 2. 运行

```bash
npm run eval:v2 -- run --suite daily-1 --engine scripted [--repeat 3] [--cases eng-clarify]
```

- 引擎三选一：`scripted`（默认，确定性工程自测）/ `fake` / `pi`。`pi` 必须显式选择且
  `DEEPSEEK_API_KEY` 预检通过，CLI 不代填凭据；真实模型每套配置完整跑三次并保留全部结果。
- 每次 trial：全新 Store 与调查 → 生产编排（`executeRun`）逐轮执行 → 捕获发送端记录回写 →
  持久化导出 trace → 逐轮标准打分。
- 产物：`runs/<suite>/manifest.json`（完整 HEAD、材料/标准/提示词/预算 hash）、
  `summary.json`、逐 trial `trace.jsonl / outputs.json / score.json`。

## 3. 复核与重评分

```bash
npm run eval:v2 -- replay --suite daily-1    # 重算评分并与 score.json 逐字段比对
npm run eval:v2 -- summary --suite daily-1   # 汇总视图（含硬失败清单）
```

- 语义项（claimSupport 等）在人工 rubric 导入前保持 null；provisional 标准的结论只作参考。
- 评分器标识为独立版本（`SCORER_VERSION=3.0.0`），与旧口径禁止同表对比；改判定语义必须
  bump 并对旧 trace 重评分。

## 4. 关键口径速查

- 召回按"需求"计（requirementId），分母=本轮适用需求；不可判记 unscored，不冒充 0/1。
- 可见性分四层：A 源返回 / B 入库 / C1 工具返回文本 / C2 请求上下文（未观测，恒 null）/
  D 报告引用。入库≠可见：预览上限与渲染预算都会造成 B、C1 差距，由指标直接暴露。
- 硬失败单列不进均值：引用不可解析、版本错配、越界断言、反证后固执、空日志推健康等。
- 隔离预检失败的 case 直接 blocked，不进评测；私有标准/未来材料/补丁结构性不可达。

## 5. 失败处理

- 单 case 异常记 `execution_error` 并保留 trace，不影响其他 case；重试 attempt 全部留痕。
- 归因六层：engineering / material / reasoning / clarification / contradiction / scoring。
  评分器自身问题归 scoring，不算模型失败。
- FastAPI 7 等外部候选在复现通过前保持 `candidate`/`deferred`，见 `data/eval-v2/candidates/`；
  不用合成日志冒充历史事故材料。
