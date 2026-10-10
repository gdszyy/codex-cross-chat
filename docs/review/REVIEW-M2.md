# REVIEW-M2 — M2 实现站独立对抗复核判决

- 复核方：GLM（异族复核，独立于执行者 DeepSeek；只出判决，不改任何产物）
- 日期：2026-10-10　判决：**FAIL**（见 §1；返工面有界，见 §7）
- 复核对象：分支 `m2-implementation`，提交 `b87bf4d` ＋ `0346fa3`（基线 `698f9a8`）的**全量合成态**
- 上游依据：`docs/plan-v1.md` §4–§8、`docs/mechanism-design.md` v1.1、`docs/m1-compat-report.md` v1.1 §6.3（C1–C6）、执行者对账表 `docs/m2-reconciliation.md` v1.0

---

## 0. 范围声明与方法

**范围**＝上述两提交的全量合成态（55 文件）。复核期间工作树出现一个我首查（`git status --porcelain` 为空）时不存在的未跟踪文件 `docs/m2-retro.md`（另一复盘子会话的产物），**不在本次判决范围内**、不影响任何结论；本文件自身亦为新增，不计入交付物。复核全程未改任何仓内文件、未建 Codex 线程/轮次、未写 `~/.codex`、未部署；长进程一律三段式取证（重定向→退出码→文件过滤）。

**每个检查自己重算**：测试亲跑（退出码为准）、证据文件亲开、代码锚点亲核、C6 只读探针亲自执行（§4）。执行者自报数字一律不作为检查依据。

---

## 1. 判决：FAIL

三项阻断成立：**B1**（真实 Codex「A→B→A」方向从未有完整通过的证据，对账表与提交信息把单方向绿灯说成双向闭环）；**B2**（「B 离线期间到达的请求，桥接重启后永远收不到」——首版承诺的离线恢复投递在进程重启路径上断裂，且未在诚实清单声明）；**B3**（对账表把「数据库配置项、管理面可调」标 ✓，实际配置表从不被生产入口读取、无任何管理面调整端点）。

同时明确：代码主体质量扎实——两套测试在我手上全绿复现（§5）、反向断言是真敏感度探针、契约测试走真实生产入口链路（SD-4 成立）、约 35 处 file:line 锚点仅 2 处轻微漂移、红线（不碰既有桌面对话、不写 ~/.codex）全程未被越过。返工面有界（§7）。

---

## 2. C1–C6 逐条复审

| # | 执行者自报 | 我的复审 | 依据（我重算） |
| --- | --- | --- | --- |
| **C1①** | 未做 | **与盘上一致，诚实**。全程无任何对既有 paginated 线程的 resume/read 痕迹；不要求越红线补做 | 两提交全量 grep 无 resume 调用路径（`packages/bridge/src/codexClient.ts` 仅 threadStart/threadRead/turnStart/turnInterrupt/modelList）；证据目录无相关文件 |
| **C1②** | 待 Owner 拍板 | **挂起正确**。须向 Owner 补一句现状说明：代码默认＝T1-only（等价机制设计 §12 拍板项 3 的**选项 B**），而设计 v1.1 的建议是**选项 A**（T2 最小支持）。服务端 manual_pull/inbox 半边已备（`router.ts:253`、`router.ts:306`），但 Owner 人工点选登记流程未建 | `packages/bridge/src/bridge.ts:13`（只建/读 T1）；`docs/mechanism-design.md:390`（建议＝A）；若 Owner 选 B 才与现状重合 |
| **C2** | 未验 | **与盘上一致，诚实**。无截图/录屏；我的 C6 探针也不能替代人眼（§4） | 证据目录无 UI 取证 |
| **C3** | ✓ | **成立**。钉定 PATH CLI 0.149.0（`evidence/m2/codex-version.txt`＝`codex-cli 0.149.0`，我亲读）；真实跑日志中 thread/start→turn/start→真终态回读全链成功（B→A→B 方向，exec turn `01a12224-8fcd…` completed）。注：thread/resume 本轮未重跑，但 M1 的 resume 实测就在同一 0.149.0 二进制上，版本未变，证据仍有效 | `dual-real-rev.run.log`：`completed r-de918a890dc49c40 turn=01a12224-8fcd… status=completed` |
| **C4** | 未做 | **与盘上一致，诚实**。未制造并发写；红线未被越过（桥接只写自建线程） | 代码面 `bridge.ts` 全部写入仅对 `threadStart` 自建线程 |
| **C5** | ✓ | **实质成立、措辞应补**（见建议 A3）：模型确实配置化（`docs/bridge-config.example.json:7`）；默认串 `gpt-5.6-luna` 在真实跑完成过一轮（C3 证据），可算满足判据后半；但「model/list 动态取」未接线——`modelList()` 全仓零调用（grep 仅定义处 `codexClient.ts:145`），且 `bridge/src/index.ts:46`、`scripts/dual-instance.ts:33` 各硬编码默认模型串 | grep `modelList|model/list` 仅 2 处命中、皆在定义文件内 |
| **C6** | ⚠ 未实测 | **我已亲自实测（§4）：服务端半边坐实 ✓，桌面 UI 半边仍 ⚠（与 C2 同源，需人眼）**。服务端确实按 `sourceKinds` 过滤；桥接自建线程 source=vscode 落在默认（interactive）集合内、且就在默认列表最新两位 | §4 探针记录（命令、五变体、输出摘录） |

