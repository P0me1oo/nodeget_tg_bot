# 消息通知 · `notify`

NodeGet 事件通知(对齐 Komari):节点**离线/上线、到期提醒、流量超额**,通过 Telegram Bot 推送。完全在边缘端运行,不改探针 agent。配置面板由 `notify-extension`(token 鉴权 iframe)经 `onCall` 读写——**无内置 `/ui`、无 `route_secret`**。Telegram `/chatid` 通过 webhook 实时响应。

---

## 环境变量(env)

| 键 | 必填 | 说明 |
|---|---|---|
| `token` | ✅ | NodeGet 平台 Token,需含「读 agent / 动态摘要 + KV 读写」;cron 触发还需 `JsWorker::RunDefinedJsWorker`。⚠️ **不是** Telegram bot token。 |
| `webhook_admin_secret` | — | 可选;也可在扩展面板设置。配置后保护 `/registerWebhook`、`/unRegisterWebhook`、`/webhookInfo` 管理路由。 |

> Telegram 的 `bot_token` / 通知目标列表 / `webhook_admin_secret` 可在配置面板里填(存 KV);敏感字段经 `get_config` 返回时始终**打码**。旧版 `chat_id` / `message_thread_id` / `events` 配置会在读取时自动兼容为 `targets`。

## 定时任务(必须)

新建 JsWorker 定时任务 → 脚本 `notify-worker` → cron 建议 `0 */2 * * * *`(每 2 分钟,6 段格式)。
> ⚠️ 没有定时任务则**不检测离线 / 上线 / 到期**(只有手动「立即检测」会跑)。

## onCall / onInlineCall(`params.action`,供扩展经 `js-worker_run` 调用)

| action | 参数 | 说明 |
|---|---|---|
| `get_config` | — | 读配置(`bot_token` 打码)+ 运行状态 |
| `set_config` | `{config:{...}}` | 改配置(`bot_token` / `webhook_admin_secret` 留空 = 保留原值,不覆盖) |
| `test` | — | 发一条测试消息 |
| `run` | — | 立即检测并推送一轮 |
| `get_state` | — | 读运行状态(`last_run` / `last_sent` 等) |

> 已移除内置 `/ui`:配置改由 `notify-extension` 用 NodeGet Token 调上面的 `onCall`(`js-worker_run` → 轮询 `js-result_query`),与 Docker / 流量监控插件一致。`onRoute` 仅用于 Telegram webhook。

## HTTP 路由(`/nodeget/worker-route/<route_name>`)

部署 worker 时需设置 `route_name`(示例:`notify`),并确保该 HTTPS 路径可被 Telegram 公网访问。

| 路径 | 说明 |
|---|---|
| `GET/POST /registerWebhook` | 使用当前域名注册 Telegram webhook,回调地址为同一路由下的 `/telegramWebhook` |
| `GET/POST /unRegisterWebhook` | 删除 Telegram webhook |
| `GET /webhookInfo` | 查询 Telegram 当前 webhook 状态 |
| `POST /telegramWebhook` | Telegram update 回调入口,会校验 `X-Telegram-Bot-Api-Secret-Token` |

如通过 env 或扩展面板设置了 `webhook_admin_secret`,前三个管理路由需带 `?s=密钥` 或请求头 `x-webhook-admin-secret`。`/telegramWebhook` 不使用该密钥,只接受 Telegram 注册时生成的 secret header。

## 配置模型(全局 KV,key `notify_config`)

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关,关闭则 onCron 不发送 |
| `bot_token` | — | Telegram Bot Token |
| `targets` | `[]` | 通知目标列表,每项含 `name`(可选)、`chat_id`(必填)、`message_thread_id`(可选)、`events`、`enabled` |
| `chat_id` / `message_thread_id` | — | 兼容旧配置;读取时会转换为 `targets`,新配置优先使用 `targets` |
| `webhook_admin_secret` | — | 可选,保护 webhook 注册/注销/查询管理路由;留空则管理路由公开 |
| `endpoint` | `https://api.telegram.org/bot` | 被墙可填反代 |
| `template` | `{{emoji}} {{event}}…` | 消息模板 |
| `events` | offline/online/expire 开,traffic 关 | 兼容旧配置的默认事件开关;新配置按 `targets[].events` 判断 |
| `expire_days` | `7` | 到期提前提醒天数(1–90) |
| `offline_delay` | `5` | 离线告警延迟分钟数(0–1440,0=立即);掉线持续达此时长才推送,避免抖动误报 |

## 事件说明

- **离线 / 上线**:90 秒无上报判离线,**持续达 `offline_delay` 分钟(默认 5)才告警**(宽限期内恢复不报,避免网络抖动误报;0=立即);同一轮多台离线/恢复**合并成一条**;只发送给目标列表中启用对应事件的目标;发送失败下轮重试。
- **到期**:`metadata_expire_time` 距今 ≤ N 天(默认 7),**每天提醒一次**(跨天重发,续费即停);只发送给启用到期事件的目标。
- **流量超额**:经 `inlineCall` 读 `traffic-billing-worker` 的告警节点,**80% 起每 +5% 档位报一次**;需目标启用流量事件且已部署 traffic-billing。

## Chat ID 获取

在 Telegram 内向 Bot 发送 `/chatid` 或 `/chat_id`。注册 webhook 后,Telegram 会把 update 实时推送到 worker,worker 会立即向该会话回复当前 `chat_id`、类型和名称。超级群话题内发送时,回复会落在同一个话题。

首次启用流程:

1. 在扩展面板保存 Bot Token、至少一个通知目标、请求端点和可选 Webhook 管理密钥。
2. 访问 `https://你的域名/nodeget/worker-route/<route_name>/registerWebhook` 注册 webhook;如配置了管理密钥,追加 `?s=密钥`。
3. 在 Telegram 内发送 `/chatid` 或 `/chat_id` 验证实时回复。

## 消息模板变量

`{{emoji}}` `{{event}}` `{{client}}`(节点名) `{{time}}`(CST) `{{type}}`
