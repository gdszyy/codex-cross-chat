# codex-relay — Codex 跨设备对话通信（M2 实现）

把不同设备上的指定 Codex 对话连起来：互相派任务、查进度、回传结果。
架构＝**Railway 消息中转服务 ＋ 每台设备的本地桥接程序 ＋ Codex 通信工具**（方案正本 `docs/plan-v1.md`）。

> 设计权威：`docs/mechanism-design.md` v1.1。本仓实现严格按它的接口表（§9 十八接口）、
> 三层状态（§5.2）、去重与启动窗口（§5.3）、链上限（§5.4）、权限与 64KB（§6）、运行参数（§7.2）。
> 对账表：`docs/m2-reconciliation.md`。

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

## 约束

- 桥接**不写** `~/.codex`（只用 App Server 接口；运行钉定 CLI 时由 CLI 自己落 rollout）。
- 唯一手工环境变量＝连接密钥；其余参数全为数据库配置项带默认值。
- 首版只接 **T1 桥接自建对话**；既有 paginated 桌面对话（T2）在当前栈上不支持自动接入
  （见 `docs/m1-compat-report.md` §6.1 与对账表 C1）。