---

## 3. 发现清单（3 阻断 ＋ 8 建议；每条附我重算的证据）

### 阻断

**B1｜真实 Codex「A→B→A」方向从未完整通过，被标成双向闭环 ✓**

- 事实链（我亲开全部四份真实跑日志）：
  - `evidence/m2/dual-instance-real-2026-10-09T19-19-46-878Z.log`：方向 1 尝试①，19:20:01 `delivered result r-aff4d0b2… turn=01a1221b-aae4…` 后即 `FATAL Error: -32603: failed to read thread: thread-store internal error: failed to read session metadata … rollout … is empty`；
  - `evidence/m2/dual-real.run.log`（＝19-21-59 尝试②，时间戳相同）：`delivered result r-07d6252c… turn=01a1221e-1807…` 后即 `[dual-instance] fatal Error: timeout waiting for A->B->A result pushed to origin`；
  - 容错修复后的重跑只有 `--only=rev`：`dual-real-rev.run.log` → `dual-instance-real-2026-10-09T19-29-29-958Z.json` **仅含 B→A→B 一条 step**，且其 `origin_readback`＝`"thread/read unavailable (rollout not readable in real stack)"`——真实栈上「结果回到原对话」最后一公里**从未被读回证实过**（mock 才有 `origin_turns` 读回：1→2 递增，链自洽）。
- 与声明的冲突：对账表 §d 该行写「✓ 任务执行轮 `completed`，**结果推送进 A 原对话**（delivery turn 已起）」——「推送进原对话」只有 turn-start 日志一行佐证，同一日志随即在恰恰这一步的验证上 FATAL；引用的「两次尝试的 dual-real.run.log」实际该文件只含一次尝试（两次分在两个文件）。§e 第 10 条「改为容错重试后重跑通过」只对方向 2 成立，读者会误推方向 1 已重跑通过。提交信息「双实例闭环全部可运行」据此过头。
- 轮次预算算术：「每方向 ≤2 轮」——方向 2＝2 轮 ✓；方向 1＝两次尝试 ×（执行轮＋推送轮）＝**4 轮**（重试有披露，但 §d「每方向 2 轮」的读数与日志算术不符）。
- 返工要求：用容错版脚本真实重跑方向 1（A→B→A）至读回或如实标注「读回不可用」，并把 §d 两行、§e 第 10 条、提交口径改为与日志一致。

**B2｜离线→重启的请求投递断裂（未声明缺口；plan §2.1/§8.2 必验用例）**

