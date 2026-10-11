# codex-relay — Codex 跨设备对话通信（M2 实现）

把不同设备上的指定 Codex 对话连起来：互相派任务、查进度、回传结果。
架构＝**Railway 消息中转服务 ＋ 每台设备的本地桥接程序 ＋ Codex 通信工具**（方案正本 `docs/plan-v1.md`）。

> 设计权威：`docs/mechanism-design.md` v1.1。本仓实现严格按它的接口表（§9 十八接口）、
> 三层状态（§5.2）、去重与启动窗口（§5.3）、链上限（§5.4）、权限与 64KB（§6）、运行参数（§7.2）。
> 对账表：`docs/m2-reconciliation.md`。**接入一个 Codex 对话**：见 `docs/access-guide.md`。

## 包结构

| 包 | 作用 |
| --- | --- |
| `packages/relay` | 中转服务：HTTP＋WebSocket，PostgreSQL 为事实源 |
| `packages/protocol` | 共享类型与常量（三层状态、§7.2 参数默认值） |
| `packages/bridge` | 桥接守护：连 relay，经 `codex app-server --stdio` 驱动 Codex；含 MCP 工具与 skill |
| `packages/mock-codex` | 假 App Server（stdio JSON-RPC）＋故障注入，作为测试床 |

## 快速开始

```bash
pnpm install

# 1) 起中转服务（本机用嵌入式 PG；生产设 DATABASE_URL 走真 PG）
#    唯一手工环境变量是连接密钥
RELAY_ROOT_KEY=dev-key pnpm --filter @relay/relay start      # 默认 0.0.0.0:8788（本地只回环加 HOST=127.0.0.1）

# 2) 注册一台设备（拿 device_token）
curl -s -X POST http://127.0.0.1:8788/v1/devices/register \
  -H "x-root-key: dev-key" -H "content-type: application/json" \
  -d '{"owner_label":"owner"}'

# 3) 起桥接（把上一步的 device_token 填进配置）
cp docs/bridge-config.example.json bridge.config.json
pnpm --filter @relay/bridge start -- --config ../../../bridge.config.json
```

### 桥接的启动形态（平台差异）

`codex_command` / `codex_args` 是**按平台不同**的，写错会在桥接启动时直接失败（表现为 codex 子进程起不来）：

| 平台 | `codex_command` | `codex_args` | 失败形态（实测） |
| --- | --- | --- | --- |
| macOS / Linux | `codex` | `["app-server","--stdio"]` | — |
| **Windows** | `cmd.exe` | `["/c","codex","app-server","--stdio"]` | 裸名 `codex` → `ENOENT`；指向 `codex.cmd` 的全路径 → `EINVAL` |

`docs/bridge-config.example.json` 里两种形态都给了（Windows 形态在 `_codex_command_windows`）；本机 Windows 用 `cmd.exe` 形态。`heartbeat_ms` 控制桥接心跳间隔（默认 60s），它同时决定 **对话 presence 的刷新频率**：桥接会把本机已登记的 `conv_id` 随每次心跳上报，服务端据此刷新这些对话的 `last_seen_at`（机制设计 §2.2 `presence.mode=heartbeat`）。

```bash
# Windows 起桥接（PowerShell）
node --import tsx packages\bridge\src\index.ts --config C:\path\to\bridge.config.json
```

## 测试

```bash
pnpm --filter @relay/relay test     # 契约 + 反向断言（真 HTTP/WS 链路）
pnpm --filter @relay/bridge test    # 集成 + 恢复 + MCP 契约 + 单测（真 relay + mock App Server 子进程）
```

## 本机双实例闭环（交付物 7）

```bash
npx tsx scripts/dual-instance.ts --mock          # 预演（不花模型额度）
npx tsx scripts/dual-instance.ts                 # 真实 Codex（钉定 0.149.0，低成本模型）
npx tsx scripts/dual-instance.ts --only=rev      # 只跑反向
```

