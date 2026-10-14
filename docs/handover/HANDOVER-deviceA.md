# 交接文档 · 设备 A（本机）— Codex 跨设备对话通信

**v0.2 更新**：邀请新设备使用 [主动配对](../pairing.md)，只交换十分钟一次性码。本文 Owner 注册和旧 join code 保留为已有设备/兼容管理路径。A 主动调用 `relay_pair_invite` 或配对 CLI；配对自动授予精确双方权限，无需互改 `allow_sources`。

## 0. 你现在在哪台设备上、这份文档带你做什么

- **你在哪台设备上**：本机＝**设备 A**（Windows 10 / PowerShell 5.1）。这套「Codex 跨设备对话通信」已在**本机**跑通并常驻。
- **这份文档带你做什么**：让你（本机上任一 Codex 对话）在五分钟内认清现场 → 把自己接进名册 → 会发/查/读/取消任务 → 桥接出事会看、会重启。
- **权威在哪**：接入语义以仓内 `docs/access-guide.md`（接入权威）为准，部署/桥接/换钥以 `README.md` 为准，机制以 `docs/mechanism-design.md` 为准。本文只给**指针＋速览**，不整段复抄，避免两处漂移。

## 1. 这套系统是什么（三句）

1. **目的**：把不同设备上的指定 Codex 对话连起来，互相派任务、查进度、回传结果。
2. **架构**：Railway 消息中转服务（生产已部署）＋ 每台设备的本地桥接守护进程（连 relay，并经 `codex app-server --stdio` 驱动 Codex）＋ 每个对话的本地 MCP 工具（`relay_*` 九件套）。
3. **身份**：对话用服务端分配的全局句柄 `conv_id` 寻址；身份由「宿主设备令牌（跨设备面）＋ 本机通道绑定（本机面）」背书——**消息里自称的名字只是显示，不被信任**。

## 2. 本机已就位的东西

| 项 | 值 | 怎么核 |
| --- | --- | --- |
| 生产地址 | `https://codex-cross-chat-production.up.railway.app` | `curl.exe https://codex-cross-chat-production.up.railway.app/health` → `200 {"ok":true}` |
| 设备 A 已注册 | `device_id ＝ dev-zumj`（`owner_label`＝`device-a`） | `GET /v1/admin/overview`（根密钥）看 `devices` 列表 |
| 桥接常驻 | 配置 `C:\Users\Administrator\.codex-relay\bridge.config.json`；状态目录 `C:\Users\Administrator\.codex-relay\state`；工作目录 `C:\Users\Administrator\.codex-relay\workspace` | 见 §5「查看桥接是否在跑」 |
| 测试对话在册 | `conv_id ＝ c-gq40xd`、alias `device-a-worker`、role `worker`、project `codex-cross-chat`、tier `t1_managed`、绑定线程 `01a12185-2353-7051-9398-8d0e87774bd2` | `relay_whoami` 或 `GET /v1/roster` |

> **本轮现场快照（2026-10-11 11:2x，写本文时）**：生产 `GET /v1/roster` 用设备令牌返回 **401**，`GET /v1/admin/overview`（根密钥）显示 `devices: []`、`roster_count: 0`——即**生产名册此刻为空**（而当日 03:15 的 `evidence/m3/` 证据里 `dev-zumj` 尚在）。
> 所以上表两行「已注册／在册」是**应然状态**：请务必按「怎么核」那列**现场复核**。若为空，先按 §5 健康自检定位，再按 §3 重新入册。

## 3. 我（一个新对话）怎么入册 —— 两条自举路

先问「我是谁」：`relay_whoami`（→ `GET /v1/roster/me`）。未绑定时返回 `{ status: "unbound", bootstrap: { self: "...", invite: "..." } }`，照指引二选一。**完整口径见 `docs/access-guide.md` §2。**

- **路 A · 自发登记（T1，桥接托管对话）**：调 `relay_register { alias, role, task, project, task_ref? }`（`role` ∈ `manager|worker|verifier|observer`）。
  **T1 标记绑定要点**：桥接**先确认「它创建的线程 ＝ 你」**——工具发回一个一次性随机标记、要求你把它写进下一条回复，桥接在本线程 `thread/read`（末轮）回读命中，才认定「对话＝线程」并分配 `conv_id`。自报的名字不作身份依据。
- **路 B · Owner 给加入码**：Owner 用**根密钥**生成一行 `relay-join: XXXX-XXXX ...`（对话侧永不接触根密钥），你调 `relay_join { code, alias? }`。

> ⚠ **登记成功后，必须带返回的 `--conv-id` 重启你的 MCP 实例，才能发任务。** 工具的身份绑在**启动通道**上（`--conv-id` / `--profile` / `--thread-id`，见 `access-guide.md` §1.2）；`relay_register` / `relay_join` 只在服务端建了花名册行，当前实例的启动参数里还没有那个 `conv_id`。**不重启就发不出任务**，`relay_send` 会报 `400 binding_required "provide conv_id or profile+thread_id"`。做法：用返回的 `--conv-id <c-XXXXXX>`（连同 `--profile` / `--thread-id`）重启实例。

