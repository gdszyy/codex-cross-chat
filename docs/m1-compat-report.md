# M1 本机兼容验证报告 — Codex 跨设备对话通信

- 版本：**v1.1**（返工修订版）；v1.0 与 v1.1 日期均为 2026-10-10
- 返工轮次：第 1 次返工（依据 `docs/review/REVIEW-M1.md` 判决 FAIL 的 R1–R5）。本版为**报告级修订**：未跑新探针、未跑新模型轮次、未写 `~/.codex`、未改证据目录。
- 范围：第一阶段**本机部分** = 环境侦察 ＋ 官方接口核对 ＋ 本地兼容验证实测。第二台设备不在本次范围。
- 执行：Worker（执行者，未派子任务、未向用户提问）
- 证据目录：`D:\claude\codex-relay\evidence\m1\`

---

## 0. 摘要

1. **方案拷贝已修复**：`D:\claude\codex-relay\docs\plan-v1.md` 现与源附件逐字节一致，SHA256 = `253D4DA218AD85B56DFAE43B5CABA7E3DFA609C1989374C5B05680B284E36073`（两侧相同）。
2. **本机 App Server 可用**：`codex app-server --stdio`（PATH Codex CLI 0.149.0）在**自建的新测试对话**上完成了「线程读取 → 恢复 → 启动一轮 → 读取该轮真实终态与最终输出」。两轮均 `completed`，末条 `agentMessage` 分别为 `PROBE-OK`、`RESUME-OK`。**注意（v1.1 更正，R1）**：探针所用 PATH `codex` 为 0.149.0，而桌面后端二进制实测为 0.153.4——见 §2「版本偏差」行。
3. **桌面 App 存在且其后端就是 app-server**：AppX 包 `OpenAI.Codex 26.901.6511.0`；桌面后端进程 = `codex.exe ... app-server ...`。桌面、CLI、桥接**共用同一 `CODEX_HOME` 落盘存储**；但**每个 app-server 进程的内存 loaded 态相互独立**（新进程 `thread/loaded/list` 返回空）。
4. **并发 / 所有权结论：有条件 go（conditional go）**。条件已重写为可验收判据表，见 §6.3。
5. 发现 **4 处方案假设需要修正**（见 §5），其中「messenger 脚本模型映射」与「provider＝codex_local_access」两项已与本机现状不符。
6. **桌面线程格式墙（v1.1 新增，R2）**：`evidence\m1\as-list-default.json` 显示既有桌面对话**14/14 全部 `historyMode="paginated"`**（`cliVersion="0.153.4"`），唯一 `legacy` 线程是本报告的探针自建线程。官方文档明文：paginated 线程的 full-history reads、turn pagination 与 **resume** 均 `fail closed`。⇒ 按方案 §8.3，本报告**明确记录「既有桌面对话在当前已验证栈上不支持接入」**；当前唯一已验证路径是**桥接自建 legacy 线程**（不得冒充桌面对话兼容性通过）。详见 §6.1。
7. **「桌面可见性」为方案 §8.1.1 明列验收项，本轮未做、也未验证**（v1.1 恢复该 item，R4）。详见 §8。

---

## 1. 证据与口径

- 每项断言附**命令原文**与**输出**：命令原文即探针 `.log` 文件内的逐条 JSON-RPC 报文（`[SEND]` / `[RECV]` / `[STDERR]`），输出即对应的 `.json` / `.txt`。
- 长进程取证按三段式：重定向到文件（`cmd /c "... > file 2>&1"`，裸字节重定向）→ 读 `$LASTEXITCODE` → 只在文件上过滤。
- **只读声明与其背书**：`~/.codex` 全程只读；本次唯一写入面＝自建测试对话内容（新建 thread 的 rollout）＋证据目录。未修改任何 `~/.codex` 文件、未修改会话数据库（`thread_history_1.sqlite` / `state_5.sqlite` 等均未写入）。
- **凭据**：`auth.json` 只读取 `auth_mode` 字段用于报告，token 未打印、未落盘。
- **诚实标注**：`probe-gpt54-startonly.json` / `.log` 为 **0 字节**，是探针脚本首版死锁（见 §7 风险 R1）被中断时留下的空文件；**它不是本次任何结论的来源**，保留原样（清理被本地安全策略拦下）。

---

## 2. 环境清单

证据：`evidence\m1\env-recon.txt`（脚本 `_tmp\env_recon.py` 直出）。

| 项 | 实测值 |
| --- | --- |
| CLI 版本（PATH） | `codex-cli 0.149.0`（`codex --version`） |
| PATH CLI 入口 | `C:\Users\Administrator\AppData\Roaming\npm\codex.cmd` → `node_modules\@openai\codex\bin\codex.js`（npm 全局包装；`findCodexExecutable()` 解析到平台包自带二进制，**不读** `CODEX_CLI_PATH`） |
| 桌面后端二进制 | `C:\Users\Administrator\AppData\Local\OpenAI\Codex\bin\8e5b6932251c2c1c\codex.exe`（约 295 MB）；**直接运行 `--version` = `codex-cli 0.153.4`**（**复核方实测，REVIEW-M1**）。`env-recon.txt` 第 30 行记桌面后端 PID 25076 的可执行路径即此二进制 ⇒ **桌面后端是 0.153.4**；与既有线程 `cliVersion="0.153.4"` 互证。⚠ 该二进制**不是** PATH CLI 的二进制，`config.toml` 的 `CODEX_CLI_PATH` 指向它只是配置项，PATH CLI 并不读它。 |
| **版本偏差（v1.1 新增，R1）** | 两个二进制版本不同：**PATH CLI ＝ 0.149.0**（探针与 §4 全部接口实测所用），**桌面后端 ＝ 0.153.4**。⇒ **§4 全部接口实测结论都只在 0.149.0 上成立；「0.149.0 写入端 ↔ 0.153.4 会话库」的跨版本一致性未验证**。M2 **必须钉定桥接使用哪一个二进制**（PATH `codex app-server`＝0.149.0，还是桌面 0.153.4 二进制），并在所钉定的版本上重跑 §4 接口实测全绿后再接入。 |
| CODEX_HOME | `C:\Users\Administrator\.codex` |
| 配置 | `config.toml`（12,118 B）：`model = "gpt-6-astra"`、`model_provider = "openai"`、`approval_policy = "never"`、`sandbox_mode = "workspace-write"`、`approvals_reviewer = "user"`、`service_tier = "default"`；含 `[desktop]` 段 |
| 认证 | `auth.json`：`auth_mode = "chatgpt"`（ChatGPT 订阅 OAuth），`OPENAI_API_KEY` 为空 |
| 可用模型 | `models_cache.json` 收录：`gpt-5.5`、`gpt-5.6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-6-astra`、`gpt-reserve`（另有 `codex-auto-review`、`priority`） |
| 会话存储 | `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<threadId>.jsonl`；`thread_history_1.sqlite`（8.05 GB）、`state_5.sqlite`（281 MB）、`logs_2.sqlite`（640 MB）、`goals_1.sqlite`、`memories_1.sqlite`、`queue_1.sqlite`、`session_index.jsonl`、`thread-writer-locks\`（目录） |
| 桌面 App | AppX 包 `OpenAI.Codex`，版本 `26.901.6511.0`，`InstallLocation = C:\Program Files\WindowsApps\OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0`，`Status = Ok` |
| 桌面后端进程 | PID 25076：`codex.exe -c features.code_mode_host=true app-server --analytics-default-enabled -c "mcp_servers.codex_app={create_thread/send_message_to_thread/fork_thread/handoff_thread/automation_update ...}"` |
| 其它在跑进程 | PID 19824：`codex.exe app-server --listen stdio://`；PID 107252：`codex-code-mode-host.exe`；两个 `codex-command-runner-0.153.4.exe`；两个 `codex.exe sandbox ... node_repl` worker |
| 共享判断 | 桌面后端、独立 stdio app-server、CLI 均以 `C:\Users\Administrator\.codex` 为 home ⇒ **共用同一落盘会话存储**（见 §6 证据） |
| app-server 传输 | 支持 `--listen stdio://`（默认）/ `ws://IP:PORT` / `unix://` / `off`；`daemon` 生命周期子命令**在 Windows 报错**：`codex app-server daemon lifecycle is only supported on Unix platforms` |

