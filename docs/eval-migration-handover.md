# 评测 v2 迁移交接（下一个会话先读这篇）

> **分支 `eval/v2-migrate`**（不是 main）。本会话结束时 HEAD=`5c2dd16`，与 origin 同步。
> 方案与工作单：`docs/eval-implementation-plan.md`（M0–M10 状态以它为准）。
> 开源数据：`docs/eval-open-source-datasets.md`。历史设计：`docs/eval-design.md`（v1，已废弃）、`docs/eval-v2.md`（v2 使用说明）。
> 一句话：**把曾经在 main、后被合并删掉的 eval2（`66d5425`）恢复到分支并适配当前主链路，接上真实开源数据（RCAEval）与 Langfuse**。

---

## 0. 30 秒上手

```bash
cd /opt/ticket-doctor
git checkout eval/v2-migrate && git pull
npm install                     # 会带上 devDeps: hyparquet / hyparquet-compressors
npm run typecheck && npm test && npm run docs:check     # 全绿基线（tests.ts=258）
npm run eval:v2 -- run --suite smoke --engine scripted  # 工程自测（离线、零成本）
npm run eval:v2 -- replay --suite smoke                  # 离线重放逐字段一致
```

## 1. 三条线（别混）

| 线 | 是什么 | 去哪 |
|---|---|---|
| 生产主链路 | Host → Runner → 诊断会话+审计会话 → 报告 | SQLite + 投递 |
| 观测（Langfuse） | 每次 attempt 的 trace | Langfuse |
| 评测（本分支） | 固定案例批量跑主链路并评分 | `data/eval-v2/`（不入库）+ 可选推 Langfuse |

**权威源契约**：接入 Langfuse 后**语义分以 Langfuse 为准**，本地只读镜像；模型分与人工分**分来源记录**，自动分不得覆盖人工裁决。

## 2. 现状：工作单 M0–M10

| # | 任务 | 状态 |
|---|---|---|
| M0 | 恢复 `66d5425` 的 eval2（`src/evals/v2/*` 16 文件、6 测试、`docs/eval-v2.md`、`fixtures/evals/checkout-timeout`、`scripts/init-eval-fixture.mjs`）；T7 `SourcePage` 适配；恢复 `OrchestratorDeps.onPrepared` | ✅ |
| M1 | runner/脚本引擎适配当前 `runDiagnosisLoop`（审计/补证/协议 v4/证据 UID）；**顺带修了生产 bug `extractService`（OQ-45）** | ✅ |
| M2 | 四层可见性 A/B/C1/C2/D + 覆盖信息 | ✅ |
| M3 | scorer 口径重验；**`blocked` 一等结果（OQ-46）已做**；审计 verdict/降级纳入评分 | 🟡 |
| M4 | manifest 纳入 `diagnosis.audit` + `diagnosis.coverage`；离线 replay 逐字段一致 | ✅ |
| M5 | 隔离预检适配当前 sources | ✅ |
| M6 | review ↔ Langfuse 权威源契约 | ❌ |
| M7 | Langfuse：**trace+score 推送已实现**（v4 OTLP + score ingestion）；dataset/experiment/annotation | 🟡 |
| M8 | 真实案例：**M8a RCAEval 导入器 + 原生 gold 已做**；M8b 扩样本+人工复核；M8c 代码级 gold | 🟡 |
| M9 | 冻结正式质量基线 | ❌ |
| M10 | **CI 门禁 `--gate on` 已做**；线上代理分 + 案例回流 | 🟡 |

## 3. 关键文件地图

```
src/evals/v2/
  runner.ts      多轮执行（复用 executeRun）、trial 隔离、捕获回写、manifest 组装
  scorer.ts      SCORER_VERSION=3.1.0：硬检查 + 逐轮行为 + 四层可见性；语义项 unscored
  visibility.ts  A/B/C1/C2/D 四层（RecordingFileLogSource 是 A 层观测点）
  isolation.ts   路径闭包/未来消息/答案文件/git tree 预检
  manifest.ts / hash.ts   指纹与冻结
  review.ts      人工/AI 复核工件导入（只覆盖语义项，不覆盖硬失败）
  langfuse.ts    评测→Langfuse 推送（v4：OTLP 建 trace + ingestion 推 score）
  schema.ts      case/truth 校验（已放宽：sourceTier=reproduced_history 允许 log-only repos:[]）
  cli.ts         run | replay | summary | rescore | push（`--audit on|off`、`--gate on`、`--cases`）
  engcases.ts    工程自测用例生成器（含 version/truncation/counter-evidence/clarify）
scripts/
  import-rcaeval.mjs   RCAEval→v2 布局导入器（原生 gold + root_cause.txt 强 locator）
  init-eval-fixture.mjs 初始化工程 fixture 仓库
```

运行产物在 `data/eval-v2/`（**gitignored**，可随时重建）：`catalog/`、`public/<case>/`、`private/<case>/`、`runs/<suite>/`。

## 4. 怎么跑（全流程）

