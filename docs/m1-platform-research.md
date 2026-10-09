# M1 平台与协议事实核查报告

版本：**V1.1**（返工修订版）；V1.0 日期 2026-10-10　范围：Railway 平台能力核对 ＋ Codex App Server 官方协议细读 ＋ 本机开发前置核查
返工轮次：第 1 次返工（依据 `docs/review/REVIEW-M1.md`，仅修 **R5 出处归因**；未跑新探针、未改证据、未改平台结论）
方法：Railway/OpenAI 官方文档逐页 `web_fetch` 现取（优先 page `.md` 变体）＋ 本机只读命令现取
查阅日期：**2026-10-10**（Railway 与 OpenAI 文档均"subject to change"，引用均附 URL，价值随日期衰减）
边界：本轮**只读调研**——不注册、不部署、不花钱、不装软件；结论只到"文档层面支持/不支持/需注意"，运行态一律标"未实测"。

引用的官方来源（本报告全部断言的可核查出处）：

- [R-serverless] Railway, Serverless：https://docs.railway.com/deployments/serverless
- [R-specs] Railway, Specs & Limits：https://docs.railway.com/networking/public-networking/specs-and-limits
- [R-pg] Railway, PostgreSQL：https://docs.railway.com/databases/postgresql
- [R-services] Railway, Services：https://docs.railway.com/services
- [R-plans] Railway, Pricing Plans：https://docs.railway.com/pricing/plans
- [R-bill] Railway, Understanding Your Bill：https://docs.railway.com/pricing/understanding-your-bill
- [C-app] OpenAI, Codex App Server：https://learn.chatgpt.com/docs/app-server

---

## 0. 方案 §9 逐行结论（含"前三行"）

方案 §9 表共 6 行（源附件与 `plan-v1.md` 逐字一致，见核对记录 §7）。前三行 = 行 1（App Server）／行 2（本机桥接入口）／行 3（Railway）。

| # | 事项 | 方案依据列 | 方案原结论 | M1 核查结论 |
|---|---|---|---|---|
| 1 | Codex 可通过程序操作线程与轮次 | 官方 App Server 文档 [1] | 接口层面具备基础能力 | **确认成立（文档层）**。官方 App Server 为 JSON-RPC 2.0，明文提供 `thread/start`·`resume`·`fork`·`read`·`list`、`turn/start`·`steer`·`interrupt` 及事件通知。稳定面可直接用，实验面需 `experimentalApi` 门控。本机已装 `codex-cli 0.149.0`，可 `codex app-server` 启动。→ 由"具备基础能力"升级为"官方文档逐条确认 + 本机具备入口"；**运行态仍待实测**。 |
| 2 | 本机存在消息桥接入口 | 本轮只读检查现有 messenger 脚本 | 存在实现，未在本轮执行验证 | **维持原结论，本轮未复验**。方案 §3.4 所指 messenger 脚本不在本次 M1 前置核查范围内，未再检查。本轮新增事实：本机 `codex` CLI v0.149.0（npm 全局）已装，App Server 随 CLI 提供（`codex app-server`），桥接具备官方接入点。→ 仍为"存在实现，未运行验证"。 |
| 3 | Railway 可承载中转服务 | 官方服务、网络和数据库文档 [2][3][4] | 平台能力与方案匹配 | **确认成立（文档层）**。常驻服务（Persistent services）＋PostgreSQL 模板＋HTTP/1.1 上的 WebSocket（明文支持）＋TLS/HTTPS 公网入口＋TCP Proxy＋备份/HA 指引，均在官方文档逐条命中（见 §1）。**需注意**：Serverless 若被启用会在空闲 5–10 分钟后休眠并冷启动，打断常驻 WebSocket 连接——部署时必须确认未启用（方案 §7.1 已提此点，方向正确）。 |
| 4 | 现有桌面对话双机互通 | 尚无本轮运行证据 | 待实测 | **维持"待实测"**。本轮不产生运行证据；且据**方案 §3.4**（本方案自己的假设，**非** App Server 文档自述）"另启一个 App Server 并读取相同历史，不等于接管桌面中正在运行的会话"——本机 `thread/loaded/list` 空已实测佐证该假设。仍是本方案**最高不确定项**。 |
| 5 | 去重、审批、取消和故障恢复 | 本文推荐规则与验收用例 | 待实现与验证 | **维持"待实现"**。App Server 侧已确认可用原语：`turn/interrupt`（取消）、审批类 server-request（`item/permissions/requestApproval` 等）、`thread/read`＋turn 历史（恢复核对）。规则与幂等仍须自建（方案 §5.3 已知无官方幂等保证）。 |
| 6 | 成本与投递性能 | 尚无部署用量和测量 | 待试运行测量 | **维持"待试运行"**。本轮给出计费维度框架（§4），无实测数据；不给月费估算（遵方案 §7.3）。 |

