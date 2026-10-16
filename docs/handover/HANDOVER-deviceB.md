# 新设备接入：一次性配对 + 原接入桌面对话

本页回答“如何接入”；接好之后的能力、操作示例和实际边界见 [接入后能做什么](../usage-guide.md)。

接入语义以 [access-guide.md](../access-guide.md) 为准；配对机制见 [pairing.md](../pairing.md)，原生气泡见 [native-task-messages.md](../native-task-messages.md)。生产 Relay：https://codex-cross-chat-production.up.railway.app。2026-10-15 两台物理设备的两个全新请求及两端原生气泡已完成验证，见 [实测记录](../native-task-verification.md#v023-发布后的两个全新物理设备请求)。

## 给接收者的一段话

```text
请把本设备接入 https://github.com/gdszyy/codex-cross-chat，只在当前这个原接入桌面对话接收并处理来信，不新建执行对话或“跨设备接收器”，不要求跨任务来源行。复用已有仓库和依赖，检查远端最新版；首次安装按锁文件准备。阅读 docs/handover/HANDOVER-deviceB.md、docs/pairing.md、docs/desktop-inbox.md，以 docs/access-guide.md 为权威。核实当前原对话准确UUID、匹配桌面历史结构的公开App Server运行时以及metadata/完整分页历史/队列的真实可用性；Relay须支持desktop_inbox许可。准备仓库及~/.codex外的私密配置和state，再让我提供十分钟配对码。新设备从一开始用execution_mode=desktop_inbox、bindings=[]，pairing.desktopThreadId填当前原对话UUID，不填其他设备token；仅兑换一次，由服务把独立凭证保存在本机。已有配对则保留device_id/device_token、conv_id、注册threadId、pairing和state_dir，先确认无在途任务，停止旧Bridge，再按desktop-inbox文档迁移desktopThreadId和配置，不重新配对、不冒用lost_local_thread重绑。不要创建/恢复额外执行线程、不要抢占桌面writer，不改~/.codex或历史数据库，不输出或提交密钥。只保留一个Bridge；公开队列accepted不是执行成功，必须核对原对话真实消费、唯一轮次、真实relay_read/evidence和没有新增对话。已有relay MCP优先，无入口则用仓库RelayClient读取本机私密token。旧额外对话待迁移验证和责任交接后才能退出，不删状态或未知作业。失效配对码、兑换未知、协议或权限不符时停止受影响动作如实报告，禁止mock、盲重试、自动回信或转派。业务测试每请求最多一轮；缺少对端零模型发送入口时准备不含凭证的脚本给我转交，不用QUERY要求模型再发QUERY。完成后报告版本/提交、原桌面ID、conv_id、pairing_id、Bridge PID、health/WS/roster和真实请求结果，保持Bridge运行。
```

## 1. 前置

Node ≥20（建议22）、pnpm 10.33.0、git、已登录且支持 app-server 的公开 Codex 运行时和实际原桌面对话。旧 managed/native_task 的验证载体为 CLI **0.149.0**；它已实际不能解析新版桌面的一类历史记录，不能据旧验证推荐它用于 desktop_inbox。新模式的只读协议预检使用桌面自带 **0.162.0-alpha.17.2** 成功读取 metadata、队列和完整历史；这还不是完整新模式物理实测。各机应选择匹配桌面结构的运行时并真实预检，不能只凭版本号声称兼容。接入不要求修改 ~/.codex。

先完成仓库、依赖、私密短路径目录和原对话公开API能力准备，再申请十分钟配对码，避免准备过程中耗尽有效期。已有仓库先检查分支/改动并 fetch；不能覆盖未提交工作。已有依赖且锁文件未变时复用，不重复安装。下列命令用于首次安装：

```bash
git clone https://github.com/gdszyy/codex-cross-chat.git
cd codex-cross-chat
pnpm install --frozen-lockfile
```

最新版接入文档以 GitHub 默认分支为准，记录实际代码提交；本次已验证的程序发布版为 v0.2.3，文档后续更新不会移动版本标签。没有原生发送工具时，可以报告通信准备情况，但不能把普通 desktop_queue 消息当成原生气泡通过。

