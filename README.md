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
RELAY_ROOT_KEY=dev-key pnpm --filter @relay/relay start      # 默认 http://127.0.0.1:8788

# 2) 注册一台设备（拿 device_token）
curl -s -X POST http://127.0.0.1:8788/v1/devices/register \
  -H "x-root-key: dev-key" -H "content-type: application/json" \
  -d '{"owner_label":"owner"}'

# 3) 起桥接（把上一步的 device_token 填进配置）
cp docs/bridge-config.example.json bridge.config.json
pnpm --filter @relay/bridge start -- --config ../../../bridge.config.json
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

1. **建服务**：Railway → New Project → **Deploy from GitHub repo** → 选本仓对应分支。Railway 以容器为单元部署；推送新提交会自动重建部署（`docs/m1-platform-research.md` §1.4）。
2. **加数据库**：同项目内 **Add → PostgreSQL**。数据库**默认私有**，同项目服务经 private network 可达（§1.3）。
3. **绑定注入 `DATABASE_URL`**：在 relay 服务的 Variables 里**引用**数据库的 `DATABASE_URL`（Reference，**绑定注入、非手工填写**）。relay 有它就走 `pg` 驱动，没有则回退内嵌 pglite——生产必须注入。走**私有** `DATABASE_URL`，**不要**开 Public Access 用 `DATABASE_PUBLIC_URL`（会按 Network Egress 计费）。
4. **唯一手工变量**：`RELAY_ROOT_KEY=<高熵令牌>`（生成与轮换见下）。全系统**只有它**一个手工密钥。
5. **检查项 · Serverless 必须保持关闭**：Railway 的 Serverless 一旦启用，服务空闲 5–10 分钟即休眠，首个请求冷启动**且可能返回 502**，直接打断常驻 WebSocket（官方原文见 `docs/m1-platform-research.md` §1.1）。部署后到服务 Settings 确认 **Serverless 未启用**。
6. **网络入口**：公网入口必须 HTTPS / TLS 1.2+；WebSocket 走标准 TLS 端口，官方明确"可长期闲置保持"（§1.2）。
7. **健康检查与重启行为**：本版**没有独立 `/health` 路由**，以端口监听作为健康信号（如需专用健康端点可另加）。平台侧重启 / 重部署**不是平滑停机**，连接会被断开——这正是设计上把"重连与持久化"当正常路径的原因：桥接断线后按指数退避重连（单次上限 60 s），每次重连先 **resume 持久游标**、再**补拉 `inbox`**，把离线期间入队的请求补执行（`packages/bridge/src/bridge.ts` `onConnected` / `pullInbox`）。
8. **数据库备份**：Railway 的 Backups 需自行开启（非默认），并按方案做一次恢复演练。
9. **部署前须知（代码现状，须先确认）**：入口 `packages/relay/src/index.ts:27` 调 `relay.listen(port)`，而 `packages/relay/src/server.ts:59` 的 host 默认 `127.0.0.1`。容器托管平台（含 Railway）的边缘通常要求服务监听**容器可路由地址**（一般 `0.0.0.0`）。首版未提供 `HOST` 开关，**部署前需确认/补上监听地址**，否则平台可能连不上。

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
RELAY_ROOT_KEY=dev-key pnpm --filter @relay/relay start       # 内嵌库；默认 http://127.0.0.1:8788
pnpm --filter @relay/bridge start -- --config docs/bridge-config.example.json
```

relay 默认监听 `127.0.0.1:8788`；**不设 `DATABASE_URL` → 用内嵌库**，设了才走真 PG（`packages/relay/src/index.ts`）。

## 消息语义要点

- **结果通知按条目幂等**：同一 `result_id` 只向原对话推一轮，重复事件不重推。
- **新口径**：RESULT 之后**每条到达的新 STATUS 会作为新条目、在原对话各起一轮**（进度播报，非"回信"；与"结果不自动回信"不冲突）。
- RESULT/STATUS 等待用户或材料时如实上报；**无终态不写完成**（`result_missing`）。

## 约束

- 桥接**不写** `~/.codex`（只用 App Server 接口；运行钉定 CLI 时由 CLI 自己落 rollout）。
- 唯一手工环境变量＝连接密钥；其余参数全为数据库配置项带默认值。
- 首版只接 **T1 桥接自建对话**；既有 paginated 桌面对话（T2）在当前栈上不支持自动接入
  （见 `docs/m1-compat-report.md` §6.1 与对账表 C1）。