- 机制链（我逐环核死）：WS 事件持久化在 `events` 表备重放（`packages/relay/src/ws.ts:128-131`），但服务端**只在客户端主动发 `resume` 时重放**（`ws.ts:109-121`，`onConnection` 不补推）；桥接侧游标**只存内存**（`packages/bridge/src/relayClient.ts:27` `private cursor = 0`），且**仅 cursor>0 才发 resume**（`relayClient.ts:143`）；`LocalState` 无游标字段（`packages/bridge/src/state.ts:36-69` DDL 只有 dispatch/outbox/log/binding）；桥接启动序列（`bridge.ts:100-113`）**没有任何收件箱补拉**（`relay.inbox` 在 src 内除 MCP 工具外零调用）。
- 后果：B 进程停机期间入队的请求，在 B 重启后**永远无人领取**（停在 queued/device_received 直到 24h 过期）；A 离线期间到达的 `result.available` 同理——结果存得住（HTTP 可读）但**永远不会被推回 A 的对话**。违反 plan §2.1 原话「离线暂存：B 离线时保留未过期消息，恢复连接后继续投递；A 离线时同样暂存返回结果」与 §8.2 必验用例「接收设备离线后上线｜未过期消息恢复投递」。
- 测试侧掩盖：`recovery.test.ts:168` 用 `await shared.state.intent(id, …)` **手工预写** intent 行才让「重启后安全续跑」通过——真实离线场景根本没有 intent 行；`bridge.integration.test.ts:5-7` 文件头自称「covering the M2 recovery matrix from plan §8.2」，而 §8.2 十二行矩阵实际覆盖约五行（离线后上线、来源离线、同名对话、审批/凭证、撤销/伪造、服务重启均未覆盖）。对账表 §e 十一条诚实清单**均未声明此缺口**。
- 返工要求：游标落盘（LocalState）或启动时收件箱扫描补拉，二选一或并用；补 §8.2「接收设备离线后上线」用例（不手工预置 intent）；对账表补声明。

**B3｜「数据库配置项、管理面可调」标 ✓ 名不副实（D9/§7.2）**

- 事实（grep 全仓）：`loadConfig` 唯一调用点在 `Store.refreshConfig`（`domain.ts:145-147`），而 `refreshConfig` 与 `setConfigValue`（`db.ts:162`）**全仓零调用**；生产入口 `createRelay`（`server.ts:30-33`）用 `DEFAULT_CONFIG`＋opts 构造 Store、**从不读 config 表**；router 全部路由中**没有任何配置管理端点**。改库里的配置值对运行中的服务零效果。
- 与声明的冲突：机制设计 §8 原话「其余参数（链上限、加入码 TTL、保留期等）全部是数据库配置项带默认值、**管理面可调**」；对账表 §7.2 末行「全部为数据库配置项带默认值、管理面可调（`db.ts:20` config 表）｜✓」——锚点只证明表存在并被 seed，不证明「可调」成立。契约用例「honours the database-configured limit (not an env var)」实际经构造参数注入（`relay/test/helpers.ts:23` 的 `config`），**未走数据库**，用例名夸大。
- 返工要求（二选一）：①生产入口启动时 `loadConfig`＋补一个根密钥配置端点；②对账表把该行改标「默认值生效、DB 可调未接线」并移入 §e。

### 建议

**A1｜真实栈 RESULT 的 evidence 写死占位串**：`bridge.ts:253/355/385` 一律 `evidence: mock://threads/<threadId>/turns/<turnId>`——真实跑也如此。§4 第 6 步要求「可访问的证据引用」；占位串既不可访问也未按 §6「明确标记」处理，且未在 §e 声明。

**A2｜STATUS 触发重复结果推送（潜在协议缺陷）**：`domain.ts:684-688` 每条 STATUS 也 emit `result.available`；A 侧 `deliverResultToConversation`（`bridge.ts:273-289`）无幂等——RESULT 已存在后再到任何 STATUS 事件会把同一 RESULT **再推一轮**，破坏 §5.4「RESULT 投递只产生一条 push 轮次」的 ✓ 语义。当前桥接流程不会产生 RESULT 后继 STATUS（未触发），但协议允许，未测。

**A3｜C5「model/list 动态取」未接线**：`modelList()` 死代码（`codexClient.ts:145`，零调用）；`bridge/src/index.ts:46`、`scripts/dual-instance.ts:33` 各硬编码默认串 `'gpt-5.6-luna'`。默认串真实跑通过一轮（C3），判据实质满足，但 C5 的 ✓ 应注明「动态取未实现」。

**A4｜§4 第 3 步顺序反转**：设计要求「B 桥接**先**写本地接收记录，**再**确认设备已收到」；实现先 `claim`（`bridge.ts:207` → `domain.ts:573` 置 device_received）后写 intent（`bridge.ts:219`）。claim 与 intent 之间崩溃的请求无本地记录可恢复——与 B2 同根，扩大丢件窗口。