---

## 1. Railway 能力核查（逐项：方案原句 → 官方出处 → 结论）

### 1.1 常驻服务与 Serverless/休眠行为

**方案原句（§7.1）**："服务应配置为常驻运行，核对 Railway 的 Serverless/休眠设置，避免设备无人操作时影响投递及时性。[5]"
**另（§3.1）**："Railway 官方文档说明其支持持久运行的服务……"

**官方出处**：[R-serverless]、[R-services]
**官方原文（逐字）**：

- `Serverless allows you to increase the efficiency of resource utilization on Railway and may reduce the usage cost of a service, by ensuring it is running only when necessary.`（[R-serverless]）
- `Serverless is applied to a container when that container is created. Enabling it on a running service does not affect the container already running; the service must be deployed before it takes effect.`（[R-serverless]）
- `Once a service stops sending packets it is considered inactive after 5 minutes. Inactivity is sampled on an interval rather than measured continuously, so in practice a service sleeps somewhere between 5 and 10 minutes after its last outbound traffic.`（[R-serverless]）
- Caveats：`There will be a small delay in the response time of the first request sent to a slept service (commonly known as "cold boot times").`／`The first request sent to a slept service may return a 502 Bad Gateway response.`／`Slept services still consume a slot on Railway's infrastructure, enabling Serverless de-prioritizes your workload and in remote cases, may require a rebuild to re-live the service.`（[R-serverless]）
- `Persistent services: Services that are always running. Examples include web applications, backend APIs, message queues, database services, etc.`（[R-services]）

**结论：支持（需注意）**。Railway 有明确的"常驻服务"形态，且 Serverless 是**可选开关**（默认不启用），故方案"配置为常驻"可行。**注意**：一旦对服务启用 Serverless，空闲 5–10 分钟即休眠，首个请求冷启动且**可能返回 502**——这会直接打断常驻 WebSocket。⇒ 方案 §7.1 的提醒正确且必要；部署检查项应含"确认目标服务未启用 Serverless"。

### 1.2 基于 HTTP/1.1 的 WebSocket 支持

**方案原句（§3.1）**："Railway 官方文档说明其支持持久运行的服务、PostgreSQL 部署以及基于 HTTP/1.1 的 WebSocket……"

**官方出处**：[R-specs]
**官方原文（逐字）**：

- `Support for HTTP/1.1 and HTTP/2.`
- `Support for websockets over HTTP/1.1.`
- `Idle HTTP/1.1 connections are closed after 60 seconds between requests. This does not apply to HTTP/2 or websocket connections.`
- `Websocket connections are exempt from these duration and inactivity limits, and can stay open indefinitely, even while idle.`
- Rate limits：`10,000 concurrent connections`／`11,000~ RPS`／`10,000 requests`（per connection）
- `All traffic must be HTTPS and use TLS 1.2 or above, and TLS SNI is mandatory for requests.`

**结论：支持（明确）**。写法逐字命中"websockets over HTTP/1.1"，且 WebSocket **不受空闲/时长限制、可长期闲置保持**——这正是常驻桥接需要的。**注意**：公网入口必须走 HTTPS/TLS 1.2+（不接受明文）；WebSocket 走的是标准 TLS 端口（非 TCP Proxy）。

