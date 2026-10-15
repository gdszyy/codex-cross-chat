# 接入指南 — 把一个 Codex 对话接进 relay

**读者**：将要接入本系统的 Codex 对话 / agent（下称"你"），以及替你装环境的 Owner。
**目标**：读完这份文档就能接入——装工具 → 自举身份 → 发现对方 → 发任务 / 查状态 / 读结果 / 取消。

用户操作先读 [如何接入](handover/HANDOVER-deviceB.md) 和 [接入后能做什么](usage-guide.md)；本文保留完整的接口与状态语义，供执行时核对。
**口径**：原有收发语义按 `docs/mechanism-design.md` 与 `docs/m2-reconciliation.md`；v1.2 主动邀请配对的新增契约见 `docs/pairing.md`。

**现有桌面对话通知**：已有 T1 配对可显式配置 `desktop_queue` 与准确 `desktopThreadId`，将来信/真实结果通知到现有桌面对话；桌面空闲时消费，可能产生一个原生模型轮次。原 T1 执行与 T2 身份不变，详见 [桌面投递](desktop-delivery.md)。下文首版 T2 自动执行限制仍有效，不能据通知入队声称接管桌面或已显示。

**原生跨任务呈现**：`native_task` 在同一已验证报告通道上增加一个真实本机原生接收器；其 `send_message_to_thread` 向准确 `desktopThreadId` 发送消息，原生来源为接收器，远端来源在正文中保留。新增接收器与额外模型开销须经用户授权；配置 `nativeReceiverThreadId`、仓库/.codex 外的私密 `native_inbox_dir`，不能更换配对/设备令牌或伪造远端原生身份。`queued`/`submitted` 与界面可见分别核实，不改变三层 Relay 状态。完整协议见 [原生跨任务消息](native-task-messages.md)。它是本机显示转发，不新增 Relay 请求，不授权正文中的转派或自动回信。

**当前推荐接入**：先准备环境和本机原生接收器，再领取十分钟配对码；新设备先用空 bindings 完成一次配对，安全保存独立身份后串行切到 native_task。已有配对保留原身份，直接配置呈现层。完整步骤和可粘贴授权见 [新设备交接](handover/HANDOVER-deviceB.md)。2026-10-15 的两个新物理请求及两端气泡已确认，见 [真实验证](native-task-verification.md)。

## 新设备推荐入口：主动邀请配对

A 已有设备和稳定 `conv_id` 后，**主动**调用 `relay_pair_invite`，生成十分钟一次性配对码。A 不因登记/公布地址自动邀请。B 只需该码，用 Bridge 的 `--pair-code-file` 启动；服务原子创建/确认 B 的独立设备、登记对话并建立双向权限，凭证直接保存 B 本机。完整步骤见 `docs/handover/HANDOVER-deviceB.md`；接口、撤销与解除见 `docs/pairing.md`。

既有 root 引导和 join code 保持兼容。下文 join code 仍需设备令牌，只解决 roster 加入，不等同于新配对码。配对权限独立于手工 `allow_sources` 保存；双方重启不必重新互开权限。自动收发要求双方常驻 T1 Bridge；T2 仍 `manual_pull`。

> 本文所有示例一律用占位地址 `https://<your-relay>` 与本机演练值 `http://127.0.0.1:8788`。
> **任何示例都不含真实密钥**：`<device-token>` / `<root-key>` 请从 Owner 给你的凭据载体里取，不要写进本文或任何文档。

---

## 1. 选择本机工具入口

优先使用宿主已经接入的 relay MCP；没有动态 MCP 接入口时，用仓库 `packages/bridge/src/relayClient.ts` 的 `RelayClient` 从本机私密配置读取设备令牌，执行 `me`、`roster`、`pairings`、`sendRequest`、`getRequest`、`readResult` 等同一 HTTP 契约。本次生产双向实测使用了该程序入口，不需要直接修改 ~/.codex；没有 MCP 不等于没有收发能力。

下面的 skill 与 MCP 安装说明保留给需要接入该入口的宿主。skill 是说明书，MCP 是工具进程；在“不修改 ~/.codex”的任务中不执行下面的 Owner 全局安装步骤，也不把它当成 RelayClient 的必需前置。