> **开放来源 `allow_sources`**＝「谁可以给我发任务」，**默认 `["owner"]`**（只有 Owner 直接派活）。两个默认登记的对话**互相发不了**；要互发，须由**接收方**在登记/重登记时显式开放 `[对方 conv_id]`（或 `device:<设备id>`）。重登记同 `profile`+`thread_id` 是**更新**（`conv_id` 不变）。目标没开放你 → `relay_send` 报 `403 source_not_allowed`。详见 `access-guide.md` §2「开放来源」。

## 4. 发现 / 发任务 / 查状态 / 读结果 / 取消（速览）

| 动作 | 工具 | 端点 | 关键参数 |
| --- | --- | --- | --- |
| 发现可寻址对话 | `relay_discover` | `GET /v1/roster?project=&role=&q=` | 只回元数据，不回正文 |
| 查我自己 | `relay_whoami` | `GET /v1/roster/me` | 未绑定 → `unbound` |
| 我的收件箱 | `relay_inbox` | `GET /v1/inbox?for=<conv_id>` | 只能读自己的 |
| 发 | `relay_send` | `POST /v1/requests` | `to`(精确 `conv_id`)、`type`(`TASK/QUERY/CLARIFY`)、`body`(≤64 KB)、`ttl_s?`、`parent_request_id?` |
| 查 | `relay_status` | `GET /v1/requests/{id}` | 三层状态 |
| 读 | `relay_read` | `GET /v1/requests/{id}/result` | 全文 ＋ `evidence` |
| 取消 | `relay_cancel` | `POST /v1/requests/{id}/cancel` | 仅**发起方**可取消 |

- **发送前必须先发现**：`to` 必须是**精确 conv_id**，不许按名字猜。
- **回传结果的主路径是 HTTP**（`access-guide.md` §4.1）：`POST /v1/requests/{id}/result`，`kind=RESULT|STATUS`；`evidence` **必须是字符串**（传数组 → `400 bad_field_evidence`）。
- 三层状态、STATUS 与续轮、链上限（默认 3）、64 KB、结果缺失标记等语义：`access-guide.md` §6。

## 5. 运营操作（本机）

**查看桥接是否在跑**
```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*codex-relay*bridge*' } |
  Select-Object ProcessId, CommandLine
```
启动方可能把 PID 写在 `D:\claude\codex-relay\evidence\m3\bridge.pid`，但**以现场进程为准**（历次重启会覆盖它）。

**停止**：`Stop-Process -Id <pid>`。注意：桥接只有在**启动它的控制台里按 Ctrl+C** 时才优雅关停（收 `SIGINT`/`SIGTERM`）；`Stop-Process` 是强停。强停无害——下次启动会先 `reconcile` 未完成轮次、再补拉 `inbox`（`README.md` §部署 7）。

**重启**（工作目录＝仓根 `D:\claude\codex-relay`）：
```powershell
node --import tsx packages\bridge\src\index.ts --config C:\Users\Administrator\.codex-relay\bridge.config.json
```

**日志在哪**：日志由启动方重定向；本次两份在 `D:\claude\codex-relay\evidence\m3\bridge.out.log`（`info` 行）与 `bridge.err.log`（`warn`/`error` 行）。自己重启时自行指定重定向。

**健康自检三步**
1. `curl.exe https://codex-cross-chat-production.up.railway.app/health` → `200 {"ok":true}`（无鉴权、零敏感信息）。
2. **查名册（设备令牌）**：对话内 `relay_whoami` / `relay_discover`，或 `GET /v1/roster`；应能看到本机行。看不到且返回 **401** ⇒ 设备令牌已失效（如生产名册被清）——按 §3 重新登记设备 / 重新入册。
3. **看桥接 `bridge.err.log` 尾部**：正常应有 `info: ws open`；若反复出现 `warn: ws error: Unexpected server response: 401`，说明**桥接在跑但没通过 relay 鉴权**，此时 §2 的「已就位」不成立。

**根密钥在哪 / 换钥**：根密钥在本机私有 env 载体（**不在仓内、不被 git 跟踪**）：`C:\Users\Administrator\.minimax\env\env.codex-relay.local`，键名 `RELAY_ROOT_KEY`（同一文件另有 `RELAY_DEVICE_ID`、`RELAY_DEVICE_TOKEN`）。**根密钥只在设备注册与 Owner 管理面用，对话侧永不接触、绝不写进任何文档。** 生成（≥32 字节熵）与轮换（新值写入该 env ＋ 在 Railway 服务 Variables 覆盖 `RELAY_ROOT_KEY` → 触发一次重部署；换根密钥**不撤销已登记设备**）见 `README.md` §「连接密钥的生成与轮换」。

## 6. 边界提醒

- **T2 桌面已有对话不支持自动接入**：既有桌面对话是 paginated 线程，上游对 `thread/read`（全史/末轮）、`resume`、`turn/start` 一律 fail closed ⇒ 首版只能把它**手工登记**为「可被通知 / 可发起」，**不能自动接管执行**；它**没有自动唤醒**，每次被打开须主动 `relay_inbox`。见 `access-guide.md` §5。
- **真实模型轮次要省着用**：桥接驱动 Codex 会真实消耗模型额度。预演/自检优先走 mock（`npx tsx scripts/dual-instance.ts --mock`，见 `README.md` §本机双实例闭环），真实轮次每方向 ≤2 轮。
- **红线**（不广播、不自动转派、不自动回信、尊重链上限、等用户/缺材料时报 `STATUS` 不编造结果）：`access-guide.md` §8。