---

## 3. messenger 脚本：位置与能力评估

**位置**（任务 §3.4 所指「本机现有 messenger 脚本」）：

- `C:\Users\Administrator\.codex\skills\deepseek-thread-messenger\scripts\messenger.py`（17,895 B）
- 同目录 `SKILL.md`、`references\protocol-contract.md`（注明「Verified App Server contract (2026-09-16, Codex Desktop 0.149.0)」）

**能力**（读源码实测所得，非推断）：

- 传输：以 `codex app-server --stdio` 起子进程，JSON-RPC 2.0 按行收发。
- 调用：`initialize` ＋ `initialized`；`thread/start`、`thread/name/set`、`turn/start`、`thread/read`、`thread/resume`、`thread/fork`、`thread/delete`、`thread/rollback`。
- 子命令：`create` / `send` / `wait` / `read` / `fork` / `rollback` / `delete`。`send` = `thread/resume` ＋ `turn/start` ＋ 轮询 `thread/read`；`--no-wait --state-dir` 支持异步启动并在 `wait` 阶段按 state 恢复（覆盖方案 §8.1.1 所列「**读取、恢复、启动、最终结果和桌面可见性**」中的读取/恢复/启动/最终结果**四项**；方案明列的**第 5 项「桌面可见性」本轮未验证**，见 §8——v1.1 恢复该项，R4）。
- **本轮对 messenger 本体的实测**（均为零模型额度操作）：`read` 回读到自建线程两轮终态，且 `history_contains_function_call_output=false`；`create`（默认模型）成功建线程；`delete` 成功删除。证据：`messenger-read.json`、`messenger-create.json`、`messenger-delete.json`。