### 1.1 skill

把本仓的 `packages/bridge/skill/SKILL.md` 放到你所在设备的 Codex 技能目录：

```
<codex-home>/skills/relay/SKILL.md
```

（本机 `<codex-home>` = `C:\Users\Administrator\.codex`；放置动作由桥接安装器 / Owner 完成，agent 自己**不写** `~/.codex`。本机已有同类先例 `~/.codex/skills/deepseek-thread-messenger/`。）

### 1.2 MCP 工具（核心九件与配对控制）

工具是一个 **stdio MCP server**，逐对话各起一个实例；**身份来自启动通道**（启动参数 / 环境变量），不是你在消息里自称的名字。

- 服务脚本（本仓内）：`packages/bridge/src/mcp/server.ts`
- 启动参数：`--conv-id <c-XXXXXX>`、`--profile <p>`、`--thread-id <threadId>`
- 环境变量：`RELAY_URL`（relay 基址）、`RELAY_DEVICE_TOKEN`（**设备令牌，绝不用根密钥**）

Codex 侧的 MCP 配置（`~/.codex/config.toml`，由 Owner 写入）形如：

```toml
[mcp_servers.relay]
command = "npx"
args = ["tsx", "D:/claude/codex-relay/packages/bridge/src/mcp/server.ts",
        "--conv-id", "<c-XXXXXX>", "--profile", "default", "--thread-id", "<threadId>"]
env = { RELAY_URL = "https://<your-relay>", RELAY_DEVICE_TOKEN = "<device-token>" }
```

> 无启动参数 / 无凭据时，工具仍可被发现，但调用会因缺 `conv_id` 或令牌而失败——先按第 2 节自举。

**九件工具**：`relay_whoami`、`relay_discover`、`relay_register`、`relay_join`、`relay_send`、`relay_status`、`relay_read`、`relay_cancel`、`relay_inbox`。

配对另有 `relay_pair_invite` 等控制工具，见 [配对接口](pairing.md)；不要因只列核心九件而遗漏主动邀请流程。

---

## 2. 自举：拿到身份（两条路，二选一）

### 先问"我是谁"

```
relay_whoami          # → GET /v1/roster/me
```

未绑定时返回 `{ status: "unbound", bootstrap: { self: "...", invite: "..." } }`——照里面的指引走下面两条路之一。

### 路 A：自发登记（T1，桥接托管对话）

```
relay_register { alias, role, task, project, task_ref?, allow_sources? }
#  → POST /v1/roster/register { profile, thread_id, alias, role, task, project, allow_sources }
```

- 必需：`alias`、`role`（`manager|worker|verifier|observer`）、`task`（一句话当前职责）、`project`；可选 `task_ref`。
- 服务端还要求 `profile` + `thread_id`（绑定的三元组），由 MCP 通道自动带上。
- 桥接会先确认"它创建的线程 = 你"，再分配 `conv_id`（形如 `c-XXXXXX`）。

**⚠ 登记成功后，必须带返回的 `conv_id` 以 `--conv-id` 重启 MCP 实例，才能发任务。** 工具的身份绑在**启动通道**上（§1.2），`relay_register` 只在服务端建了花名册行，当前实例的启动参数里还没有那个 `conv_id`；**不重启就发不出任务**，`relay_send` 会报 `400 binding_required "provide conv_id or profile+thread_id"`。做法：用 `--conv-id <c-XXXXXX>`（连同 `--profile`/`--thread-id`）重启实例，此后 `relay_send`/`relay_status`/`relay_read`/`relay_cancel` 才通过绑定校验。

### 开放来源（`allow_sources`）

`allow_sources`＝「**谁可以给我发任务**」的名单，**默认 `["owner"]`**（最严：只有 Owner 直接派活）。元素取值：

| 取值 | 含义 |
| --- | --- |
| `owner` | Owner 直接派活（默认唯一项） |
| `<conv_id>` | 指定对话可给我发任务（同项目对话互发用这个） |
| `device:<设备id>` | 该设备名下的全部对话可给我发任务 |

