# Changelog

本文件记录 `js_workers` 仓库的主要变更。

## [1.0.0] - 2026-06-16

### Added
- `traffic-billing-worker.js` — 流量记账 Worker（逐节点 opt-in、配额阶梯告警、汇总接口）
- `notify-worker.js` — 消息通知 Worker（离线/上线/到期/流量超额 → Telegram 推送）
- `traffic-monitor-extension.zip` — 流量监控 Dashboard 扩展
- `notify-extension.zip` — 消息通知 Dashboard 扩展
- 配套扩展源码（`extension/`、`notify-extension/`）
- 完整 README 文档（快速上手、架构、API、排错）
