# 项目资源与服务器迁移清单

> 用途：服务器到期换机时，按本文把 ticket-doctor 完整搬过去并跑起来。
> 现网服务器 IP 示例 `117.50.121.89`（换机后会变，涉及 `NEXTAUTH_URL` 的地方要同步改）。

## 1. 用到了什么

**外部服务（需要账号/密钥，无法随机器搬）**

| 服务 | 用途 | 凭据/配置 |
|---|---|---|
| 飞书 / Lark 开放平台 | 用户入口：群聊 @机器人 提 Bug；事件接入用**长连接**（无需公网回调） | 应用 `FEISHU_APP_ID`/`FEISHU_APP_SECRET`；机器人 `FEISHU_BOT_OPEN_ID`。后台事件订阅选「使用长连接接收事件」 |
| DeepSeek 开放平台 | 真实诊断模型（pi 引擎） | `DEEPSEEK_API_KEY`；`TD_PROVIDER=deepseek`、`TD_MODEL=<model>` |
| GitHub | 代码仓库 | `https://github.com/5quan/ticket-doctor.git` |

**自托管服务（随机器部署）**

| 服务 | 形态 | 说明 |
|---|---|---|
| ticket-doctor Host | 宿主进程 + systemd（`npm run host`） | Web API + SSE + 调度 + Runner；端口 `3000` |
| ticket-doctor Go 适配器 | 编译二进制 + systemd | 飞书长连接 → `POST /api/agent/message`；端口 `3002` |
| Langfuse v4.50.0 | Docker Compose 六容器 | Web `3001`、Worker `3030`、Postgres `5432`、Redis `6379`、ClickHouse `8123/9000`、MinIO `19090/9091`（除 Web/MinIO 外均仅绑定 `127.0.0.1`） |

> 说明：仓库还提供一份 `docker-compose.yml`（Host + Adapter 容器化）作为**备选**部署方式；现网实际用的是 **systemd 原生 + 本地 Langfuse 容器栈**，迁移按现网来。

## 2. 现网拓扑

```
飞书 ──长连接(WS)──► Go 适配器(:3002) ──HTTP──► Host(:3000) ──► 只读材料(源码/日志)
                                                     │
                                                     └──OTLP──► Langfuse(:3001) ──► Postgres/ClickHouse/MinIO/Redis
浏览器 ──────────────────────────────────────────────────────► Host Web(:3000)
```

## 3. 端口占用

| 端口 | 归属 | 绑定 |
|---|---|---|
| 3000 | Host Web/API | 0.0.0.0 |
| 3002 | Go 适配器 | 0.0.0.0 |
| 3001 | Langfuse Web | 0.0.0.0 |
| 3030 / 5432 / 6379 / 8123 / 9000 / 9091 | Langfuse Worker/Postgres/Redis/ClickHouse | 仅 127.0.0.1 |
| 19090 | Langfuse MinIO | 0.0.0.0（浏览器附件用） |

## 4. 需要迁移的资产

| 资产 | 现网位置 | 说明 |
|---|---|---|
| 代码 | `/opt/ticket-doctor`（git，`main`） | 从 GitHub 重新 clone 即可；`node_modules` 与 `adapters/go/adapter` 可重建 |
| 运行数据 | `/opt/ticket-doctor/data/`（gitignore） | SQLite `ticket-doctor.sqlite`、`sessions/`、评测材料（`eval-v2/`、`evolve/`、`lf-eval/` 等）；约 100M+ |
| Host 密钥 | `/opt/ticket-doctor/.env`（chmod 600） | 飞书、DeepSeek、观测开关；模板见 `.env.example` |
| 适配器密钥 | `/etc/ticket-doctor-adapter.env`（root:600） | 模板见 `deploy/systemd/ticket-doctor-adapter.env.example` |
| systemd 单元 | `/etc/systemd/system/ticket-doctor-{host,adapter}.service` | 副本已入库 `deploy/systemd/` |
| Langfuse 密钥 | `/opt/ticket-doctor/deploy/langfuse/.env`（chmod 600） | 模板 `deploy/langfuse/.env.example`；含 Postgres/MinIO/ClickHouse/Redis 密码与 `LANGFUSE_INIT_*` |
| Langfuse 数据 | Docker 命名卷 `langfuse_langfuse_{postgres,clickhouse,clickhouse_logs,minio,redis}_data` | 现网在 `/data/docker/volumes/`；约 3.3G（ClickHouse 最大） |
| Go 适配器二进制 | `/opt/ticket-doctor/adapters/go/adapter` | 可 `cd adapters/go && go build -o adapter .` 重建 |

**不要迁移**：旧 `ticketing-*` 演示栈容器（与本项目无关）、`archive/*` 分支（已在 tag）、`node_modules`（重装）。

## 5. 新服务器启动步骤

前置：Ubuntu、root/sudo、Docker + Compose、Node 22+（Host 用）、Go 1.22+（仅重建适配器用）；网络能到 GitHub / DeepSeek / 飞书（Langfuse 镜像按国内环境走镜像源，见 `docs/self-host-langfuse-runbook.md`）。

