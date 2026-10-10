# M2 复盘 — Codex 跨设备对话通信（实现站）

- 复盘站：`task:mvs_6b690c26`（Codex 跨设备线 M2 复盘子会话，无派发权、不改交付物）
- 复盘对象：M2 实现站（分支 `m2-implementation`，提交 `b87bf4d` ＋ `0346fa3`；基线 `698f9a8`）
- 证据纪律：**一切结论以盘上交付物与复跑读数为准，不采信执行者自述**；行号与计数均为本轮现算
- 判据来源：选人单 M2 行＋G5 补注（`C:\Users\Administrator\.harness\staffing\20261010-0012-Codex跨设备对话通信·调研落地.md`）

---

## 一、目标达成度（对照 M2 到达判定 ＋ G5 补注，逐项）

### 1.1 M2 到达判定（里程碑表 M2 行）

| # | 到达判定项 | 判定 | 盘上依据 |
|---|---|---|---|
| 1 | git 提交在库 | **达成** | `git log`：`b87bf4d`（relay 18 接口＋契约/反向测试）＋`0346fa3`（M2 partial 状态）；55 文件 / 8540 行入账 |
| 2 | 代码侧测试全绿 | **未稳定达成**（复跑可得绿，非确定） | 复跑同冻结提交：relay **首跑 31/33**（2 条 `Test timed out in 5000ms` 红）、次跑 33/33 绿；bridge **首跑 recovery 1/3 红**（文件耗时 48s）、次跑 4/4 绿但 recovery 单文件耗时 **152s**。根因：`packages/relay` 无 `vitest.config.ts`（用 vitest 默认 5s 超时），而每条契约用例冷启 pglite(WASM)；bridge 已设 90s。⇒「全绿」依赖机器空闲，不满足「可复现」口径 |
| 3 | 本机双实例闭环两方向（真实工具链穿透） | **部分达成** | mock 双向有 ok:true 落盘（`evidence/m2/dual-instance-mock-2026-10-09T19-19-14-594Z.json` 含 A→B→A 与 B→A→B 两步）；**真实 Codex 仅单方向有绿证**：真实栈唯一 ok:true 的 JSON 只有 B→A→B 一步（`evidence/m2/dual-instance-real-2026-10-09T19-29-29-958Z.json`），A→B→A 两次尝试均以 FATAL 收尾、无 JSON（`dual-instance-real-2026-10-09T19-19-46-878Z.log`＝`-32603 … rollout … is empty`；`dual-real.run.log`＝`timeout waiting for A->B->A result pushed to origin`）。⇒「真实 Codex 双向」无独立可核凭证 |
| 4 | GLM 异族复核判决落盘 | **未达成（非 M2 交付者项）** | 本轮为门内复核中，`docs/review/` 下只有 `REVIEW-M1.md`／`REVIEW-M1.5.md`，无 M2 复核判决；属管理方/复核方下一步 |

### 1.2 G5 补注（对到达判定的增补）

| 补注 | 判定 | 盘上依据 |
|---|---|---|
| ① C1–C6 原文入任务包逐条对账（C1①/C2/C3 实现者做＋GLM 复审；C1② Owner 拍板；C4–C6 自证） | **达成（对账表齐、状态如实）** | `docs/m2-reconciliation.md` §a 六条齐：C1① 未做（诚实，红线未触碰既有桌面对话）、C1② 待 Owner、C2 未验、C3 ✓（钉 0.149.0＋真链路回读）、C4 未做、C5 ✓、C6 ⚠ 未实测。各状态与盘上证据一致，**无夸大**（唯一夸大在 §d 闭环表，见 §1.1 第 3 项） |
| ② 按 T1/T2 两级分档，钉桥接二进制并在该版本重验 | **达成** | `packages/bridge/src/bridge.ts:13` 类头 scope note＝只建/读 T1 managed 线程；`packages/relay/src/router.ts:253` T2 回 `presence.mode='last_pull_at'`（无心跳）；`evidence/m2/codex-version.txt`＝`codex-cli 0.149.0`（与 C3 钉定一致） |
| ③ 诊断导出口径＝Excel 可直接打开（CSV/xlsx）＋skill 侧「罗列可用对话」视图 | **达成** | `packages/relay/src/csv.ts:7,19`（`\uFEFF` UTF-8 BOM）；契约用例「exports roster CSV with a UTF-8 BOM and a tier column」在；`packages/bridge/skill/SKILL.md` 有 `relay_discover`「List addressable conversations」＋`relay_whoami` |