**能力局限 / 已漂移假设**：

1. `MODEL_LABELS` 把 `auto`/`pro` 映射为 `"gpt-5.4"`、`flash` 映射为 `"gpt-5.5"`。本机 `models_cache.json` **不含** `gpt-5.4`，但实测 `thread/start` 对模型串**不做即时校验**（`gpt-5.4` 被接受并建成线程，`probe-modelcheck-gpt54.json`）。⇒ `gpt-5.4` 是否真能跑通一轮**未验证**。**失败模式（v1.1 新增，建议 3）**：`thread/start` 不校验模型串表示失败被**推迟到 turn 阶段**——届时表现为运行时报错或**静默回落默认模型**；因此「建线程成功」**不构成模型可用性证据**，`probe-modelcheck-gpt54.json` 恰恰只证明了这一半。messenger `create` 默认路径（`auto`→`gpt-5.4`，`messenger-create.json` 实证）建出的线程正落在未验证区。⇒ 桥接若复用它，`create` 默认路径必须一并纳入验证。
2. 脚本注释与 SKILL 声称目标线程走 `codex_local_access` provider 并映射 DeepSeek；本机 `config.toml` 为 `model_provider = "openai"`、`model = "gpt-6-astra"`，**无** `codex_local_access` 条目 ⇒ 该假设与本机现状不符。
3. 默认 `sandbox = read-only`；`--effort` 仅 `low/high/max`。
4. messenger 本体未跑「发送一轮并等待」的端到端（省额度），该条列为未验证（§8）。

---

## 4. App Server 接口逐项实测

探针脚本：`evidence\m1\appserver_probe.py`（通用启动/轮次）、`evidence\m1\as_call.py`（单次调用）。协议报文原文见对应 `.log`。

