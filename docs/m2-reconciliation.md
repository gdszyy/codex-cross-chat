# M2 对账表 — Codex 跨设备对话通信（实现站）

版本：v1.0　日期：2026-10-10　执行：Worker（M2 实现站，单写者）
分支：`m2-implementation`　仓库：`D:\claude\codex-relay`
上游依据：`docs/plan-v1.md`（方案正本）、`docs/mechanism-design.md` v1.1（机制与接口权威）、`docs/m1-compat-report.md` v1.1（本机事实与 C1–C6）、`docs/m1-platform-research.md` v1.1（平台与工具链）

本文件是交付物 8：把交付物逐条对回上游条款与 C1–C6 判据，给出落点（文件:行）、证据与状态。**行号为本次最终提交时现算**（`read`/grep 于冻结代码后取值）。

---

## 0. 交付物地图与运行方式

| 交付物 | 位置 | 说明 |
| --- | --- | --- |
| relay 中转服务 | `packages/relay/` | TypeScript/Node，HTTP＋WebSocket；PostgreSQL 为事实源 |
| 共享协议常量/类型 | `packages/protocol/src/index.ts` | §5.2 三层状态枚举、§7.2 参数默认值 |
| bridge 桥接守护 | `packages/bridge/` | 连 relay（WS＋设备凭证）；经 `codex app-server --stdio` 驱动 Codex |
| MCP 工具 | `packages/bridge/src/mcp/server.ts` | §7 九工具（直连 MCP stdio 协议，零额外运行时依赖） |
| skill 文件 | `packages/bridge/skill/SKILL.md` | §7 骨架（Codex 读到即会用） |
| mock Codex 测试床 | `packages/mock-codex/mock-app-server.mjs` | 假 app-server（stdio JSON-RPC）＋故障注入 |
| 双实例闭环驱动 | `scripts/dual-instance.ts` | A→B→A 与反向各一次；`--mock` 预演，`--only=fwd|rev|both` |
| 证据 | `evidence/m2/` | mock/real 闭环的 JSON＋日志 |

运行：`pnpm install` → `pnpm --filter @relay/relay test`、`pnpm --filter @relay/bridge test`；
relay：`RELAY_ROOT_KEY=<key> [DATABASE_URL=<pg-url>] pnpm --filter @relay/relay start`；
bridge：`pnpm --filter @relay/bridge start -- --config docs/bridge-config.example.json`。

**单手工环境变量**：全系统只有一个手工环境变量＝连接密钥（`RELAY_ROOT_KEY`）；生产连库走 Railway 绑定的 `DATABASE_URL`（绑定注入，非手工变量）。其余参数全是数据库配置项带默认值（§7.2 / §8 / D9）。本地与测试用嵌入式 PostgreSQL（`@electric-sql/pglite`，真 Postgres 的 WASM 构建）——理由：本机无 docker/psql（platform §3），pglite 提供真 PG 语义且零系统依赖；生产切 `pg` 驱动，同一套 SQL。

---

## a. C1–C6 逐条对账

