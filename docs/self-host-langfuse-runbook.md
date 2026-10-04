# Langfuse 自托管部署与迁移避坑手册（117.50.121.89 实机）

> 目的：换机器 / 重建环境时按本文走一遍即可复现，避开已经踩过的坑。
> 首次部署日期：2026-10-03/04。平台：Langfuse v4.50.0 六服务（官方 docker-compose 模板）。
> 配套部署资产：`deploy/langfuse/`（compose.yml、compose.mirror.cn.yml、.env.example、README）。

## 1. 网络事实（2026-10-03 实测，换机器时先重测）

| 目标 | 结果 | 结论 |
|---|---|---|
| `registry-1.docker.io`（Docker Hub） | dial tcp 超时 | **不可用** |
| `docker.langfuse.com` | `/v2/` 返回 307，实际重定向到 Docker Hub | **拉取不可用**（会以为官方源活着） |
| `m.daocloud.io` | 401（正常鉴权响应） | **推荐镜像源** |
| `docker.1ms.run` | 401 | 备用镜像源 |
| `cgr.dev`（chainguard） | 401 | **可直连**（MinIO 不用走代理） |
| github.com clone / raw.githubusercontent.com | 正常 | 可用 |
| registry.npmjs.org | 正常 | 可用 |
| ifconfig.me | 超时 | 别用它探测出口 |

教训：`docker.langfuse.com` 的 307 会让 `curl /v2/` 看起来"通"，但 `docker pull` 实际
被重定向到 Docker Hub 然后超时。判断官方源可用性要看 `docker pull` 的报错，不是 curl。

## 2. 镜像拉取（国内环境）

规则：Docker Hub 镜像在完整上游地址前加 `m.daocloud.io/`；非 Hub 仓库（cgr.dev）同样支持前缀，
但本机 cgr.dev 可直连。

```sh
# Langfuse Web/Worker（compose 引用名 docker.langfuse.com/...，经 Hub 副本代理）
docker pull m.daocloud.io/docker.io/langfuse/langfuse:4.50.0
docker pull m.daocloud.io/docker.io/langfuse/langfuse-worker:4.50.0
# 其余三件
docker pull m.daocloud.io/docker.io/clickhouse/clickhouse-server:25.12
docker pull m.daocloud.io/docker.io/library/postgres:17
docker pull m.daocloud.io/docker.io/library/redis:7
# MinIO 直连
docker pull cgr.dev/chainguard/minio:latest
```

两种接入 compose 的方式（本仓库选了①）：
1. **覆盖文件**（推荐）：`deploy/langfuse/compose.mirror.cn.yml` 只覆盖 image 名，
   一切命令带 `-f compose.yml -f compose.mirror.cn.yml`。不带 mirror 文件的 `docker compose pull`
   会去撞官方源然后失败——这是预期行为，不是坏了。
2. **重新打标签**：`docker tag` 成 compose 引用名后 `up -d --pull never`。

版本纪律：拉完记录摘要到 `deploy/langfuse/README.md`（`docker image inspect --format '{{join .RepoDigests " "}}'`）。
ClickHouse 25.12 的摘要与 2026-08-20 国内部署指南快照一致（sha256:8a790dd3…），说明代理源可信。

## 3. compose 启动顺序与首次初始化

```sh
cd /opt/ticket-doctor/deploy/langfuse
docker compose --env-file .env -f compose.yml -f compose.mirror.cn.yml config --quiet
docker compose --env-file .env -f compose.yml -f compose.mirror.cn.yml up -d
docker compose --env-file .env -f compose.yml -f compose.mirror.cn.yml ps
curl http://localhost:3001/api/public/health   # {"status":"OK","version":"4.50.0"}
```

