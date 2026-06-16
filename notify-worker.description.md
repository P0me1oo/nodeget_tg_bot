# 消息通知 · notify

节点**离线 / 上线 / 到期 / 流量超额**事件,通过 Telegram Bot 推送(对齐 Komari 通知)。配置 + 模板 + 测试都在内置 `/ui`。

---

## 环境变量(env)

| 键 | 必填 | 说明 |
|---|---|---|
| `token` | ✅ | NodeGet 平台 Token,需含「读 agent / KV」权限;cron 触发还需 `JsWorker::RunDefinedJsWorker`。⚠️ **不是** Telegram bot token(Telegram 的 bot_token 在 `/ui` 里填)。 |
| `route_secret` | 可选 | 设了后 `/ui` 打开需登录密钥(本机 localStorage 记住);也可用 `…/ui#s=<密钥>` 免登录直达(hash 不进日志)。 |

## 定时任务(必须)

新建 JsWorker 定时任务 → 脚本 `notify-worker` → cron 建议 `0 */2 * * * *`(每 2 分钟,6 段格式)。
> ⚠️ 没有定时任务则**不检测离线 / 上线 / 到期**(只有手动「立即检测」会跑)。

## onCall / onInlineCall(`params.action`)

| action | 参数 | 说明 |
|---|---|---|
| `get_config` | — | 读配置(`bot_token` 打码)+ 运行状态 |
| `set_config` | `{config:{...}}` | 改配置(`bot_token` 留空 = 保留原值,不覆盖) |
| `test` | — | 发一条测试消息 |
| `run` | — | 立即检测并推送一轮 |
| `get_state` | — | 读运行状态(`last_run` / `last_sent` 等) |

## HTTP 路由(`/nodeget/worker-route/notify`)

| 方法 路径 | 鉴权 | 说明 |
|---|---|---|
| `GET /ui` | 公开(出登录页) | 配置页 |
| `GET /config` | 需登录 | 读配置(打码)+ 状态 |
| `POST /config` | 需登录 | 保存配置 |
| `POST /test` | 需登录 | 发测试消息 |
| `POST /run` | 需登录 | 立即检测一轮 |

## 事件说明

- **离线 / 上线**:90 秒无上报判离线;同一轮多台离线/恢复**合并成一条**;发送失败下轮重试。
- **到期**:`metadata_expire_time` 距今 ≤ N 天(可配,默认 7),**每天提醒一次**(跨天重发,续费即停)。
- **流量超额**:经 `inlineCall` 读 `traffic-billing-worker` 的告警节点,**80% 起每 +5% 档位报一次**;需在 `/ui` 勾选该事件且已部署 traffic-billing。

## 消息模板变量

`{{emoji}}` `{{event}}` `{{client}}`(节点名) `{{time}}`(CST) `{{type}}`
