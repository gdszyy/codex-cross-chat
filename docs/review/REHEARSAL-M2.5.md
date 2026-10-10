# REHEARSAL-M2.5 — 接入文档盲演（access-guide.md）

**判决：DOC-FAIL**（9 步中 7 步按文档直接走通；第 4 步「发任务」与第 6 步「提交结果」被文档缺口卡住，靠错误消息与未写入文档的推断才走通。系统本身全程无故障——失败的均是文档，不是实现。）

- 盲演方：异族 agent（GLM），只拿 `docs/access-guide.md` ＋其明确指向的文件（`packages/bridge/skill/SKILL.md`、`docs/mechanism-design.md`、`docs/m2-reconciliation.md`、README 相关节）。未读 relay/bridge 源码补步骤（唯一例外见 §6 披露）。
- 环境：本机真实 relay 实例，内嵌库模式（`@electric-sql/pglite`，不设 `DATABASE_URL`），`HOST=127.0.0.1 PORT=28788`，`RELAY_ROOT_KEY` 从 env 载体注入进程环境、全程未出现在任何输出/日志/证据；演练后进程树已停、留退出记录（`step99-teardown.txt`）。
- 证据：`evidence/m2-5/rehearsal/`（step01–step20 ＋ chain 日志，密钥泄漏扫描 59 文件 CLEAN）。

## 1. 逐步通过表

| # | 演练步 | 证据文件 | 结论 |
| --- | --- | --- | --- |
| 1 | 装工具/配置（§1） | step04-install.txt、step05-mcpA-tools-whoami.jsonl | **通过**。九件套 `relay_*` 与文档逐一对应；`relay_whoami` 未绑定态返回 `{status:"unbound", bootstrap:{self,invite}}`，与 §2 完全一致。skill 落位（`~/.codex/skills/relay/SKILL.md`）按 §1.1 归安装器/Owner，agent 侧无需动作，演练未代写 |
| 2 | 自发登记（§2 路 A） | step06-register-A.jsonl、step07-register-B.jsonl | **通过**。A=`c-rmdgis`、B=`c-k25x7p`，均 t1_managed/push，登记即回完整花名册行 |
| 3 | 发现（§3） | step08-discover-inbox-A.jsonl、step16-check1-2-B.jsonl | **通过**。`relay_discover` 只回元数据（含 `accepts_from` 摘要）；`relay_inbox` 五块结构与 §3 逐字对应 |
| 4 | 发任务给已登记目标（§4） | step09 / step09b / step10 / step09c-send-task1-A*.jsonl | **失败（文档缺口）→ workaround 后走通**，见 §2 |
| 5 | 查状态（§4） | step11-status-task1-A.jsonl | **通过**。三层状态（queued/pending/null）＋`turn_id`/`result_missing`/`expires_at` 齐全 |
| 6 | 以目标身份提交结果 | step13a-result-submit-attempts.txt | **失败（文档缺口）→ workaround 后走通**，见 §3 |
| 7 | 源对话读结果（§4） | step13-read-result-A.jsonl | **通过**。`relay_read` 回请求全文＋结果数组，中文正文完好，`return_status=cloud_saved` |
| 8 | 再发一条并取消（§4） | step14、step15-cancel-task2-A.jsonl | **通过**。取消后 `delivery=rejected / exec=interrupted`；inbox 的 `results_to_verify`、`my_outbox` 随之更新 |
| 9 | 故障三查（§7） | step16、step18、step19、step-chain2-d1~d4、step20-A-inbox-notices.jsonl | **通过（含两处措辞落差）**，见 §4 |

## 2. 失败步 4：发任务——两次被卡，解法均不在文档里

**第一卡（400 binding_required）**：按 §2 路 A 在**同一个 MCP 实例**里登记成功后立刻 `relay_send`，报
`relay POST /v1/requests -> 400 binding_required "provide conv_id or profile+thread_id"`。
而同实例的 `relay_register`/`relay_whoami` 都正常（说明 profile+thread_id 已在通道上）。落差在文档原句：

> §2 路 A：「桥接会先确认“它创建的线程 = 你”，再分配 `conv_id`（形如 `c-XXXXXX`）。**你从此可被寻址**。」