**A5｜单密钥声明枚举精度**：除 `RELAY_ROOT_KEY`（唯一必需手工变量，`relay/src/index.ts:12`）与 `DATABASE_URL`（绑定注入，允许）外，生产代码还读 `PORT`、`PGLITE_DIR`（`relay/src/index.ts:17,21`）、`BRIDGE_CONFIG`（`bridge/src/index.ts:30`）、`RELAY_CONV_ID/PROFILE/THREAD_ID/URL/DEVICE_TOKEN`（`mcp/server.ts:28-32`，按设计为通道绑定注入、有 CLI 等价）。**无第二个手工密钥/必需变量**，声明在实质上成立；但「其余参数全是数据库配置项」的措辞不覆盖这些带默认的可选环境旋钮，建议对账表如实枚举。

**A6｜锚点行号漂移 2 处**：§d 故障矩阵「`mock-app-server.mjs:70`（schedule）」——70 行是 `parseFault`，`schedule` 在 87；「`:13`（MOCK_STATE_FILE 持久化）」——13 行是文档注释，实读取在 25。其余约 33 处锚点逐处命中。

**A7｜死代码小瑕**：`domain.ts:705-707` `readResult` 里 `missing` 变量算而不用，返回值用另一表达式；语义碰巧等价，建议清理。

**A8｜relay 测试确定性**：`packages/relay` 无 `vitest.config.ts`（vitest 默认 5s 用例超时 × 每用例冷启 pglite WASM）。我单轮全绿（33/33，32.97s，exit 0）未复现超时；复核期间出现的未跟踪复盘稿记录过首跑 31/33 超时红、次跑绿。结构事实成立（无配置文件），建议补配置消除机器负载敏感。

---

## 4. C6 我的实测记录（只读探针）

- 探针：`D:\claude\harness\_tmp\c6_sourcekinds_probe.py`（新写于 harness 临时区，不在 relay 仓内）；仅调用 `initialize`／`initialized`／`thread/list`，全部 `useStateDbOnly:true`（避开 scan-and-repair 写行为）；**未建线程、未起轮次、未写 ~/.codex**。命令：`python -B c6_sourcekinds_probe.py`，exit 0；输出 `c6_probe_out.jsonl`＋补跑 `c6_probe2_out.json`。
- 栈：PATH `codex-cli 0.149.0`（initialize 回报 `codexHome=C:\Users\Administrator\.codex`）。
- 五变体结果：

| 变体 | 返回 | 桥接线程（01a12224-8417…／01a12224-8d28…，取自真实跑证据） |
| --- | --- | --- |
| 默认（省略 sourceKinds） | 20 条，全部 `source="vscode"` | **在，且为最新两条**（legacy，0.149.0） |
| `sourceKinds: []` | 与默认完全一致 | 在（印证 schema「空＝默认 interactive」） |
| `sourceKinds: ["vscode"]` | 同上 | 在 |
| `sourceKinds: ["cli"]` | **0 条** | 不在——**服务端过滤真实存在** |
| 非交互全集（exec/appServer/subAgent*/unknown） | 20 条**另一群**线程，source 为结构化对象 `{"subAgent":{"other":"guardian"}}` | **不在** |

- **结论**：①`thread/list` 确实按 `sourceKinds` 服务端过滤（cli→0；非交互集→subAgent 群，桥接线不在内）——这使判据有实际意义：若桥接线程的 source kind 落在非交互集，它将不出现在默认列表；②桥接自建线程 source=vscode，**落在默认（interactive）集合内**，就在默认列表最顶。**仍不能证明桌面 App UI 显示**（UI 实际查询参数与渲染需人眼＝C2）。C6 判据「确认桌面列表是否按 sourceKinds 过滤；桥接写入线程的 source kind 必须落在桌面可见集合内」：服务端半边我已实测 ✓；「桌面可见」最终一环与 C2 同源，维持 ⚠。执行者的 ⚠ 标注方向正确、且比其引用的 M1 推断更接近满足。

---

## 5. 测试真实性（我亲跑）