| # | 接口 | 请求（命令原文要点） | 实测结果 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | `initialize` | `{clientInfo:{name,title,version}, capabilities:{experimentalApi:true, requestAttestation:false}}` | 返回 `{userAgent, codexHome:"C:\Users\Administrator\.codex", platformFamily:"windows", platformOs:"windows"}`；随后 `initialized` 通知被接受 | `probe-full-turn1.log` 首两行 |
| 2 | `thread/start` | `{cwd, sandbox:"read-only", ephemeral:false, model:"gpt-5.6-luna"}` | 返回 `thread.id=01a12185-2353-7051-9398-8d0e87774bd2`，`source:"vscode"`，`historyMode:"legacy"`，`modelProvider:"openai"`，`path=…\sessions\2026\10\10\rollout-….jsonl` | `probe-full-turn1.log` / `.json` |
| 3 | `turn/start` | `{threadId, input:[{type:"text",text:"Reply with exactly: PROBE-OK",text_elements:[]}], clientUserMessageId, model:"gpt-5.6-luna"}` | 返回 `turn.id=01a12185-256c-7992-8fa2-1aa4b2fa4721`，状态 `inProgress`；流式 `thread/started`、`mcpServer/startupStatus/updated` 等通知到达 | `probe-full-turn1.log` |
| 4 | `thread/read`（轮询到终态） | `{threadId, includeTurns:true}` | 轮询后该轮 `status="completed"`；从 `items` 取末条 `agentMessage.text="PROBE-OK"`；`turn` 键 = `completedAt/durationMs/error/id/items/itemsView/startedAt/status` | `probe-full-turn1.json` |
| 5 | `thread/resume` | `{threadId, excludeTurns:true}` | 成功返回该线程（`resume_ok=true`），随后可续 `turn/start` | `probe-resume-turn2.log` |
| 6 | `turn/start`（恢复后第二轮） | `{threadId, input:[…"Reply with exactly: RESUME-OK"…], clientUserMessageId}` | `turn.id=01a12185-8e43-7193-971b-41fc7d03790f`，终态 `completed`，末条 `agentMessage.text="RESUME-OK"` | `probe-resume-turn2.json` |
| 7 | `thread/list` | `{limit:15, sortKey:"created_at", sortDirection:"desc", useStateDbOnly:true}` | 返回 15 条（`data`/`nextCursor`/`backwardsCursor`）；**自建线程排在最新一条**（`src=vscode`），证明其进入桌面读取的同一存储 | `as-list-default.json` |
| 8 | `thread/loaded/list` | `{}` | 在**全新进程**返回 `{data:[]}` ⇒ 进程内存 loaded 态独立，不共享桌面的在内存线程 | `as-loaded-list.json` |
| 9 | `thread/delete` | `{threadId}` | 删除自建探测线程成功（`deleted:true`） | `probe-modelcheck-*.json`、`messenger-delete.json` |
| 10 | 模型接受性 | `thread/start{model:"gpt-5.4"}`、`{model:"gpt-5.6-luna"}` | 两者均被接受并建成线程（无即时校验） | `probe-modelcheck-gpt54.json`、`probe-modelcheck-gpt56luna.json` |
| 11 | 协议 schema 导出 | `codex app-server generate-json-schema --experimental --out <dir>` | 导出成功，共 **401 个文件**（构成＝根目录 **45** ＋ `v1/` **2** ＋ `v2/` **354**，v1.1 更正，建议 4）；v2 含 **136** 个 `*Params`＝可调用方法 | `evidence\m1\appserver-schema-index.txt`；完整 bundle 在 `D:\claude\harness\_tmp\as_schema1` |
| 12 | 传输 `ws://`（WebSocket） | 文档 `codex app-server --listen ws://IP:PORT` | **仅文档核对，本机未起监听实测** | 见下方官方文档摘录 |
| 13 | 传输 `unix://` / `daemon` | `codex app-server daemon version` | Windows 报错：`daemon lifecycle is only supported on Unix platforms` | `env-recon.txt` |

### 官方文档核对（`https://learn.chatgpt.com/docs/app-server`，查阅 2026-10-10）

逐条对照本机实测版本（0.149.0）：

