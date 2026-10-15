# native_task 真实验证记录

日期：2026-10-15；CLI 0.149.0；生产 Relay。验证分两段：先验证真实历史报告的原生呈现，再以两个**全新物理设备请求**验证双向执行和两端气泡。两段始终保留原设备、配对和凭证；历史回填没有重跑原请求，后续新请求不是旧报告的重放。

## v0.2.3 发布后的两个全新物理设备请求

程序版本 v0.2.3，提交 `ffde077105528409336d28589929f4105b8e7baa`。2026-10-15 13:09（Asia/Shanghai）直接查询生产 Relay，记录如下：

| 方向 | request_id | 投递 / 执行 / 回传 | relay_read 真实正文 |
| --- | --- | --- | --- |
| Void `c-vi7m9h` → 第二台设备 `c-nza0c7` | `r-7538315c18d6e162` | `device_received / completed / cloud_saved` | 第二台设备已收到 |
| 第二台设备 `c-nza0c7` → Void `c-vi7m9h` | `r-73b8589dac5ae65e` | `device_received / completed / cloud_saved` | Void笔记本已收到第二台设备消息 |

两个请求都得到真实首条 RESULT、`is_first=true`、`result_missing=false`，各返回一个业务 `turn_id`：

- 正向：结果 `res-f06eb9a25992df69`，执行引用 `codex-thread:01a13b6e-9945-71c3-a31e-c7cf8279cdc9#turn:01a13df4-3dde-7500-82b7-41710f88f16c`。
- 反向：结果 `res-9f031b8ee347104a`，执行引用 `codex-thread:01a13aec-2951-79f2-9b3b-24f4770e2c24#turn:01a13df8-b20b-7af3-846a-9d3d240731ba`。本机于13:08:34发起，仅 POST 一次；之后都是只读查询，没有另发 QUERY 要求对端模型转派。

配对 `pair-0465becf449e6ee38a9d99a14d3f4b86` 沿用，没有新配对码、凭证交换或执行状态重置。发送前实际核对 health=200/db=postgres、双方在线和原关系有效。接收器/桌面呈现的模型开销与上述业务轮次分开；此处不声称全链路只有一个模型轮。

### 两端桌面呈现证据

- 第二台设备：真实本机接收器将上述同一请求/结果经原生 `codex_app.send_message_to_thread` 送入绑定的桌面对话；实际宿主消息含可信 `source_thread_id` 与新首行“跨设备回复 · c-vi7m9h → c-nza0c7”。本机原生来源行/气泡此前已有用户截图证明，新的报告按真实原生来源记录核对，不用正文仿制来源。
- Void：针对准确反向请求 `r-73b8589dac5ae65e`，向用户询问是否看到“由 ChatGPT 从另一项任务发送”来源行，以及包含“Void笔记本已收到第二台设备消息”的气泡；用户直接答复：**“已看到来源行和该回复气泡”**。证据类型是用户的实际屏幕观察，不冒称远程截图或本机直接读取Void界面。

结论：两个全新物理请求的真实执行与回传、两端绑定桌面的原生呈现均已确认。`cloud_saved` 仍保持原始 Relay 状态；不因气泡可见而伪造 `delivered/origin_processed`。Bridge 保持运行，不自动回信、不因通知正文重跑测试。

机器可读的非凭证记录见 [physical-roundtrip-20261015.json](evidence/v0.2.3/physical-roundtrip-20261015.json)。新设备可直接使用 [接入交接](handover/HANDOVER-deviceB.md) 与 [可复制指令](handover/PASTE-new-device.txt)。

## 发布前的历史报告呈现验证

以下是发布前独立保留的过程记录，不能拿它代替上面的新双向请求证据。

## 已实际执行

- 用户明确授权新增本机“跨设备接收器”及模型转发开销。真实接收器 `01a13d92-cde0-73d2-9c9b-278b81d88407`，唯一最终桌面对话 `01a13aa6-e290-7122-afec-b53a0bc617f4`。
- Bridge 单次 `startReplay` 读取生产真实请求 `r-e270ee8772aedaa1`、真实结果 `res-4aedee7140d68f34`。远端 `c-vi7m9h`，本机 `c-nza0c7`；真实报告“第二台设备已收到Void笔记本消息”。
- 原生作业 `7d476156288e651c1db815b38c419505d75946ce531703770cef93d23042fe3c`，真实 receiver queue submission `01a13da2-7b90-75b2-9f0c-dc9751339049`。队列自动唤醒接收器；接收器实际调用原生 `send_message_to_thread` 一次，保存原始回执。
- 接收器执行轮 `01a13da4-5afc-72d3-9b11-6e612bd76f09`；claim `submitted`，真实宿主回执 `isError:false` + 最终目标 `threadId`，本地分类 `tool_returned`。未重复原生发送。
- 目标的真实 `read_thread` 读到 item `fco_01a13da4-f87a-7f71-9c84-04615001d733`，类型 `functionCallOutput`，namespace `codex_app`，name `send_message_to_thread`。原生 `codex_delegation/source_thread_id` 为真实接收器，正文含上述同一 request/result。它与旧版普通 `userMessage` 不同，没有用正文模拟来源行。
- 原测试 Bridge PID 26540 在隔离验证期间仍存活，原配置逐字未改。native 展示checkpoint独立保存；replay 使用独立临时执行库，不打开原 Bridge 的 PGlite。

## 真实失败与恢复

第一次 startup 在长路径的本地 PGlite 初始化失败，未到 App Server/作业/队列；保留失败生命周期。短目录初始化实际通过后才进行首个实际入队，没有对未知写入重试。

接收器第一次读取私密作业失败。主任务核查同一工作 `claim:null`、无 claim guard、原生发送零次，再按受支持的指定文件权限批准检查及领取，同一个工作随后完成；没有再次 queue/add，没有改变 ACL 让沙箱绕过权限。

发布前这一段接收器共使用五个模型轮：能力检查、协议设置、路径更新、一次私密读失败、一次成功恢复/转发。最终目标消息插入当时正在运行的主对话；不宣称整条链零模型或只有一轮。原历史 QUERY 执行轮数增量为零。这不是上方发布后新双向测试的总轮数统计。

## 界面与物理联机边界

已核实真实原生来源及目标实际收到。桌面截图工具返回 `FrameArrived timed out`，随后用户提供当前对话实际截图：可见“由 ChatGPT 从另一项任务发送”来源行和原生气泡，正文折叠首行为 `[[relay-desktop-event:v1]]`。用户截图与本机准确来源记录共同验证原生呈现，不以工具接受代替视觉证据，没有伪造截图或回执。

根据该截图将后续消息首行改为可读的“跨设备回复/进度 · 远端 → 本机”，标记与完整引用数据保留在其后。此格式调整不重新发送上述已完成作业；既有作业及checkpoint保持不可变。发布后的新首行已在本页上方两个全新请求的原生消息记录中核对，未用旧图替代。

此前真实物理双向记录保留：正向 `r-12f2a9e542907c27`、反向 `r-e270ee8772aedaa1`；发布前这一段是新呈现链的真实历史报告验证，不能冒充新一次跨物理设备双向 QUERY。后续新请求已另列于本页开头。