读起来「登记完成即接入完成」。实际上：**登记后必须带 `--conv-id` 重启 MCP 实例才能发送**——这一步文档从未写出（§1.2 的 config 示例倒是常驻 `--conv-id`，但没有一句话把「示例里的 conv-id」与「register 回给你的 conv-id」连起来）。

**第二卡（403 source_not_allowed）**：带 conv-id 重启后再发，报
`403 source_not_allowed "sender not allowed by target"`。原因：登记默认 `allow_sources=["owner"]`，A 不在其中。文档原句：

> §7 查三：「`allow_sources` 是否允许你（不允许 → **403**）」
> §2 路 A：「必需：`alias`、`role`（`manager|worker|verifier|observer`）、`task`（一句话当前职责）、`project`。」

§7 教你**查**到 403，§2 的参数清单却不含 `allow_sources`——读者会查、无处修。实际解法（step10）：`relay_register` 本身接受 `allow_sources` 参数（重登记即更新），参数从未被文档记载；取值语义只散落在 mechanism-design §2.2（「元素为 conv_id / `device:<id>` / `owner`；默认 `["owner"]`」）。两次尝试均无「文档提供的替代路径」可换——二选一的另一条路（路 B 加入码）同样不解决「目标不接受我」。

## 3. 失败步 6：提交结果——接入指南没有对话侧回传路径

接入指南对结果回传只有一句能力声明：

> §5 T1 行：「收任务、自动执行、回传结果；结果可自动 push 回原对话」

这是**桥接**的行为；文档没有给执行方对话任何提交 RESULT/STATUS 的操作路径（九件工具里也没有）。沿指南指向的 mechanism-design §9 表第 18 行才找到端点：

> 「`POST /v1/requests/{id}/result` | device_token＋绑定 | **RESULT/STATUS 回传提交**（执行方桥接把最终输出/中途状态写回服务端；主路径 HTTP…）——v1.1 补齐」

但该行**既没写鉴权头名，也没写 body schema**。盲试 4 次才通（step13a 全记录）：无 conv → 400；query `?conv_id=` → 400（被忽略）；body 带 `evidence` 数组 → **500 internal_error**（应为干净 400）；最终 `{conv_id, kind:"RESULT", body}` ＋ `x-device-token` 头 → 200。头名在整条允许文档链里不存在，只能按 `x-root-key` 惯例类比猜。

## 4. 通过步的落差与观察（不计失败，供修订）

- **查三·错投措辞**：文档「错投 → 目标不认领」；实际是**即时 `404 conv_not_found "no such conversation: …"`**——行为比文档更好（不会静默排队），但措辞会误导读者预期。
- **查二·presence 窗口**：刚登记后的短窗口内 `presence.online=true`（此时并无任何桥接 WS 在线）；30s 心跳过期后才转 `false`。§7 查二第 3 条「看 `presence.online`」基本成立，但宜注明「online=true 仅代表近期有心跳/登记，不等于桥接当前在线」。
- **查三·413/409/通知 全部与文档一致**：70KB body → `413 body_too_large`（阈值 65536 字节逐字兑现）；链深 1/2/3 通过、第 4 环 → `409 chain_limit_reached`；且来源 inbox `notices` 恰好**一条** `kind=chain_limit`（root 指向根请求），「且仅投一条」兑现。
- **实现健壮性（转工程线，非文档）**：RESULT 端点对 `evidence` 数组返回 500 internal_error 而非 400 参数错误。

## 5. 文档必须补的清单

1. **§2 路 A 补一句**：登记成功后，MCP 实例需带返回的 `conv_id` 以 `--conv-id` 重启，`relay_send` 等工具方可通过绑定校验（现状原句「你从此可被寻址」造成「同实例即可发」的错觉）。
2. **§2 路 A 参数清单补 `allow_sources`**：写明默认 `["owner"]`、取值 `conv_id | device:<id> | owner`、以及「要让别的对话给你发任务，登记/重登记时显式开放」；否则按文档自登记的两个对话互发必然 403，且文档内无解。
3. **补结果回传一节**：`POST /v1/requests/{id}/result`，鉴权头 `x-device-token`，body `{conv_id, kind: "RESULT"|"STATUS", body}`；写明 `evidence` 的正确类型（数组会 500）；说明 STATUS/RESULT 与 §6.2 的衔接。
4. **§7 查三措辞更正**：错投不存在的 `conv_id` → 即时 `404 conv_not_found`（不是「目标不认领」的静默状态）。
5. **§7 查二补 presence 语义**：`online=true` 的时效语义（心跳窗口），避免把「刚登记」误读为「桥接在线」。
6. （配套，工程线）RESULT 端点参数类型错误应返回 400 而非 500。