如果发现本机已有有效配置：保留 device_id/device_token、convId、注册 threadId、state_dir 和配对；按 [单原对话迁移](../desktop-inbox.md#已配对设备迁移) 配置，不申请新码、不重建身份。

## 推荐：从首次接入就使用原对话

按 [desktop_inbox](../desktop-inbox.md) 和 [配置样例](../desktop-inbox-config.example.json) 准备：配置中设置 `execution_mode: "desktop_inbox"`；新设备保留空 bindings，在 pairing 中显式填写准确原桌面的 `desktopThreadId`，不设置旧 result_delivery_mode/native_inbox_dir，也不创建原生接收器。先核实服务端能力及匹配运行时再兑换，成功安全保存后仅用原配置重启。服务端/公开API不可用时停止，不自动退回下面的三角色路径。

下面第3、4节保留给**明确选择旧 managed/native_task 模式**的设备，不是推荐单原对话的步骤；其额外对话和转发开销须另有用户明确授权。

## 2. A 主动邀请

A 已有 Bridge 与稳定 conv_id 后，主动调用 MCP 的 relay_pair_invite；也可从仓根使用 CLI（conv_id 从本机 Bridge 日志或已鉴权 roster 取得，服务会验证归属）：

```bash
node --import tsx packages/bridge/src/pairing-cli.ts invite --config <A的私密配置路径> --conv-id <A的conv_id>
```

把生成的配对码私密交给 B。不要在公布对话时自动邀请。

## 3. 旧 managed/native_task：B 配置与启动

推荐把 docs/pairing-config.example.json 复制到仓库外的私密短路径目录，设置本机有效 cwd、仓库/.codex 外的短路径 state_dir，并选本机支持且用户允许的 model。该样例以 manual_read 完成首次引导，不含长期设备令牌，bindings 为空，通过 pairing 声明 B 的对话。不要复制 A 的凭证或线程 ID。配对后的项目继承 A。也可从旧 bridge-config.example.json 删除占位 device_token、清空 bindings 后加入：

```json
"bindings": [],
"pairing": { "alias": "device-b-worker", "role": "worker", "task": "处理配对方发来的任务", "owner_label": "device-b" }
```

Windows 使用 codex_command="cmd.exe"、codex_args=["/d","/s","/c","codex app-server --stdio"]；macOS/Linux 使用 codex、["app-server","--stdio"]。模型选择本机支持且用户允许的值。

**首次配对不要直接设置 native_task**：该模式要求已有设备凭证和完整绑定。先按空 bindings 完成配对，再做第4节的串行切换。桌面对话 UUID、Bridge 执行线程 UUID、接收器 UUID 和 Relay conv_id 是不同身份，不能互相替换。

把配对码保存为仓库外私密文本文件，如 ~/.codex-relay/pair-code.txt。从仓根启动：

```bash
node --import tsx packages/bridge/src/index.ts --config <仓外配置路径> --pair-code-file <仓外配对码文件路径>
```

核实 Bridge 回执和安全保存的配置确实包含本设备的 device_id/device_token、conv_id、peer_conv_id、pairing_id，随后删除已消费的配对码文件，不打印码或 token。Bridge 把新凭证保存到 B 本机配置后常驻运行。成功后普通重启只传 --config，不再传已消费的配对码。按本机平台用会话保活或后台进程方式保持 Bridge 常驻，并记录实际 PID。

## 4. 旧 native_task：绑定额外原生接收器

只有用户另行明确选择跨任务来源行、授权额外原生接收器及模型转发开销时，才执行本节；推荐粘贴块不包含该授权。取得真实 receiver UUID 和当前桌面对话 UUID，按 [固定接收器协议](../native-task-messages.md#给接收器的固定协议) 设置准确仓库 cwd、固定 inbox 和唯一目标。接收器必须实际具备原生 send_message_to_thread 和 shell，不能只写了提示词就宣布就绪。

确认无在途执行后停止本机旧 Bridge，备份仓库外私密配置。保持配对后的身份和原 state_dir，仅加入 result_delivery_mode=native_task、绝对 native_inbox_dir、绑定中的 desktopThreadId 和 nativeReceiverThreadId；再按原命令只传 --config 启动一个 Bridge。不能同时运行两个进程打开同一执行状态库，也不能为切换而丢掉已有 native inbox/claim。保持接收器及目标在桌面加载；应用关闭/重启后的自动加载没有承诺。原生来源是本机接收器，远端 conv_id 留在正文。

## 5. 工具入口与真实双向验证

已有 relay MCP 时，所属对话单独实例带 --conv-id <返回地址> 和匹配的 profile/thread-id，设备令牌从本机私密配置/环境注入。若当前宿主没有动态 MCP 接入口，直接使用 packages/bridge/src/relayClient.ts 的 RelayClient，从本机私密配置读取 token；不打印 token、不通过修改 ~/.codex 绕过限制。这是本次实测实际使用的收发入口。

1. /health 为200，生产存储 db=postgres。
2. relay_whoami 返回所属 conv_id；relay_discover 发现配对方；查询配对列表确认关系。
3. relay_inbox 检查待办，核对 Bridge WebSocket 和心跳。presence.online 仅代表近期活跃。
4. A→B 和 B→A 各由发起设备独立发送一个全新根 QUERY，保存发送意图和 client_key；相同发送结果不明时不重复 POST。每条业务最多一轮，新增接收器设置/转发及桌面呈现轮分别计，不宣称全链路总共一轮。不要通过额外 QUERY 让对端模型替你发 QUERY。
5. 逐个 request_id 调 relay_status/getRequest 和 relay_read/readResult，核真实正文、evidence、业务 turn_id 与 result_missing。cloud_saved 只代表云端保存，不等于对端屏幕已经显示。
6. desktop_inbox 核实新请求确实在准确原接入对话进入并执行、没有新增对话、真实结果 evidence 指向该原对话；不要求跨任务来源行。旧 native_task 则另核原生来源行和真实报告。另一台屏幕不可读取时，请 Owner 按准确 request_id 确认或提供截图；未确认前保留该项未通过，不编造回执。缺少对端零模型入口时先准备不含凭证、在对端读取自身配置的脚本给 Owner 转交，不索要对端 token。
7. 故障三查仍见 docs/access-guide.md §7。配对码失效/已使用/撤销，请 A 重新邀请；兑换响应未知时保留本地恢复信息，先查证，不反复消费。对照真实 [v0.2.3 双向验证](../native-task-verification.md#v023-发布后的两个全新物理设备请求)。

报告实际版本/提交、conv_id、peer_conv_id、pairing_id、Bridge PID、准确原 desktop UUID（旧 native_task 另列 receiver）、health/roster、两个新 request_id、三层状态、真实回复/evidence 和两端原对话证据；未完成项逐项写明。代码回归可以使用测试床，但它不能替代本节的真实通信与界面证据。完成后保持 Bridge 运行。

## 6. 解除与兼容

任一方可调用 relay_pair_unpair 或 CLI 解除对应配对；A 可撤销未消费的邀请。解除不撤销设备其他对话、其他配对或独立手工授权。

旧设备凭证继续可用；旧 join code 仍只解决 roster 加入。今后新设备用本页配对流程，不再要求 Owner 替每台设备预注册并转交长期凭证。
