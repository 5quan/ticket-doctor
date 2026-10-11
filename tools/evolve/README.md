# tools/evolve — GEPA 自改进适配器（交付 C）

对应方案 `docs/self-improvement-implementation-plan.md` §6。只优化 `diagnosis_rules`，
诊断与评分全部由 TypeScript 桥梁 `scripts/evolve-batch.ts` 执行；本目录只做搜索编排。

## 环境

```bash
bash scripts/evolve-env-setup.sh         # Node 24.9 + Python 3.13 + gepa 0.1.4
```

## 结构

| 文件 | 作用 |
|---|---|
| `config.py` | 读取冻结搜索配置 `evolve/config/search-v1.json` |
| `bridge.py` | 子进程 + stdin 调用 TS 桥梁（不拼 shell；退出码 3 = 系统性失败） |
| `adapter.py` | `GEPAAdapter`：`evaluate` 按 split 分组批量评测；`make_reflective_dataset` 产出反思样本 |
| `reflection.py` | 反射 LM（DeepSeek OpenAI 兼容接口，标准库实现） |
| `optimize.py` | 搜索入口：校验配置 → 跑 GEPA → 出报告与 `best-rules.md` |

## 运行

```bash
# 配置校验（fail-closed）
npm run evolve:config:verify

# 自测（不触网、不跑真实模型）
/opt/venvs/ticket-doctor-gepa/bin/python -m unittest tools.evolve.tests.test_adapter -v

# 真实搜索（需要 DEEPSEEK_API_KEY 与预算）
/opt/venvs/ticket-doctor-gepa/bin/python -m tools.evolve.optimize \
  --config evolve/config/search-v1.json \
  [--seed-rules <file>] [--max-metric-calls 200] [--out data/evolve/gepa/run1]
```

产物（`data/evolve/gepa/<run>/`）：`report.json`（均值/增益/退化/用量/结论）、`best-rules.md`、
`gepa/`（GEPA 检查点）。

## 契约与护栏

- 候选 = `{"diagnosis_rules": 规则全文}`；基础 prompt/工具/案例/评分器不参与优化。
- `repeat` 不改变 batch 长度：一个 case 一个均值分，原始 trial 存进 trajectory。
- holdout 案例（`rcb-008/009`）在 `evaluate` 内被直接拒绝，不会进入搜索。
- 预算：默认 `monitor`（trial 间累计，非请求前硬拦截）；`MaxTokensStopper` 在超额时停止。
- 结论（`adopt-candidate` / `keep-baseline`）由均值增益 + 基线通过用例是否退化决定；**发布仍需人工审核**（交付 D）。