### 1.3 PostgreSQL 服务与备份

**方案原句（§7.1）**："一个 PostgreSQL 服务｜保存消息和状态，配置备份并做恢复演练"

**官方出处**：[R-pg]
**官方原文（逐字）**：

- `The Railway PostgreSQL database template allows you to provision and connect to a PostgreSQL database with zero configuration.`
- `Databases are deployed private by default — to expose one, open the service's Settings → Networking and add Public Access. This creates a TCP Proxy and populates a DATABASE_PUBLIC_URL variable with the external connection string.`
- `Keep in mind that you will be billed for Network Egress when using the TCP Proxy.`
- **Backups**：`Backups: Automate regular backups to ensure data recovery in case of failure. We suggest checking out the native Backups feature.`
- **HA**：`An existing PostgreSQL service can be converted into a high-availability cluster with automatic failover, backed by Patroni, etcd, and HAProxy.`
- **Major version upgrades**：`Move a PostgreSQL service to a newer major version in place, with a preflight check, automatic backups, and one-click revert.`

**结论：支持（需注意）**。PostgreSQL 模板开箱即用；数据库**默认私有**（同项目内服务经 private network 可达，不暴露公网），与方案"数据库是消息状态的事实源"契合。**注意**：① 备份不是平台默认自动执行——Railway 提供原生 Backups 功能，方案要求的"配置备份并做恢复演练"须自行落实；② 想从项目外连库需开 Public Access（TCP Proxy）**并按 Network Egress 计费**——方案设计里桥接与库同项目，应走 `DATABASE_URL`（私有）而非 `DATABASE_PUBLIC_URL`；③ SHM 默认 64MB，必要时设 `RAILWAY_SHM_SIZE_BYTES`。

### 1.4 服务部署形态

**方案原句（§7.1）**："Railway｜一个常驻消息服务，优先单实例｜HTTPS/WSS、健康检查、平滑停机、重连恢复"

**官方出处**：[R-services]
**官方原文（逐字）**：

- `A Railway service is a deployment target. Under the hood, services are containers deployed from an image.`
- `Services on Railway can be deployed from a GitHub repository, a local directory, or a Docker image.`
- `If a Dockerfile is found within the source repository, Railway will automatically use it to build an image for the service.`
- `Private Docker registry deployments require the Pro plan.`
- `Every service deployment has access to ephemeral storage, with the limits being 1GB on the Free plan and 100GB on a paid plan.`（持久化数据用 volume）
- 部署来源/自动部署：`When a new commit is pushed to the linked branch, Railway will automatically build and deploy the new code.`

**结论：支持（需注意）**。服务以容器为单元，来源可为 GitHub 仓库／本地目录（`railway up`）／Docker 镜像；常驻单实例可行。**注意**：① 方案列的"平滑停机"不是平台保证——平台侧重启/重新部署会断开连接（方案 §7.1 已认知，故"重连与持久化必须作为正常路径设计"）；② 私有镜像源需 Pro 档；③ 无 volume 的文件系统是临时的，重启即失——消息状态应落 PostgreSQL（方案已如此）。

### 1.5 定价模型与计费维度（口径框架）

**方案原句（§7.3）**："成本由云端后端运行、数据库与备份、网络流量、本机资源及各 Codex 环境的模型使用组成。中转服务自身无需再调用模型；任务和回传后来源对话的处理仍可能消耗模型额度。"／"当前不提供未经核实的月费数字。部署前按实际套餐和资源上限估算，试运行后用真实用量校准……"

**官方出处**：[R-plans]、[R-bill]
**官方口径框架（逐字要点）**：