证据落 `evidence/m2/`。真实轮次最小化：每方向 ≤2 轮。

## 部署（Railway）

> **本仓目前只到"部署就绪"，不执行部署**——以下步骤由 Owner 复核后自行执行；本机未注册任何外部服务。

1. **建服务**：Railway → New Project → **Deploy from GitHub repo** → 选本仓对应分支。**服务根＝仓根**：仓根有 `Dockerfile`（`node:22-bookworm-slim` ＋ corepack 启用 pnpm 10.33.0 ＋ `pnpm install --frozen-lockfile`（含 devDeps，生产用 tsx 跑 TS）＋ `CMD ["pnpm","--filter","@relay/relay","start"]`），Railway 检出到 Dockerfile 即**自动用它构建**（官方原文见 `docs/m1-platform-research.md` §1.4）；配套 `.dockerignore` 排除 `node_modules`/`.git`/`.tmp` 等，避免把本机安装带进镜像。若构建器未走 Dockerfile，兜底＝根 `package.json` 的 `start` 脚本（同一条命令）。推送新提交会自动重建部署。
2. **加数据库**：同项目内 **Add → PostgreSQL**。数据库**默认私有**，同项目服务经 private network 可达（§1.3）。
3. **绑定注入 `DATABASE_URL`**：在 relay 服务的 Variables 里**引用**数据库的 `DATABASE_URL`（Reference，**绑定注入、非手工填写**）。relay 有它就走 `pg` 驱动，没有则回退内嵌 pglite——生产必须注入。走**私有** `DATABASE_URL`，**不要**开 Public Access 用 `DATABASE_PUBLIC_URL`（会按 Network Egress 计费）。
4. **唯一手工变量**：`RELAY_ROOT_KEY=<高熵令牌>`（生成与轮换见下）。全系统**只有它**一个手工密钥。
5. **检查项 · Serverless 必须保持关闭**：Railway 的 Serverless 一旦启用，服务空闲 5–10 分钟即休眠，首个请求冷启动**且可能返回 502**，直接打断常驻 WebSocket（官方原文见 `docs/m1-platform-research.md` §1.1）。部署后到服务 Settings 确认 **Serverless 未启用**。
6. **网络入口**：公网入口必须 HTTPS / TLS 1.2+；WebSocket 走标准 TLS 端口，官方明确"可长期闲置保持"（§1.2）。
7. **健康检查与重启行为**：已提供**无鉴权**健康端点 `GET /health`（恒 `200 {"ok":true}`，零敏感信息、不需根密钥或设备令牌），可在服务 Settings 里把它设为 Healthcheck Path。平台侧重启 / 重部署**不是平滑停机**，连接会被断开——这正是设计上把"重连与持久化"当正常路径的原因：桥接断线后按指数退避重连（单次上限 60 s），每次重连先 **resume 持久游标**、再**补拉 `inbox`**，把离线期间入队的请求补执行（`packages/bridge/src/bridge.ts` `onConnected` / `pullInbox`）。
8. **数据库备份**：Railway 的 Backups 需自行开启（非默认），并按方案做一次恢复演练。
9. **持久性（必检，实测踩过）**：relay 的**事实源必须是 Railway 上的 PostgreSQL 服务**（项目内 `DATABASE_URL` 绑定注入）。若 `DATABASE_URL` 未绑定，relay 会退回**容器内嵌入式 pglite**，数据落在临时文件系统上——**每次重新部署即全部丢失**：设备与花名册归零（`GET /v1/admin/overview` 的 `devices`/`roster_count` 变 0），已下发的 `device_token` 全部返回 `401 unauthorized unknown device token`。**检查判据**：① 项目内存在 PostgreSQL 服务且 relay 服务已引用它（Variables 里能看到 `DATABASE_URL`，而非仅在本地或未设置）；② 做一次**重新部署**，重部署后 `GET /v1/admin/overview`（根密钥）的 `devices`/`roster_count` **不得归零**——归零即说明落在临时盘上，须先绑库再继续。
   **已实证（2026-10-11 12:1x）**：Railway 变量必须写 **`DATABASE_URL` = `${{Postgres.DATABASE_URL}}`（双花括号引用语法）**——单花括号写法保存后**不生效**，`/health` 仍报 `db=pglite`（本轮实测踩过，且面板"变量区在列"并不构成已生效的证据）。变量写对后重部署：设备 `dev-3mi5` 与对话 `c-pl1wdg` **幸存**（`devices=1/roster_count=1`、对话 `presence.online=true`/`mode=heartbeat`），证据 `evidence/m3/persistence-final-20261011-121100.json`；**快速判据＝`GET /health` 的 `db` 字段**（`postgres`=已绑持久库，`pglite`=临时盘）。