- 协议＝**JSON-RPC 2.0**（线上省略 `"jsonrpc":"2.0"` 头）；传输＝`stdio`（默认，JSONL）／`websocket`（`ws://IP:PORT`，**实验性且不支持生产**）／`unix://`／`off`。**与本机 `--help` 一致**。
- WebSocket：`--listen ws://IP:PORT` 同端口提供 `GET /readyz`、`GET /healthz`；带 `Origin` 头请求被 `403` 拒绝；**非回环监听当前默认允许未认证连接**，需配 `--ws-auth capability-token|signed-bearer-token`。命令与 WebSocket 传输**均标注为实验性**。⇒ **与方案 §3.4「TCP WebSocket 目前标为实验性，不作为首版公网入口」一致**。
- 启动：默认即 stdio，无需额外参数（文档：`codex app-server`）。初始化＝`initialize` ＋ `initialized`，否则请求被拒。
- 线程/轮次接口名与关键字段：`thread/start`（返回 `thread.id`）、`thread/resume`、`thread/read`（`includeTurns`）、`thread/list`（`modelProviders`/`sourceKinds`/`archived`/`isPinned`/`cwd`/`useStateDbOnly`/`searchTerm` 过滤）、`turn/start`、`turn/steer`、`turn/interrupt`；终态通知 `turn/completed`。**均与本机实测吻合**。
- 版本差异：文档示例用 `gpt-6.1-sol`；本机可用模型不同（见 §2），且 `model/list` 可动态取；文档明确「available models depend on client and account」。
- 补充（文档、本机未实测）：`thread/archive`、`thread/metadata/update`、`thread/compact/start`、`turn/steer`、`account/*`（auth）、`fs/*`、`process/*` 等。

---

## 5. 对方案假设的修正清单

| # | 方案原假设（出处） | 实测事实 | 影响与建议改法 |
| --- | --- | --- | --- |
| A1 | §3.4：`本机现有 messenger 脚本中存在 thread/resume、turn/start 的调用` | **成立**。脚本 `deepseek-thread-messenger\scripts\messenger.py` 确有 `thread/resume`、`turn/start`（`send` 路径） | 保留；补记脚本绝对路径 |
| A2 | §3.4/§9：以官方 App Server 为桥接适配层基础 | **成立**。本机 `codex app-server --stdio` 全链路可跑 | 保留 |
| A3 | 隐含：App Server 命令行/WebSocket 是可用通道 | `--stdio` 可用；**WebSocket 实验性**（文档明确「experimental and unsupported」），`daemon` 在 Windows 不可用 | 首版只走 `--stdio` 本地通道；云端 WebSocket 由方案自建传输层（与 §3.4 一致），不要依赖 app-server 自带 ws |
| A4 | §3.4：另启 App Server 读取相同历史 ≠ 接管桌面会话 | **成立且已取得半边证据**：新进程 `thread/loaded/list` 为空（内存态独立），但落盘存储在桌面/新进程间共享 | 见 §6；须补「桌面正活跃线程的并发写」实测后才能放开普通对话 |
| A5 | messenger 模型映射：`auto/pro→gpt-5.4`、`flash→gpt-5.5`，经 `codex_local_access` 映射 DeepSeek | 本机 `models_cache` 无 `gpt-5.4`；`model_provider="openai"`、`model="gpt-6-astra"`，无 `codex_local_access` | **需改**：桥接若复用该脚本，模型标签须按本机 provider/模型刷新；`gpt-5.4` 能否跑通轮次未验证 |

---

## 6. 桌面与桥接并发 / 所有权结论

> v1.1（R2/R3）把本节拆为三小节：**6.1 桌面线程格式墙**（阻断 1 的落点）、**6.2 现有实测依据**（含对推断的显式标注）、**6.3 go/no-go 可验收判据表**（阻断 3＋建议 2 的落点）。

### 6.1 桌面线程格式墙 —— 既有桌面对话在当前已验证栈上不支持接入（v1.1 新增，R2）

**事实链**（复核方实测＋本报告证据，REVIEW-M1）：

1. `evidence\m1\as-list-default.json` 共 15 条线程：**14 条既有桌面对话全部 `historyMode="paginated"`、`cliVersion="0.153.4"`**；唯一 `legacy` 线程＝本报告的探针自建线程（0.149.0）。本人已重解析该文件逐条核对（14 paginated / 1 legacy）。
2. 官方文档（`https://learn.chatgpt.com/docs/app-server`）明文：paginated 线程的 **full-history reads、turn pagination 与 resume 均 `fail closed`**（本报告的 §4 官方文档核对与平台报告 L7 已抄录该规则；复核方重取原文逐字命中）。
3. 本报告 §4 的全部接口实测（resume/read/turn）**只对自建 legacy 线程做过**，**从未对任何既有 paginated 线程做过 resume/read**。

