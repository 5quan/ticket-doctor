# 工作单：评测打分校准 + 文档状态一致性

> 本文是交给下一个执行会话（zcode）的**设计方案 + 操作手册**。
> 开工前先按 `docs/handover.md §7.1` 的阅读顺序过一遍，并跑一次基线
> `npm run typecheck && npm test && npm run test:go`（全绿再动）。
>
> 两个问题，按顺序做，一次只做一件：
> - **问题 A（评测正确率定义）**：`src/evals/scorer.ts` 修了 UID 兼容，但"正确率"仍只判
>   "top 假设 supported 且引用到 gold 证据"，**没有核对根因内容**。导致真实模型 90/30.7/80
>   不能代表新版质量。→ 第一部分 + 第二阶段 Z1/Z2。
> - **问题 B（文档状态漂移）**：同一事实在 ≥7 份文档里各写一份快照，改一处漏多处；且无检查。
>   → 第一部分 §B + 第二阶段 Z3。
>
> 硬边界不变：生产只读、单机 SQLite、不改主链路语义、不引入无触发条件的架构。

---

# 第一部分 · 设计方案

## A. 评分校准：把"引用对了"和"根因对了"拆开

### A.1 现状（代码事实，已核对）

`src/evals/scorer.ts` 的 `correct`（诊断类）当前是：

```ts
correct =
  !!top &&
  top.status === "supported" &&
  top.evidenceIds.some((id) => {
    const e = byId.get(id);
    return !!e && gold.some((g) => evidenceMatches(e, g));
  });
```

它只回答"结论是否 supported + 是否顺手引了一条 gold 证据"，**完全没读 `top.cause` 文本**。
后果（已能在现有单测/基线里复现）：

1. **错误根因 + 正确引证也能判对**：报告说"根因是 Redis 连接池打满"，只要在 `evidenceIds`
   里带上一条 InventoryClient 的 gold 日志，`correct=true`。
2. **只要求"至少一条" gold**：ct-002 的 gold 同时含"库存超时"与"OrderService NPE"两处证据，
   只答直接原因（NPE 无容错）、不答根因，也会判对。
3. **不惩罚引用干扰证据**：真实基线 ct-003 一边引用 gold、一边引用 6 条干扰，仍判 `correct=true`。
4. **精确率分母被重复引用放大**：真实基线 ct-003 的 `citedDistractor` 出现 `E3,E5,E6` 重复，
   同一条证据被引用多次会反复计入分母。
5. **口径不随证据策略变化**：D6 取消跨调用去重后证据条数变多，但打分器没有版本字段，
   fake 70/20/60 与真实 90/30.7/80 是**不同口径**，却被并排引用。

**结论**：现有 `accuracy` 不是"根因正确率"，只能叫"引证支持率"。必须重构后再重跑基线，
且**禁止跨打分器版本比较分数**。

### A.2 目标与非目标

**目标**
1. `accuracy` 能区分"根因说对"与"根因说错/说偏"；错误根因不能被"顺手引证"救回。
2. 打分是确定性的、可离线复跑的（CI 不依赖真实模型）；语义判定作为可选 judge 第二层。
3. 每次结果带 **打分器版本 / 判定模式 / benchmark 版本 / gitRev / 证据口径**，可追溯、不可混比。
4. 重跑一次真实模型基线，给出可信的质量数字。

**非目标**
- 不做概率校准（对齐 backlog A5：退役 confidence 作决策依据）。
- 不改生产主链路、不改 `validate.ts` 的校验语义。
- 不让被评测的模型给自己当裁判（硬禁区）。

### A.3 判定模型（三层，逐层收紧）

把 `correct` 拆成三个可独立审计的布尔量：

| 量 | 含义 | 判定方式 |
|---|---|---|
| `causeMatched` | top 假设的**根因文本**是否命中 gold 的根因概念 | 确定性概念匹配（默认）；judge 可选 |
| `evidenceSupported` | top 假设是否引用了 ≥1 条命中 gold 的证据 | 现有 `evidenceMatches` |
| `distractorOnly` | top 的引用是否**全是**干扰证据（无任何 gold） | 现有干扰匹配 |