### 1.3 对账表质量

- **齐**：§a（C1–C6）、§b（§4 八步 / §5.1 五对象 / §5.2 三层 / §5.3 / §5.4 / §6 / §7.2）、§c（复核残留润色 2 处）、§d（测试读数与反向断言）、§e（诚实清单 11 条）齐备。
- **行号可复核**：抽检 42 处 `文件:行`（bridge / protocol / domain / state / relayClient / codexClient / router / csv / db / ws）**逐处命中**（行内容与对账表描述一致），对账表行号诚实。
- **小瑕（不影响结论）**：提交信息测试读数口径不一致——`b87bf4d` 写「32/32」、`0346fa3` 写「relay 33 passed（26 契约＋7 反向）」；实测 `relay.contract.test.ts` 27 个 `it()` ＋ `reverse.assertions.test.ts` 6 个 = 33，即应为「27 契约＋6 反向」。对账表 §d 的「33 passed」正确。

---

## 二、卡点与返工（以 git 提交信息与证据为据）

| 卡点 | 盘上依据 | 后果 / 处置 | 是否返工 |
|---|---|---|---|
| 真实栈 `thread/read` 空 rollout | `evidence/m2/dual-real.run.log`、`dual-instance-real-2026-10-09T19-19-46-878Z.log` 的 `-32603 … rollout … is empty` 原文 | 桥接 `waitForTurn` 已 catch 容错；**验证脚本首版按硬失败处理**，A→B→A 两次在结果已投递后早退 | **返工 1 次**（`scripts/dual-instance.ts` 回读改容错重试）；已由执行者投收件箱（类别 C，轻量，状态 新） |
| pglite(WASM) 多实例压力致后跑测试极慢 | `packages/bridge/scripts/run-tests.mjs` 首段注释（「every file in one worker accumulates enough WASM pressure that later tests become extremely slow」）＋ `packages/bridge/test/recovery.test.ts` 首段注释 | 处置＝每文件独立进程 ＋ bridge `testTimeout 90s`；**残留**＝relay 无 testTimeout、bridge 内部 `waitFor` 15–25s 上限 | 无（属设计取舍） |
| 真实栈「结果送达原对话」缺独立回读 | `dual-instance-real-2026-10-09T19-29-29-958Z.json` 字段 `origin_readback: "thread/read unavailable"` | 真实方向的原对话侧送达**仅凭日志一行** `delivered result … into <conv> turn=…` 自述，无回读确认（mock 侧有 `origin_has_result:true`） | 无 |
| 依赖安装超时 / MCP 子进程握手 | **盘上无独立证据锚**（git 提交信息未记、`evidence/m2/` 无对应日志） | — | 未证（无锚点不收） |

**返工总数：1 次（脚本级，非交付物级）**。交付物级无返工（M2 尚无 G 门判决）。已投收件箱的 C 行不重复投。

---

## 三、教训判定与去向（门槛四项逐条指实体）

门槛判据（收件箱契约 §4）：① 影响已交付/已验收产物 ② 同类第 2 次 ③ 跨 ≥2 项目 ④ 漏拦归因。

