# 主动邀请与一次性配对（v0.2）

这是新设备/新对话接入的推荐路径。旧 Owner 注册设备与 join code 继续兼容；join code 不是本页的配对码。

## 用户流程

1. A 启动常驻 Bridge，获得稳定 `conv_id`。登记/公布对话本身不生成配对码。
2. A 主动调用 `relay_pair_invite`，或配对 CLI 的 `invite`。服务生成一次性配对码，固定十分钟有效。
3. A 只把配对码交给 B，不交换长期设备令牌或 Owner 根密钥。
4. B 把配对码保存为仓库外的私密文本文件，准备不含 `device_token` 的本机 Bridge 配置，用 `--pair-code-file` 启动。
5. Bridge 创建并保存 B 的本机线程，然后兑换配对码。服务在一个数据库事务内核验有效期和未使用状态、创建独立设备（或确认 B 的既有设备）、登记 B 的对话、消费配对码并创建双向关系。
6. 新设备凭证由 HTTPS 直接返回 B，由 B 的 Bridge 保存到本机配置。A 不会收到 B 的设备令牌。
7. B 使用自己的凭证连接 Relay。A、B 使用对方的精确 `conv_id` 通信，无需手工改 `allow_sources`。

配对码只授权**一个邀请方对话与一个接收方对话**。它不是设备令牌、根密钥或可复用的登录码。泄露者可能抢先消费这一次配对；A 可撤销未消费的邀请码，或发现错误接收方后解除关系并重新邀请。

## 生命周期和权限

- 一次性、固定 600 秒有效，服务器仅保存码的摘要。过期、撤销、已消费均不能再次兑换。
- 邀请必须由已鉴权设备以所属对话发起。兑换已有设备时使用 B 自己的凭证，绝不返回别人的长期凭证。
- 关系独立持久化，Bridge 重启、同一线程重新登记不会抹掉关系。只覆盖两条精确地址，不授权同设备其他对话或整个项目。
- 任意一方可解除双方配对。解除移除这条配对授予的权限；既有独立手工 `allow_sources` 授权保持原含义。消息历史保留。服务端启动许可是执行边界：Bridge 在调用模型前申请许可，解除后尚未获许可的排队任务会被拒；解除前已获许可的在途执行不保证撤销。
- 对话或设备被暂停/撤销后，不可借旧配对建立新任务。邀请撤销不撤销其他配对。
- 兑换结果未知应停下查证，不盲目再次消费。私密配置、配对码文件、本地状态放在仓库外，不能提交或粘进日志。

## HTTP 契约

除兑换新设备外，以下接口均使用 `x-device-token` 或 Bearer 设备令牌，并核验所属 `conv_id`。

| 动作 | 接口 | 参数/返回 |
| --- | --- | --- |
| 主动邀请 | `POST /v1/pairing/invitations` | `{conv_id}` → `invitation_id, code, expires_at, inviter_conv_id` |
| 撤销邀请 | `POST /v1/pairing/invitations/:id/revoke` | `{conv_id}`，仅邀请方 |
| 兑换 | `POST /v1/pairing/redeem` | `{code, profile, thread_id, alias, role, task, owner_label?}` → `device, conversation, peer_conv_id, pairing_id` |
| 查询关系 | `GET /v1/pairings?conv_id=...` | 仅该对话的关系，不含 token/code |
| 解除配对 | `POST /v1/pairings/:id/revoke` | `{conv_id}`，任一配对成员 |

兑换新设备不需要预先持有 device_token；已有设备在鉴权头提供本机 token。新 token 仅交给兑换端；已有设备继续使用自己的 token。项目继承 A，不能用配对码任意指定项目。

Bridge 执行请求时，在本地 `turn/start` **之前**调用 `POST /v1/requests/:id/authorize-start`，以目标设备凭证获取持久启动许可。许可失败不得调用模型；获得真实轮次后仍用原 `/start` 补报 `turn_id`。这个顺序防止只在模型已启动后才发现配对被解除。

## 在线前提与完成判定

新设备需要原生桌面来源行和气泡时，先完成本页配对，再按 [新设备交接](handover/HANDOVER-deviceB.md) 串行切换到 [native_task](native-task-messages.md)。首次空 bindings 配对不能直接使用 native_task。2026-10-15 两个全新物理请求和两端气泡已确认，见 [真实记录](native-task-verification.md)。

限额联机测试可在发起方 Bridge 配置中设置 `"result_delivery_mode": "manual_read"`：Bridge 保持在线，但收到结果事件时不再启动本机模型轮次，调用者通过 `relay_read` / RelayClient 显式读取真实回复。默认 `push_turn` 保持原有结果推入对话行为；本选项不禁止远端执行 QUERY，也不代替全局模型轮次预算。若一次 QUERY 全程最多一轮模型，发起方需用 manual_read，唯一模型轮次由接收方执行。

自动收发要求双方均为常驻 Bridge 托管的 T1 对话，运行本机 Codex App Server。T2 桌面对话仍为 `manual_pull`，配对不改变上游格式限制，也不会让云端自动唤醒它。`presence.online` 仅代表近期活跃。

项目级回归覆盖兑换、拒绝重放、第三方被拒、撤销/解除、重启关系保留；不是要求每台新设备在生产重新建立第三方设备或解除当前配对。每次接入核自身身份/关系/健康，并按授权完成双方新请求、真实读回和两端呈现；不能用 `/health`、roster 或测试床代替真实通信证据。双向两个根 QUERY 各最多一个业务执行轮，接收器设置/转发与桌面消费轮另计，不等于整条链总共一轮。自动化回归的 mock App Server 只作代码检查，不能冒充联机实测。