| 套件 | 命令（我执行） | 读数 | exit |
| --- | --- | --- | --- |
| relay（契约＋反向） | `pnpm --filter @relay/relay test`（重定向 `_rev-relay-test.log`） | `Test Files 2 passed (2)`／`Tests 33 passed (33)`，32.97s | **0** |
| bridge（每文件独立进程） | `node scripts/run-tests.mjs`（于 `packages/bridge`，重定向 `_rev-bridge-test.log`） | integration 6 passed＋1 skipped；mcp.contract 2 passed；recovery 3 passed；unit 2 passed；`[run-tests] 4/4 files passed` | **0** |

- 与对账表 §d 自报**一致**（33/2 文件；4/4 文件 13 过 1 跳）。`run-tests.mjs` 亲读：`spawnSync` 每文件独立进程，「每文件独立进程」声明属实（`packages/bridge/scripts/run-tests.mjs:24-38`）。
- **反向断言是真敏感度探针**（`relay/test/reverse.assertions.test.ts` 亲读）：六条护栏均在同一用例内先断言受控行为（409/413/403/first=false/expired/return_addr=from_conv），再运行时植入短路（`cfg.chain_limit=999`、`assertCanSend=()=>{}`、删既有 RESULT 等）并断言探针翻红（201/first=true/queued）——若护栏被移除或旁路，正向断言必转红；非恒真断言、非错误对象引用。回程绑定一条为正向即断言（对账表已如实标注）。
- **SD-4 成立**：契约测试经 `startTestRelay`→`createRelay()`（`server.ts:28`，真 HTTP 路由＋真 WsHub＋真 DB），用真 `fetch`/`ws` 连临时端口（`relay/test/helpers.ts:21-34`）；MCP 契约测试以真实子进程＋stdio JSON-RPC 驱动（`mcp.contract.test.ts:36-44`）；bridge 集成测试跑真 relay＋mock App Server 真子进程。无中间产物注入。mock 替身只替代 Codex 端（声明的测试床），relay 链路无替身。
- CSV BOM 我亲验（经我自己的测试运行执行该断言）：契约用例在**原始字节**上断言 `[0xef,0xbb,0xbf]`（`relay.contract.test.ts:441-444`），`csv.ts:7,19` `\uFEFF` 前缀；断言在我亲跑的 33 绿之内。T2 无心跳标注用例（`:116-138`）、「never leaks message bodies」（`:105-114`）、链上限唯一通知（`:283-323`）均在且真。小注：通知唯一性经 DB 直查佐证（WS 推送路径存在于 `domain.ts:546-551`，未在断言中走过）。
- 提交信息历史口径小噪：`b87bf4d` 写「32/32」、最终为 33（27 契约＋6 反向）——对账表 §d 的 33 正确，历史提交信息不追改。

---

## 6. 证据链与条款对账抽查

- **mock 闭环证据**（`dual-instance-mock-…594Z.json` 亲开）：request_id↔turn_id↔marker（`[[relay:r-…]]` 在 RESULT 正文）↔origin_turns 1→2 递增，链自洽；**该 mock 预演未注入故障**——故障注入（delay/crash/duplicate/no_terminal）只存在于自动化测试（代码与用例均实、我复跑全绿）；对账表未声称 mock 预演含故障，无不实。字段形态（`origin_has_result`）与终版脚本（`origin_readback`）不同，系早版脚本产物，证据本身真实。
- **真实闭环证据**：见 B1。`codex-version.txt`＝`codex-cli 0.149.0` 亲读。
- **锚点抽查**（≥10 处要求；实核约 35 处，代表性 15 处）：

| 对账表锚点 | 我核结果 |
| --- | --- |
| `protocol/src/index.ts:60` chain_limit=3 | ✓（:60） |
| `protocol/src/index.ts:64-68` 30/90/60/24h/64KB | ✓ 逐值一致 |
| `domain.ts:435` assertCanSend 三层 | ✓（:435-445） |
| `domain.ts:487` depth>limit→409 | ✓（:487-490） |
| `domain.ts:517` return_addr 入队绑定 | ✓（:517 注释＋取值） |
| `domain.ts:533` 链上限唯一通知 | ✓（:533-552，含 WS emit） |
| `domain.ts:627` 结果 64KB | ✓（:626-628） |
| `domain.ts:711/829/173` 取消/过期/撤销 | ✓ 三处 |
| `ws.ts:139` revoked→close(4003) | ✓（:139） |
| `router.ts:253` T1/T2 presence 分档 | ✓（:253-263） |
| `csv.ts:34` presence_mode 列 | ✓（:34,41，heartbeat／last_pull_at_no_heartbeat） |
| `bridge.ts:13/194/291/333` scope note／去重／waitForTurn／reconcile | ✓ 四处 |
| `codexClient.ts:97/116/126/131/145` 拒批／start／read／turn／modelList | ✓ 五处 |
| `state.ts:37/111/129` dispatch 表／intent／recordTurn | ✓ 三处 |
| `mock-app-server.mjs:70/:13` | **漂移**（实为 :87 schedule／:25 STATE_FILE，见 A6） |

