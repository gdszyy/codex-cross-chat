# 真实物理设备联机失败与修复（2026-10-15）

实际配对成功：第二台设备 `c-nza0c7`，Void 笔记本 `c-vi7m9h`，配对 `pair-0465becf449e6ee38a9d99a14d3f4b86`。
真实 QUERY `r-8e584abe5acce0d5` 到达对端，但只读到失败 STATUS：

```
bridge failed to start turn: -32600: thread not found: 01a13aec-2951-79f2-9b3b-24f4770e2c24
```

当时状态 `delivery_status=device_received`、`exec_status=failed`、`return_status=null`、`turn_id=null`。没有收到要求的真实模型回复，不能将配对成功写成双向联机通过。

## 已证实的客户端问题

旧 Bridge 重启后直接使用保存的线程 ID，没有先 `thread/resume`。真实 Codex CLI 0.149.0 零模型探针还发现：仅 `thread/start(ephemeral:false)` 创建的空线程，退出 App Server 后可能没有 rollout；本机原绑定线程已实际确认 `no rollout found`。

修复先持久化新线程的名称并读取同 ID 历史；重启时恢复同一线程，验证其为可读的 durable legacy 历史，之后才登记、接入设备通道。缺历史时明确停止，不自动替换线程。

确实不可恢复的旧空线程，使用 [显式恢复流程](thread-recovery.md)，保留设备凭证、`conv_id`、配对和权限。服务端重绑校验归属、旧线程预期值和在途工作，并原子记录审计；恢复前必须停止旧 Bridge。

## 本机 Bridge 退出

原 Bridge 进程曾以 1 退出，现有日志不足以证明具体根因。普通后台进程跨工具调用存活的实测排除了“所有后台进程都会立即被工具清理”这一推断。修复增加独立生命周期日志、错误脱敏、Codex 子进程退出检测、有限时清理，并捕获游离的游标/日志写入失败。这些是诊断及可靠性改进，不能据此声称旧退出根因已证实。

## 验证边界

本次验证使用真实 Codex App Server、真实 HTTP/数据库，不调用 mock，不生成伪造模型回执；线程验证无需模型轮次。原失败 QUERY 不自动重发。实际跨设备成功仍要求对端更新并恢复 Bridge 后，另行完成一次真实 QUERY 和 Relay 结果读回。

接口依据：[Codex App Server 官方文档](https://developers.openai.com/codex/app-server/)。0.149.0 空线程持久化行为来自本机实际跨进程探针，不将该实现细节推定为所有 CLI 版本的承诺。