- 计费结构 = **订阅费 + 资源用量**（订阅费可抵扣用量）：`Your subscription fee … is a minimum usage commitment. It covers your first $5 or $20 of resource usage each month.`（[R-bill]）
- 计量维度：`RAM`／`CPU`／`Network Egress`／`Volume Storage`（[R-plans]）；另有 VM 档（sandboxes、cloud agents）。
- 计费原则：`you pay for allocated resources, not traffic`——服务运行即计 RAM/CPU，**与是否有流量无关**（[R-bill]）。
- 构建免费：`Service builds are free. Railway does not charge for build CPU, memory, base-image downloads, image exports, or image storage.`（[R-plans]）
- 用量额度按月重置：`Included usage credits reset each billing cycle. They do not accumulate or roll over to the next month.`（[R-bill]）
- 防 egress 建议：`Use DATABASE_URL (private) instead of DATABASE_PUBLIC_URL.`（[R-bill]）

**结论：支持框架**。计费维度与方案 §7.3 的组成一致。官方公布的**牌价**（仅作口径锚点，**非本项目估算**，见 §4）与不给出月费总额估算的做法，符合方案 §7.3 的"禁止未经核实的月费数字"。

---

## 2. Codex App Server 可用接口与限制清单（交付 M2 实现者）

来源：[C-app]。**方向约定**：`→` = client→server 请求；`←` = server→client 通知；`⇄` = server→client 请求（client 必须回应）；`(exp)` = 需 `capabilities.experimentalApi = true`，否则被拒（error：`<descriptor> requires experimentalApi capability`）；`(dev)` = 官方标注"勿在生产 client 调用"。

### 2.1 传输与握手

- 协议：JSON-RPC 2.0 双向（线上省略 `"jsonrpc":"2.0"` 头；与 MCP 类似）。
- 传输 `--listen`：`stdio://`（默认，换行分隔 JSON/JSONL）｜`ws://IP:PORT`（**实验性、不支持**，每帧一条 JSON-RPC）｜`unix://[PATH]`（HTTP Upgrade 的 WebSocket over Unix socket）｜`off`。
- WS 健康探针（仅 `--listen ws://`）：`GET /readyz`→`200 OK`；`GET /healthz`→无 `Origin` 头时 `200 OK`，带 `Origin` 一律 `403`。
- WS 认证旗标：`--ws-auth capability-token --ws-token-file <绝对路径>`｜`--ws-auth capability-token --ws-token-sha256 <HEX>`｜`--ws-auth signed-bearer-token --ws-shared-secret-file <路径>`（可配 `--ws-issuer`／`--ws-audience`／`--ws-max-clock-skew-seconds`）。客户端在握手时以 `Authorization: Bearer <token>` 出示，服务端在 `initialize` 之前先鉴权。
- 握手：每连接**必须**先发一次 `initialize`（带 `clientInfo`），再发 `initialized` 通知。未初始化前任何请求 → `Not initialized`；重复 `initialize` → `Already initialized`。`initialize.params.capabilities` 还支持 `optOutNotificationMethods`（精确名，无通配）、`requestAttestation`、`mcpServerOpenaiFormElicitation`。
- 过载：请求入口满 → JSON-RPC 错误码 `-32001`，message `"Server overloaded; retry later."`；客户端应**指数退避＋抖动**重试。

### 2.2 方法与通知（按域）