**诊断类 `correct`** = `top.status==="supported" && causeMatched===true && evidenceSupported && !distractorOnly`。
**材料不足类 `correct`** = `completeness==="partial" && 所有假设 status!=="supported"`（保持现有语义，
但增加"不得给出具体根因"的更严格可选校验，见 A.7）。

### A.4 benchmark 注解扩展（向后兼容）

`src/evals/types.ts` 里 `gold` 增可选字段；**缺字段 = 未校准（legacy），不得当作已校准口径报数**：

```ts
export interface GoldSpec {
  answer: string;
  evidence: EvidenceLocator[];
  /** 新增：每组 any-of；top.cause 必须每组命中至少一个同义词。 */
  requiredConcepts?: string[][];
  /** 新增：断言即错（含否定语境豁免，见 A.5）。 */
  forbiddenConcepts?: string[][];
  /** 新增：人类可读的等价表述，供 judge 与人工核对（确定性打分不用）。 */
  acceptableCauses?: string[];
  /** 新增：期望粒度，root=要根因，direct=直接原因即可。 */
  causeLevel?: "root" | "direct";
}
```

`benchmark.json` 示例（ct-003）：

```jsonc
"gold": {
  "answer": "根因不是 Redis 连接池，而是库存服务调用超时；RedisPool 告警是伴随现象",
  "evidence": [{ "kind": "log", "level": "ERROR", "substring": "InventoryClient 调用库存服务失败 timeout" }],
  "requiredConcepts": [["库存", "inventory"], ["超时", "timeout"]],
  "forbiddenConcepts": [["redis", "连接池"]],
  "acceptableCauses": ["库存服务调用超时导致下单失败（Redis 告警为伴随现象）"]
}
```

> 注解是**人工黄金标准**，属于 `docs/eval-design.md §12.1` 的"禁区"，自动迭代的 Proposer
> 不得写 `benchmark.json`。

### A.5 概念匹配（确定性，默认）

```ts
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
const NEG = /(不|非|并非|不是|排除|未|无|而不是|而非|not|no|without|rather than)/;

function containsGroup(cause: string, group: string[]): boolean {
  const n = norm(cause);
  return group.some((w) => n.includes(norm(w)));
}

/** 该概念是否被"断言"（排除否定语境，如"不是 Redis 而是库存"）。 */
function assertsGroup(cause: string, group: string[]): boolean {
  const n = norm(cause);
  for (const w of group) {
    const i = n.indexOf(norm(w));
    if (i < 0) continue;
    const pre = n.slice(Math.max(0, i - 12), i); // 约 12 字符窗口
    if (!NEG.test(pre)) return true;
  }
  return false;
}

function matchCause(cause: string, gold: GoldSpec) {
  const missing = (gold.requiredConcepts ?? []).filter((g) => !containsGroup(cause, g));
  const forbidden = (gold.forbiddenConcepts ?? []).filter((g) => assertsGroup(cause, g));
  const checked = (gold.requiredConcepts?.length ?? 0) > 0;
  return {
    checked,
    matched: checked ? missing.length === 0 && forbidden.length === 0 : null,
    missingGroups: missing.map((g) => g.join("|")),
    forbiddenHit: forbidden.map((g) => g.join("|")),
  };
}
```

同义词选择要求（写进 fixture 注释）：用**不易误伤的领域词**（"库存/inventory"），不要用会被
正常否定句触发的通用词；需要排除的干扰原因单独放 `forbiddenConcepts`。

### A.6 精确率/召回率修正

- 引用集合先**按解析后身份去重**（uid 优先，其次 `(runId,evidenceId)`）：`citedDistinct`。
- `precision = citedDistinct 为空 ? (insufficient?1:0) : |citedDistinct∩gold| / |citedDistinct|`。
- 新增 `distractorCitationRate = |citedDistinct∩distractors| / |citedDistinct|`。
- `matchedGold / missedGold / citedDistractor` 全部去重。
- `recall` 定义不变（`registry.all()` 命中 gold 比例）。

