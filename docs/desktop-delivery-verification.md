# v0.2.2 桌面通知真实验证

2026-10-15（Asia/Shanghai）。代码及下述限定功能路径经非作者独立复核通过。

## 实际通过的路径

Void 笔记本此前发出的真实物理设备 QUERY `r-e270ee8772aedaa1`，来源 `c-vi7m9h`，目标 `c-nza0c7`，已由本机 Bridge 执行并保存真实 RESULT `res-4aedee7140d68f34`：

> 第二台设备已收到Void笔记本消息

原执行证据为 `codex-thread:01a13b6e-9945-71c3-a31e-c7cf8279cdc9#turn:01a13bbe-54c2-7363-b904-dfe717c6da5b`。该请求状态为 `device_received / completed / cloud_saved`。

本次通过真实生产 Relay 的 readResult，使用真实 Bridge `--replay-desktop-request` 单次回填上述来信和报告，没有重跑 QUERY，也没有改换设备、凭证或配对。公开持久队列返回：

| 项目 | 真实读数 |
| --- | --- |
| 绑定桌面 thread | `01a13aa6-e290-7122-afec-b53a0bc617f4` |
| queued submission | `01a13cf0-4477-7f13-b9e4-1f48b79ae078` |
| native 接收 turn | `01a13cf4-488f-7f32-8bb8-5fb3236ed148` |
| native userMessage | `01a13cf4-4c50-7d40-b2c0-4ada09fa741c` |

原桌面执行轮结束后，桌面自动消费这唯一正式通知，启动一次原生轮次。主执行者和独立审查者分别通过宿主 `read_thread` 读取准确 thread，均看到真实 `userMessage`：包含 `[[relay-desktop-event:v1]]`、原 request/result ID、双端地址、来信正文、真实回复及原执行 evidence，前一轮状态为 completed。消费后另一个公开接口连接查到原队列项已消失。关联按完整正文及真实报告逐项核对；native reader 没有返回 clientId，不冒充已观测到该字段。

这证明真实生产历史报告能够进入指定桌面对话的原生正文，并实际触发一次接收轮。不是 mock，不是仅检查队列接受。没有采集像素截图，也没有把原始 JSON 日志冒充桌面截图。

## 运行与检查

实际开启本机常驻 `desktop_queue`，目标为上表 thread，沿用原状态目录、`c-nza0c7`、原执行线程及现有配对。2026-10-15 08:29:07 核实 Bridge PID `26540` 存活、`ws open`；生产 `/health` 为 HTTP 200，`db=postgres`；本机 roster online=true。Void 在此时 roster online=false，配对仍有效。PID/presence 为当时快照，不能当作永久在线承诺。

- `pnpm -r build` 通过；最后一处 Bridge 修正后的定向 build 与 `git diff --check` 通过。
- `scripts/check-desktop-queue.ts` 使用真实 CLI 0.149.0 和真实 PGlite，验证 metadata、持久意图重开、未知接受不重发、正文漂移及非法 UUID 拒绝；队列写入与模型启动均为零。
- 正式消息写入前，早期 API 探测条目被精确核对并删除，未被消费；正式测试仅保留一条通知，未重试 add，新增原生接收轮为一轮。
- 不把 `queued` 写成 Relay delivered，不自动回信或转派，不输出凭证，不直接修改 Codex 配置/会话数据库。

## 适用边界

本轮是**已完成真实物理请求的生产回填显示测试**，没有在新模式下再发一条物理 QUERY；不能据此声称每一种实时事件、断网恢复、跨版本桌面或多绑定均完成端到端实测。实时通知路径、旧无 ID 事件兼容及去重机制通过代码独立复核，详见 [桌面投递](desktop-delivery.md)。

普通 CLI 的 `thread/items/list` 对该桌面新 `subAgentActivity.kind=completed` 存在反序列化兼容错误；本次最终正文观测使用可用的原生宿主 reader，没有修改上游数据库规避。队列 metadata/add/list 路径已实际可用。桌面需加载准确对话并在空闲时消费，通知可能产生原生模型费用。