- **保留位反查（§e 声明 vs 代码实态）**：保留期清理——`retention_*` 仅存在于协议常量（grep 仅 `protocol/src/index.ts` 4 处），无清理作业，与 §e#7 声明一致；`origin_processed`——枚举存在（`protocol/src/index.ts:33`）、无写入路径，与 §e#8 一致；WS 等效回传报文——未实现、设计 §9#18 定性为传输优化非缺口，与 §e#6 一致。**唯一未声明的实质缺口是 B2。**

---

## 7. 对「M2 过门进打包站」的明确意见

**不过门（FAIL）。** 三项阻断中 B2 是功能缺口（首版承诺的离线恢复投递在重启路径上静默丢件），B1/B3 是验收文书与证据的失真——按本项目先例（REVIEW-M1 因报告事实错误判 FAIL），对账表的 ✓ 必须可复算，失真即返工。

**返工面有界**（估）：B2＝游标落盘或启动收件箱补拉＋一条不预置 intent 的离线用例；B1＝容错版脚本真实重跑 A→B→A 一次（2 轮预算内）＋改三处文书口径；B3＝接线 loadConfig＋配置端点，或把该行改标并移入诚实清单。A1–A8 可随后续站顺带处理，不单独设站。

**partial 项可否带入后续站**：C1①（红线内不做）、C1②（Owner 拍板）、C2（需人眼截图/录屏）、C4（红线内不做）**可以带入**，其「未做/待拍板」声明与盘上一致、不阻塞打包站技术面——但 C2 建议在打包站前由 Owner 肉眼一次性验收（桌面 UI 可见性），因为它决定「跨设备桌面对话」叙事能否成立；C6 服务端半边我已实测补齐，UI 半边与 C2 合并验收即可。

---

## 8. 复盘投递声明

本段无值得复盘的发现。执行中仅有的自坑（探针脚本对 API 返回的 `source` 字段类型做了字符串假设、遇结构化对象崩溃一次，已就地修正重跑）低于投行门槛；实质性发现均已写入本判决，由管理方与返工方消费。

---

## 复审记录（返工轮，2026-10-10）

**终判：PASS_WITH_FIXES**（R1 三阻断全部销账、我逐一重算复现；残留两处小修不阻断过门，见末段）。复审对象＝返工提交 `0638dd0`（工作树干净，仅本判决书与 `docs/m2-retro.md` 两份未纳入产物）；只核 R1 发现的销账，不扩攻击面；全程未改任何仓内文件（本节为唯一追加）。

### B2（离线→重启丢件）——**已销**

- 游标持久化：`state.ts:69`（kv 表 DDL）／`:202`（getCursor）／`:207`（setCursor），亲读吻合。
- 重连 resume＋事件即存：`relayClient.ts:151`（open 时从 cursorStore 载入）／`:157`（`cursor>0` 发 resume）／`:172`（收到事件即 `cursorStore.set`），亲读吻合。
- 启动/重连补拉：`bridge.ts:144`（`pullInbox`：逐 conv 拉 `pending_for_me` 并驱动）＋`:132`（启动时调用）＋`:116`（`onConnected` 每次重连再拉）；并发双触发防重 `:60`（inFlight）＋`:244`（processRequest 守卫），亲读吻合。
- 掩洞用例**真被替换**：`recovery.test.ts:130`「executes a request that arrived while the bridge was offline (real path, no hand-written intent)」——B 先 stop、请求到达时断言 `pending/queued`、重启**同状态库零预置**、终态 completed、`marker=relay:<id>` 由桥接自产、线程恰 1 轮；另 `:198` 游标跨重启持久用例。两用例在我亲跑中通过（见读数）。
- §4 第 3 步顺序（A4）：`bridge.ts:273`（读状态端点取 to_conv）→`:284`（intent）→`:289`（claim），亲读吻合；§8.2「接收设备离线后上线」自此有真实路径覆盖。