### A.7 结构化输出扩展

`CaseScore` 增：

```ts
causeMatched: boolean | null;      // null = 该 case 未注解（legacy）
causeCheck: { missingGroups: string[]; forbiddenHit: string[] } | null;
evidenceSupported: boolean;
distractorOnly: boolean;
correctBasis: "cause+evidence" | "insufficient" | "evidence-only(legacy)";
citedNonGold: string[];            // 去重后的非 gold 引用
```

`ScenarioScore` 增：

```ts
scorerVersion: string;             // 例 "2.0.0"，改判定语义必须 bump
benchmarkVersion: string;          // benchmark 内容 hash（sha256 前 12 位）
gradeMode: "deterministic" | "judge";
calibrated: boolean;               // 所有诊断类 case 均带 requiredConcepts 才为 true
judge?: { model: string; agreement?: number }; // 用了 judge 才带
gitRev?: string;
evidencePolicy: "d6_no_dedupe";
```

**规则**：`calibrated=false` 时，`accuracy` 只是 legacy 兼容值，文档/控制台必须显式标注
"未校准，不可与校准口径比较"；不同 `scorerVersion` 的数字禁止同表对比。

### A.8 可选 judge（第二层，M2 再做）

- 新增端口 `src/evals/judge.ts`：
  ```ts
  export interface CauseJudge {
    name: string;
    judge(input: { question: string; goldAnswer: string; acceptableCauses?: string[]; cause: string }):
      Promise<{ equivalent: boolean; rationale: string }>;
  }
  ```
- 实现 `PiCauseJudge`，单独文件隔离 SDK（照 `pi-engine.ts` 的隔离方式），
  温度 0、只输出 JSON、模型用 `TD_EVAL_JUDGE_MODEL`（**应与被评测模型不同**）。
- CLI 增 `--judge`；默认确定性。judge **不得覆盖**确定性硬失败（无 gold 引证、distractorOnly）；
  只在确定性无法判定（`checked=false`）或作为交叉校验时使用，分歧要落盘。
- **采用门槛**：先在人工标注集上测 judge 与人工/确定性的吻合度（Cohen's kappa），
  达阈值（建议 ≥0.8）才准用于报数；否则只作辅助信息。

### A.9 重跑基线协议（关键）

因为判定语义变了，**旧基线一律作废**：

1. 冻结 scoring v2 + benchmark 注解，先 `commit`（确保结果可追 gitRev）。
2. fake 基线（离线、CI）：`npm run eval -- --scenario checkout-timeout`，记录。
3. 真实模型基线：`TD_ENGINE=pi npm run eval -- --scenario checkout-timeout`，跑 **3 次**，
   报告 3 次明细与中位数（模型抖动，禁止只报最好一次）。
4. 若启用 judge：同跑 3 次，并记录与确定性判定的一致性。
5. 每个数字必须带 `scorerVersion + gradeMode + gitRev + calibrated` 一起落文档。
6. 文档里旧数字标注：`（D6 前 + scorer v1 口径，已作废，勿引用）`。

### A.10 验收（问题 A）

- [ ] `correct` 不再能被"错误根因 + 一条 gold 引证"通过（新增单测证明）。
- [ ] `distractorOnly` 判错；引用干扰记入 `distractorCitationRate`。
- [ ] 重复引用不再放大精确率分母（新增单测）。
- [ ] 结果 JSONL 带 `scorerVersion/gradeMode/calibrated/gitRev`。
- [ ] 5 个 fixture case 全部补 `requiredConcepts`（ct-005 为 insufficient 可不补）。
- [ ] `npm test` 全绿；fake 基线已重跑并记入 `docs/status.json`。
- [ ] 真实基线已重跑（有 key 时）；无 key 时明确写"待跑"，不得沿用旧数。
- [ ] `docs/eval-design.md §5` 已改为 v2 口径。

---

## B. 文档状态一致性

### B.1 现状（漂移清单，已核对同一 HEAD）