**Threads（→）**：`thread/start`、`thread/resume`、`thread/fork`、`thread/read`、`thread/list`、`thread/loaded/list`、`thread/name/set`、`thread/goal/set`·`get`·`clear`、`thread/metadata/update`、`thread/archive`、`thread/delete`、`thread/unsubscribe`、`thread/unarchive`、`thread/compact/start`、`thread/shellCommand`、`thread/inject_items`；实验：`thread/turns/list`(exp)、`thread/items/list`(exp)、`thread/backgroundTerminals/clean`·`list`·`terminate`(exp)；`thread/rollback`（**已弃用**）。
**Turns（→）**：`turn/start`、`turn/steer`、`turn/interrupt`、`review/start`。
**Exec/进程（→）**：`command/exec`（+`/write`·`/resize`·`/terminate`）、`process/spawn`(exp)+`/writeStdin`·`/resizePty`·`/kill`(exp)。
**模型/特性（→）**：`model/list`、`modelProvider/capabilities/read`、`experimentalFeature/list`、`experimentalFeature/enablement/set`、`environment/info`(exp)。
**权限/模式（→）**：`permissionProfile/list`（beta）、`collaborationMode/list`(exp)。
**Skills/Hooks/Plugins（→）**：`skills/list`、`skills/extraRoots/set`、`skills/config/write`、`hooks/list`、`marketplace/add`·`remove`·`upgrade`、`plugin/skill/read`；`plugin/list`·`plugin/read`·`plugin/install`·`plugin/uninstall`（**均 `(dev)`，勿在生产 client 调用**）。
**Apps/connectors（→）**：`app/installed`、`app/list`、`app/read`。
**MCP（→）**：`config/mcpServer/reload`、`mcpServerStatus/list`、`mcpServer/resource/read`、`mcpServer/tool/call`、`mcpServer/oauth/login`。
**配置（→）**：`config/read`、`config/value/write`、`config/batchWrite`、`configRequirements/read`。
**文件系统 v2（→）**：`fs/readFile`、`fs/writeFile`、`fs/createDirectory`、`fs/getMetadata`、`fs/readDirectory`、`fs/remove`、`fs/copy`、`fs/watch`、`fs/unwatch`。
**Auth/account（→）**：`account/read`、`account/login/start`（`apiKey`｜`chatgpt`｜`chatgptDeviceCode`｜`chatgptAuthTokens`(exp)）、`account/login/cancel`、`account/logout`、`account/rateLimits/read`、`account/usage/read`、`account/rateLimitResetCredit/consume`、`account/sendAddCreditsNudgeEmail`、`account/workspaceMessages/read`。
**外部 agent 迁移（→）**：`externalAgentConfig/detect`、`externalAgentConfig/import`、`externalAgentConfig/import/readHistories`。

**通知（←，无 `id`，method+params）**——本轮文档抓取全文在中段被本地抓取器截断，**下述名字来自已读到的正文**，完整清单以 §2.4 的现算 schema 为准：`thread/started`、`thread/archived`、`thread/unarchived`、`thread/deleted`、`thread/closed`、`thread/name/updated`、`thread/goal/updated`、`thread/goal/cleared`、`thread/status/changed`、`turn/started`、`turn/completed`、`item/started`、`item/completed`、`item/agentMessage/delta`、`command/exec/outputDelta`、`process/outputDelta`、`process/exited`、`skills/changed`、`app/list/updated`、`mcpServer/startupStatus/updated`、`mcpServer/oauthLogin/completed`、`account/updated`、`account/login/completed`、`account/rateLimits/updated`、`externalAgentConfig/import/progress`·`/completed`、`serverRequest/resolved`。

**Server 请求（⇄，client 必须回应）**：`mcpServer/elicitation/request`、`item/permissions/requestApproval`（`request_permissions` 工具触发，回 `permissions` 子集，`scope` 可 `"session"`/`"turn"`）、`item/tool/call`（dynamic tool，exp）、`account/chatgptAuthTokens/refresh`、`tool/requestUserInput`(exp)。审批类可带 `autoResolutionMs`（毫秒超时后由 host 自动裁决）。

### 2.3 生命周期（桥接要用的主链）

1. 每连接一次 `initialize` → `initialized`。
2. `thread/start`（新建）/`thread/resume`（续接，传 `threadId`）/`thread/fork`（分叉）。三者返回 `instructionSources`（已加载指令文件路径）。续接不自动更新 `thread.updatedAt`，起 turn 时才更新。
3. `turn/start`（带目标 `threadId` + `input`；可覆盖 model/personality/`cwd`/sandbox 策略等）。
4. 流式通知：`item/started`、`item/completed`、`item/agentMessage/delta`、`turn/started` 等。
5. `turn/completed`（含最终 status）表示轮次结束；或 `turn/interrupt` 取消（终态 `status: "interrupted"`）。
6. `turn/steer` 可向进行中的 turn 追加输入而不新起 turn。

