# T1 线程重启恢复与显式修复（Codex CLI 0.149.0）

## 已验证的故障与机制

本次真实联机故障的 STATUS 是 `bridge failed to start turn: -32600: thread not found`。这说明请求已到达执行端，但不能据此断言模型已启动或业务已完成。

真实 CLI 的独立进程探针复现了两点：

- 仅调用 `thread/start`，即使 `ephemeral:false` 且响应包含路径，零轮次的 legacy 线程仍可能没有持久 rollout。关闭原进程后，新进程 `thread/resume` 报 `no rollout found`。
- 在线程仍存活时调用稳定接口 `thread/name/set` 后，关闭原进程，下一进程能恢复同一线程。恢复前状态为 `notLoaded`，恢复后为 `idle`，完整历史的轮次数仍为 0。

[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)区分了读取与恢复：`thread/read` 不会把线程加载成可继续执行的会话，继续原线程需要 `thread/resume`。本项目实际消费的字段与默认 legacy 行为以本机 CLI 0.149.0 生成的 schema 和真实探针为准；不能把其他版本的默认历史模式套过来。

这次修复包括：新线程命名持久化；保存的 T1 绑定先恢复同一线程并核验完整 legacy 历史，再上线；线程或对话身份变化时停止；读历史失败不再被当成空历史；已失败请求不自动重跑。不会在 daemon 启动时悄悄换线程。

## 真实验证怎么复核

在仓库根目录运行，证据目录必须位于仓库外：

```powershell
pnpm --filter @relay/bridge build
node --import tsx scripts/verify-real-thread-recovery.ts --out "C:\your-private-work\thread-recovery-proof"
```

探针使用独立 `CODEX_HOME`，不改实际 `~/.codex` 配置、不打开现有配对线程或生产配置。它运行真实 CLI 进程、真实本地 HTTP 和 PGlite，没有模拟 API 响应。模型启动方法设有拒绝执行的安全闸；成功报告要求启动尝试数和实际轮次数均为 0。

`report.json` 的真实断言覆盖：plain 零轮次线程丢失对照；修复后的同 ID 跨进程恢复；显式修复 CLI 的真实 rebind；conv、pairing、手工 ACL、原设备 token 保留；更新后的 Bridge 两次重启仍读取同一新线程；失败请求没有重跑；未知 alias、多重同对话绑定、缺少精确本地映射均在替换前被拒绝。以上是本机接口与生命周期证据，不是另一物理设备已经修好的证明。

只分享 `report.json`。整个证据目录还包含测试专用私密配置和隔离 CLI 状态，不应整目录打包转发。

## 另一设备执行步骤

1. 保存该设备自己的未提交改动，更新到报告指定的修复分支和提交，安装依赖并运行上面的类型检查。服务端必须已部署支持 rebind 的版本。
2. 停止该设备对应的 Bridge 及其子 App Server。不要停止无关 Codex 对话，不要同时让两个进程写同一 Bridge state。
3. 使用该设备自己的原配置及准确 `conv_id` 运行显式修复；不需要新邀请码，不复制另一设备的凭证。

```powershell
node --import tsx packages/bridge/src/repair-thread.ts --config "C:\your-private-work\bridge.json" --conv-id "c-your-owned-conv" --ack-history-unrecoverable
```

有多个不同的本地绑定时，可以加 `--alias "已有的本地别名"`。未知别名、同一对话对应多个本地绑定或缺少精确 thread/conv 映射时，命令拒绝执行。已有精确 LocalState 映射可以补足旧配置中未写出的标识。

`--ack-history-unrecoverable` 表示明确接受：若原线程确实没有 rollout，旧线程上下文无法凭本次修复重建。命令会先真实恢复旧线程；若原线程可恢复，保持原绑定，不创建替代线程。只有得到准确的 `no rollout found` 证据时才创建新的零轮次、已持久化线程，并在第二个 App Server 进程恢复成功后提交 rebind。

成功后，设备 token、conv_id、配对及手工 ACL 保留；只有本机 thread_id 改变，原失败请求仍保持失败。再正常启动：

```powershell
node --import tsx packages/bridge/src/index.ts --config "C:\your-private-work\bridge.json"
```

确认启动日志显示 `resumed thread` 和原 `conv_id`。本轮单次模型预算与 `manual_read` 配置继续有效；不要自动重发原失败请求。新的实际业务复验需沿原授权与轮次预算执行。

## rebind 与结果不明的处理

接口是设备鉴权的 `POST /v1/roster/:conv_id/rebind`，正文精确为：

```json
{"expected_thread_id":"old-thread-id","profile":"default","thread_id":"new-thread-id","reason":"lost_local_thread"}
```

成功响应为 `{ok:true,data:{conversation:RosterRow,rebind_id,rebound_at,idempotent}}`。服务端保留原对话身份，检查旧 thread 的比较后更新；在途执行、过期的旧绑定、被占用目标绑定或不适用的对话会被拒绝。该接口不恢复旧上下文。

命令先在原配置旁保存不含 token/邀请码的 `.thread-repair-c-….json` intent。创建线程或网络回执不明时停止，不盲目创建第二个线程。再次执行会先按同一 intent 查询：若服务器已绑定 intent 中的新线程，完成本机配置/LocalState 保存；若仍是旧线程且阶段为 `rebind_pending`，保留现场。确认原请求已结束后，才可加 `--retry-rebind` 重试同一个 old/new 组合。不要删除 intent、改设备 token、清空 state 或反复重新配对。

若 CLI 仍报告历史缺失、目录或权限不一致，应保留失败信息继续排查；不得把远端未执行的步骤写成“双方联机已恢复”。