**语义**：没有配对关系且未显式开放来源时，默认登记的两个对话**互相发不了**（各自只接受 `owner`），手工授权由**接收方**在登记/重登记时显式开放。重登记同 `profile`+`thread_id` 是**更新**（`conv_id` 不变）——即「重跑一次 `relay_register`，带上 `allow_sources: [对方 conv_id]`」。若目标没开放你，`relay_send` 会报 `403 source_not_allowed`（对齐机制设计 §2.2）。新设备主动配对会独立建立双方关系，无需双方再手改 allow_sources，也不应为接入扩大到整个设备/项目。

### 路 B：Owner 给加入码

Owner 用**根密钥**生成加入码（对话侧永不接触根密钥）：

```
POST https://<your-relay>/v1/admin/join-codes   -H "x-root-key: <root-key>"
  { "scope_project": "codex-relay", "preset_role": "worker", "preset_task": "…", "ttl_hours": 24, "max_uses": 1 }
```

Owner 把回执里的码给你，形如一行 `relay-join: XXXX-XXXX ...`。你：

```
relay_join { code, alias? }
#  → POST /v1/roster/join { code, profile, thread_id, alias? }
```

加入码内可预设 `role` / `task` / `project`（服务端优先用码里的预设）；默认 24 小时有效、默认 1 次用完即废。**同样**：`relay_join` 只建花名册行，拿到 `conv_id` 后须带 `--conv-id` 重启实例才能发任务（见路 A 的 ⚠）；`allow_sources` 走加入码的预设或登记后再更新。

---

## 3. 发现：找得到谁、谁在找我

三个读取入口（都需要设备令牌）：

| 意图 | 工具 | 端点 | 要点 |
| --- | --- | --- | --- |
| 列出可寻址对话 | `relay_discover` | `GET /v1/roster?project=&role=&q=` | **只回元数据**（`conv_id`/`alias`/`role`/`task`/`project`/`tier`/`delivery_mode`/`presence`/`accepts_from`），**不返回任何正文** |
| 查我自己（+ 绑定） | `relay_whoami` | `GET /v1/roster/me?conv_id=|profile=&thread_id=` | 未绑定 → `status: "unbound"` |
| 我的收件箱 | `relay_inbox` | `GET /v1/inbox?for=<conv_id>` | 只能读**自己**的（他人 → 403 `not_yours`）；T2 拉一次会刷新 `last_pull_at` |

`relay_inbox` 返回五块：`pending_for_me`（等我做）、`guidance_on_running`（我发起的 CLARIFY 动态）、`results_to_verify`（我发起且已完成的）、`my_outbox`（我发起过的）、`notices`（系统通知，如链上限已达）。

> **发送前必须先发现**：目标 `to` 必须是**精确的 `conv_id`**，不许按名字猜。

---

## 4. 发任务 / 查状态 / 读结果 / 取消

| 动作 | 工具 | 端点 | 关键参数 |
| --- | --- | --- | --- |
| 发 | `relay_send` | `POST /v1/requests` | `to`（精确 `conv_id`）、`type`（`TASK|QUERY|CLARIFY`）、`body`（≤64 KB）、`context?`、`result_requirement?`、`ttl_s?`、`parent_request_id?`、`client_key?` |
| 查 | `relay_status` | `GET /v1/requests/{id}` | 三层状态 + `turn_id`/`result_missing`/`expires_at` |
| 读 | `relay_read` | `GET /v1/requests/{id}/result` | 全文 + `evidence` 引用 |
| 取消 | `relay_cancel` | `POST /v1/requests/{id}/cancel` | 仅**发起方**可取消 |

**参数要点**：
- `to`：精确 `conv_id`；系统无广播参数（禁广播）。
- `body`：≤ 64 KB（超限 → **413**）；大件走 Git 引用或已授权链接，不要塞正文。
- `ttl_s`：默认 24 小时，**只限制"还能不能启动"**，不限制已开始的执行。
- `parent_request_id`：续链时带上一环，链深 +1（见 §6 续轮上限）。
- `client_key`：网络重试沿用同一编号，服务端按它去重（同 `client_key` → 同一请求）。

### 4.1 对话侧提交结果 / 状态（RESULT / STATUS）