### 2.4 版本兼容与"以本机为准"

- 官方明述：`You can generate a TypeScript schema or a JSON Schema bundle from the CLI. Each output is specific to the Codex version you ran, so the generated artifacts match that version exactly`。生成命令：
  - `codex app-server generate-ts --out ./schemas`
  - `codex app-server generate-json-schema --out ./schemas`
- ⇒ **M2 实现者的权威字段/notification 清单，应以上脚本在本机 v0.149.0 的生成物为准**（本报告 §2.2 的通知名可能因文档截断不全）。

### 2.5 限制与硬边界（M2 / 首版必须内化）

| # | 限制（官方原文要点） | 对本方案的含义 |
|---|---|---|
| L1 | `The app-server command and WebSocket transport are experimental and aren't supported for production workloads.`／`WebSocket transport is experimental and unsupported.` | 方案 §3.4"TCP WebSocket 暂标实验性、不作首版公网入口"**与官方一致**。本机桥接→App Server 优先 `stdio://` 或 `127.0.0.1` WS。 |
| L2 | `Non-loopback WebSocket listeners currently allow unauthenticated connections by default during rollout, so configure WebSocket auth before exposing one remotely.` | 远程 WS 监听**默认无认证**，必须配 `--ws-auth`。 |
| L3 | `App-server authentication has never been permitted for commercial or hosted services.` | **重要**：旧 app-server auth 面**明文禁止**用于商用/托管服务；本方案为个人自用，仍应记录此边界，认证留在本机 `~/.codex/auth.json`，云端不持有。 |
| L4 | over-load：`-32001 "Server overloaded; retry later."` | 桥接须实现指数退避＋抖动重试。 |
| L5 | 未 `initialize` 前一切请求被拒；`initialize` 每连接仅一次。 | 重连须重跑握手。 |
| L6 | `thread/inject_items` 的描述是 `append raw Responses API items to a loaded thread's model-visible history without starting a user turn`。 | 方案 §4.7"在原对话追加一条带来源的结果通知"若用 `inject_items`，**它只写"模型可见历史"、不开用户轮次**，是否等价于"桌面对话内可见消息"**未证实**——这正是 §9 行 4 的"待实测"核心。 |
| L7 | `historyMode: "paginated"` 未支持，创建即返回 `-32601`；分页历史 resume 会 fail-closed。 | 首版用默认 `"legacy"` 历史模式。 |
| L8 | `thread/start`/`resume` 在"被标记 `required` 的 MCP server 初始化失败"时会**直接失败**而非降级。 | 桥接侧配置的 MCP 需保持可用，或不要标 `required`。 |
| L9 | `plugin/*` 全部 `Don't call this method from production clients yet.` | 不使用。 |
| L10 | 动态工具、`chatgptAuthTokens`、`process/*`、`thread/items/list` 等均须 `experimentalApi`。 | 明确区分稳定面/实验面，稳定面优先。 |

---

## 3. 本机开发前置核查（只读命令现取）

命令与观测（PowerShell 5.1，2026-10-10）：

| 依赖 | 命令 | 观测结果 | 判定 |
|---|---|---|---|
| Node.js | `node --version` | `v26.2.0`（`C:\Program Files\nodejs\node.exe`） | **有**（消息服务用 TS/Node 可行） |
| npm | `npm --version` | `11.13.0` | 有 |
| pnpm | `pnpm --version` | `10.33.0` | 有 |
| yarn | `yarn --version` | `无法将"yarn"项识别为 …` | **缺**（非必需，npm/pnpm 可替代） |
| git | `git --version` | `git version 2.53.0.windows.1` | 有 |
| docker | `docker --version` | `无法将"docker"项识别为 …` | **缺** |
| docker compose | `docker compose version` | 同上（命令不存在） | **缺** |
| psql（本地 PostgreSQL 客户端） | `psql --version` | `无法将"psql"项识别为 …` | **缺**（本机无 PG 客户端） |
| Python | `python --version` | `Python 3.14.5` | 有 |
| **codex CLI** | `codex --version` | `codex-cli 0.149.0`（`C:\Users\Administrator\AppData\Roaming\npm\codex.ps1`） | **有**（App Server 入口具备） |
| Codex 状态目录 | `Test-Path "$env:USERPROFILE\.codex"` | 存在（含 `config.toml`、`auth.json`、`sessions/` 等） | 有 |