10. **监听地址（已解决）**：生产入口 `packages/relay/src/index.ts` 按 `HOST` 环境变量绑定，**默认 `0.0.0.0`**（容器可路由，平台边缘可达）；本地只回环时设 `HOST=127.0.0.1`。`HOST` 是**带默认值的可选项**，不影响"`RELAY_ROOT_KEY` 是唯一必填手工变量"。（`packages/relay/src/server.ts` 的 `listen(port, host)` 默认仍为 `127.0.0.1`，供测试/嵌入式调用。）

### 连接密钥的生成与轮换

`RELAY_ROOT_KEY` 是唯一手工密钥，**绝不入 git、不进日志、不进任何文档**。

生成（任选其一）：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # ≥32 字节熵
python -c "import secrets;print(secrets.token_urlsafe(32))"
```

本机演练用的落地位置（私有 env 目录，**不在仓库内、不被 git 跟踪**）：

```
C:\Users\Administrator\.minimax\env\env.codex-relay.local     # 一行：RELAY_ROOT_KEY=<token>
```

轮换：新令牌写入上述 env 载体并在 Railway 服务 Variables 覆盖 `RELAY_ROOT_KEY` → 触发一次重新部署；旧值随部署失效。轮换只换根密钥，**设备令牌不受影响**（改根密钥不撤销已登记设备；要连设备一起作废用 `POST /v1/devices/{id}/revoke`）。

## 本地开发模式（内嵌库）

本机无 docker / psql（`docs/m1-platform-research.md` §3），故本地**不依赖系统 PostgreSQL**：relay 与桥接都用嵌入式 PostgreSQL `@electric-sql/pglite`（真 PG 的 WASM 构建），**同一套 SQL**，生产切 `pg` 驱动即可。

```bash
pnpm install
RELAY_ROOT_KEY=dev-key pnpm --filter @relay/relay start       # 内嵌库；默认 0.0.0.0:8788（本地只回环可加 HOST=127.0.0.1）
pnpm --filter @relay/bridge start -- --config docs/bridge-config.example.json
```

relay 入口默认监听 `0.0.0.0:8788`（容器托管用）；**本地只回环**请显式设 `HOST=127.0.0.1`。**不设 `DATABASE_URL` → 用内嵌库**，设了才走真 PG（`packages/relay/src/index.ts`）。健康检查端点：`GET /health`。

## 消息语义要点

- **结果通知按条目幂等**：同一 `result_id` 只向原对话推一轮，重复事件不重推。
- **新口径**：RESULT 之后**每条到达的新 STATUS 会作为新条目、在原对话各起一轮**（进度播报，非"回信"；与"结果不自动回信"不冲突）。
- RESULT/STATUS 等待用户或材料时如实上报；**无终态不写完成**（`result_missing`）。

## 约束

- 桥接**不写** `~/.codex`（只用 App Server 接口；运行钉定 CLI 时由 CLI 自己落 rollout）。
- 唯一手工环境变量＝连接密钥；其余参数全为数据库配置项带默认值。
- 首版只接 **T1 桥接自建对话**；既有 paginated 桌面对话（T2）在当前栈上不支持自动接入
  （见 `docs/m1-compat-report.md` §6.1 与对账表 C1）。
