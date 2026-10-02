# 评测交接包存档

- `phase1-d270c0a.tar.gz`（+.sha256）：阶段一首轮验收运行与 FastAPI 7 资格资料，基准 d270c0a。
- `phase1-supplement-1cf90c9.tar.gz`（+.sha256）：阶段一补充收尾验收（视图包含双向/硬链接/junction/
  版本核对矩阵/扫描完整性分离），基准 1cf90c9，含未提交实现补丁 `impl-diff/uncommitted-impl.patch`
  （可 `git apply` 到 1cf90c9 复现服务器工作区）。
- 校验：`sha256sum -c *.sha256`（各包内另有逐文件 FILELIST.sha256）。
- 说明：这些 tar 由 `git add -f` 定向豁免 `data/` 忽略规则入库；tar 内含制作侧私有答案
  （truth），仅供监督方与案例制作使用，不在诊断 Agent 工具可达范围内。
