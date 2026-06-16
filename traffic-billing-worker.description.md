# 流量监控 · traffic-billing

逐台 **opt-in** 的节点流量记账 + 可选配额告警 + 对外汇总接口 + 内置配置页。完全在 NodeGet 边缘端运行,不改探针任何代码。

---

## 环境变量(env)

| 键 | 必填 | 说明 |
|---|---|---|
| `token` | ✅ | NodeGet 平台 Token,需含「读 agent / 动态摘要 + KV 读写」权限;cron 触发还需 `JsWorker::RunDefinedJsWorker`。**不是** Telegram token。 |
| `route_secret` | 可选 | 设了后配置页 `/ui` 打开需登录密钥(本机 localStorage 记住);数据接口 `/list`、`/summary` 始终公开,供探针前端拉取。 |

## 定时任务(必须)

新建 JsWorker 定时任务 → 脚本 `traffic-billing-worker` → cron 建议 `0 */5 * * * *`(每 5 分钟,6 段格式)。
> ⚠️ 没有定时任务则**用量不累计、到点不重置**。

## onCall / onInlineCall(`params.action`)

| action | 参数 | 说明 |
|---|---|---|
| `list` | — | 所有节点(含未开启)的记账视图 |
| `get_summary` | — | 汇总 + 告警节点 `alerting:[{uuid,name,percent,level}]`(80% 起每 5% 一档,供 notify) |
| `get_config` | `{uuid}` | 读单节点配置 |
| `set_config` | `{uuid, enabled?, billing_day?, mode?, quota_gb?}` | 改配置(`mode`= `outbound`/`inbound`/`both`;`quota_gb` 留空=不限额) |
| `audit_now` | — | 立即审计一轮 |
| `reset_node` | `{uuid}` | 重置本期已用为 0 |

## HTTP 路由(`/nodeget/worker-route/traffic-billing`)

| 方法 路径 | 鉴权 | 说明 |
|---|---|---|
| `GET /ui` | 公开(出登录页) | 配置页 |
| `GET /list`、`GET /summary` | **公开** | 数据接口,探针前端拉取 |
| `GET /config?uuid=` | 需登录 | 读配置 |
| `POST /config` | 需登录 | 改配置 |
| `POST /audit` | 需登录 | 立即审计 |
| `POST /reset` `{uuid}` | 需登录 | 重置本期 |

## 计费规则

- 配额留空 = 只统计用量、不限额、不告警;填数字 → 80% / 每 +5% 档位告警(供 notify 阶梯报警)。
- 按**日历月**重置:每月「起算日」0 点(东八区)清零;短月(如 2 月)自动落月末。
- 计费方向:出网(上传)/ 入网(下载)/ 双向;节点重启计数器归零自动容错。
- 配额状态等数据可被 `notify-worker` 经 `inlineCall` 读取做「流量超额」通知。