## 6. 纪律声明

- 密钥纪律：`RELAY_ROOT_KEY` 只经进程环境注入；设备令牌只进 TEMP 文件＋进程环境，演练结束已删；全部 59 个证据文件扫描 CLEAN（无根密钥、无裸设备令牌）。内嵌库数据目录（pgdata，含设备行）演练后已随收尾删除。
- 进程收尾：relay 进程树 `taskkill /T /F` 全灭（`step99-teardown.txt`），端口 28788 释放、健康端点失联确认；每个 MCP 子进程由驱动器自行 kill（各 step 日志内含 `exit` 记录）。
- 盲演边界披露：为确认设备令牌头名做的一次全仓 grep 意外命中源码（`packages/relay/src/router.ts` 使用 `x-device-token`）——该头名**未出现在任何允许文档中**，即使不依赖该次命中，按 `x-root-key` 惯例类比也是唯一合理盲试；文档缺口照记（清单第 3 条）。
- 复盘收件箱：本段无值得复盘的发现——文档缺口即本报告交付物本身，过程性坑（Node 26 spawn `.cmd` 需 shell、PS 正则解析失误）均为一次性脚本问题，无复发面。

## 二轮记录（HEAD 6a36ddf 返工后复验）

**判决：DOC-PASS**（三件任务全部「一次即通」，无任何盲试；两处措辞抽验与实际行为一致）。环境同上（内嵌库、回环 28788、密钥注入不外泄；证据前缀 `r2-`，泄漏扫描 26 文件 CLEAN；进程树已停、临时令牌与 r2-pgdata 已删）。

| 任务 | 判据 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1. 重走步 4（发任务） | 按文档 ⚠ 段＋「开放来源」节操作，`relay_send` 一次即通 | **通过**：A 登记默认来源→B 登记时按文档带 `allow_sources:["owner","c-6rorfd"]`→A 按 ⚠ 带 `--conv-id` 重启实例→首发即 201（`r-c71e4423fa88ddee`，queued/pending，return_addr 绑回 A）。全程零盲试、零 400/403 | r2-step04/05/06 |
| 2. 重走步 6（提交结果） | 按 §4.1 一次即通（含 evidence 字符串正确形态）；数组确实回 400 而非 500 | **通过**：按 §4.1 的 `x-device-token` 头＋`{conv_id,kind:"RESULT",body,evidence:"codex-thread:…",exec_status:"completed"}` 首发即 200（`res-b1825b2578d8e135`，evidence 字符串入库，is_first=true）；`evidence:["a","b"]` → **400 `bad_field_evidence "evidence must be a string (received array)"`**，与 §4.1 原句逐字兑现（一轮为 500，修复确认）；A 侧 `relay_read` 读回全文，中文完好、exec=completed/return=cloud_saved | r2-step07/08/09 |
| 3a. 查三措辞（404） | 「不存在 → 即时 `404 conv_not_found "no such conversation: …"`，不会静默排队」 | **通过**：发往 `c-r2-nonexist` → 即时 `404 conv_not_found "no such conversation: c-r2-nonexist"`，无排队 | r2-step11 |
| 3b. presence 时效句 | 「刚登记后的短窗口内即显示 true……无心跳后约 30–90 s 才衰减为 false」 | **通过**：新登记 C（无任何桥接 WS）t0 即 `online=true`；15s 间隔轮询实测衰减点在 **84.9s（仍 true）→ 100.5s（已 false）** 之间，阈值≈90s（＝30s 心跳×3 次未达），落在「约 30–90 s」的容差上沿；HTTP 工具调用不刷新 `last_seen_at`（观察项，与「只当最近活跃读」的口径相容） | r2-step10/12/13 |

过程披露：3b 初测时我用 PS 手算时间差得出「+150s 仍 true」的错误中间结论，随后改为 15s 轮询实测（r2-step13 全程留痕）推翻之——判决依据一律以实测为准，不以推算为准。

