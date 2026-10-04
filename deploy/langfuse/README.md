# Langfuse v4.50.0 自托管部署（ticket-doctor 观测平台）

依据《ticket-doctor：Langfuse Web 观测接入实施方案》第 9 节，基于官方
`langfuse/langfuse` 仓库 `v4.50.0` tag 的 `docker-compose.yml` 做最小改动生成。

## 文件

| 文件 | 用途 |
|---|---|
| `compose.yml` | 官方 v4.50.0 模板 + 最小改动：Web/Worker 版本固定 4.50.0；Web 宿主端口 3000→**3001**（避开本机 ticket-doctor Host 的 3000）；MinIO 宿主端口 9090→**19090**（避开 ticketing-mockwebhook 的 9090）；全部服务加 json-file 日志轮转（10MB×3） |
| `compose.mirror.cn.yml` | 仅覆盖镜像来源（Docker Hub 直连不可达，经 m.daocloud.io）。cgr.dev 的 MinIO 可直连，不覆盖 |
| `.env` | 运行密钥与首次初始化用户（chmod 600，**勿提交**） |
| `.env.example` | 密钥生成说明模板 |

与官方模板的其余行为（六服务、命名卷持久化、健康检查、内部网络）完全一致。

## 命令

```sh
cd /opt/ticket-doctor/deploy/langfuse
docker compose --env-file .env -f compose.yml -f compose.mirror.cn.yml config --quiet
docker compose --env-file .env -f compose.yml -f compose.mirror.cn.yml pull
docker compose --env-file .env -f compose.yml -f compose.mirror.cn.yml up -d
docker compose --env-file .env -f compose.yml -f compose.mirror.cn.yml ps
docker compose --env-file .env -f compose.yml -f compose.mirror.cn.yml logs --tail=100
```

不带 `-f compose.mirror.cn.yml` 的命令会对官方源 pull/检查，在本机会因网络阻塞失败——
这是已验证的网络事实（registry-1.docker.io 超时；docker.langfuse.com 307 重定向到 Docker Hub）。

## 端口占用说明（本机实测）

| 宿主端口 | 归属 | 说明 |
|---|---|---|
| 3000 | ticket-doctor Host（宿主进程） | 冲突源，故 Langfuse Web 用 3001 |
| 9090 | ticketing-mockwebhook 容器 | 冲突源，故 MinIO 用 19090 |
| 3001 / 19090 | **Langfuse Web / MinIO** | 新增 |
| 3306 | ticketing-db (MySQL) | 与 Langfuse 无冲突 |
| 5432 / 6379 / 8123 / 9000 / 9091 / 3030 | Langfuse 其余服务 | 仅绑定 127.0.0.1 |

`NEXTAUTH_URL=http://117.50.121.89:3001`；若实际入口是 SSH 隧道（`ssh -L 3001:localhost:3001`），
把 `.env` 中 NEXTAUTH_URL 改为 `http://localhost:3001` 后重建 web 容器。

## 凭据位置

- 登录用户：`.env` 的 `LANGFUSE_INIT_USER_EMAIL` / `LANGFUSE_INIT_USER_PASSWORD`
  （仅在空库首次启动时自动创建：组织 `ticket-doctor`、项目 `ticket-doctor`）。
- 项目 API key：登录 Web 后在项目 Settings → API Keys 生成；写入 ticket-doctor Host 运行环境，
  不进入消息、日志或文档。

## 镜像摘要（拉取后记录）


| 镜像（compose 引用名） | 实际来源与摘要（docker inspect RepoDigests） |
|---|---|
| `docker.langfuse.com/langfuse/langfuse:4.50.0` | m.daocloud.io/docker.io/langfuse/langfuse@sha256:3d2ae888a0e6edb41fdba6e7d5baca5e4baede3a870dac7970dadd9d925b018e |
| `docker.langfuse.com/langfuse/langfuse-worker:4.50.0` | m.daocloud.io/docker.io/langfuse/langfuse-worker@sha256:52f7fd41ded2f1a6acab13ff7cb1832d36dfe2cbf44adea402b7a09cfa4ce800 |
| `docker.io/clickhouse/clickhouse-server:25.12` | m.daocloud.io/docker.io/clickhouse/clickhouse-server@sha256:8a790dd3468db22b1d4e7b18a176f378ff5ff6053b9c48dd4ea1fa71a24c |
| `docker.io/postgres:17` | m.daocloud.io/docker.io/library/postgres@sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f |
| `docker.io/redis:7` | m.daocloud.io/docker.io/library/redis@sha256:c6eabf748fc7a61dbb5a705c78bcf3d6377b1127a97d0ce965c11c44ba46896f |
| `cgr.dev/chainguard/minio:latest` | cgr.dev/chainguard/minio@sha256:4cf4831a2bbcf13ddca09c1cbcc9faff716dd3c4247e0babc32864b8ee8e0034 |


## 资源与已知限制

- 实机 2 核 / 3.8GiB / 无 swap（按方案 9.1 未创建 swap）。官方建议 4 核 16GiB，
  本机按"尽力启动"原则运行标准模板：一次一个调查、纯文本、不跑批量实验。
- 因根分区容量不足，2026-10-04 已将 Docker 数据迁至 /data：`/etc/docker/daemon.json`
  增加 `"data-root": "/data/docker"`，`/etc/containerd/config.toml` 设
  `root = "/data/containerd"`。迁移后根分区 39%，/data 44%。
- 老 ticketing 演示栈（含 MySQL）已停止（只停未删，`sudo docker start ticketing-db-1
  ticketing-server-1 ticketing-mockwebhook-1` 可恢复）；其 MySQL 与本项目无关。
- 观测为 best-effort：Langfuse 离线或过载时允许丢观测，业务会话不受影响。
- 排查失败时不执行 `docker compose down -v`（保留数据卷）。