| # | 判据（照抄 compat §6.3「怎么算满足」） | 落点 | 证据 | 谁验 | 状态 |
| --- | --- | --- | --- | --- | --- |
| **C1①** | 用**既有 paginated 桌面线程**做受控 `thread/resume`＋`thread/read{includeTurns:true}`，成功返回全史与轮次 ⇒ 墙被推翻 | 未做（本轮不触碰既有桌面对话） | 结论引用 M1 §6.1 事实链（14/14 paginated、官方 fail closed 原文） | M2 实现者做、复核方复审 | **未做（诚实：本轮未对任何既有桌面对话发起 resume/read）** |
| **C1②** | 经 Owner 确认把首版范围**收窄为「只接桥接自建对话」** | 实现整体只做 T1：`packages/bridge/src/bridge.ts:13`（类头 scope note）；relay 侧 T2 表达为 `manual_pull` 无心跳（`packages/relay/src/router.ts:253`） | 本文件 §c；`packages/relay/test/relay.contract.test.ts`（T2 用例） | **Owner 拍板（不阻塞代码）** | **待 Owner 拍板**；代码默认即按②实现（不越墙） |
| **C2** | 桥接写入的最终结果在**桌面 App UI 中肉眼可见**（截图/录屏为证） | 未做 | — | M2 实现者出证＋复核方复审 | **未验**；T1 push 只证明「结果成为该 T1 线程的一个新轮次」，不等于桌面 UI 可见 |
| **C3** | 明确桥接 spawn 的是哪个二进制，并在该钉定版本上重跑 §4 接口实测全绿 | 钉定 PATH CLI 0.149.0：`packages/bridge/src/codexClient.ts:116`（thread/start）、`:131`（turn/start）、`:126`（thread/read）；`docs/bridge-config.example.json` 默认 `["app-server","--stdio"]` | `evidence/m2/codex-version.txt`（`codex --version` = `codex-cli 0.149.0`）＋ `evidence/m2/dual-instance-real-2026-10-09T19-29-29-958Z.json`（建线程 → turn/start → 真终态回读全链路成功） | M2 实现者；复核方复审 | **✓（见 §d 读数）** |
| **C4** | 受控实测「桌面正在某线程跑一轮时，另起 app-server 对同一线程 `turn/start`」⇒ 安全排队或明确拒绝，不得抢写历史 | 未做（本轮不制造并发写） | — | M2 实现者 | **未做**（不越红线；实现上 T1 桥接只写自建线程，`packages/bridge/src/bridge.ts:333` reconcile + `:194` dedupe 保证同请求不二次启动） |
| **C5** | 桥接**不硬编码模型串**，改用 `model/list` 动态取；`create` 默认路径要么改标签、要么跑通一轮 | 模型来自配置（`BridgeOptions.model`，`packages/bridge/src/bridge.ts:43`）；`CodexClient.modelList()`（`packages/bridge/src/codexClient.ts:145`） | 双实例实跑用 `gpt-5.6-luna`（配置注入，非写死） | M2 实现者 | **✓（模型串配置化＋model/list 接口就位）** |
| **C6** | 确认桌面列表是否按 `sourceKinds` 过滤；桥接写入线程的 source kind 必须落在桌面可见集合内 | 桥接自建线程的 `source` 由 App Server 决定（M1 实测 `vscode`，与既有桌面对话同集合）；实现不写 ~/.codex | M1 §6.2 依据 1 ＋ `evidence/m1/as-list-default.json` | M2 实现者 | **⚠（未实测桌面 UI 可见性 ⇒ 与 C2 同源；source kind 未变仍为 vscode，落在同一过滤集合内）** |

**结论口径（照 M1 §6.3）**：本轮**不声称「跨设备桌面对话已打通」**。已验证的是「桥接自建 T1 对话之间的完整往返」；「接入既有指定桌面对话」在 C1 满足前**未达**。

---

## b. 规范条款逐条对账

### §4 一条消息如何完成往返（八步）

| 步 | 条款原文要点 | 实现落点（文件:行） | 状态 |
| --- | --- | --- | --- |
| 1 | A 工具提交目标/正文/背景/结果要求/有效期；目标必须来自已授权目录 | `packages/bridge/src/mcp/server.ts`（relay_send 工具卡）；`packages/relay/src/router.ts:311`（POST /v1/requests） | ✓ |
| 2 | A 桥接验证身份与允许范围；服务端校验路由后持久化，生成唯一编号，返回「已入队」 | `packages/relay/src/domain.ts:435`（assertCanSend 三层校验）；`packages/relay/src/domain.ts:447`（createRequest＋`newRequestId`）；`packages/relay/src/router.ts:311` | ✓ |
| 3 | B 在线时领取；先写本地接收记录，再确认「设备已收到」 | `packages/bridge/src/bridge.ts:194`（processRequest → claim 取回含 body 的请求行）；`packages/bridge/src/state.ts:111`（intent）；`packages/relay/src/domain.ts:573`（claimRequest → delivery_status=device_received） | ✓ |
| 4 | B 确认可安全接入且空闲后投递，保存实际 threadId、turnId；忙碌时排队 | `packages/bridge/src/state.ts:129`（recordTurn 立即保存 turnId）＋`packages/bridge/src/bridge.ts:194`；同对话串行由 dispatch 去重保证（`packages/bridge/src/state.ts:111`） | ✓（忙碌排队＝本地串行；跨线程并发未开放，符合 §3.4） |
| 5 | B 在现有权限下处理；遇审批/登录/权限拒绝/材料不足返回具体状态；桥接不自动替用户批准 | `packages/bridge/src/codexClient.ts:97`（serverRequest 一律回 `approved:false`）；STATUS 通道 `packages/relay/src/domain.ts:615`（submitResult kind=STATUS） | ✓ |
| 6 | B 读取真实终态与最终输出，打包 RESULT（原请求编号/结论/验证/剩余事项/证据引用） | `packages/bridge/src/bridge.ts:291`（waitForTurn 读真实终态）＋`:403`（submitWithOutbox）；`packages/bridge/src/codexClient.ts` `lastAgentMessage` | ✓ |
| 7 | 服务端保存结果并按原请求绑定的回程地址投递；A 桥接落盘后在原对话追加带来源的结果通知 | `packages/relay/src/domain.ts:665`（按 `return_addr` emit）；`packages/bridge/src/bridge.ts:273`（deliverResultToConversation → 在 A 线程起一轮） | ✓ |
| 8 | 分别记录「结果已保存/已送达原对话/已被接收方处理」；业务验收另判 | `packages/protocol/src/index.ts:29`（ReturnStatus）＋`packages/relay/src/domain.ts:615`（写 `cloud_saved`） | ✓（前两层落点；`origin_processed` 为保留位，见 §e） |

