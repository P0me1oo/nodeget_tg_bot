# 消息通知 · `notify`

NodeGet 事件通知(对齐 Komari):节点**离线/上线、资源规则、到期提醒、流量配额提醒**,通过 Telegram Bot 推送。完全在边缘端运行,不改探针 agent。配置面板由 `notify-extension`(token 鉴权 iframe)经 `onCall` 读写——**无内置 `/ui`、无 `route_secret`**。Telegram `/chatid` 通过 webhook 实时响应。

---

## 环境变量(env)

| 键 | 必填 | 说明 |
|---|---|---|
| `token` | ✅ | NodeGet 平台 Token,需含「读 agent / 动态摘要 + KV 读写」;建议给 Agent namespace 的 `metadata_*` 读权限;cron 触发还需 `JsWorker::RunDefinedJsWorker`。⚠️ **不是** Telegram bot token。 |
| `webhook_admin_secret` | — | 可选;也可在扩展面板设置。配置后保护 `/registerWebhook`、`/unRegisterWebhook`、`/webhookInfo` 管理路由。 |

> Telegram 的 `bot_token` / 通知目标列表 / `webhook_admin_secret` 可在配置面板里填(存 KV);敏感字段经 `get_config` 返回时始终**打码**。旧版 `chat_id` / `message_thread_id` / `events` 配置会在读取时自动兼容为 `targets`。

## 定时任务(必须)

新建 JsWorker 定时任务 → 脚本 `notify-worker` → cron 建议 `*/30 * * * * *`(每 30 秒,6 段格式)。
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
| `GET/POST /registerWebhook` | 使用当前域名注册 Telegram webhook,回调地址为同一路由下的 `/telegramWebhook`;成功后同步注册 Telegram 命令列表中的 `chatid` |
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
| `template` | `{{emoji}} {{event}}…` | 离线/上线模板 |
| `resource_template` | `{{event}}…` | CPU/内存/磁盘资源告警与恢复模板 |
| `renew_template` | `{{emoji}} {{event}}…` | 到期/续费信息模板,仅到期事件使用 |
| `traffic_template` | `{{emoji}} {{event}}…` | 流量配额提醒模板,仅流量事件使用 |
| `events` | offline/online/resource/expire 开,traffic 关 | 兼容旧配置的默认事件开关;新配置按 `targets[].events` 判断 |
| `nodes` | `[]` | 每节点资源开关;每项含 `uuid`、`name`、`rules.cpu/memory/disk.enabled` |
| `offline_threshold_sec` | `90` | 离线阈值,单位秒;最后上报超过该阈值后,下一次扫描立即触发离线通知 |
| `resource_rules` | CPU/内存/磁盘 90%,持续 300 秒 | 资源类全局阈值与持续时间;是否启用由每个节点的 `rules.*.enabled` 控制 |
| `expire_days` | `7` | 到期提前提醒天数(1–90) |
| `traffic_threshold` | `80` | 流量配额提醒起始阈值百分比(1–200),达到后每 +5% 档位提醒 |

## 事件说明

- **离线 / 上线**:worker 只读取 `agent_dynamic_summary_multi_last_query` 的最近动态摘要,不主动探测节点。节点最后上报超过 `offline_threshold_sec` 后,下一次扫描立即触发离线通知;持续离线不重复发送,恢复后发送一次恢复通知,再次离线会再次通知。新启用但从未见过有效上报的节点进入等待首次上报状态,不会直接报离线。离线成功通知后会记录离线前最后上报时间,恢复通知可显示最后上报时间、离线持续时间和恢复检测时间。
- **节点范围**:离线监控覆盖所有未软删除节点。节点被删除或不在活跃节点列表内时会清理旧状态,不再发送该节点离线或恢复通知。
- **资源规则**:每个节点可独立开启 CPU、内存、磁盘使用率告警。资源类告警只有连续超过 `resource_rules.*.threshold_pct` 达到 `duration_sec` 后才触发;持续超阈值不刷屏,降回阈值以下后发送一次恢复通知。资源扫描同样只读取 NodeGet 已有动态摘要字段 `cpu_usage`、`used_memory/total_memory`、`total_space/available_space`。
- **到期**:`metadata_expire_time` 距今 ≤ N 天(默认 7),**每天提醒一次**(跨天重发,续费即停);只发送给启用到期事件的目标。到期通知会读取节点 KV 中的 `metadata_price`、`metadata_price_unit`、`metadata_price_cycle`、`metadata_expire_time` 与 `metadata_tags`,并直接按 `renew_template` 渲染完整到期/续费消息。`metadata_expire_time` 支持 Dashboard 写入的 `YYYY-MM-DD` 日期串,也兼容毫秒/秒时间戳。
- **流量配额提醒**:经 `inlineCall` 读 `traffic-billing-worker` 的告警节点,从 `traffic_threshold`(默认 80%) 起**每 +5% 档位报一次**;需目标启用流量事件且已部署 traffic-billing。流量通知使用 `traffic_template`,可显示已用流量、总配额、使用率、提醒档位和下次重置日;`{{event}}` 会按使用率显示为“流量配额提醒 / 流量接近配额 / 流量已达配额 / 流量已超配额”。阈值变更后,通知侧会清空旧流量档位状态并按新阈值重新评估。

