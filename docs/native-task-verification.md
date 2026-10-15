# native_task 真实验证记录

日期：2026-10-15；CLI 0.149.0；使用生产 Relay 的既有物理设备测试记录。没有新发 QUERY，没有重跑历史请求，没有更换设备、配对或凭证。

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

本次接收器共使用五个模型轮：能力检查、协议设置、路径更新、一次私密读失败、一次成功恢复/转发。最终目标消息插入当时正在运行的主对话；不宣称整条链零模型或只有一轮。原历史 QUERY 执行轮数增量为零。

## 界面与物理联机边界

已核实真实原生来源及目标实际收到。桌面截图工具返回 `FrameArrived timed out`，随后用户提供当前对话实际截图：可见“由 ChatGPT 从另一项任务发送”来源行和原生气泡，正文折叠首行为 `[[relay-desktop-event:v1]]`。用户截图与本机准确来源记录共同验证原生呈现，不以工具接受代替视觉证据，没有伪造截图或回执。

根据该截图将后续消息首行改为可读的“跨设备回复/进度 · 远端 → 本机”，标记与完整引用数据保留在其后。此格式调整不重新发送上述已完成作业；既有作业及checkpoint保持不可变。新格式的下一条原生卡片在新的真实请求中验证，不把旧图当成新首行已展示证据。

此前真实物理双向记录保留：正向 `r-12f2a9e542907c27`、反向 `r-e270ee8772aedaa1`；这轮是新呈现链的真实历史报告验证，不能冒充新一次跨物理设备双向 QUERY。后续 Void 更新后需另做新请求，按实际模型预算执行。