```bash
# 1) 代码
sudo mkdir -p /opt && cd /opt
git clone https://github.com/5quan/ticket-doctor.git
cd /opt/ticket-doctor && git checkout main
npm ci                      # 安装依赖（Node 22）

# 2) 运行数据（从旧机拷贝）
#    scp -r old:/opt/ticket-doctor/data ./data
#    或：只拷 ticket-doctor.sqlite + sessions，其余评测材料可重建

# 3) 密钥
cp .env.example .env && chmod 600 .env
#   填 FEISHU_APP_ID/SECRET/BOT_OPEN_ID、DEEPSEEK_API_KEY、TD_ENGINE=pi、
#   TD_RUNNER_MODE=process、TD_FEISHU_DIRECT=false、
#   TD_OBSERVABILITY_ENABLED=true、LANGFUSE_BASE_URL=http://127.0.0.1:3001
#   以及三个 LANGFUSE_* key（在 Langfuse 项目 Settings→API Keys 生成）
#   材料源按实际设置：TD_REPOS="app:/path/to/repo"、TD_LOG_DIR=/path/to/logs（默认用仓库内 fixtures）

# 4) Langfuse 六服务
cd /opt/ticket-doctor/deploy/langfuse
cp .env.example .env && chmod 600 .env    # 填密码；NEXTAUTH_URL 改成新机实际访问地址
docker compose --env-file .env -f compose.yml -f compose.mirror.cn.yml up -d
curl http://localhost:3001/api/public/health   # {"status":"OK",...}

# 5) Go 适配器
cd /opt/ticket-doctor/adapters/go && go build -o adapter .
sudo cp /opt/ticket-doctor/deploy/systemd/ticket-doctor-adapter.env.example /etc/ticket-doctor-adapter.env
sudo chmod 600 /etc/ticket-doctor-adapter.env   # 填 LARK_APP_ID/SECRET/BOT_OPEN_ID，ADAPTER_MODE=ws

# 6) systemd 服务
sudo cp /opt/ticket-doctor/deploy/systemd/ticket-doctor-{host,adapter}.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ticket-doctor-host ticket-doctor-adapter
systemctl status ticket-doctor-host ticket-doctor-adapter --no-pager
```

## 6. 迁移 Langfuse 数据（保留历史 trace/评测）

数据只在 Docker 命名卷里，代码不重建。旧机导出：

```bash
# 旧机（先停写）
cd /opt/ticket-doctor/deploy/langfuse
docker compose --env-file .env -f compose.yml -f compose.mirror.cn.yml down
sudo tar czf /tmp/langfuse-volumes.tgz -C /data/docker/volumes \
  langfuse_langfuse_postgres_data langfuse_langfuse_clickhouse_data \
  langfuse_langfuse_clickhouse_logs langfuse_langfuse_minio_data langfuse_langfuse_redis_data
# 新机解包后 docker compose up -d；六容器命名与卷名必须一致
```

> 若历史 trace 不重要，可跳过卷迁移：空库首次启动会按 `LANGFUSE_INIT_*` 自动建组织/项目/用户，重新生成 API key 写入 Host `.env` 即可。

## 7. 验证清单

```bash
curl -s http://127.0.0.1:3000/api/agent/capabilities | head    # Host 存活
curl -s http://127.0.0.1:3001/api/public/health                # Langfuse 存活
journalctl -u ticket-doctor-adapter -n 20 --no-pager           # 应见「已启动长连接事件源」
```

- 飞书群里 @机器人 发一条报错描述 → 应收到预检报告（真实端到端）。
- Host 观测开启时，Langfuse 项目里应出现对应 trace。
- 自改进链路的可复现验证（不需要付费模型）：`npm run typecheck && npm test && npm run docs:check`、`npm run evolve:config:verify`、`npm run evolve:review:verify`。

## 8. 换机注意（已踩过的坑）

- **IP 变化**：`deploy/langfuse/.env` 的 `NEXTAUTH_URL`、以及飞书回调（若用 webhook 模式）都要改成新地址；长连接模式无需公网回调。
- **端口冲突**：若新机 3000/3001/19090 被占，改 `TD_HOST_PORT` 与 compose 映射，并同步 `HOST_API_BASE`、`LANGFUSE_BASE_URL`。
- **镜像源**：国内环境 Docker Hub 直连不可用；务必带 `-f compose.mirror.cn.yml`（详见 `docs/self-host-langfuse-runbook.md`）。
- **Langfuse INIT**：v4 首次初始化必须同时设 `LANGFUSE_INIT_ORG_ID` / `LANGFUSE_INIT_PROJECT_ID`，否则其它 `INIT_*` 被静默忽略。
- **三个密码一致性**：`DATABASE_URL` 密码 == `POSTGRES_PASSWORD`；三个 `LANGFUSE_S3_*_SECRET_ACCESS_KEY` == `MINIO_ROOT_PASSWORD`。
- **Node 版本**：Host 用系统 Node 22；自改进交付 C（GEPA）另需 Node 24.9 + Python 3.13 + gepa（`scripts/evolve-env-setup.sh`）。
- **凭据保密**：`.env`、`/etc/ticket-doctor-adapter.env`、`deploy/langfuse/.env` 都是 600 且**不入库**；迁移走加密通道，不要贴到聊天/工单。