### B1（真实 A→B→A 无绿证）——**已销**

- 亲开 `evidence/m2/dual-instance-real-2026-10-09T20-39-50-262Z.json`（派单笔误写 10-10，实际 UTC 日期 10-09）：`exec_terminal.exec_status=completed`（turn `01a12264-e0b1-…`）、`delivery_turn_id=01a12264-f3f1-…`、RESULT 正文 `RELAY-A2B-OK`、与 `dual-real-fwd.run.log` 逐行互证（单次尝试、无 FATAL、`A->B->A OK … origin_readback=thread/read unavailable`）；本轮轮次＝2（执行 1＋推送 1），预算内；R1 超支（累计 8 轮）在 §d/§e#12 如实披露。
- 诚实注记而非冒充：`origin_readback_note` 明写「主凭证＝delivery_turn_id；真实栈回读可报 unflushed rollout、被容错」；§d 表改为「执行终态＋推送轮已起＋原对话内容回读在真实栈不可得」；提交信息不再说「全部可运行」。mock 新证据（`…20-45-44-614Z.json`）双向 `origin_readback=thread/read confirmed`、`origin_turns` 1→2，链自洽。

### B3（config 表名不副实）——**已销**

- `server.ts:34`：`new Store(opts.db, await loadConfig(opts.db))`——生产入口（`relay/src/index.ts`→`createRelay`）启动即从表读运行值。
- `router.ts:156`（GET）/`:160`（POST `/v1/admin/config`，根密钥＋键名校验＋`setConfigValue`＋`refreshConfig` 立即生效），亲读吻合。
- 契约用例「serves the effective DB config and applies an admin change to real requests」亲跑通过（在我 34/34 之内）：`POST chain_limit=1` 后真实链上第 2 续轮 `c2.status===409`、未知键 400。

### 稳定性与建议项——**全部落地**

- `packages/relay/vitest.config.ts` 存在：testTimeout/hookTimeout 30s、fileParallelism false，亲读。
- model/list 接线（`bridge.ts:95-101`，真实日志两实例均现 `model/list: gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna`）；RESULT evidence 改 `codex-thread:<threadId>#turn:<turnId>`（`bridge.ts:327/434/464`）；A2 幂等护栏（`bridge.ts:358/363`＋`state.ts:215/220`，新用例断言 RESULT 不因后续 STATUS/重复事件重推、STATUS 作为新条目恰推一次）；A7 死变量已删（`domain.ts:697-708`）；A5 环境变量枚举补全（§e#13）；A6 mock 锚点改 `:87/:25/:30`。
- 我亲跑读数（冻结代码 `0638dd0`，三段式取证）：relay `pnpm --filter @relay/relay test`＝**34 passed / 2 files，29.64s，exit 0**；bridge `node scripts/run-tests.mjs`＝**4/4 files，integration 7＋mcp 2＋recovery 4＋unit 2＝15 passed，exit 0**；`tsc -p tsconfig.json --noEmit` 两包均 **0**。与对账表 §d 自报完全一致。

### 残留（不阻断过门，带入打包站前顺手修）

1. **测试换出未披露**：R1 的「restarts safely when the turn was never started」（intent 已写、无 turnId、重启）被新用例替换后，reconcile 的「marker 扫描为空 ⇒ 安全重启」分支（`bridge.ts:467-470`）失去直接用例；§f 未提此次换出。建议恢复该窗口的等价用例或在 §f 补一句披露。
2. 语义确认（无需改码）：`deliverResultToConversation` 现按条目幂等推送——RESULT 后到达的每条**新** STATUS 会在原对话各起一轮（用例所证行为）。与 §5.4「结果通知不自动回信」不冲突（推送≠回信），打包站文档保持此口径即可。

### 门禁意见

**M2 过门进打包站：放行（PASS_WITH_FIXES）。** C1①（红线内不做）、C1②（Owner 拍板，须告知现状默认＝设计选项 B 而设计建议 A）、C2（打包站前 Owner 一次性肉眼验收桌面 UI 可见性）、C4（红线内不做）按原判带入；C6 服务端半边我已实测补齐、UI 半边与 C2 合并验收。