**本机部署前置缺口清单**：

1. **缺 docker / docker compose**：无法在本机一键起 PostgreSQL 做本地联调。→ 要么用 Railway 上的库联调，要么另定本地库方案；本机不安装（遵本轮只读边界）。
2. **缺 psql**：本机无 PostgreSQL 命令行客户端；连库需 psql 或走 Node `pg` 驱动（后者随依赖安装）。
3. **缺 yarn**：非阻断（npm/pnpm 已具备）。
4. 需 Owner 侧提供：**Railway 账号与预算**（方案 §8.3 已列）。
5. 部署检查项（文档层给出）：确认目标常驻服务**未启用 Serverless**；桥接↔库走 **private network**（`DATABASE_URL`，非 public）。

---

## 4. 成本口径框架（维度＋官方牌价锚点，**非本项目估算**）

> 遵方案 §7.3：**不给未经核实的月费数字**。下表官方牌价均取自 [R-plans]，仅作**口径锚点**，不构成本项目的花费承诺或估算；实际以部署套餐、区域与真实用量为准。

**计费结构**：订阅费（可抵扣用量）＋ 资源用量。用量按维度计量：

| 维度 | 官方牌价（[R-plans]） | 本项目关注点 |
|---|---|---|
| RAM | `$10 / GB / month`（`$0.000231 / GB / minute`） | 常驻消息服务的内存常驻占用（空闲也计） |
| CPU | `$20 / vCPU / month`（`$0.000463 / vCPU / minute`） | 同上；空闲也计 |
| Network Egress | `$0.05 / GB` | 桥接↔云端、库公网连接产生的出站流量 |
| Volume Storage | `$0.15 / GB / month` | 若无 volume，PG 落临时盘有丢失风险；卷存储计入此维 |
| 订阅档 | Free `$0`/月、Hobby `$5`/月（含 $5 用量）、Pro `$20`/月（含 $20 用量）、Enterprise 定制 | 档位与资源上限见 [R-plans] |

**原则性口径（[R-bill]）**：① 按**分配的资源**而非流量计费——服务一运行就算 RAM/CPU；② 用量额度按月重置、不累积；③ build 免费（不收费 build CPU/内存/镜像）；④ 服务↔库走公网 URL 会计 egress。

**方案 §7.3 的组成对应**：云端后端运行（常驻服务 RAM/CPU）＋ 数据库与备份（PG 的 RAM/CPU ＋ 卷/备份存储）＋ 网络流量（egress）＋ 本机资源（本机自担）＋ 各 Codex 环境模型额度（桥接自身不调模型，但来源对话处理任务仍可能消耗）。

---

## 5. 风险与建议

| 风险 | 等级 | 依据 | 建议 |
|---|---|---|---|
| R1 桌面会话所有权/并发未证 | **高** | **方案 §3.4 假设**（另起 App Server 读同一历史 ≠ 接管桌面运行中会话）＋本机实测（`thread/loaded/list` 空）；**非** App Server 文档自述 | 首版只用"明确交由桥接控制的空闲测试对话"；先做所有权验证（M2/M3）再放开 |
| R2 app-server auth 禁用于商用/托管 | 中 | [C-app]：`never been permitted for commercial or hosted services` | 认证留本机 `~/.codex/auth.json`，云端不持有；记录此边界 |
| R3 WS 实验性 + 非 loopback 默认无认证 | 中 | [C-app] L1/L2 | 首版不把 App Server WS 作公网入口；本机用 `stdio`/`127.0.0.1` |
| R4 Serverless 休眠断连 | 中 | [R-serverless] 5–10 分钟休眠、冷启动、可能 502 | 部署检查"未启用 Serverless"；重连/持久化为正常路径（方案 §7.1 已列） |
| R5 版本兼容 | 中 | [C-app] §2.4 生成物随版本 | 固定 codex 版本范围，升级后做接入回归（方案 §7.1 已列） |
| R6 结果注入的"桌面可见性"未证 | 中 | [C-app] L6（`inject_items` 只写 model-visible history） | 作为 §9 行 4 先验项单独实测，勿假设等价于桌面可见消息 |
| R7 本地联调缺 docker/psql | 低 | §3 观测 | 用 Railway 库或 Node `pg` 驱动；本机不装软件 |
| R8 计费盲区（空闲计费/公网 DB egress） | 低 | [R-bill] | 全程走 private network；试运行后用真实用量校准 |

