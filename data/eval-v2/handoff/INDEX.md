# 交接包索引（随提交更新）

| 包 | 基线/提交 | 内容 |
|---|---|---|
| phase1-d270c0a.tar.gz | d270c0a（未提交实现期） | 阶段一首轮验收 + FastAPI 7 资格 |
| phase1-supplement-1cf90c9.tar.gz | 1cf90c9（补充收尾实现未提交） | 补充收尾验收；impl-diff patch = 提交 f9560a0 内容 |
| phase1-close-520d7aa.tar.gz | 520d7aa（工作区干净） | 收尾二验收（私有硬链接/解析树扫描/夹具修正）；工作区无未提交实现 |

全部 tar 已随 git 提交入库（git add -f 豁免 data/ 忽略）。哈希见各 .sha256 与包内 FILELIST.sha256。
| phase1-close2-85b6e1b.tar.gz | 85b6e1b（收尾三，工作区干净） | 收尾三验收（泄漏归一化/读取失败记账/junction errno/私有答案硬链接反例）+ FastAPI 7 资料四件（REBUILD/准入表/gold 依据/复验）+ RECORD.md |