**结论（按方案 §8.3 记录）**：**既有桌面对话在 M1 已验证的栈（PATH app-server 0.149.0）上不支持接入**（待受控实测推翻）。当前**唯一已验证路径是「桥接自建 legacy 线程」**；依 §8.3，该路径**只能作为单独验证路径，不得冒充「原有桌面对话兼容性通过」**。⇒ 产品核心目标「接入既有指定桌面对话」（方案 §2.1、§3.3）在本版**未达**，除非 §6.3 判据 C1 被满足。

### 6.2 现有实测依据（全部为本机实测，推断已显式标注）

1. **共享同一存储**：桌面后端（PID 25076 的 `app-server`）、独立 `codex.exe app-server --listen stdio://`（PID 19824）、CLI 与我的探针，均以 `~/.codex` 为 home；自建线程出现在 `thread/list` 最新一条（`as-list-default.json`）。
   - ⚠ **（v1.1 更正，阻断 3）** 此条只证明**存储共享 ＋ 默认列表查询能返回该线程**；由此推出「桌面 App UI 会显示它」**属未标注的推断**，本轮**未实测**。且 0.149.0 自家 schema（`ThreadListParams.json`，本报告所用同一 bundle）明文：`sourceKinds` "When omitted or empty, **defaults to interactive sources**" ⇒ **列表存在服务端默认过滤**（只回交互式来源）。本次探针线程与桌面线程同为 `source=vscode`，恰落在同一过滤器内，故该推断**未被证伪、也从未被检验**。
2. **内存态独立**：新起 app-server 的 `thread/loaded/list = {data:[]}`（`as-loaded-list.json`）⇒ 另启 app-server **不接管**桌面已加载的在内存会话。
3. **跨进程读/恢复/启动可用（仅针对自建 legacy 空闲线程）**：对**自建**线程，跨进程 `thread/read`、`thread/resume`、`turn/start`、终态回读全部成功（`probe-full-turn1*`、`probe-resume-turn2*`）。**不适用于既有 paginated 线程**（§6.1）。
4. **红线遵守**：全程未读、未写任何既有活跃对话；测试仅发生在自建新线程。

### 6.3 结论与 go/no-go（有条件 go — 可验收判据）

**结论：有条件 go（conditional go）。** 条件如下，每条给出「怎么算满足」与「谁验」；**未满足前该条对应能力不得接入**。

| # | 条件（阻断/来源） | 怎么算满足（判据） | 谁验 |
| --- | --- | --- | --- |
| **C1** | **桌面线程格式墙（阻断 1，决定性）** | **二选一**：① 在一台设备上用**既有 paginated 桌面线程**做一次受控 `thread/resume` ＋ `thread/read{includeTurns:true}`，**成功**返回全史与轮次 ⇒ 墙被推翻/官方已解除；**或** ② 经 Owner 确认把首版范围**收窄为「只接桥接自建对话」**，并明确接受方案 §2.1/§3.3「接入既有指定桌面对话」目标**本版不达**。若实测返回 fail-closed ⇒ 墙成立，**必须走②**。 | ①受控实测由 M2 实现者做、复核方复审；②范围收窄决定由 Owner |
| **C2** | **桌面可见性（阻断 3，方案 §8.1.1 明列）** | 桥接写入的最终结果，在**桌面 App UI 中肉眼可见**（提供截图/录屏为证）；若不可见，则如实记为「不支持」并改写方案 §4.7 的「桌面内可见消息」设计。**不得以「thread/list 能查到」代替**。 | M2 实现者（出证）＋复核方复审 |
| **C3** | **二进制/版本钉定（阻断 2）** | 明确桥接 spawn 的是哪个二进制（0.149.0 / 0.153.4），并**在该钉定版本上重跑 §4 接口实测全绿**。 | M2 实现者；复核方复审 |
| **C4** | **并发写同一活跃线程（§3.4 红线）** | 受控实测「桌面正在某线程跑一轮时，另起 app-server 对同一线程 `turn/start`」的行为，产出明确结论：**安全排队 或 明确拒绝**，**不得抢写历史**。 | M2 实现者 |
| **C5** | **messenger 模型/provider 刷新（建议 3）** | 桥接**不硬编码模型串**，改用 `model/list` 动态取；且 `create` 默认路径（`auto`→`gpt-5.4`）要么改标签、要么跑通一轮验证（`thread/start` 建成 ≠ 模型可用）。 | M2 实现者 |
| **C6** | **sourceKinds 过滤核对（阻断 3 衍生）** | 确认桌面列表是否按 `sourceKinds` 过滤非交互式来源；**桥接写入线程的 source kind 必须落在桌面可见集合内**（否则即便落库也不会出现在桌面列表）。 | M2 实现者 |

