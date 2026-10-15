# 把跨设备消息显示在现有桌面对话

`desktop_queue` 是可选的桌面通知模式。Bridge 继续用原托管线程执行来信，把真实来信和真实结果作为通知放进指定桌面对话的公开持久队列。原设备凭证、`conv_id`、配对和执行历史保持原样。

这不是对桌面线程的接管：Bridge 不恢复、抢锁、创建或复制该线程，也不调用 `thread/queue/start`。桌面所属 App Server 在对话空闲时消费队列。忙碌时等待，桌面关闭或没有加载该对话时不能承诺自动显示。

## 配置

先完成正常配对。停止本设备旧 Bridge，备份仓库外私密配置，在原配置中加入下列字段；其余绑定及凭证不变。不要重新配对或把 token 放进文档/命令行。

```json
{
  "result_delivery_mode": "desktop_queue",
  "bindings": [{
    "alias": "原别名",
    "role": "worker",
    "task": "原任务",
    "project": "原项目",
    "threadId": "原Bridge托管线程UUID",
    "convId": "原conv_id",
    "desktopThreadId": "准确的现有桌面对话UUID"
  }]
}
```

`desktopThreadId` 必须取自已核实的本机桌面对话，不能按标题猜。每个本地绑定都要明确目标；多个本地参与方无法唯一定位时拒绝投递。Bridge 和桌面必须在同一操作系统用户、同一 Codex home 下运行。此版本按 CLI **0.149.0** 的真实协议验证，需开启初始化的 `experimentalApi`；Bridge 只在此模式开启，不改全局配置。

从仓库根目录正常启动：

```sh
node --import tsx packages/bridge/src/index.ts --config <仓库外私密配置>
```

启动时核实准确 UUID、持久的 paginated 历史和队列接口。元数据读取成功只证明目标存在，不证明桌面当前在线或已经显示消息。不能将另一进程看到的 `notLoaded` 误判为原桌面对话不存在。

## 通知语义与成本

- 收到跨设备请求时，原托管线程仍按原规则执行一次。真实结果保存到 Relay 后，将来信与回复一起通知桌面；失败或未获得真实结果不能伪报成功。
- 本机发出请求所收到的 RESULT/STATUS 也走桌面队列，不再为回推而启动托管线程。STATUS 明确标作阶段通知，不代表任务完成。
- 通知带原 `request_id`、`result_id` 和来源/目标地址，正文按引用数据展示，要求不重跑、不自动回信或转派。它不是新的 Relay 请求。
- **桌面消费排队的用户消息可能启动一次原生模型轮次。** Bridge 不直接启动该轮次，不代表零模型或零费用。原任务执行和桌面通知分别计量。
- `manual_read` 保持只存结果、人工读取；默认 `push_turn` 保持原托管线程回推行为。它们都不声明既有桌面对话自动显示。

## 去重、未知结果与恢复

同一请求/结果/本地参与对话使用稳定 key 和 `clientUserMessageId`。先在本地状态库保存意图、目标及正文哈希，再向公开队列写入；成功保存 `queuedSubmissionId`。重复事件及回填使用同一记录，不再 add。Bridge 仅允许一个进程独占同一 `state_dir`；不要同时启动两个实例。

队列 RPC 超时或返回形态不明确时，只查询同一个 client ID。查到且内容相符才恢复接受回执；查不到也**不盲目重发**，因为它可能已被桌面消费。`prepared`/`uncertain` 需要人工核实，不能删本地状态绕过保护。改变绑定目标或正文后复用同一 key 会被拒绝。

`status=queued` 仅表示公开队列接受；不等于用户已看到、不等于模型已执行，也不推进 Relay 的 `return_status` 为 delivered/origin_processed。日志不会打印通知正文或凭证。Relay 的三层状态与桌面通知状态分别核验。

需要回填已有真实历史时，可在启动时使用：

```sh
node --import tsx packages/bridge/src/index.ts --config <私密配置> --replay-desktop-request <真实request_id>
```

此动作是单次回填：先停止同 `state_dir` 的旧 Bridge，只初始化公开接口并核实身份，不连接 WS、不补拉待执行任务、不恢复执行线程。它读取 Relay 原结果，不发新 QUERY，不执行原任务；仅允许本机是参与方且有真实 RESULT/STATUS 的请求。它沿用实时通知的去重 key，输出只有关联 ID 和 queued 接受状态，完成后退出。之后用正常启动命令恢复常驻 Bridge。不要对兑换、未知队列写入或原 QUERY 自动重试。

## 实测与排障

确认 Relay `/health`、配对和双方 roster；确认 Bridge `ws open`。再核对通知的 queued ID、准确桌面 thread 内出现的正文及原请求的真实 read 结果。日志中的 queued 或后台线程回答均不能单独替代桌面正文证据。

零模型预检可运行 `pnpm exec tsx scripts/check-desktop-queue.ts --thread-id <准确桌面UUID>`。它使用真实 CLI 只读接口及临时真实 PGlite，验证持久意图恢复和未知接受不重发，禁止队列写入及模型启动；此预检不替代真实桌面消息验收。

本机版本源码的公开队列服务会观察其他进程的持久队列变更，并在空闲时分派。该行为不是 Bridge 新增的轮询服务。若一直等待：先确认桌面已打开准确对话、当前轮次结束、两端使用相同用户/home，以及 CLI 版本兼容。不要清写锁、修改会话数据库或复制 rollout。

依据：[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)、[官方 CLI 参考](https://learn.chatgpt.com/docs/cli/reference)、[0.149.0 队列服务源码](https://github.com/openai/codex/blob/rust-v0.149.0/codex-rs/ext/queue/src/service.rs)。最新版文档字段不能替代本机 schema 核验。