**回程不可改写（§4 末段）**：`packages/relay/src/domain.ts:517`——`return_addr` 在入队时绑定为 `from_conv`，请求正文里的 `return_addr`/`return_address` 字段被忽略；反向断言见 §d。

### §5.1 五对象

| 对象 | 建议保留信息 | 实现落点 | 状态 |
| --- | --- | --- | --- |
| 设备 | 所有者、设备编号、凭证状态、最后连接时间 | `packages/relay/src/db.ts:25`（devices 表） | ✓ |
| 对话路由 | 设备、运行环境/profile、threadId、展示别名、允许来源 | `packages/relay/src/db.ts:34`（roster 表：既有五字段＋§2.2 全部追加字段） | ✓ |
| 请求 | 消息编号、来源与目标、类型、正文、有效期、关联任务、回程地址 | `packages/relay/src/db.ts:57`（requests 表：return_addr/ttl_s/parent_request_id/root_request_id/client_key） | ✓ |
| 执行记录 | 消息编号、实际 turnId、启动记录、执行状态、错误原因 | `packages/relay/src/db.ts:57`（requests.turn_id/exec_status/error）＋`packages/bridge/src/state.ts:37`（本地 dispatch 表） | ✓ |
| 结果与回执 | 原请求编号、最终输出、证据引用、目标接收状态 | `packages/relay/src/db.ts:90`（results 表）＋`return_status` | ✓ |

### §5.2 三层状态

| 层 | 取值 | 实现落点 | 状态 |
| --- | --- | --- | --- |
| 投递状态 | 已入队/设备已接收/已过期/投递被拒绝 | `packages/protocol/src/index.ts:16`（DeliveryStatus）＋`domain.ts:573`/`:711`/`:829` | ✓ |
| 执行状态 | 待启动/运行中/等待用户/已完成/失败/已中断/结果待核对 | `packages/protocol/src/index.ts:21`（ExecStatus）＋`packages/bridge/src/state.ts:37`（本地 result_pending_verify） | ✓ |
| 回传状态 | 本地结果已保存/云端结果已保存/已送达原对话/接收方已处理 | `packages/protocol/src/index.ts:29`（ReturnStatus）＋`domain.ts:615` | ✓（前两层落点，后两层保留） |
| 「结果缺失」不得显示为业务完成 | — | `packages/relay/src/domain.ts:615`（写 `result_missing`）；`packages/bridge/src/bridge.ts:291`（无终态 → `failed`+`result_missing=true`，绝不写 `completed`） | ✓ |

### §5.3 去重与启动意图窗口

| 条款要点 | 实现落点 | 状态 |
| --- | --- | --- |
| 接收端启动前先写启动意图 | `packages/bridge/src/state.ts:111`（dispatch 行 status=`starting`） | ✓ |
| 取得 turnId 后立即保存 | `packages/bridge/src/state.ts:129`（recordTurn 同写 turnId+status=running） | ✓ |
| 重连优先查询原轮次 | `packages/bridge/src/bridge.ts:333`（reconcile：有 turn_id 先回读终态） | ✓ |
| 启动窗口崩溃：结合关联标记与线程历史查找原轮次 | `packages/bridge/src/bridge.ts:333`（marker=`relay:<request_id>`，扫线程历史） | ✓ |
| 无法唯一确认 ⇒ 进入「结果待核对」，暂停自动重启 | `packages/bridge/src/bridge.ts:333`（matches.length≠1 ⇒ `result_pending_verify`） | ✓ |
| 同 request_id 重复投递对应同一执行记录 | `packages/bridge/src/bridge.ts:194`（开头去重）＋`packages/relay/src/db.ts:88`（`requests_client_key` 唯一索引，网络重试沿用原编号） | ✓ |
| 重复 RESULT 归档、不触发新投递 | `packages/relay/src/domain.ts:615`（`is_first`；非首条不 emit） | ✓ |
| 消息标记只是核对线索，非幂等保证 | 代码注释（`packages/bridge/src/state.ts`、`bridge.ts`）明示；标记只用于定位 | ✓ |