**基于上表**：首版仅限「明确交由桥接控制的**空闲/新建**对话」，**不开放普通活跃对话的自动写入**（与方案 §3.4 一致）；且**在 C1/C2 满足前，不得声称「跨设备桌面对话已打通」**（方案 §1 末段）。

---

## 7. 风险与建议

- **R1（自身踩坑，已修）**：探针脚本首版用非重入锁，`RPC 调用`持锁后又经日志助手抢同一把锁 ⇒ 首个响应即死锁、日志恒 0 字节。已改为独立日志锁后正常。建议：任何「持锁期间调用子函数」的采证脚本，读写锁分离。（此类问题会表现为「进程存活但零输出」，勿误判为对端无响应。）
- **R2**：桌面与桥接共享同一 `.codex`，且存在 `thread-writer-locks\` 目录 ⇒ 存在按线程的写者锁机制；桥接写入前应显式利用/尊重该锁，并先做「并发写同一活跃线程」的受控实测。
- **R3**：`thread_history_1.sqlite` 达 8.05 GB，`logs_2.sqlite` 640 MB。桥接**不得**直接读这些库（易锁表/慢查询）；应只用 App Server 的 `thread/read`/`thread/turns/list` 等接口。
- **R4**：模型标签与 provider 漂移（§5 A5）。桥接 adapter 不应硬编码模型串，改用 `model/list` 动态取。**（v1.1 补，建议 3）** 失败被**推迟到 turn 阶段**（运行时出错或静默回落默认模型），故「`thread/start` 建成」≠ 模型可用，详见 §3 局限 1；`create` 默认路径（`auto`→`gpt-5.4`）须一并验证。
- **R5**：`approval_policy="never"`、`sandbox_mode="workspace-write"` 为全局设置。跨设备来信触发的本地执行将继承该策略 ⇒ 必须在桥接层做「来源/权限/任务授权」校验（方案 §6 已覆盖）。
- **R6**：`initialize` 的 `experimentalApi:true` 会解锁实验性方法与字段；桥接应显式声明所需能力，不要默认全开。

---

## 8. 未验证项（明确）

| 项 | 原因 |
| --- | --- |
| **桌面 UI 可见性（方案 §8.1.1 明列的第 5 项；v1.1 恢复，R4）** | 本轮只在 `thread/list`（存储/列表层）验证了自建线程可被查询返回；**桌面 App UI 是否显示、如何按 `sourceKinds` 过滤，未实测**——不得以「列表能查到」代证（见 §6.1/§6.2）。 |
| **既有桌面对话的接入（paginated 线程 resume/read）** | §6.1 墙：14/14 既有线程为 paginated，官方明文 resume/full-history reads `fail closed`；本轮未对既有线程做任何 resume/read |
| 桌面正活跃线程的并发写（`turn/start`）行为 | 触碰方案 §3.4 红线（不得读写既有活跃对话）；未制造并发写 |
| app-server 自带 WebSocket（`--listen ws://`）实起监听 / 鉴权行为 | 本轮只需本地 `--stdio`；未起监听（且文档标注实验性、不支持生产） |
| messenger 脚本「发送一轮并等待」端到端 | 省额度，未跑；仅验证了 `read`/`create`/`delete` |
| `gpt-5.4` 映射实际能否完成一轮 | `thread/start` 接受该串，但未跑该模型的轮次；失败会推迟到 turn 阶段（§3 局限 1） |
| 会话存储内部格式细节（sqlite 表结构） | 只做只读观察；未解析 8 GB 库（避免锁表） |
| 第二台设备、Railway 闭环 | 不在本次范围 |

---