| 文档 | 位置 | 漂移内容 |
|---|---|---|
| `handover.md` | L43 | 飞书接入写 `◐ 长连接（S3）待做`，§6 同文又写"长连接 S3 已实现" |
| `handover.md` | L62 | Go 适配器写 `长连接待做` |
| `handover.md` | L64 | 测试 `TS 126 个`（实为 127） |
| `handover.md` | L81 | `npm test # 58 个测试` |
| `handover.md` | L74 / L95 | "跨轮证据复用"与已完成的稳定 UID 混列，未区分"证据跨轮（已完成）"和"上下文跨轮（未做）" |
| `handover.md` | L84 | `npm run gateway` 未标注"旧链路/过渡期" |
| `session-handover.md` | L67 | §3.3 写"评测打分器适配 v2 ❌ 有 bug"，§4 又写"已修复"（同文自相矛盾） |
| `session-handover.md` | L4 | 版本 `0.3.0`，L21 又写 `0.3.1` |
| `evidence-uid-design.md` | L7 | "已知遗留：离线评测打分器尚未适配 v2"（已修） |
| `roadmap.md` | L11 | `打分器待修`（已修 UID 兼容） |
| `roadmap.md` | L26 | 测试 `TS 126` |
| `roadmap.md` | L40/41 | 旧真实基线 90/30.7/80 未标口径/未标作废 |
| `host-runner-design.md` | L4 | "阶段三骨架完成；阶段五部分覆盖"（长连接/故障测试/部署均已完成） |
| `host-runner-design.md` | L50 | 迁移表只到 `005_host_queue.sql`（已有 006） |
| `host-runner-design.md` | L94 | "Host 重启进程级验证与 docker-compose 待补"（已完成） |
| `host-runner-design.md` | L98 | "长连接模式……真正签名校验（当前为 token 校验）"（长连接已实现、签名已实现） |
| `host-runner-design.md` | L101 | "阶段五……部署收口" 待办 |
| `handover-technical-plan.md` | L37-41 | 基线提交 `81f260f`、版本 `0.2.0`、测试 `90`、迁移 `001…005`（全过时） |
| `handover-technical-plan.md` | L172 起 §5.5 | 已实现（OQ-38），却仍留"实现时在独立会话按其 §8 清单执行" |
| `handover-technical-plan.md` | §7 | "新增迁移从 `006_` 起"（应 `007_`） |
| `handover-technical-plan.md` | §10 | `OQ-1…OQ-35`（已有 OQ-40） |
| `contributor-onboarding.md` | L15 / L144 | 测试 `119 个` |
| `contributor-onboarding.md` | L186 | `npm run gateway` 未标旧链路 |
| `backlog.md` | L6 | P0 指向"修打分器 → S3 → S4"（已过时） |
| `backlog.md` | Q6 | 旧基线 90/30.7/80 未标口径/未标作废 |
| `README.md` | 当前边界 | "Go 适配器当前为飞书 Webhook 回调；长连接与多平台待扩展"（已完成） |
| `README.md` | 目录 | `migrations/ 001…005`（应 `001…006`） |

**根因**：易变事实（版本、测试数、迁移头、基线分数、功能状态）在 ≥7 份文档里各存一份，
靠人手同步；没有任何检查点。

### B.2 机制设计

**B.2.1 单一事实源 `docs/status.json`**

所有易变事实只在这里定义，其他文档**引用而不复述**：

```jsonc
{
  "version": "0.3.1",
  "gitHead": "<由脚本校验，不手写>",
  "tests": { "ts": 127, "go": "adapter" },
  "migrations": { "head": "006_evidence_uid.sql", "nextPrefix": "007_" },
  "eval": {
    "scorerVersion": "2.0.0",
    "benchmarkVersion": "<hash>",
    "baselines": {
      "fake": { "recall": null, "precision": null, "accuracy": null, "gradeMode": "deterministic", "calibrated": true, "ts": null },
      "pi":   { "recall": null, "precision": null, "accuracy": null, "gradeMode": "deterministic", "calibrated": true, "ts": null }
    }
  },
  "features": {
    "feishu_webhook": "done",
    "feishu_longconn": "done_unverified",
    "multi_platform": "skeleton",
    "host_runner": "done",
    "evidence_uid": "done",
    "audit_agent": "todo",
    "eval_m2": "in_progress"
  }
}
```