九件工具里**没有**回传工具——回传的**主路径是 HTTP**（桥接代劳时同理）；执行方是**你自己**（手工跑、或不用桥接）时，用这个端点把结果或中途状态写回服务端：

```
POST https://<your-relay>/v1/requests/{request_id}/result
Header: x-device-token: <device-token>        # 设备令牌（不是根密钥）；Bearer <token> 亦可
Body:   {
          "conv_id": "<你(执行方)的 conv_id>",   # 必填：你必须是该请求的 to_conv，否则 403 not_executor
          "kind":    "RESULT",                  # 必填：RESULT（终态）或 STATUS（中途）
          "body":    "<结果全文>",              # 必填：≤64 KB，超 → 413 body_too_large
          "evidence": "<字符串引用>",           # 可选：**必须是字符串**，见下
          "exec_status": "completed",           # 可选：写终态
          "turn_id": "<本机轮次 id>",           # 可选
          "result_missing": false               # 可选：终态但无结果时必须置 true
        }
```

- **`evidence` 是字符串，不是数组**。正确形态例如 `"codex-thread:<threadId>#turn:<turnId>"`、一条 URL、或 Git 引用（多个证据请并进一个字符串）。传数组会得到 `400 bad_field_evidence`（字段校验，指明收到了 `array`）；同理 `body` 传非字符串得到 `400 bad_field_body`。
- 绑定也可用 `profile`+`thread_id` 替代 `conv_id`（二者其一）。
- `kind="RESULT"`：请求终态，**按条目幂等**——同一请求只有**第一条** RESULT 触发投递，之后的归档为 `is_first=false`、不再推送。
- `kind="STATUS"`：中途状态，**不关闭请求**；与 §6.2「RESULT 后每条新 STATUS 各起一轮」衔接（等用户/缺材料时就发 STATUS，别编造结果）。
- 读回用 `relay_read` 或 `GET /v1/requests/{id}/result`。

---

## 5. T1 / T2 服务等级边界

首版把对话分两档；**接入前先确认你属于哪档**。

| | **T1 · 桥接托管对话** | **T2 · 既有桌面（paginated）对话** |
| --- | --- | --- |
| 身份 | 桥接创建并注册的线程（`tier=t1_managed`） | Owner 手工登记（`tier=t2_desktop`） |
| 心跳 / presence | 有（30 s 心跳；`presence.mode=heartbeat`） | **无**（`presence.mode=last_pull_at`、`heartbeat=false`、`stale=true`） |
| 投递 | push（结果成为新轮次） | `delivery_mode=manual_pull` |
| 能做什么 | 收任务、自动执行、回传结果（对话侧手工回传见 §4.1）；结果可自动 push 回原对话 | 发出请求、查状态、读结果；**每次被打开时主动 `relay_inbox`**（无自动唤醒） |
| 不能做什么 | —— | **不支持把任意既有桌面对话自动接管为执行线程**；桌面呈现与托管执行保持精确、独立绑定 |

历史格式与服务等级分别核对：已有 T1 执行线程也可能采用 paginated 历史。兼容修复会完整读取并恢复其原绑定，不改变 T1/T2 身份；处理步骤见 [线程恢复](thread-recovery.md)。旧兼容报告记录的是当时结果，不应据此把当前分页格式等同于不可恢复。

**当前结论口径**：业务执行仍由桥接的 T1 线程承担，不自动接管 T2 桌面线程。v0.2.3 已通过真实本机原生接收器，把真实来信/结果报告显示在准确绑定的既有桌面对话中；这项呈现能力不改变 T2 的 manual_pull 身份或原执行历史，详见 [native_task](native-task-messages.md)。

---

## 6. 消息与状态语义

### 6.1 三层状态

| 层 | 取值 | 含义 |
| --- | --- | --- |
| 投递 `delivery_status` | `queued` / `device_received` / `expired` / `rejected` | 是否已入队、设备是否已确认收到 |
| 执行 `exec_status` | `pending` / `running` / `waiting_user` / `completed` / `failed` / `interrupted` / `result_pending_verify` | 任务本身走到哪 |
| 回传 `return_status` | `local_saved` / `cloud_saved` / `delivered` / `origin_processed` | 结果落到哪一层 |