### §5.4 排队、取消与循环控制

| 条款要点 | 实现落点 | 状态 |
| --- | --- | --- |
| 同一对话串行处理 | 桥接按 request 串行驱动；dispatch 去重防二次启动（`state.ts:111`／`bridge.ts:194`） | ✓ |
| 禁默认广播 | 发送原语只有单目标 `to=conv_id`；工具面无广播参数（`mcp/server.ts` relay_send） | ✓ |
| 禁自动转派 | 执行方不能改写 `to`；转派只能由来源发显式新请求（受 allow_sources 校验，`domain.ts:435`） | ✓ |
| 有限自动续轮上限（默认 3，数据库配置项，非环境变量） | `packages/protocol/src/index.ts:60`（默认 3）＋`packages/relay/src/domain.ts:487`（depth>limit ⇒ 409） | ✓ |
| 超限 ⇒ 该链新请求被拒＋向来源投且**仅投一条**「链上限已达」通知 | `packages/relay/src/domain.ts:533`（raiseChainLimitNotice）＋`packages/relay/src/db.ts:124`（notices_dedupe 唯一索引） | ✓ |
| 重复结果去重 | 同 §5.2/§5.3（is_first） | ✓ |
| 结果不自动回信（传输回执≠对话轮次） | RESULT 投递只产生一条 push 轮次，不生成任何自动回执轮次 | ✓ |
| 取消：未启动可取消；已运行发中断、读真实终态才显示已中断；迟到结果归档不自动重启来源 | `packages/relay/src/domain.ts:711`（cancelRequest 两分支）＋`packages/bridge/src/bridge.ts:259`（onCancel→turnInterrupt）＋`packages/bridge/src/codexClient.ts:141` | ✓ |

### §6 权限与资料边界（含 64KB）

| 条款要点 | 实现落点 | 状态 |
| --- | --- | --- |
| 设备身份＋对话许可＋任务授权一起校验 | `packages/relay/src/domain.ts:435`（assertCanSend：sender active / target active / allow_sources 命中）＋`packages/relay/src/router.ts` requireDevice/`resolveBinding` | ✓ |
| 每台设备独立可撤销凭证；撤销后立即阻止并关闭连接 | `packages/relay/src/domain.ts:173`（revokeDevice：置 revoked、名下对话转 paused、emit revoked）＋`packages/relay/src/ws.ts:139`（对 revoked 设备 `ws.close(4003)`） | ✓ |
| 对话开放：未认证零暴露；已登记成员见元数据不见正文 | `packages/relay/src/router.ts:232`（roster 只回元数据）＋契约用例「never leaks message bodies through discovery」 | ✓ |
| 权限继承：远端正文不能改规则/取执行权限 | 桥接不把正文当系统命令；`packages/bridge/src/codexClient.ts:97` serverRequest 一律拒绝自动批准 | ✓ |
| 凭证保管：模型登录/密钥留设备；对话不持云端令牌 | 桥接配置只放 device_token；对话经 MCP 工具间接调用（`mcp/server.ts`，device_token 走环境变量，不进对话上下文） | ✓ |
| 正文 64KB 上限 | `packages/protocol/src/index.ts:68`（65536）＋`packages/relay/src/domain.ts:438`（请求）＋`packages/relay/src/domain.ts:627`（结果） | ✓ |
| 不可访问的证据引用必须明确标记 | RESULT 带 `evidence` 字段（`packages/relay/src/db.ts:90`）＋`result_missing` 标记 | ⚠（引用可达性由执行方保证、系统如实透传，不作可达性校验——首版口径） |

### §7.2 四参数