（`baselines` 初值留 null，Z2 重跑后回填。）

**B.2.2 `npm run docs:check`：把一致性变成会失败的检查**

新增 `scripts/check-docs.mjs` + `npm run docs:check`，规则：

1. **派生事实校验**：`version`（package.json）、`ts` 测试数（静态统计 `test(`）、
   `migrations.head`（`migrations/` 最大文件）、`gitHead`（`git rev-parse --short HEAD`）
   必须与 `status.json` 一致（`gitHead` 由脚本写入或跳过）。
2. **禁用旧口径 grep**（在 `docs/*.md` + `README.md` 里出现即 fail，附文件:行）：
   - `打分器待修` / `评分器未修` / `仍按 .E#. 建索引`
   - `长连接（S3）待做` / `长连接待做`
   - `docker-compose 待补` / `Host 重启进程级验证与 docker-compose`
   - `001…005` / `001 … 005`
   - `OQ-1…OQ-35`
   - 未加"作废/旧口径"标注的 `真实模型基线.*90%` 旧数
   - `跨轮证据复用` 出现在"未实现/待做"语境
3. **测试数字一致性**：扫描 `TS \d+ 个` / `当前 \d+ 个` 等，必须等于 `status.json.tests.ts`
   （除非该行带 `<!-- status:volatile -->` 豁免标记且指向 status.json）。
4. **`npm run gateway` 上下文**：出现处必须同句含"旧链路/过渡/legacy"，否则 fail。
5. **内链存在性**：文中 `docs/xxx.md`、`fixtures/...` 引用必须存在。
6. **输出**：fail 时打印 `文件:行: 原因` 并以非 0 退出。

把 `docs:check` 接进 `npm test`（新增 `tests/integration/docs-consistency.test.ts` 调脚本），
**让漂移直接挂测试**，而不是靠自觉。

**B.2.3 文档角色约定（写进 `handover.md §7`）**

| 文档 | 角色 | 状态怎么维护 |
|---|---|---|
| `docs/status.json` | 易变事实唯一源 | 手改，脚本校验 |
| `session-handover.md` §1–3 | 会话级快照 | 引用 status.json，数字不得手写 |
| `handover.md` §2/§六 | 长期叙述 | 不写测试数/版本等数字，链接 status.json |
| `roadmap.md` / `backlog.md` | 逐项状态 | 状态用词统一，数字引用 status.json |
| `host-runner-design.md` / `evidence-uid-design.md` / `adapter-longconn-design.md` | **时点设计记录** | 头部一行 `> 状态见 docs/status.json#features.<x>`，不再维护快照 |
| `open-questions.md` | 决策历史（append-only） | 新结论追加，旧结论标"已取代"，不改写历史 |

**B.2.4 收尾规程强化**（追加到 `handover.md §7.3`）

> 每次改动收尾必须：① 若改动了任何易变事实，**先改 `docs/status.json`**；
> ② 跑 `npm run docs:check`（已并入 `npm test`）；③ 其他文档只许引用，不许写死数字；
> ④ `commit`（说明"改了什么/为什么"）+ `push`。

### B.3 验收（问题 B）

- [ ] `docs/status.json` 存在且通过 `docs:check`。
- [ ] `npm test` 会在文档漂移时失败（用一个故意旧数字验证过）。
- [ ] B.1 清单逐条修正（脚本 grep 清零）。
- [ ] `handover.md §7.3` 已加"先改 status.json + docs:check"。
- [ ] 新增文档头部状态一行制约定已写入 `handover.md`。

---

# 第二部分 · zcode 操作手册

> 按 Z0→Z4 顺序执行；每步走完整闭环：**实现 → typecheck → test（+Go）→ 更新文档 → commit → push**。
> 一次只做一件事；任何步骤发现与代码不符，**以代码为准**并回头修正本文与相关文档。