| 代号 | 教训（现象） | 门槛判定（指实体） | 去向 |
|---|---|---|---|
| **L1** | **闭环结论/勾选与实际落盘凭证不符**：对账表 §d 与里程碑行把「真实 Codex 双向闭环」记为达成/勾 ✓，但真实栈只有单向（B→A→B）有 ok:true 绿证，另一方向（A→B→A）无 ok:true 落盘、以 FATAL 收尾 | **①命中**。实体＝已交付产物 `D:\claude\codex-relay\docs\m2-reconciliation.md` §d 表 A→B→A 真实行（勾 ✓，证据格自述「两次尝试的 dual-real.run.log」）；反证＝`D:\claude\codex-relay\evidence\m2\dual-real.run.log` 结尾 FATAL | **重型** → 投收件箱新行（类别 B） |
| **L2** | **测试「全绿」不可确定复现，且不区分「机器卡顿」与「断言失败」**：relay 无 testTimeout（默认 5s）＋每条契约用例冷启 pglite，负载下偶发超时红 | **②命中＋③命中**。②实体＝同类第 1 次记录＝收件箱行 `2026-10-08`｜`比分站合并主控（Claude Code）`「高负载机器上 E2E…偶发超时…需…区分『机器卡顿』与『断言失败』」（证据 `D:\claude\scorebrazil-build-lab\runs\MERGE-NOTES.md D-5`）；③实体＝`codex-relay` ＋ `scorebrazil-build-lab`（比分站） | **重型** → 投收件箱新行（类别 B） |
| **L3** | **提交信息测试读数与盘面不一致**：`0346fa3` 写「26 契约＋7 反向」、`b87bf4d` 写「32/32」，实际 27＋6＝33 | ①未命中（提交信息读数口径小不一致，对账表 §d 的「33 passed」正确，不改任何结论）；②③④未命中 | **轻量** → **留表**（登记于本复盘，待复发或影响面扩大再投；本项不投收件箱） |
| **L4** | 题面所列「依赖安装超时 / MCP 子进程握手」卡点 | 四条**均指不出盘上实体**（无日志、无提交信息记载） | **不入账**（契约 §2：没有可复现锚点的不收） |

### 投递与同族检查

- **L1**：与执行者已投的 C 行（`2026-10-10 03:32`｜`task:mvs_13061596`，现象＝rollout 空读）**共用证据文件 `dual-real.run.log` 但根因不同**（C 行＝运行时行为；L1＝报告勾选未随证据修正）。按契约 §2「同一根因才合并」判为**非同一根因**，故**新起行**；已在行内注明共用证据文件（契约 §3 判据 6：证据路径同而现象不同只作报告项、不判红）。
- **L2**：与收件箱 `2026-10-08` 比分站行同为「负载→偶发超时→假红」，但证据路径不同（不同仓），按契约 §2 机械判据**不构成同族合并**；跨项目复发按 §4 门槛②③**新起行**。
- 本轮为**子会话**，依契约 §5 末段**不认领消费动作**（不派复盘子会话）；仅履行 §2 投递义务与写后校验。
- 观察（不属本复盘处置面）：写后校验读数显示 `pending(状态=新)=40`，已触积压硬触发阈值（契约 §5）；消费权在**定时哨兵专用对话**，此处仅记录。

---

## 附：本次复盘复跑原始读数（可复算）

- `pnpm --filter @relay/relay test` → 首跑 `2 failed | 31 passed (33)`，exit 1；次跑 `2 passed (2 files) / 33 passed (33)`，exit 0
- `pnpm --filter @relay/bridge test` / `node packages/bridge/scripts/run-tests.mjs` → 首跑 `recovery.test.ts` 1 failed（48s）/ `3/4 files passed`，exit 1；次跑 `4/4 files passed`，exit 0（recovery 单文件 152s）
- `python -B D:\claude\harness\skills\agent-orchestration-kernel\scripts\validate_retro_inbox.py` → 写前 `data rows=812  pending=40  violations=0  VERDICT: PASS`；写后（投 L1＋L2 两行）`data rows=814  pending=42  violations=0  VERDICT: PASS`（全表违规数未增，自己的两行落在 L887／L888，不在任何违规项内）
- `codex --version` → `codex-cli 0.149.0`（与 `evidence/m2/codex-version.txt` 一致）