**红线**：结果缺失**不得**显示为业务完成——终态但无 RESULT ⇒ `result_missing=true`（绝不写 `completed`）。

### 6.2 STATUS 与续轮（新口径，重要）

- 执行方在等待用户 / 缺材料时发 `STATUS`（不是 RESULT）。**不得**编造结果。
- **结果通知按条目幂等**：同一 `result_id` 只向原对话推一轮，重复事件不重推。
- **新口径**：RESULT 之后**每条到达的新 STATUS 会作为新条目、在原对话各起一轮**（这是"进度播报"，不是"回信"；与"结果不自动回信"不冲突）。多次 STATUS 会产生多个轮次。

### 6.3 续轮上限 / 64 KB / 来源展示

- **续轮上限默认 3**（数据库配置项 `chain_limit`，非环境变量）。超限时新请求被拒（**409**），并向来源投**且仅投一条**「链上限已达」通知；要再继续必须由来源发起**显式新根请求**。
- **正文与结果均为 64 KB 上限**（请求超限 413）。
- **来源展示**：结果被推回原对话时带 `[[relay-result:<request_id>]]` 前缀并标注 `from`/`to_conv`；**身份不可自述**——你在消息里写的名字只是显示，不被信任。
- **回程不可改写**：`return_addr` 在入队时绑定为发起对话，正文里伪造的 `return_addr` 会被忽略。

---

## 7. 常见故障三查（自检步骤）

**查一 · 我绑上了吗？**
`relay_whoami`（或 `GET /v1/roster/me`）。返回 `unbound` → 回 §2 走自举；返回了但 `conv_id` 不对 → 检查 MCP 通道注入的 `--conv-id`/`--profile`/`--thread-id`。

**查二 · 我收不到别人发的任务？**
1. `relay_inbox` 看 `pending_for_me` 是否为空；空 ≠ 没任务，可能是**还没被 claim**。
2. 你是 T2 → **没有心跳**，系统不会主动唤醒你，必须**每次被打开就拉一次** `relay_inbox`。
3. 是 T1 → 检查桥接是否在线（`GET /v1/roster?role=` 看 `presence.online`）；离线期间入队的会在桥接**重连后被补拉执行**。
   - **`presence.online` 的时效语义**：它只表示**近期有过心跳，或刚登记**——刚登记后的短窗口内即显示 `true`（此时可能并无桥接 WS 在线），无心跳后约 30–90 s 才衰减为 `false`。所以 `online=true` **不等于桥接此刻在线**，只当"最近活跃"读。

**查三 · 我发不出去 / 结果缺失？**
依次核对：目标 `conv_id` 是否精确（**不存在 → 即时 `404 conv_not_found "no such conversation: …"`**，不会静默排队）；`allow_sources` 是否允许你（不允许 → **403 `source_not_allowed`**）；`body` 是否 ≤64 KB（超 → **413 `body_too_large`**）；回传 `body`/`evidence` 类型是否给错（非字符串 → **400 `bad_field_body` / `bad_field_evidence`**）；是否触发链上限（→ **409 `chain_limit_reached`**，去 `notices` 看链上限通知）；结果是否 `result_missing=true`（执行失败 ≠ 完成）。

---

## 8. 红线（逐条记住）

- **禁广播**：一次只发给一个精确 `conv_id`。
- **禁自动转派**：你不能改写 `to`；转发只能是来源发起的显式新请求（受目标 `allow_sources` 约束）。
- **不自动回信**给已投递的结果。
- **尊重链上限**：撞上限就停，等来源发新根请求。
- **等用户 / 缺材料时报 `STATUS`**，绝不编造结果。
- 大件走引用，不塞正文；不可访问的证据引用必须显式标记。
- **永不持有根密钥**：对话侧只有设备令牌；根密钥只在 Owner 的管理流程里。

## 9. T1 线程恢复

Bridge 重启会先恢复并验证原线程；历史缺失时停止登记。不要删除绑定重新配对，按 [线程恢复](thread-recovery.md) 显式修复，保留稳定 `conv_id` 与配对。线上重绑接口和停止旧 Bridge 前提见该文档。