## Z0 准备（必做）

```bash
cd /opt/ticket-doctor
npm install
npm run typecheck && npm test && npm run test:go   # 必须全绿
npm run demo                                       # 可选，离线冒烟
git status                                         # 确认工作区干净
```

阅读顺序：`docs/session-handover.md` → `docs/handover.md §7` → 本文 → `docs/eval-design.md`。
确认理解：**不跨打分器版本比较分数；不改主链路；benchmark 是禁区。**

## Z1 打分器 v2 校准（问题 A 代码）

1. 改 `src/evals/types.ts`：按 A.4/A.7 增加 `GoldSpec`、`CaseScore`、`ScenarioScore` 字段
   （全部可选，保证旧调用不炸）。
2. 改 `src/evals/benchmark.ts`：加 `benchmarkVersion(path)`（文件内容 sha256 前 12 位）。
3. 改 `src/evals/scorer.ts`：
   - 加 A.5 的 `matchCause`；
   - 去重引用集合；
   - 实现 A.3 的 `correct` 与 A.6 的指标；
   - 返回 A.7 新字段；`correctBasis`/`calibrated` 明确标注。
4. 改 `src/evals/runner.ts`：汇总时填 `scorerVersion/benchmarkVersion/calibrated/gradeMode/
   evidencePolicy`（`gitRev` 用 `git rev-parse --short HEAD`，可容错为空）。
5. 改 `src/evals/cli.ts`：控制台打印这些口径字段；`calibrated=false` 时打印"未校准"警告；
   结果 JSONL 追加同样的字段。
6. 改 `fixtures/evals/checkout-timeout/benchmark.json`：给 ct-001~ct-004 补
   `requiredConcepts`（必要可加 `forbiddenConcepts` / `causeLevel` / `acceptableCauses`）。
   参考：
   - ct-001：`[["库存","inventory"],["超时","timeout"]]`，`forbidden: [["redis"]]`
   - ct-002：`[["库存","inventory"],["超时","timeout","null"]]`（gold 根因是库存超时）
   - ct-003：`[["库存","inventory"],["超时","timeout"]]`，`forbidden: [["redis","连接池"]]`
   - ct-004：`[["InventoryClient"],["3000"]]`
   - ct-005：不加（insufficient 类）
7. 改 `tests/unit/scorer.test.ts`，**新增**：
   - 错误根因 + 引用 gold → `correct=false`（防回归，核心用例）；
   - 正确根因但引用干扰 → `distractorOnly=true`、`correct=false`；
   - 重复引用同一证据 → 精确率分母去重；
   - 缺 `requiredConcepts` → `causeMatched=null`、`calibrated=false`、`correctBasis="evidence-only(legacy)"`；
   - ct-003 式否定句"不是 Redis，是库存超时"→ `forbiddenHit` 为空、`causeMatched=true`。
8. `npm run typecheck && npm test`。
9. 更新 `docs/eval-design.md §5`（打分器章节）为 v2 口径；在 `open-questions.md` 追加一条
   `OQ-41 评测正确率定义校准`（append-only），写明动机、判定规则、口径版本。

**Z1 完成判据**：单测全绿，且"错误根因 + 顺手引证"用例由 true 变 false。

## Z2 重跑基线（问题 A 数据）

1. `npm run eval -- --scenario checkout-timeout` 跑 fake，确认汇总带 `scorerVersion` 等字段。
2. 有真实模型 key（`.env` 已配 `DEEPSEEK_API_KEY`）时：
   ```bash
   TD_ENGINE=pi npm run eval -- --scenario checkout-timeout
   ```
   连跑 3 次；记录 3 次的 `recall/precision/accuracy` 明细与中位数。
   - key 不可用或限流时：**如实写"待跑"**，不得沿用旧 90/30.7/80。
