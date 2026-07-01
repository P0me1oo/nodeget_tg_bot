# Changelog

本文件记录 `js_workers` 仓库的主要变更。

## [1.3.0] - 2026-07-01

### Added
- `traffic-billing-worker` 升级为 `v3.2.0`,新增 `billing_mode:"period"|"traffic_package"`;旧配置没有该字段时继续按周期计费。
- 流量包模式支持按总流量 `quota_gb` 或按金额预算 `unit_price_per_gb` + `budget_amount` 计算达量比例,金额单位支持 `budget_unit` 自由文本。
- 流量监控扩展新增“从到期日设置”按钮,读取节点 `metadata_expire_time` 并兼容 `YYYY-MM-DD`、`YYYY/MM/DD`、秒时间戳和毫秒时间戳。
- 流量监控扩展新增流量包配置、追加流量、重置用量和直接修改总额度/预算字段。
- `traffic-billing-worker` 的 `list` / `get_config` 返回 `expire_time`、`expire_date`、`expire_billing_day` 等只读快捷字段。
- `traffic-billing-worker` 新增 `append_quota` action 和 `POST /append-quota` 路由。

### Changed
- 流量包模式不会按起算日自动重置累计用量,只在用户手动重置时清零;周期模式仍按原起算日逻辑运行。
- 达量提醒统一为 80% 起每 +5% 一档,100% 文案可区分达量,超过 100% 可区分超量。
- `traffic-billing-worker` 的 `list` 排序改为对齐 NodeGet 节点管理:有效 `metadata_order` 优先按数值升序,无有效排序值的节点排后并用 uuid 稳定排序。
- 流量监控扩展在周期模式显示“本期用量 / 起算日”,在流量包模式显示“已用流量 / 总额度 / 剩余额度”或费用预算信息。

## [1.2.1] - 2026-07-01

### Added
- `notify-worker` 注册 Telegram webhook 时同步调用 `setMyCommands`,将 `chatid` 加入 Telegram 输入 `/` 后显示的命令建议列表。

## [1.2.0] - 2026-07-01

### Added
- `notify-worker` 支持逗号或换行分隔的多个 Telegram Chat ID,同一通知会逐个发送到配置的目标。
- `notify-worker` 新增 `targets` 通知目标列表,每个目标可单独配置名称、Chat ID、话题 ID、离线、恢复、到期、流量和启用状态。
- `notify-worker` 支持 Telegram `/chatid` 与 `/chat_id` 指令通过 webhook 实时回复当前会话 ID、类型和名称。
- `notify-worker` 新增可选 Webhook 管理密钥 `webhook_admin_secret`,可在扩展面板或 env 配置,用于保护 webhook 注册、注销和查询管理路由。
- `notify-worker` 离线/上线模板新增 `{{clients}}`、`{{node_count}}`、`{{status}}`、`{{last_seen}}`、`{{last_seen_list}}`、`{{offline_duration}}`、`{{offline_duration_list}}`、`{{offline_delay}}`、`{{tags}}`、`{{tag_count}}` 等变量。
- `notify-worker` 到期通知新增到期/续费信息模板 `renew_template`,支持 `{{expire_time}}`、`{{days_left}}`、`{{days_left_text}}`、`{{price}}`、`{{price_unit}}`、`{{price_cycle}}`、`{{renewal_price}}`、`{{tags}}` 等变量。
- `notify-worker` 新增流量配额提醒模板 `traffic_template`,流量事件不再只能复用通用消息模板。
- 流量配额提醒模板新增 `{{traffic_used}}`、`{{traffic_quota}}`、`{{traffic_percent}}`、`{{traffic_level}}`、`{{traffic_reset_day}}`、`{{traffic_billing_day}}`、`{{traffic_remaining}}` 等变量,可显示已用流量、总配额、使用率、提醒档位和下次重置日。
- `notify-worker` 新增流量提醒阈值 `traffic_threshold`,默认 80%,可配置 1–200,达到阈值后每 +5% 档位提醒。
- `notify-extension` 的 Bot Token 与 Webhook 管理密钥输入框默认隐藏,支持眼睛按钮临时显示本次输入。
- `notify-extension` 将原 Chat ID 文本框改为通知目标列表,支持新增、删除目标并逐行勾选接收事件。
- `notify-extension` 配置页新增「到期/续费信息模板」和「流量配额提醒模板」输入框,可在 Dashboard 内直接编辑。

### Changed
- `notify-worker` 发送事件时按目标的事件开关筛选接收方;旧 `chat_id` / `message_thread_id` / `events` 配置会在读取时自动兼容为目标列表。
- 到期通知会读取 `metadata_price`、`metadata_price_unit`、`metadata_price_cycle`、`metadata_expire_time` 与 `metadata_tags`,并直接按 `renew_template` 渲染完整到期/续费消息。
- 到期和流量模板的 `{{event}}` 改为动态文案:到期按剩余天数区分“即将到期/今日到期/已过期”,流量按使用率区分“配额提醒/接近配额/已达配额/已超配额”。
- 续费增强字段改为可选读取:缺少标签/价格等可选字段权限时对应变量为空,不会阻断基础通知;Dashboard 写入的 `YYYY-MM-DD` 到期日期会按日期原样显示。
- 离线成功通知后会在 `notify_state.offline_since` 记录节点离线前最后上报时间,用于恢复通知显示离线持续时间;旧状态无该字段时自动兼容。
- `traffic-billing-worker` 升级为 `v3.1.0`,其 `get_summary().alerting[]` 保留原有 `uuid/name/percent/level/thresholds`,并额外返回用量、配额、计费日、重置日和更新时间,供通知模板渲染。
- `traffic-billing-worker` 的 `get_summary` 支持 `alert_threshold` 参数,供通知 worker 按配置阈值生成流量提醒列表。

## [1.1.0] - 2026-06-18

### Added
- `docker-extension/` — Docker 管理扩展（容器/镜像/运行，execute + docker CLI）
- `process-extension/` — 进程管理扩展（进程 ps/kill、端口 ss、systemd、pm2、任意日志 tail；execute）
- `log-cleanup-worker.js` — 日志清理 Worker（truncate 各机 NodeGet 日志，自助定时）
- `stream-unlock-worker.js` — 流媒体解锁检测 Worker（YouTube/Netflix v4/v6）

### Changed
- 重命名 `extension/` → `traffic-extension/`（与 `*-extension` 命名统一）
- `notify`（worker + 扩展）迁移到 NodeGet Token 鉴权：移除内置 `/ui` + `route_secret`，扩展改为自包含 iframe
- `traffic-extension` 同样改为 token 鉴权 iframe（不再跳转 worker `/ui`）

### Fixed
- 进程管理 pm2 日志改为直接 tail `pm_out/err_log_path` 文件，修复 `pm2 logs --nostream` 在非 TTY 下只显示 `[TAILING]` 横幅、无内容的问题

## [1.0.0] - 2026-06-16

### Added
- `traffic-billing-worker.js` — 流量记账 Worker（逐节点 opt-in、配额阶梯告警、汇总接口）
- `notify-worker.js` — 消息通知 Worker（离线/上线/到期/流量配额提醒 → Telegram 推送）
- `traffic-monitor-extension.zip` — 流量监控 Dashboard 扩展
- `notify-extension.zip` — 消息通知 Dashboard 扩展
- 配套扩展源码（`extension/`、`notify-extension/`）
- 完整 README 文档（快速上手、架构、API、排错）