## Chat ID 获取

在 Telegram 内向 Bot 发送 `/chatid` 或 `/chat_id`。注册 webhook 后,Telegram 会把 update 实时推送到 worker,worker 会立即向该会话回复当前 `chat_id`、类型和名称。超级群话题内发送时,回复会落在同一个话题。`/registerWebhook` 会同步把 `chatid` 注册到 Telegram 命令列表,用户输入 `/` 时可看到该快捷命令;`chat_id` 只作为兼容指令保留,不注册到命令列表。

首次启用流程:

1. 在扩展面板保存 Bot Token、至少一个通知目标、请求端点和可选 Webhook 管理密钥。
2. 访问 `https://你的域名/nodeget/worker-route/<route_name>/registerWebhook` 注册 webhook;如配置了管理密钥,追加 `?s=密钥`。
3. 在 Telegram 内发送 `/chatid` 或 `/chat_id` 验证实时回复。

## 消息变量

离线/上线模板变量:

`{{emoji}}` `{{event}}` `{{client}}`(兼容摘要,超过 6 台会截断) `{{clients}}`(完整节点名列表) `{{node_count}}` `{{status}}` `{{last_seen}}`(单节点最后上报时间;多节点为最早离线前上报时间) `{{last_seen_list}}`(逐节点最后上报时间) `{{offline_duration}}`(最长静默/离线持续时间) `{{offline_duration_list}}`(逐节点持续时间) `{{offline_threshold}}` `{{recovery_time}}` `{{time}}`(CST) `{{type}}` `{{tags}}`(节点标签,逗号分隔) `{{tag_count}}`

资源告警/恢复模板变量:

`{{event}}`(资源规则告警/资源规则恢复) `{{status}}` `{{client}}`(节点名) `{{resource_type}}` `{{resource_value}}`(当前值) `{{resource_threshold}}`(告警阈值) `{{resource_duration}}`(超限持续阈值) `{{resource_since}}` `{{recovery_time}}` `{{time}}`(CST) `{{type}}` `{{tags}}` `{{tag_count}}`

到期/续费信息模板变量:

`{{emoji}}` `{{event}}`(节点即将到期/节点今日到期/节点已过期) `{{status}}` `{{client}}`(节点名) `{{time}}`(CST) `{{type}}` `{{expire_time}}`(到期日期/时间) `{{days_left}}` `{{days_left_text}}` `{{price}}` `{{price_unit}}` `{{price_cycle}}` `{{renewal_price}}` `{{tags}}`

流量配额提醒模板变量:

`{{emoji}}` `{{event}}`(流量配额提醒/流量接近配额/流量已达配额/流量已超配额) `{{status}}` `{{client}}`(节点名) `{{time}}`(CST) `{{type}}` `{{traffic_used}}`(如 `12.34 GB`) `{{traffic_quota}}`(如 `100 GB`) `{{traffic_percent}}` `{{traffic_level}}`(当前告警档位) `{{traffic_reset_day}}`(下次重置日期) `{{traffic_billing_day}}`(每月计费日) `{{traffic_remaining}}` `{{traffic_used_gb}}` `{{traffic_quota_gb}}` `{{traffic_remaining_gb}}` `{{tags}}`

标签、价格、价格单位和计费周期是可选增强字段;如果 worker token 缺少这些可选 key 的读权限,通知仍会发送,对应变量为空。到期判断本身仍需要读取 `metadata_expire_time`。
包含 `{{tags}}` 的整行在标签为空时会自动隐藏,默认模板不会输出空的“标签：”行。
