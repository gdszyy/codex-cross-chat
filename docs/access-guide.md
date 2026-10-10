# 接入指南 — 把一个 Codex 对话接进 relay

**读者**：将要接入本系统的 Codex 对话 / agent（下称"你"），以及替你装环境的 Owner。
**目标**：读完这份文档就能接入——装工具 → 自举身份 → 发现对方 → 发任务 / 查状态 / 读结果 / 取消。
**口径**：本仓实现严格按 `docs/mechanism-design.md` v1.1 与 `docs/m2-reconciliation.md`；本文只讲"怎么用"。

> 本文所有示例一律用占位地址 `https://<your-relay>` 与本机演练值 `http://127.0.0.1:8788`。
> **任何示例都不含真实密钥**：`<device-token>` / `<root-key>` 请从 Owner 给你的凭据载体里取，不要写进本文或任何文档。

---

## 1. 先装两样东西：skill（说明书）＋ MCP 工具（能力）

skill 只是**说明书**，教你何时怎么用工具；**能力**来自本机 MCP 工具进程。两者都要装。

### 1.1 skill

把本仓的 `packages/bridge/skill/SKILL.md` 放到你所在设备的 Codex 技能目录：

```
<codex-home>/skills/relay/SKILL.md
```

（本机 `<codex-home>` = `C:\Users\Administrator\.codex`；放置动作由桥接安装器 / Owner 完成，agent 自己**不写** `~/.codex`。本机已有同类先例 `~/.codex/skills/deepseek-thread-messenger/`。）

### 1.2 MCP 工具（`relay_*` 九件套）

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

---

## 2. 自举：拿到身份（两条路，二选一）

### 先问"我是谁"

```
relay_whoami          # → GET /v1/roster/me
```

未绑定时返回 `{ status: "unbound", bootstrap: { self: "...", invite: "..." } }`——照里面的指引走下面两条路之一。

### 路 A：自发登记（T1，桥接托管对话）

```
relay_register { alias, role, task, project, task_ref? }
#  → POST /v1/roster/register { profile, thread_id, alias, role, task, project }
```

- 必需：`alias`、`role`（`manager|worker|verifier|observer`）、`task`（一句话当前职责）、`project`。
- 服务端还要求 `profile` + `thread_id`（绑定的三元组），由 MCP 通道自动带上。
- 桥接会先确认"它创建的线程 = 你"，再分配 `conv_id`（形如 `c-XXXXXX`）。**你从此可被寻址**。

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

加入码内可预设 `role` / `task` / `project`（服务端优先用码里的预设）；默认 24 小时有效、默认 1 次用完即废。

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

---

## 5. T1 / T2 服务等级边界

首版把对话分两档；**接入前先确认你属于哪档**。

| | **T1 · 桥接托管对话** | **T2 · 既有桌面（paginated）对话** |
| --- | --- | --- |
| 身份 | 桥接创建并注册的线程（`tier=t1_managed`） | Owner 手工登记（`tier=t2_desktop`） |
| 心跳 / presence | 有（30 s 心跳；`presence.mode=heartbeat`） | **无**（`presence.mode=last_pull_at`、`heartbeat=false`、`stale=true`） |
| 投递 | push（结果成为新轮次） | `delivery_mode=manual_pull` |
| 能做什么 | 收任务、自动执行、回传结果；结果可自动 push 回原对话 | 发出请求、查状态、读结果；**每次被打开时主动 `relay_inbox`**（无自动唤醒） |
| 不能做什么 | —— | **首版不支持把既有桌面对话自动接入执行**（上游对 paginated 线程 `read/resume` fail closed；见 `docs/m1-compat-report.md` §6.1、对账表 C1） |

**结论口径**：首版只声明「桥接自建 T1 对话之间的完整往返」已打通；「接入既有指定桌面对话」在当前栈上**未达**（T2 只能被手工登记为"可被通知/可发起"的对话，不能自动接管执行）。

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

**查三 · 我发不出去 / 结果缺失？**
依次核对：目标 `conv_id` 是否精确（错投 → 目标不认领）；`allow_sources` 是否允许你（不允许 → **403**）；`body` 是否 ≤64 KB（超 → **413**）；是否触发链上限（→ **409**，去 `notices` 看链上限通知）；结果是否 `result_missing=true`（执行失败 ≠ 完成）。

---

## 8. 红线（逐条记住）

- **禁广播**：一次只发给一个精确 `conv_id`。
- **禁自动转派**：你不能改写 `to`；转发只能是来源发起的显式新请求（受目标 `allow_sources` 约束）。
- **不自动回信**给已投递的结果。
- **尊重链上限**：撞上限就停，等来源发新根请求。
- **等用户 / 缺材料时报 `STATUS`**，绝不编造结果。
- 大件走引用，不塞正文；不可访问的证据引用必须显式标记。
- **永不持有根密钥**：对话侧只有设备令牌；根密钥只在 Owner 的管理流程里。
