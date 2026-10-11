# 交接文档 · 新设备 / 新用户（每位新用户一份）— Codex 跨设备对话通信

## 0. 你是谁、这份文档带你做什么

- **你是谁**：**新设备 / 新用户**（操作系统未知：Windows / macOS / Linux 任一），此前**从未接过**这套系统。**每位新用户一份本文档**，你注册用的 `owner_label` 建议按 `device-b`、`device-c`…逐个递增。
- **这份文档带你做什么**：从零把这台新设备接进「Codex 跨设备对话通信」——装前置 → 取代码 → 让 Owner 给你注册设备 → 写桥接配置 → 起桥接并验证 → 把对话登记进名册 → 会收发/查/读 → 故障三查 → **通知 Owner 做双向闭环验证**。
- **权威在哪**：接入语义以仓内 `docs/access-guide.md`（接入权威）为准，部署/桥接/**平台差异**以 `README.md` 为准，机制以 `docs/mechanism-design.md` 为准。本文只给**步骤＋指针**，不整段复抄。

## 0.5 一段话交接（把这段粘给那台设备上的 Codex，并附上它的 device_id 与 device_token）

把下面这段**整段**粘给新设备上的 Codex，并另附该设备的 `device_id` 与 `device_token`（凭证纪律见 §3：不进 git、不进日志、不贴对话正文）。它读完这段就会照本文档往下做：

```text
你要把这台设备接入 codex-cross-chat 跨设备通信系统，步骤如下：①git clone https://github.com/gdszyy/codex-cross-chat 并 pnpm install；②通读 docs/handover/HANDOVER-deviceB.md 并严格照做，接入语义以 docs/access-guide.md 为权威；③我会另外给你本设备的 device_id 与 device_token——填进桥接配置即可，禁止写入 git、日志或任何外发内容；④按文档的平台启动形态把桥接跑成常驻 → 按文档登记你所属对话（relay_register，角色/任务/项目自拟并告诉我）→ 带返回的 --conv-id 重启工具实例；⑤跑文档的验证与故障三查，全过后向我报告：conv_id、桥接进程号、/health 与 /v1/roster 读数。约束：不修改 ~/.codex 任何文件；真实模型轮次最多 1 轮；文档与实际不符时停下如实报差异，不自行发明步骤。
```

## 1. 前置条件

- **Node ≥ 20**（生产镜像用 `node:22`，建议 22）。
- **pnpm**（由 corepack 启用，仓内 `pnpm-lock.yaml` 锁 10.33.0）。
- **git**。
- **Codex CLI**：需带 `app-server` 子命令，且**已登录**；版本尽量贴近 **0.149.x**——机制设计 D13 把桥接**钉定在 0.149.0**（M1 全部接口实测的载体，且它创建的线程是 legacy，恰在「桌面线程格式墙」的正确一侧）。升级须整体重验。
- 网络可达生产 HTTPS/WSS：`https://codex-cross-chat-production.up.railway.app`（`/health` 无鉴权）。

## 2. 取代码

```bash
git clone https://github.com/gdszyy/codex-cross-chat.git
cd codex-cross-chat
pnpm install
```

## 3. 设备注册（拿 device_id ＋ device_token）

设备注册**需要根密钥**，而根密钥只在 Owner 手里——**这一步由 Owner 跑，你收结果**。Owner 执行（把 `<ROOT_KEY>` 换成真实值）：

```bash
curl -s -X POST https://codex-cross-chat-production.up.railway.app/v1/devices/register \
  -H "x-root-key: <ROOT_KEY>" -H "content-type: application/json" \
  -d '{"owner_label":"device-b"}'
```

> Windows PowerShell 下请用 `curl.exe`（不是 `curl` 别名），并按 PS 的引号规则转义 `-d` 里的 JSON。

回执形如：`{"ok":true,"data":{"device_id":"dev-XXXX","device_token":"<不透明令牌>","token_length":48,"owner_label":"device-b",...}}`。

Owner 把 **`device_id` 与 `device_token`** 交给你（token 一机一票，用来起桥接）。你要做的：
- 把 `device_token` 写进**本机桥接配置**（见 §4）。
- ⚠ **令牌纪律**：`device_token` **不进 git、不进任何文档、不贴进对话正文**，只落在本机桥接配置文件里；**根密钥你永不接触**（对话侧只持设备令牌）。

## 4. 写桥接配置（照仓内样例）

```bash
# 放到仓外（例如 ~/.codex-relay/），不要提交进 git
cp docs/bridge-config.example.json ~/.codex-relay/bridge.config.json
```

字段名与样例 `docs/bridge-config.example.json` 保持一致（**先读样例再写**）：

| 键 | 填什么 |
| --- | --- |
| `relay_url` | `https://codex-cross-chat-production.up.railway.app` |
| `device_token` | §3 拿到的 `device_token` |
| `profile` | `default` |
| `codex_command` / `codex_args` | **按平台写死，见下表** |
| `model` | 可选（样例 `gpt-5.6-luna`）；想省额度可挑低成本模型 |
| `cwd` | 本机工作区目录 |
| `state_dir` | 桥接本地状态目录（嵌入式 PG，仓外，如 `~/.codex-relay/state`） |
| `allow_sources` | `["owner"]`（默认最严） |
| `heartbeat_ms` | 心跳间隔（默认 `60000`），同时决定对话 `presence` 刷新频率 |
| `bindings` | 你要托管的对话，每项 `{ alias, role, task, project }`（**不要填 `threadId`**——桥接会自建线程） |

**平台差异（必须写对，否则桥接起不来）** —— 以 `README.md`「桥接的启动形态」与样例里的 `_codex_command_windows` 为准：

| 平台 | `codex_command` | `codex_args` | 失败形态（实测） |
| --- | --- | --- | --- |
| macOS / Linux | `codex` | `["app-server","--stdio"]` | — |
| **Windows** | `cmd.exe` | `["/c","codex","app-server","--stdio"]` | 裸名 `codex` → `ENOENT`；指向 `codex.cmd` 的全路径 → `EINVAL` |

## 5. 启动桥接并验证

工作目录＝仓根。

**Windows（PowerShell）**：
```powershell
node --import tsx packages\bridge\src\index.ts --config C:\Users\<你>\.codex-relay\bridge.config.json
```

**macOS / Linux**：同一条命令、换成你机器的路径即可（`codex_command` 用 `codex` 形态）。

启动日志应依次出现（样式与设备 A 的 `evidence/m3/bridge.out.log` 同形）：
- `created thread for <alias>: <threadId>`（桥接自建线程）
- `<alias> registered as c-XXXXXX`（登记成功——**记下这个 `conv_id`**）
- `ws connecting wss://.../v1/device?token=***` → `ws open`（WS 连上）
- 之后按 `heartbeat_ms` 周期出现心跳。

**自检**：
1. `curl.exe https://codex-cross-chat-production.up.railway.app/health` → `200 {"ok":true}`。
2. **设备侧自检用 roster/inbox（设备令牌即可）**：对话内 `relay_whoami` / `relay_discover`，或 `GET /v1/roster`，应能看到你的行。
3. **`presence` 的读法**：`presence.online=true` 只表示「近期有过心跳，或刚登记」——无心跳后约 30–90 s 会衰减为 `false`，**`online=true` ≠ 桥接此刻在线**。
4. **admin 总览 `GET /v1/admin/overview` 需要根密钥**（属 Owner 面）；要看它请让 Owner 看，你自己别去调。

## 6. 对话登记与收发

- 让某个 Codex 对话进名册：照 `docs/access-guide.md` §2 的两条自举路（**自发登记 `relay_register`** / **Owner 给加入码 `relay_join`**）。
- ⚠ **登记成功后必须带 `--conv-id` 重启该对话的 MCP 实例**才能发任务；不重启 `relay_send` 会报 `400 binding_required "provide conv_id or profile+thread_id"`（见 `access-guide.md` §2 的 ⚠）。
- 发 / 查 / 读 / 取消与三层状态语义：`access-guide.md` §3–§6；工具卡也在 `packages/bridge/skill/SKILL.md`。
- **互发前提**：默认 `allow_sources=["owner"]`，两个对话**互相发不了**；你要和别的对话互发，须由**接收方**登记时显式开放对方的 `conv_id`（`access-guide.md` §2「开放来源」）。

## 7. 故障三查（照 `access-guide.md` §7）

1. **我绑上了吗？** → `relay_whoami`；`unbound` 回 §2 走自举。
2. **收不到任务？** → 先 `relay_inbox`；T1 再检查桥接是否在线。
3. **发不出去 / 结果缺失？** → 核对 `conv_id` 是否精确、`allow_sources`、`body` ≤64 KB、`evidence` 类型、链上限、`result_missing`。

本机专属两条：
- **桥接起不来** ⇒ 先看 §4 平台差异表（Windows 的 `ENOENT` / `EINVAL` 都出自 `codex_command` 写错）。
- **WS 反复 `401`** ⇒ 设备令牌无效、或生产名册为空；找 Owner 重新注册设备（`POST /v1/devices/register`）。

## 8. 跑通后：通知 Owner 做 A↔B 双向闭环验证

设备 B 自检通过后，**通知 Owner**，由他组织「**设备 A ↔ 设备 B 双向闭环**」验收：设备 A 的对话发一条 `TASK` 给设备 B 的 `conv_id` → 设备 B 侧执行并回传 `RESULT` → 设备 A 侧 `relay_read` 读到结果；**反向再来一次**。

**这是本系统的正式验收动作**——不要自行判断「跑通即完成」。