**总体判断**：方案对 Railway 的三条平台假设（常驻服务、PostgreSQL、HTTP/1.1 WebSocket）**文档层全部成立**；对 App Server 的判断（提供线程/轮次/事件接口、TCP WebSocket 实验性）**与官方文档一致**。方案的最大不确定项仍集中在 **"桌面会话所有权/并发"与"结果在桌面正确显示"**——这两项官方文档**不提供保证**，必须实测，且不属于本轮（M1）可闭合的范围。

---

## 6. 未核实项（显式声明，禁止当作已证）

1. **App Server 通知/审批的完整逐字段 schema**：本轮抓取 `https://learn.chatgpt.com/docs/app-server`（`.md` 变体约 25k tokens）时，中段（Turns/Notifications/Approvals 部分）被本地抓取器 16000-token 上限截断，§2.2 的通知名仅覆盖已读到的正文。**权威清单以本机 `codex app-server generate-ts` 生成物为准**（[C-app] §2.4）。
2. **本机 messenger 脚本（方案 §3.4 所指）**：本轮 M1 前置核查范围不含它，未复验；§9 行 2 维持"存在实现，未运行验证"。
3. **Railway 实际套餐/区域/配额/费用**：方案 §3.1 已声明"部署前核实"，本轮只核文档能力，未开账号、未计价。
4. **Railway 边车对 WebSocket 的实测行为**：文档明文"支持且可长期闲置保持"，但**未实测**（本轮只读）。

---

## 7. 核对记录（源附件 vs 本地拷贝）

- 源附件 `C:\Users\Administrator\.minimax\v2\assets\2026\10\10\00-04-09-138-asset_...Codex跨设备对话通信方案.md` 与本地 `D:\claude\codex-relay\docs\plan-v1.md`：§9 表 6 行、§3.1/§7.1/§7.3 关键句**逐字一致**（比对行 208–213、47、145–152、166）。
- 本报告引用的"方案原句"均取自 `plan-v1.md`（与源附件一致）。
- 文本编辑：以 UTF-8 读写（`[IO.File]::ReadAllText` 语义），避免 PowerShell 5.1 默认 ANSI 静默错读（PC-7.1）。

---

## 8. 返工变更记录（V1.0 → V1.1）

依据：`docs/review/REVIEW-M1.md`（判决 FAIL）。本报告只涉 **R5（建议 1·出处误归因）**：

| 返工项 | 改了什么 | 改动位置 |
| --- | --- | --- |
| **R5** | §0 行 4 把"另起进程读同一历史 ≠ 接管桌面运行中会话"的出处，从「App Server 文档自述」改为「**方案 §3.4 假设 ＋ 本机实测（`thread/loaded/list` 空）**」——本人重取 App Server 文档未见该表述，该句实为方案 §3.4 原文的转写 | **§0 行 4**；**§5 风险表 R1** |
| 版本行 | 升 V1.1 并注明返工轮次与依据 | 文首 |

**平台结论未变**：§1 Railway 能力核查、§2 App Server 接口/限制、§4 成本口径框架均维持 V1.0 结论（复核方已确认前 3 行官方出处逐字命中）。**未做**：未跑新探针、未改证据、未改平台结论。