3. 回填 `docs/status.json.eval.baselines`（fake/pi 各字段 + gradeMode + calibrated + ts）。
4. 更新 `docs/eval-design.md` 实施状态、`docs/session-handover.md §4`、`docs/roadmap.md`
   的基线数字；旧数字统一加 `（D6 前 + scorer v1 口径，已作废）`。
5. 在 `docs/open-questions.md` OQ-41 里补实测结果与解释（含与旧口径差异原因：
   正确率定义变严 + D6 证据口径变化）。

**Z2 完成判据**：文档里的真实基线数字全部来自本次 `scorerVersion`，旧数字已显式作废。

## Z3 文档一致性（问题 B）

**Z3.1 机制**
1. 新建 `docs/status.json`（B.2.1 结构，baselines 用 Z2 结果）。
2. 新建 `scripts/check-docs.mjs` 实现 B.2.2 全部规则；`package.json` 加 `"docs:check"`。
3. 新建 `tests/integration/docs-consistency.test.ts` 调脚本，使 `npm test` 覆盖漂移。
4. 先**故意**制造一处漂移验证检查会挂，再修正。

**Z3.2 修内容漂移**（按 B.1 清单逐条改，改完 `npm run docs:check` 应清零）：
- `handover.md`：L43/L62 状态、L64 测试数、L74/L95 跨轮表述、L81 测试数、L84 gateway 标注；
  并按 B.2.4 强化 §7.3、按 B.2.3 加文档头部状态约定。
- `session-handover.md`：L4 版本、L67 打分器状态、§4 重写（UID 修复 vs 正确率校准分开）、§6 顺序。
- `evidence-uid-design.md`：L7 已知遗留改为"UID 兼容已修（fad5595）；正确率校准见 OQ-41"。
- `roadmap.md`：L11、L26、L40/L41。
- `host-runner-design.md`：L4、迁移表补 006、L94、L98、L101。
- `handover-technical-plan.md`：§2 基线表、§5.1、§5.5 陈旧段、§7 迁移前缀、§10 OQ 范围。
- `contributor-onboarding.md`：L15/L144、L186、§6 已实现项。
- `backlog.md`：L6 P0 指向、Q6 基线作废标注。
- `README.md`：当前边界长连接/多平台、目录 `001…006`。

**Z3 完成判据**：`npm run docs:check` 通过；`npm test` 全绿；B.1 清单逐条核对无遗漏。

## Z4 收尾

1. 更新 `docs/handover.md §六`、`docs/session-handover.md §1–3/§6`、`backlog.md` 状态、
   `roadmap.md` 勾选；`open-questions.md` 追加 OQ-41（若未在 Z1 加）。
2. `npm run typecheck && npm test && npm run test:go && npm run docs:check`。
3. `git add -A && git commit`（信息说清"改了什么/为什么"，例：
   `fix(evals): 正确率按根因概念判定 + 重跑基线`、`docs: 状态单源化 + docs:check`）。
4. `git push`（保持 origin/main 同步）。

---

# 第三部分 · 禁止事项（zcode 必读）

1. **不得**通过改 `benchmark.json` / 放宽 `requiredConcepts` 来"让分数好看"；注解是黄金标准。
2. **不得**跨打分器版本比较或混排分数；旧数字必须标"作废"。
3. **不得**让被评测模型当自己裁判；judge 未过校准门槛不得用于报数。
4. **不得**改动生产主链路（`src/diagnosis`、`src/host`、`src/storage`、`src/agent`）语义。
5. **不得**删除历史 `data/evals/*.jsonl` 行；只能追加。
6. **不得**引入无触发条件的新架构（PG/Redis/MQ/前端框架）；`docs:check` 只是脚本，不算架构件。
7. 文档与代码冲突时**以代码为准**，并顺手修正文档。
8. 用户已明确"暂缓"的项（脱敏等）不要动。

---

# 附：一句话总结

> 把评测的 `accuracy` 从"引证支持率"改成"根因概念匹配 + 证据支持 + 非干扰独证"的联合判定，
> 带版本口径重跑基线、显式作废旧数；再把易变事实收敛到 `docs/status.json` 并用 `docs:check`
> 挂进测试，让文档漂移必然失败。