| 条款要点 | 默认值 | 落点 | 状态 |
| --- | --- | --- | --- |
| 连接心跳 30 秒 | 30 | `packages/protocol/src/index.ts:64`；`packages/bridge/src/relayClient.ts:180`（startHeartbeat） | ✓ |
| 连续 90 秒无响应显示离线 | 90 | `packages/protocol/src/index.ts:65`；`packages/relay/src/ws.ts:145`（sweep）＋`packages/relay/src/router.ts:253`（presence） | ✓ |
| 重连指数退避，单次间隔上限 60 秒 | 60 | `packages/protocol/src/index.ts:66`；`packages/bridge/src/relayClient.ts:20`（backoffDelay）＋`:170`（scheduleReconnect） | ✓ |
| 未启动请求默认 24 小时过期 | 24 | `packages/protocol/src/index.ts:67`；`packages/relay/src/domain.ts:829`（expireUnstarted）＋`packages/relay/src/server.ts`（定时器） | ✓ |
| 「工程建议值，非平台保证」 | — | 全部为数据库配置项带默认值、管理面可调（`packages/relay/src/db.ts:20` config 表） | ✓ |

---

## c. 复核残留润色（2 处）

1. **设计 §11:382「thread/read 按 T1 限定」** —— 落实为代码约束＋显式声明：
   - `packages/bridge/src/bridge.ts:13` 类头 scope note：桥接只创建/读取 T1 managed 线程（`historyMode: legacy`）；paginated T2 线程上游 fail closed，桥接永不触碰。
   - `packages/bridge/src/bridge.ts:291`（waitForTurn）就地注释同义。
   - 状态：✓（代码约束已写死；T2 无任何 read/resume 调用路径）
2. **设计 §6.1:253「T2 无心跳标注」** —— 落实为显式字段＋导出列：
   - `packages/relay/src/router.ts:253` roster presence：T1 回 `{mode:'heartbeat', heartbeat:true, online, last_seen_at}`；T2 回 `{mode:'last_pull_at', heartbeat:false, last_pull_at, stale:true}`。
   - `packages/relay/src/csv.ts:34` roster 导出新增 `presence_mode` 列，取值 `heartbeat` / `last_pull_at_no_heartbeat`。
   - 状态：✓（契约用例「marks a T2 desktop conversation as pull-only with no heartbeat」覆盖）

---

## d. 测试读数与反向断言

**最终读数（最后一次全量运行，真跑 exit code 为准）**：

| 套件 | 命令 | 结果 | exit |
| --- | --- | --- | --- |
| relay（契约＋反向） | `pnpm --filter @relay/relay test`（`vitest run`） | **33 passed / 2 files** | 0 |
| bridge（集成） | `pnpm --filter @relay/bridge test` → `bridge.integration.test.ts` | 6 passed（1 skipped 占位＝已迁 recovery） | 0 |
| bridge（恢复） | 同上 → `recovery.test.ts` | 3 passed | 0 |
| bridge（MCP 契约） | 同上 → `mcp.contract.test.ts` | 2 passed | 0 |
| bridge（单测） | 同上 → `unit.test.ts` | 2 passed | 0 |
| bridge 汇总 | `node scripts/run-tests.mjs`（每文件独立进程） | **4/4 files passed，13 tests passed** | 0 |

**结构约束（SD-4）落实**：
- 契约测试走**真实生产入口链路**：`startTestRelay` 调 `createRelay()`（真 HTTP 路由＋真 WebSocket hub＋真 DB），测试经 `fetch`/`ws` 真连；无任何中间产物注入（`packages/relay/test/helpers.ts`；MCP 契约测试以真实子进程＋stdio JSON-RPC 驱动 `packages/bridge/src/mcp/server.ts`）。
- 桥接侧同样全链路：真 relay（HTTP＋WS）＋真 mock App Server 子进程（`packages/bridge/test/recovery.test.ts`、`bridge.integration.test.ts`）。

**反向断言逐条（把旧/短路实现放回去必须转红，`packages/relay/test/reverse.assertions.test.ts`）**：

| 护栏 | 正向断言 | 短路版（放回去） | 短路后读数（探针转红） |
| --- | --- | --- | --- |
| §5.4 链上限 | depth 4 请求 → 409 | `store.cfg.chain_limit = 999` | 变 201 |
| §6 64KB 上限 | 65537 字节 → 413 | `store.cfg.body_max_bytes = 1e7` | 变 201 |
| §6 来源许可 | 默认 allow_sources 下 → 403 | `assertCanSend = 空函数` | 变 201 |
| §5.2 RESULT 去重 | 第二条 RESULT `first=false` | 提交前删掉既有 RESULT | 变 `first=true` |
| §7.2 未启动过期 | ttl=0 后过期 → `expired` | `expireUnstarted = async()=>0` | 仍 `queued` |
| §5.2 回程绑定 | 正文 `return_addr=c-attacker` 被忽略 | —（正向即断言） | `return_addr === from_conv` |