```bash
# 1) 导入真实开源案例（RCAEval，约 3.4GB 全量；按 suite 取更小）
npm run import:rcaeval -- --dataset RE3-OB --limit 5      # 也支持 RE3-TT / RE3-SS
# 2) 工程自测（零成本）
npm run eval:v2 -- run --suite smoke --engine scripted --gate on
# 3) 真实模型（pi，需 DEEPSEEK_API_KEY；当前可用）
CASES=rcaeval-re3ob_adservice_f3_1,rcaeval-re3ob_adservice_f4_1
npm run eval:v2 -- run --suite rcaeval-pi --engine pi --cases "$CASES" --gate on
# 4) 重放一致 / 汇总 / 语义复核
npm run eval:v2 -- replay --suite rcaeval-pi
npm run eval:v2 -- summary --suite rcaeval-pi
npm run eval:v2 -- rescore --suite rcaeval-pi --case <id> --trial t1 --review <review.json>
# 5) 推 Langfuse（v4）
npm run eval:v2 -- push --suite rcaeval-pi
```

## 5. 已实测结果（工程/程序指标，非质量结论）

| 场景 | 例数 | recall.C1 | recall.D | requiredFactCoverage | 硬失败 |
|---|---|---|---|---|---|
| RE3-OB（adservice f3/f4，弱/强 gold） | 5 | 100% | 80% | — | 0 |
| RE3-TT / RE3-SS 跨系统 | 1+1 | 100% | 100% | — | 0 |
| RE3-SS carts f1（**强 gold**） | 2 | **0%** | 0% | **100%** | 0 |

**可讲的点**：RCAEval 提供**两级原生 gold**——`root_cause_service`（`requiredFactCoverage` 自动判"定位到哪个服务"）+ `root_cause.txt`（强 locator，判"是否引用根因日志行"）。SS 实测：**服务级 100%，证据级 0%**——即"找到服务，但没引到那条根因日志（该行根本没被工具返回）"。

语义分：目前仅 **AI 模型裁判**（`reviewer=model-judge:pi`，`claimSupport 5/5`），**不是人工裁决**。

## 6. 决策记录（本分支）

- **OQ-44** 检索范围约束（query_logs 服务/时间窗 + allowedRepos 硬白名单）。
- **OQ-45** `extractService` 把日期当服务名——**生产 bug，已修**。
- **OQ-46** 预期内"读取前阻断"提升为**一等结果 `blocked`**（与真实 error 区分；CI 门禁只卡硬失败）。
- **Langfuse 是 v4.50.0 `events_only`**：`/api/public/ingestion` **只收 score**，轨迹必须走 **OTLP**；`/api/public/traces|observations|scores` **已下架**（读取改 `/api/public/v3/scores`）。**程序化验证受限，需在 UI 核对**（trace 名 `eval/<case>`）。
- **sourceTier**：`reproduced_history`（RCAEval 派生）/ `synthetic_engineering` / `human_ticket`——**不同 tier 禁止同表比**。
- **权威源**：Langfuse 承载人工裁决；本地快照只读；模型分单列。

## 7. 已知坑（务必先读）

1. **scripted 引擎未适配补证循环**：`--audit on` 时若审计建议 continue，补证轮会耗尽脚本步骤（报告被"脚本已耗尽"覆盖）。工程自测固定 `--audit off`；真实审计效果用 `--engine pi`。
2. **gold 质量分层**：只有 RE3-SS 8 例有 `root_cause.txt`（强）；其余自动派生是"根因服务最高频日志"（弱，只宜当材料可达性）。**M8c** 才能补代码级 gold。
3. **题面是合成/取自 `fault_description`**，不是真实工单；不能声称评了"工单理解"。
4. **RCAEval 数据**：HF 用 `curl` 下（本机 Node `fetch` 连 HF 会超时）；parquet 用 `hyparquet`+`hyparquet-compressors`（ZSTD）读；缓存 `data/rcaeval/`。
5. **runner-process 集成测试在负载下偶发 flaky**（子进程 + 5s 超时），与评测无关；单独跑可通过。
6. **`data/` 不入库**：导入的案例与 runs 需重跑生成；要冻结就单独归档。
7. v4 读取接口缺失导致 **push 的结果要靠 UI 核对**；ingestion 返回 2xx 不代表一定能读回。

## 8. 下一步（按依赖）

1. **M8c 代码级 gold**（最高价值）：为 Online Boutique / Sock Shop / Train Ticket 建**带故障/修复双提交**的 fixture 仓库，给 `root_cause.txt` 缺失的案例补 code locator；把弱 locator 升级为故障签名。
2. **M8b 扩样本 + 人工复核**：跑遍 8 个强 gold 的 RE3-SS 案例；把 AI 裁判换成/叠加人工复核（`rescore --review`），冻结首个**开源原生 gold 基线（M9）**。
3. **M7 余项**：Langfuse dataset/experiment/annotation（v4 下用 `@langfuse/*` 的 dataset API；注意读取接口变化）。
4. **M3 余项**：把审计 verdict/降级纳入评分；旧口径作废声明。
5. **M6/M10 余项**：权威源落地；线上代理分 + 案例回流 flywheel。

## 9. 交接规程（DoD）

1. 先 `npm run typecheck && npm test && npm run docs:check` 全绿。
2. **一次只做一项**，在 `docs/eval-implementation-plan.md` 改状态。
3. 改判定口径必须 bump 对应版本（`SCORER_VERSION` / `AUDIT_POLICY_VERSION`），提交信息注明。
4. 新迁移从 `007_` 起（本方案预期无迁移）。
5. `commit` + `push`（分支 `eval/v2-migrate`）；合并 main 前先决定**是否保留薄 MVP `src/eval/`**（当前与其并存）。