**已踩过的坑：v4 的 `LANGFUSE_INIT_*` 自动建组织/项目/用户，必须同时设置
`LANGFUSE_INIT_ORG_ID`（和 `LANGFUSE_INIT_PROJECT_ID`），否则其他 INIT_* 变量全部被静默忽略**
（web 启动日志里只有一行 warn）。只设 EMAIL/PASSWORD 是不生效的。

`.env` 一致性三对值必须相同，否则启动后业务间互相鉴权失败：
- `DATABASE_URL` 里的密码 == `POSTGRES_PASSWORD`
- 三个 `LANGFUSE_S3_*_SECRET_ACCESS_KEY` == `MINIO_ROOT_PASSWORD`
- `LANGFUSE_INIT_PROJECT_PUBLIC_KEY/SECRET_KEY` 需带 `pk-lf-` / `sk-lf-` 前缀

`NEXTAUTH_URL` 必须等于浏览器实际访问地址（本机为 `http://117.50.121.89:3001`，
走 SSH 隧道就改成 `http://localhost:3001` 后重建 web 容器）。

## 4. 端口冲突（本机）

| 宿主端口 | 占用者 | 处置 |
|---|---|---|
| 3000 | ticket-doctor Host（宿主进程，node） | Langfuse Web → **3001** |
| 9090 | ticketing-mockwebhook 容器 | MinIO → **19090** |
| 3306/5432/6379/8123/9000/9091 | ticketing-db(MYSQL)/Langfuse 其余 | 无冲突 |

老 ticketing 演示栈（含 MySQL）与本项目无关，已停止未删除；恢复：
`sudo docker start ticketing-db-1 ticketing-server-1 ticketing-mockwebhook-1`。

## 5. Docker 数据根迁移到 /data（根分区告急时）

本机根分区 19G 曾用 91%，`/var/lib/containerd`（containerd image store，Docker 29 默认）7.8G +
`/var/lib/docker` 364M 是大头。迁移步骤（停机约 2 分钟）：

```sh
sudo systemctl stop docker.socket docker.service containerd
sudo rsync -aHAX /var/lib/containerd/ /data/containerd/
sudo rsync -aHAX /var/lib/docker/ /data/docker/
sudo du -sb /var/lib/containerd /data/containerd /var/lib/docker /data/docker   # 字节级对比，一致再删
sudo rm -rf /var/lib/containerd /var/lib/docker
# /etc/docker/daemon.json：保留原有 registry-mirrors，加 "data-root": "/data/docker"
# /etc/containerd/config.toml（新建）：version = 2 \n root = "/data/containerd"
sudo systemctl start containerd docker
```

坑：**ticketing-db/mockwebhook 的 RestartPolicy 是 no，docker 重启后不会自动回来**，
需要手动 `docker start`；langfuse 全系 always 自动恢复。迁移结果：根分区 39%，/data 44%。

## 6. 磁盘清理位（按收益排序）

- `sudo journalctl --vacuum-size=200M`（曾清出 1G）
- `sudo apt-get clean`（约 300M）
- Docker 构建缓存 `sudo docker builder prune -f`（曾清出 3.2G，先看 `docker system df`）
- `/root/.cache`、`/root/.npm`（约 560M，重建无害）
- 别删：`node:24-slim` 等 base 镜像（Docker Hub 被墙，删了只能从 DaoCloud 重新拉）

## 7. Host 侧观测接入配置（ticket-doctor）

依赖（方案 §8 固定版本，peer 一并装）：
```
@langfuse/otel@5.11.1  @langfuse/tracing@5.11.1
@opentelemetry/api@1.9.0  @opentelemetry/core@2.0.1
@opentelemetry/sdk-trace-base@2.0.1  @opentelemetry/exporter-trace-otlp-http@0.207.x
```
运行环境变量（写入 Host 运行环境，不入库不入日志）：
```
TD_OBSERVABILITY_ENABLED=true
LANGFUSE_BASE_URL=http://127.0.0.1:3001        # 本机同机部署；容器间用 http://<宿主IP>:3001
LANGFUSE_PUBLIC_KEY=pk-lf-...                  # deploy/langfuse/.env 已预置项目 key
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_TRACING_ENVIRONMENT=production
TD_OBSERVABILITY_MAX_EVENT_BYTES=524288
TD_OBSERVABILITY_SHUTDOWN_MS=5000
```
启用但缺配置：打印不含秘密的错误并降级不采集，业务不受影响。

