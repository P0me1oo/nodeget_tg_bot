# 流量监控 · traffic-billing

逐台 **opt-in** 的节点流量记账 + 可选配额告警 + 对外汇总接口。完全在 NodeGet 边缘端运行,不改探针任何代码。

---

## 环境变量(env)

| 键 | 必填 | 说明 |
|---|---|---|
| `token` | ✅ | NodeGet 平台 Token,需含「读 agent / 动态摘要 + KV 读写」权限;cron 触发还需 `JsWorker::RunDefinedJsWorker`。**不是** Telegram token。 |
| `route_secret` | 可选 | 设了后 `/config`、`/append-quota`、`/audit`、`/reset` 等写路由需带密钥;数据接口 `/list`、`/summary` 始终公开,供探针前端拉取。 |

## 定时任务(必须)

新建 JsWorker 定时任务 → 脚本 `traffic-billing-worker` → cron 建议 `0 */5 * * * *`(每 5 分钟,6 段格式)。
> ⚠️ 没有定时任务则**用量不累计、到点不重置**。

## onCall / onInlineCall(`params.action`)

| action | 参数 | 说明 |
|---|---|---|
| `list` | — | 所有节点(含未开启)的记账视图;按 `metadata_order` 排序,并返回 `expire_time` / `expire_billing_day` |
| `get_summary` | `{alert_threshold?}` | 汇总 + 告警节点 `alerting:[{uuid,name,billing_mode,percent,level,used_gb,quota_gb,cost_amount,reset_day,...}]`(默认 80% 起每 5% 一档,可由 `alert_threshold` 调整,供 notify) |
| `get_config` | `{uuid}` | 读单节点配置,并返回到期日快捷字段 |
| `set_config` | `{uuid, enabled?, billing_day?, mode?, billing_mode?, package_limit_type?, quota_gb?, unit_price_per_gb?, budget_amount?, budget_unit?}` | 改配置;旧配置无 `billing_mode` 时默认 `period`,无 `mode` 时默认 `both` |
| `append_quota` | `{uuid, add_gb}` | 流量包 + 流量额度方式下追加总额度,不修改已用量 |
| `audit_now` | — | 立即审计一轮 |
| `reset_node` | `{uuid}` | 重置已统计用量为 0 |

## HTTP 路由(`/nodeget/worker-route/traffic-billing`)

| 方法 路径 | 鉴权 | 说明 |
|---|---|---|
| `GET /list`、`GET /summary` | **公开** | 数据接口，供探针前端 / StatusShow 拉取 |
| `GET /config?uuid=` | 需登录 | 读配置 |
| `POST /config` | 需登录 | 改配置 |
| `POST /append-quota` `{uuid,add_gb}` | 需登录 | 追加流量额度 |
| `POST /audit` | 需登录 | 立即审计 |
| `POST /reset` `{uuid}` | 需登录 | 重置用量 |

> 图形配置面板已移到 `traffic-monitor` 扩展（iframe），经 `js-worker_run` 调本 worker 的 `onCall`，**不再有内置 `/ui` 页**。`/list`、`/summary` 仍保留供只读拉取。

## 计费规则

- `billing_mode` 缺省为 `period`,兼容老配置:按**日历月**重置,每月「起算日」0 点(东八区)清零;短月(如 2 月)自动落月末。
- `billing_mode:"traffic_package"` 为不限时流量包:不会按起算日自动重置,累计用量一直增长,直到用户手动 `reset_node`。
- 流量包支持 `package_limit_type:"traffic"` 按 `quota_gb` 计算百分比,或 `package_limit_type:"cost"` 按 `used_gb * unit_price_per_gb / budget_amount` 计算百分比;`budget_unit` 是自由文本货币单位。
- 无有效额度时只统计用量、不告警;有有效额度时默认 80% 起每 +5% 档位告警。`get_summary({alert_threshold})` 可调整告警起始阈值,供 notify 阶梯报警。
- 计费方向:出网(上传)/ 入网(下载)/ 双向;未配置方向时默认双向,节点重启计数器归零自动容错。
- 配额状态等数据可被 `notify-worker` 经 `inlineCall` 读取做「流量配额提醒」。`get_summary().alerting[]` 会额外返回 `billing_mode`、`package_limit_type`、`billing_day`、`mode`、`used_bytes`、`used_gb`、`quota_gb`、`remaining_gb`、`unit_price_per_gb`、`budget_amount`、`budget_unit`、`cost_amount`、`reset_day`、`next_reset_time`、`current_period_start`、`last_update`,用于流量通知模板显示周期配额或流量包额度。