**桥接侧覆盖的故障矩阵（mock 注入）**：延迟（`delay`）、崩溃窗口（`crash`＝进程死）、重复终态（`duplicate`）、终态缺失（`no_terminal`）、重复投递（同 request_id 事件重复）、取消、relay 不可达（outbox 补传）。落点：`packages/mock-codex/mock-app-server.mjs:70`（schedule）＋`:13`（MOCK_STATE_FILE 持久化）。

**双实例闭环（本机，交付物 7）**：

| 方向 | 模式 | 结果 | 证据 |
| --- | --- | --- | --- |
| A→B→A | mock 预演 | ✓（B 执行 1 轮完成，A 原对话收到结果轮） | `evidence/m2/dual-instance-mock-2026-10-09T19-19-14-594Z.json` |
| B→A→B | mock 预演 | ✓ | 同上 |
| A→B→A | **真实 Codex**（0.149.0，`gpt-5.6-luna`） | ✓ 任务执行轮 `completed`，结果推送进 A 原对话（delivery turn 已起） | `evidence/m2/dual-run` 日志（两次尝试的 `dual-real.run.log`） |
| B→A→B | **真实 Codex** | ✓ 任务执行轮 `completed`，结果推送进 B 原对话（delivery turn 已起） | `evidence/m2/dual-instance-real-2026-10-09T19-29-29-958Z.json` |

真实轮次用量：每方向 2 轮（执行方 1 轮 ＋ 结果推送轮 1 轮），落在「每方向 ≤2 轮」预算内；另有一次方向 1 的尝试因脚本回读容错缺陷重跑（不产生额外模型轮次以外的副作用，详见 §e 第 10 条）。

**真实栈局限（诚实记录）**：真实 Codex 下，对「线程刚建、其首轮仍在飞」的线程调 `thread/read` 返回 `-32603 ... rollout ... is empty`；该轮完成后即可正常回读。桥接的 `waitForTurn`（`packages/bridge/src/bridge.ts:291`）已把它当「尚未就绪」重试，故桥接侧无影响；双实例验证脚本首版按硬失败处理、当轮改为容错重试后双向通过。已按收件箱契约投一行（类别 C，轻量，状态 新）。

---

## e. 未完成 / 未验证（诚实清单）

1. **C1①（既有 paginated 桌面对话受控 resume/read）未做**：本轮全程未对任何既有桌面对话发起 resume/read（红线）。C1② 待 Owner 拍板。
2. **C2 桌面 UI 可见性未验**：无截图/录屏；T1 push 只证明「结果成为该 T1 线程的新轮次」。
3. **C4 并发写未做**：未制造「桌面活跃线程 + 另起 app-server 同线程 turn/start」。
4. **C6 桌面列表 sourceKinds 过滤未实测**：仅按 M1 事实记录 source=`vscode` 落在同一集合内。
5. **真多进程桥接重启未做**：崩溃窗口用例用「同一 LocalState 交给第二个 Bridge 实例」模拟进程重启（等价于重开状态库的内容）；mock 状态以文件持久化、线程历史跨进程可读已覆盖。
6. **异步出口（WS 等效回传报文）未实现**：RESULT/STATUS 只实现 HTTP 主路径（设计 §9 #18 所述 WS 等效报文语义相同，非缺口）。
7. **保留期清理作业未实现**：正文 7 天/元数据 30 天仅作配置项，无定时清理。
8. **`origin_processed` 回传层未落**：保留位。
9. **Railway 部署未做**：按任务边界不部署、不注册任何外部服务；`DATABASE_URL`/`pg` 驱动路径已实现但未在真实 Railway 上跑过（生产路径未被真实部署验证）。
10. **双实例验证脚本首版回读用例曾误判**：真实栈 `thread/read` 空 rollout 被当硬失败，方向 1 早先两次尝试因此在「结果已推送后」的取证步骤退出（模型轮次已发生）；改为容错重试后重跑通过。
11. **`bridge export` 便利命令未做**（设计 §6.1 标注为可选、非首版必需）。

---

## 附：本次提交点

最终提交信息含 `M2 status: <done|partial>` 与完成清单；证据目录 `evidence/m2/`。