pi SDK（0.84.2）关键事实，改观测代码前先核对：
- `Agent.streamFunction` 非可选（缺省即 streamSimple），compaction 复用同一函数 → 包装一处全量计数；
- 流契约：不 throw、失败以最终 AssistantMessage（stopReason=error/aborted）经 `result()` 传递；
- `onPayload` 经 agent loop 进入 stream options，链式包装即可捕获真实 provider 请求体。

已踩过的坑（2026-10-04 实测）：
- **`LangfuseSpanProcessor` 默认 `shouldExportSpan` 只放行官方 tracer 名的 span**，自建
  `BasicTracerProvider.getTracer("ticket-doctor")` 产生的 span 会被静默丢弃（无任何报错，
  ClickHouse 全空）。必须传 `shouldExportSpan: () => true`（本 provider 专用、无自动埋点，安全）。
- **v4 events_only 模式没有 legacy 查询 API**：`GET /api/public/traces` 返回
  "endpoint is not available"。验证数据落库直接查 ClickHouse：
  `docker exec langfuse-clickhouse-1 clickhouse-client --user clickhouse --password <.env 的 CLICKHOUSE_PASSWORD>
   --query "SELECT type, name, count() FROM events_core GROUP BY type, name"`。

端到端验证记录（2026-10-04）：`TD_ENGINE=pi npm run demo`（显式开观测）两轮真实调查 →
`events_core` 39 条：diagnose-turn trace ×2（共享同一 session=investigationId）、
diagnosis-attempt ×2、model-request generation ×11（usage 全部真实，cache_read 由
DeepSeek 返回）、tool ×22（query_logs/search_code/read_code/list_files/submit_report）、
report-validation ×2。

## 8. 快速重建清单（TL;DR）

1. 装依赖：`npm ci`（含 §7 的 OTel/langfuse 包）。
2. 拉镜像（§2）→ 起 Langfuse（§3）→ 健康检查。
3. 迁移 Docker 数据根到大盘（§5，可选）。
4. Host 侧配观测变量（§7）→ systemd 服务（§9）。
5. 生产 Host 接入（§9）。
5. 验证：跑一条真实调查，Langfuse Web（:3001）能看到 diagnose-turn trace。

## 9. 生产 Host 接入（本机 systemd，2026-10-04 实装）

- 服务单元：`/etc/systemd/system/ticket-doctor-host.service`（`npm run host`，User=ubuntu，
  WorkingDirectory=/opt/ticket-doctor，Restart=on-failure，日志进 journald）。
- 观测变量写在 `/opt/ticket-doctor/.env`（Host 启动时 loadDotEnv 读取）：`TD_OBSERVABILITY_ENABLED=true`、
  `LANGFUSE_BASE_URL=http://127.0.0.1:3001`、`LANGFUSE_PUBLIC_KEY/SECRET_KEY`（deploy/langfuse/.env 的项目 key）、
  `LANGFUSE_TRACING_ENVIRONMENT=production`。
- 常用命令：`sudo systemctl restart ticket-doctor-host`；日志 `journalctl -u ticket-doctor-host -f`。
- 验证：启动日志出现"Host 已启动"且**无**"观测已启用但缺少配置"告警 = recorder 初始化成功；
  从 Web（:3000）或飞书发起一条真实调查，Langfuse（:3001）应出现新 trace（session=investigationId）。
- 注意：Host 一直没有守护进程，2026-10-04 前曾静默挂掉；现在 systemd 开机自启 + 崩溃自动拉起。
