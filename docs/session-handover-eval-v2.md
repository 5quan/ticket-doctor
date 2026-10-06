# 评测 v2 会话交接（2026-10-02 收官，HEAD 689d11f）

> 面向下一个实施会话。方案全文（需求方持有）＋本文件＋`docs/eval-v2.md`（使用说明）＝完整上下文。
> 易变事实以 `docs/status.json` 为准；本文不重复具体分数，只交代结构与约定。

## 1. 项目一句话

ticket-doctor＝飞书 Bug 预诊断 Agent（只读取证→带证据编号的预诊断报告→补问/补证→回写）。
当前阶段：为其建设**可信评测闭环**（工程验收标准＝评测能正确揭示失败，不是诊断分数高）。

## 2. 两套评测入口（并存，勿混）

| 入口 | 命令 | 状态 |
|---|---|---|
| v1 单轮 | `npm run eval` | 历史保留（checkout-timeout 5 case，scorer 2.0.0 口径），仅作旧基线 |
| v2 多轮闭环 | `npm run eval:v2`（`run/replay/summary/rescore`） | **本期主战场**（`src/evals/v2/`，14 模块） |

## 3. v2 结构速览（src/evals/v2/）

- 数据协议：`types.ts`（case-v2/truth-v2/trace/manifest/score/review）、`schema.ts`（严格校验＋`validatePairing`）
- 运行：`runner.ts`（每 trial 全新 Store→routeInbound→claim→executeRun 生产编排→投递捕获→逐轮驱动；
  **onPrepared 观察钩**：读取前记录 `scope_resolved` 并阻断版本错配/隔离违规，随后中止整个 trial）
- 可见性：`visibility.ts`（A 源返回/B 入库/C1 工具返回文本/C2 请求上下文恒 null/D 报告引用；
  C1 按**调用身份绑定**＝返回文本含关键内容且同调用批次证据匹配类型/仓库/SHA/路径/内容）
- 评分：`scorer.ts`（SCORER_VERSION=3.1.0；确定性硬检查→逐轮行为→分维度汇总；
  语义项 review 导入前 value=null；`requiredFactCoverage` 是关键词代理，单列不冒充语义分）
- 复核：`review.ts`（工件校验/绑定/逐项重评分；硬失败与可见性不可被覆盖）＋CLI `rescore`
- 隔离：`isolation.ts`（真实路径闭包、视图两两关系＝相等+双向父子包含拒绝、链接逃逸、
  跨轮/私有材料硬链接 inode 检查、扫描完整性独立记账、未来消息泄漏）
- 工程 case：`engcases.ts` 生成器（eng-clarify / eng-counter-evidence / eng-truncation /
  eng-version-drift / eng-version-headfix，全部 synthetic_engineering，仅验 harness）
- 汇总：`manifest.ts`（完整 SHA/材料/标准/提示词/预算指纹）、`trace.ts`（实时+derived 两类事件）、
  `replay`（重算评分与 score.json 逐字段一致）

## 4. 关键口径（改任何一处必须 bump SCORER_VERSION 并另建结果目录）

1. 召回按需求（requirementId）计；不可判＝unscored，聚合 den>0 且 unscored=0 才出 value——
   未评分不得在 suite 级被分子分母再生。
2. 入库≠可见（B/C1 差异由预览上限与渲染预算造成），检索/可见/引用三层分开报告。
3. 日志授权语义：`allowedServices` undefined=不限（生产遗留默认）、[]=全拒、非空=白名单；
   评测逐轮传 `round.services`。
4. 版本：评测**不注入 rev**——生产按发生时间/HEAD 钉版的路径被完整考验；expectedSha 由
   onPrepared 观察点核对（missing-in-scope/unresolved/mismatch/ok/no-expected 五态），
   并对实际解析 SHA（可能选中中间提交）单独做隔离扫描。正式 case 每轮仓库必须声明 expectedSha。
5. 隔离预检用真实路径（realpath）：符号链接/junction/目录别名/路径穿越/跨轮与私有材料硬链接
   （inode）全部阻断；扫描完整性（incomplete_scan）与未来消息泄漏是两项独立检查。
6. 硬失败（wrong_sha/citation_unresolvable/forbidden_assertion/…）不可被 review 或模型裁判覆盖。

## 5. 运行与验收命令

```bash
npm run eval:v2 -- run --suite <新id> --engine scripted [--repeat N] [--cases a,b]
npm run eval:v2 -- replay --suite <id>     # 重算评分比对，不一致非零退出
npm run eval:v2 -- summary --suite <id>
npm run eval:v2 -- rescore --suite <id> --case <c> --trial t1 --review <file>
npm test && npm run typecheck && npm run docs:check   # 194 项用例（193 过+1 skip+0 失败）
```

- 结果在 `data/eval-v2/runs/<suite>/`（manifest/summary/逐 trial trace·outputs·score）；
  **同名 suite 拒绝重跑**；`data/` 不随 Git 同步，交接包 tar 在 `data/eval-v2/handoff/`
  （已 `git add -f` 入库，`INDEX.md` 是提交↔产物对应索引）。
- 测试分布：`tests/unit/eval-v2-{scorer,schema,links,audit}.test.ts` +
  `tests/integration/eval-v2-{run,version}.test.ts`。junction 用例 Windows 才跑（其余平台 skip）。

## 6. case 生态

- 工程自测：5 条（生成器落盘 `data/eval-v2/`，可随时重建）——补问/反证/截断（B≠C1 实证）/
  版本漂移×2（预期阻断）。
- 真实历史：**fp07-clarify（fastapi-7）＝qualified**。复现完成（故障 cc4c13e4 → 1 failed
  TypeError: Decimal not JSON serializable；修复 19c77e35 → 1 passed；venv 可复用）。
  资料：candidates/fastapi-7/{qualification.md,REBUILD.md,admission-checklist.md} +
  private/fp07-clarify/{truth.private.json,gold-evidence-basis.md}（provisional）。
  fastapi 12/5 仍 deferred。九项准入表见 admission-checklist.md——唯一阻塞＝第 9 项独立人工复核。

## 7. 下一批（阶段二，按需求方顺序）

1. C1 展示片段绑定细化：read_code 截断的行/字符范围记账（现在只到"调用级"绑定）。
2. review 闭环实战演练：用工程 trial 走通 review 工件→rescore→report（不必等 FastAPI 7；
   gold 准入复核与 trial 语义评分是两种不同工件）。
3. 语义评分与记录问题收尾。
4. fp07 转 admitted（等独立人工复核）→ pi 三连跑基线（需预算授权；key 在 .env，预检就绪）。

## 8. 禁区（需求方多次重申）

- 不实现自动修复/Shell/编辑工具/PR；生产诊断逻辑与提示词保持基线（评测只暴露问题）。
- 不改 benchmark/gold 迎合输出；不同 scorer 口径禁止同表比较；旧结果目录只增不删。
- 真实模型调用与 push 均需需求方逐次明确指示（token 在 ~/.bashrc 的 GH_TOKEN，用完撤销）。
- 文档冲突以代码为准；易变事实先改 status.json（docs:check 挂在 npm test 里）。