## 附：本机实测使用的探针与命令

- 探针（已复制进证据）：`evidence\m1\appserver_probe.py`、`evidence\m1\as_call.py`；工作副本 `D:\claude\harness\_tmp\appserver_probe.py`、`as_call.py`、`as_min.py`、`env_recon.py`。
- 典型命令（原文见报告各节与 `.log`）：
  - `python -B appserver_probe.py --model gpt-5.6-luna --prompt "Reply with exactly: PROBE-OK" --cwd <ev> --log <ev>\probe-full-turn1.log`
  - `python -B appserver_probe.py --thread 01a12185-2353-7051-9398-8d0e87774bd2 --prompt "Reply with exactly: RESUME-OK" --log <ev>\probe-resume-turn2.log`
  - `python -B as_call.py thread/list '{...}'`；`python -B as_call.py thread/loaded/list '{}'`
  - `codex app-server generate-json-schema --experimental --out <dir>`
  - `python -B messenger.py read --thread <id> --cwd <ev>`

**自建测试对话标识**（本报告全部轮次均在此线程）：

- threadId：`01a12185-2353-7051-9398-8d0e87774bd2`
- turn1：`01a12185-256c-7992-8fa2-1aa4b2fa4721`（completed，`PROBE-OK`）
- turn2：`01a12185-8e43-7193-971b-41fc7d03790f`（completed，`RESUME-OK`）
- rollout：`C:\Users\Administrator\.codex\sessions\2026\10\10\rollout-2026-10-10T00-35-35-01a12185-2353-7051-9398-8d0e87774bd2.jsonl`

---

## 返工变更记录（v1.0 → v1.1）

依据：`docs/review/REVIEW-M1.md`（判决 FAIL）。逐条对应：

| 返工项 | 改了什么 | 改动位置 |
| --- | --- | --- |
| **R1** | 「实际二进制」行事实错误已改：拆为「PATH CLI 0.149.0」与「桌面后端二进制 0.153.4（复核方实测，REVIEW-M1）」两行；新增「版本偏差」行，写明 §4 全部接口实测只在 0.149.0 上做、与 0.153.4 会话库跨版本未验证，M2 须钉定二进制并在该版本重验 | 文首版本行；**§2 环境清单**（3 行）；**§0 摘要 2** |
| **R2** | 新增小节「桌面线程格式墙」：14/14 既有线程 paginated（引 `as-list-default.json`）＋官方 fail-closed 原文＋按 §8.3 记录「既有桌面对话在当前已验证栈上不支持接入（待受控实测推翻）」；标明自建 legacy 线程为唯一已验证路径、不得冒充桌面对话兼容性 | **§6.1**（新增）；**§0 摘要 6**；**§8 未验证表**新增一行 |
| **R3** | 「有条件 go」条件重写为可验收判据表（每条含「怎么算满足／谁验」），补入 C1 桌面线程格式墙与 C2 桌面可见性两个前置条件 | **§6.3**（新增）；**§0 摘要 4** |
| **R4** | §8 未验证项表补「桌面 UI 可见性」一行；§3 引用 §8.1.1 恢复原文（含桌面可见性），并注明该第 5 项未验证 | **§8 未验证表**（新增行）；**§3 能力**（引用句）；**§0 摘要 7** |
| **建议 3** | 「thread/start 不校验模型串」的推迟失败模式：失败推迟到 turn 阶段、建成 ≠ 可用，`create` 默认路径落未验证区 | **§3 局限 1**；**§7 R4** |
| **建议 4** | 计数小误更正：401 ＝ 根目录 45 ＋ v1 2 ＋ v2 354 | **§4 表 11** |
| **阻断 3（补充落点）** | §6 依据 1 的「桌面可见」由推断恢复为显式标注；补 `sourceKinds` 默认「只回交互式来源」的过滤问题（0.149.0 自家 `ThreadListParams.json` 原文） | **§6.2 依据 1**；**§6.3 C6** |

**未做（按返工单边界）**：未跑新探针/新模型轮次、未写 `~/.codex`、未改证据目录、未改方案正本。**待复核方复审**：本版是否把阻断 1/2/3 落到位、C1–C6 判据是否可验收。
