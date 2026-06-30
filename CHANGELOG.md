# Changelog

本文件记录 `js_workers` 仓库的主要变更。

## [1.2.0] - 2026-07-01

### Added
- `notify-worker` 支持逗号或换行分隔的多个 Telegram Chat ID,同一通知会逐个发送到配置的目标。
- `notify-worker` 新增 `targets` 通知目标列表,每个目标可单独配置名称、Chat ID、话题 ID、离线、恢复、到期、流量和启用状态。
- `notify-worker` 支持 Telegram `/chatid` 与 `/chat_id` 指令通过 webhook 实时回复当前会话 ID、类型和名称。
- `notify-worker` 新增可选 Webhook 管理密钥 `webhook_admin_secret`,可在扩展面板或 env 配置,用于保护 webhook 注册、注销和查询管理路由。
- `notify-extension` 的 Bot Token 与 Webhook 管理密钥输入框默认隐藏,支持眼睛按钮临时显示本次输入。
- `notify-extension` 将原 Chat ID 文本框改为通知目标列表,支持新增、删除目标并逐行勾选接收事件。

### Changed
- `notify-worker` 发送事件时按目标的事件开关筛选接收方;旧 `chat_id` / `message_thread_id` / `events` 配置会在读取时自动兼容为目标列表。

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
- `notify-worker.js` — 消息通知 Worker（离线/上线/到期/流量超额 → Telegram 推送）
- `traffic-monitor-extension.zip` — 流量监控 Dashboard 扩展
- `notify-extension.zip` — 消息通知 Dashboard 扩展
- 配套扩展源码（`extension/`、`notify-extension/`）
- 完整 README 文档（快速上手、架构、API、排错）
