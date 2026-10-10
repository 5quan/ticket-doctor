# 自改进交付 B：固定评测桥梁

> 对应方案：`docs/self-improvement-implementation-plan.md` §6、§7、§8、§12 交付 B。
> 状态：候选编译器、确定性评分器、预算账本、TS 批量桥梁已完成；Python GEPA 适配器（交付 C）未开始。

## 1. 模块

| 模块 | 作用 |
|---|---|
| `src/evolve/compile.ts` | 候选编译器：基础 prompt + 候选规则 → **完整** systemPrompt；范围校验（拒绝 case/trace/commit ID、私有路径、答案文件、覆盖系统提示词） |
| `src/evolve/grade.ts` | 固定评分器：必需事实（概念组，含否定窗口）、禁用断言、四层可见性、引用有效性、行为边界；硬失败单独阻断 |
| `src/evolve/budget.ts` | 预算账本：`monitor`（事后累计）与 `enforce`（trial 间停止） |
| `src/evolve/batch.ts` | TS 批量桥梁：解析/校验请求，逐 case×repeat 执行，逐 trial 终态 + 逐 case 均值 |
| `scripts/evolve-batch.ts` | CLI：stdin 一个请求 JSON，stdout 一个结果 JSON，日志走 stderr |

## 2. 协议（§6.1）

请求：`{ runId, candidateId, rulesText, caseIds, split, repeat, captureTraces, budget?, budgetMode?, baseline? }`
结果：`{ ...hash, baseline, items: BatchItemResult[], cases: BatchCaseResult[], budget, stoppedByBudget }`

护栏（已实现并测试）：

- **基线模式**：`baseline: true` 时不加任何外部规则，直接用当前生产内置提示词（`rulesText` 可省略）；与候选同一执行路径，供 §8 第 3 步跑基线。

- **不重复注入**：桥梁传给执行层的是 `compileCandidate(rulesText).compiledPrompt`（基础 + 规则），不是把完整 prompt 再当规则拼一次。
- **只接受批准 ID**：`caseIds` 必须属于该 `split` 的可运行清单（admitted）；未知/重复/非有限数一律 `BatchProtocolError`（CLI 退出码 2）。
- **每项终态**：`scored | task_error | unscored`，逐 trial 都落记录。
- **个别失败 vs 系统性失败**：模型/工具失败记 `task_error` + 失败分；材料 hash/隔离/加载失败抛 `SystematicBatchError` **终止整轮**（退出码 3）。
- **repeat 语义**：一个 case 对应一个均值分，全部原始 trial 保留在 `items` 里，不平铺成多个 case（§6.2）。
- **预算诚实**：当前无统一可拒绝的模型 transport，无法请求前硬拦截；账本默认 `monitor`，`enforce` 也只能在 trial 之间停止，快照显式标 `enforcedAt`。

## 3. 评分口径（§7.3）

`fitness = 0.50×结论支持度 + 0.30×证据充分度 + 0.20×判断边界正确度`，适用项归一化；
**硬失败**（隔离失败、错误 SHA/无法解析引用、禁用断言、非预期阻断/运行错误、outcome 越界）单独阻断并置 0。

边界说明：结论支持度由**概念组关键词 + 否定窗口**确定性判定，只覆盖可机器判的子集；禁用断言要求概念组**同窗口共现**，且带 `onlyWhenStatus` 时**仅对 `supported` 假设**判定（`candidate`/不确定不当肯定断言）。语义裁判（模型）留待人工标注校准后另接，本模块不冒充语义正确率。

## 4. 命令

```bash
# 负路径示例（未准入案例会被拒绝，退出码 2）echo '{"runId":"r1","candidateId":"c1","rulesText":"...规则...","caseIds":["rcb-001"],"split":"train","repeat":1}' \
  | node --experimental-strip-types scripts/evolve-batch.ts

# 基线（不加规则，直接用生产提示词）
echo '{"runId":"baseline-1","candidateId":"baseline","baseline":true,"caseIds":["rcb-001","rcb-004","rcb-007"],"split":"train","repeat":3,"captureTraces":true}' \
  | node --experimental-strip-types scripts/evolve-batch.ts
```

GEPA（交付 C）会以子进程参数数组 + stdin 调用同一入口，不拼 shell 字符串。

## 5. 尚未完成

1. **Python GEPAAdapter**（交付 C）：`evaluate` / `make_reflective_dataset` 两个方法。
2. **语义裁判**：需先在人工标注正反例上校准（§7.3）。
3. **批量结果入 Langfuse**：本地评分与上传共用同一结果对象，但尚未接上传。
4. **请求前预算拦截**：需统一可拒绝的模型 gateway（§8）。
5. **可运行的 train/validation 案例**：当前 `rcb-*` 仍 `qualified`，准入清单为空；桥梁负路径已验证，正路径需人工复核后置 `admitted`。
