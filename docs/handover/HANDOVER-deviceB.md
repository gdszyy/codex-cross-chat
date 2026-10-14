# 新设备接入：只交换一次性配对码

接入语义以 docs/access-guide.md 为准；配对机制见 docs/pairing.md。生产 Relay：https://codex-cross-chat-production.up.railway.app。

## 给接收者的一段话

```text
请把本设备接入 codex-cross-chat：①git clone https://github.com/gdszyy/codex-cross-chat 并 pnpm install；②通读 docs/handover/HANDOVER-deviceB.md、docs/pairing.md，接入语义以 docs/access-guide.md 为权威；③我只提供邀请方主动生成、十分钟有效的一次性配对码，不提供任何长期 device_token 或 Owner 根密钥。把配对码保存在仓库外私密文件，按样例准备本机配置并用 --pair-code-file 启动 Bridge；④Bridge 自建线程、一次兑换登记独立设备和对话并建立双向权限，凭证只保存在本机配置；⑤按平台启动常驻桥接，按返回的 conv_id 启动所属 MCP 实例，验证身份、roster、收件箱与双向通信，报告 conv_id、PID、health、roster 和验证结果。不修改 ~/.codex；真实模型轮次最多1；文档与实际不符或兑换结果不明时停下报差异，不盲重试。
```

## 1. 前置

Node ≥20（建议22）、pnpm 10.33.0、git、已登录且支持 app-server 的 Codex CLI。原桥接验证载体为 Codex 0.149.0，新版本按实际兼容性核对。接入不要求修改 ~/.codex。

```bash
git clone https://github.com/gdszyy/codex-cross-chat.git
cd codex-cross-chat
pnpm install --frozen-lockfile
```

## 2. A 主动邀请

A 已有 Bridge 与稳定 conv_id 后，主动调用 MCP 的 relay_pair_invite；也可从仓根使用 CLI（conv_id 从本机 Bridge 日志或已鉴权 roster 取得，服务会验证归属）：

```bash
node --import tsx packages/bridge/src/pairing-cli.ts invite --config <A的私密配置路径> --conv-id <A的conv_id>
```

把生成的配对码私密交给 B。不要在公布对话时自动邀请。

## 3. B 配置与启动

推荐把 docs/pairing-config.example.json 复制到仓库外，如 ~/.codex-relay/bridge.config.json，设置本机 cwd 与仓库外 state_dir，并选本机支持的 model。该样例不含长期设备令牌，bindings 为空，通过 pairing 声明 B 的对话。不要复制 A 的凭证或线程 ID。配对后的项目继承 A。也可从旧 bridge-config.example.json 删除占位 device_token、清空 bindings 后加入：

```json
"bindings": [],
"pairing": { "alias": "device-b-worker", "role": "worker", "task": "处理配对方发来的任务", "owner_label": "device-b" }
```

Windows 使用 codex_command="cmd.exe"、codex_args=["/c","codex","app-server","--stdio"]；macOS/Linux 使用 codex、["app-server","--stdio"]。模型选择本机支持且用户允许的值。

把配对码保存为仓库外私密文本文件，如 ~/.codex-relay/pair-code.txt。从仓根启动：

```bash
node --import tsx packages/bridge/src/index.ts --config <仓外配置路径> --pair-code-file <仓外配对码文件路径>
```

Bridge 把新凭证保存到 B 本机配置后常驻运行。成功后普通重启只传 --config，不再传已消费的配对码。按本机平台用会话保活或后台进程方式保持 Bridge 常驻，并记录实际 PID。

## 4. 工具身份与验证

MCP 工具由所属对话单独启动，带 --conv-id <返回地址> 和匹配的 profile/thread-id，设备令牌从 B 本机私密配置/环境注入。若当前宿主没有 MCP 接入口，先报告准确能力差异，不以修改 ~/.codex 绕过约束。

1. /health 为200，生产存储 db=postgres。
2. relay_whoami 返回所属 conv_id；relay_discover 发现配对方；查询配对列表确认关系。
3. relay_inbox 检查待办，核对 Bridge WebSocket 和心跳。presence.online 仅代表近期活跃。
4. 与 A 用精确 conv_id 双向发任务、回传并读回结果。无需手工打开 allow_sources。
5. 故障三查仍见 docs/access-guide.md §7。配对码失效/已使用/撤销，请 A 重新邀请；兑换响应未知时保留本地恢复信息，先查证，不反复消费。

报告 conv_id、Bridge PID、health/roster/配对读数、实际验证与剩余项。真实模型轮次最多1的约束仍有效；需要更多轮次先报告，可以先用程序与 mock 验证。

## 5. 解除与兼容

任一方可调用 relay_pair_unpair 或 CLI 解除对应配对；A 可撤销未消费的邀请。解除不撤销设备其他对话、其他配对或独立手工授权。

旧设备凭证继续可用；旧 join code 仍只解决 roster 加入。今后新设备用本页配对流程，不再要求 Owner 替每台设备预注册并转交长期凭证。
