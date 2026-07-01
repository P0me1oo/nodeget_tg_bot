# 消息通知 扩展

NodeGet Dashboard 扩展,为「消息通知」提供图形化配置面板(对齐 Komari 通知)。

扩展 iframe 内即是完整界面(**不再跳转** worker 的 `/ui`),鉴权方式**和 Docker / 流量监控插件一致**:用安装时按 `app.json.limits` 创建的 NodeGet Token(经 iframe hash 传入),调 `js-worker_run`(`run_type=call`)触发 `notify-worker` 的 `onCall`,再轮询 `js-result_query` 取结果。**不再使用 worker 的 `route_secret`**。

所需权限(`app.json.limits` 已声明,安装时确认):

- `JsWorker::RunDefinedJsWorker` — 运行 worker
- `JsResult::Read` — 读执行结果
- Scope:`JsWorker(notify-worker)`

> ⚠️ `WORKER_NAME` 默认 `notify-worker`,须与 worker 的**脚本名**一致(不是 route_name)。改了脚本名要同步 `resources/assets/main.js` 顶部的 `WORKER_NAME` 与 `app.json` 的 scope。

## 为什么仍需要 worker

通知是**有状态 + 定时**的功能:按秒级离线阈值判定离线、同轮合并、失败重试、等待首次上报、资源规则连续超阈值、到期每天一次、流量阶梯报警,都靠 `notify-worker` 的 `onCron` 周期性跑 + KV 存状态。扩展只是它的配置面板,无法脱离 worker 独立工作(这点和 Docker 那种"即时无状态"插件不同)。本次重构去掉的是对 worker `/ui` 页面的依赖,不是去掉 worker。

## 前置:部署 notify-worker

worker 文件在上级目录 `../notify-worker.js`。**单文件**,在面板里部署即可:

1. Dashboard → **JS Worker** → 新建,名称 `notify-worker`。
2. 把 `notify-worker.js` 全文贴进代码框,点**保存代码**。
3. 设置 `route_name`,建议填 `notify`,用于 Telegram webhook 回调。
4. **环境变量** 加一条 `token` = 你的 NodeGet Token(需含读 agent/动态摘要 + KV 读写权限;建议给 Agent namespace 的 `metadata_*` 读权限;cron 触发还需 `JsWorker::RunDefinedJsWorker`)。这是 **NodeGet 平台 Token,不是 Telegram bot token**。`webhook_admin_secret` 可在扩展面板里填;也可作为 env 配置。
5. Dashboard → **定时任务** 新建一个任务,脚本 `notify-worker`,cron 建议 `*/30 * * * * *`(每 30 秒扫描一次)。**必须有这个定时任务**,否则不会检测离线/上线/资源规则/到期/流量事件。

## 安装扩展

1. NodeGet Dashboard → **扩展管理** → 安装。
2. 选本 `notify-extension` 文件夹,或 `notify-extension.zip`。
3. 装后「应用扩展」区出现「消息通知」入口(全局,一套配置管所有节点)。

## 使用

- **开启通知**:总开关,关闭后定时检测不发送。
- **Telegram 设置**:填 Bot Token(@BotFather 获取)、通知目标列表、请求端点(被墙可填反代)、可选 Webhook 管理密钥。每个通知目标可配置名称、Chat ID(数字 id 或 @频道名)、可选话题 ID、离线、恢复、到期、流量和启用状态。
- **Telegram 指令**:在私聊、群组或频道内向 Bot 发送 `/chatid` 或 `/chat_id`,注册 webhook 后 worker 会实时回复当前会话的 Chat ID。
- **通知事件**:在通知目标列表逐行勾选。未勾选某事件的目标不会收到该事件;同轮多台离线/恢复**合并成一条**;到期**每天提醒一次**(临期后每天叮,续费即停);流量从配置的提醒阈值(默认 80%)起每 +5% 报一档。
- **节点监控**:离线监控覆盖全部未删除节点。节点列表排序对齐 NodeGet 节点管理顺序,用于逐节点开启 CPU、内存和磁盘资源告警。节点删除或不在活跃节点列表内时会清理旧状态,不再发送该节点离线或恢复通知。新节点未见过有效上报时会等待首次上报,不会直接报离线。
- **离线/上线模板**:变量 `{{emoji}}` `{{event}}` `{{client}}` `{{clients}}` `{{node_count}}` `{{status}}` `{{last_seen}}` `{{last_seen_list}}` `{{offline_duration}}` `{{offline_duration_list}}` `{{offline_threshold}}` `{{recovery_time}}` `{{time}}`(CST) `{{type}}` `{{tags}}` `{{tag_count}}`。标签来自节点 KV `metadata_tags`;恢复通知会显示离线前最后上报时间、离线持续时间和恢复检测时间。
- **资源告警/恢复模板**:变量 `{{event}}` `{{status}}` `{{client}}` `{{resource_type}}` `{{resource_value}}`(当前值) `{{resource_threshold}}`(告警阈值) `{{resource_duration}}`(超限持续阈值) `{{resource_since}}` `{{recovery_time}}` `{{time}}` `{{type}}` `{{tags}}` `{{tag_count}}`。CPU、内存、磁盘可按节点独立启用,连续超过阈值达到持续时间后才触发。
- **到期/续费信息模板**:仅到期通知使用,变量 `{{emoji}}` `{{event}}` `{{status}}` `{{client}}` `{{time}}` `{{type}}` `{{expire_time}}` `{{days_left}}` `{{days_left_text}}` `{{price}}` `{{price_unit}}` `{{price_cycle}}` `{{renewal_price}}` `{{tags}}`。`{{event}}` 会按剩余天数显示为“节点即将到期 / 节点今日到期 / 节点已过期”。续费字段来自节点 KV `metadata_price`、`metadata_price_unit`、`metadata_price_cycle`、`metadata_expire_time`;Dashboard 写入的 `YYYY-MM-DD` 到期日期会原样显示。缺少标签/价格等可选字段读权限时,对应变量为空,不会阻断通知。
- **流量配额提醒模板**:仅流量通知使用,变量 `{{emoji}}` `{{event}}` `{{status}}` `{{client}}` `{{time}}` `{{type}}` `{{traffic_used}}` `{{traffic_quota}}` `{{traffic_percent}}` `{{traffic_level}}` `{{traffic_reset_day}}` `{{traffic_billing_day}}` `{{traffic_remaining}}`。`{{event}}` 会按使用率显示为“流量配额提醒 / 流量接近配额 / 流量已达配额 / 流量已超配额”。这些字段来自 `traffic-billing-worker` 的 `get_summary().alerting[]`,需同步更新流量 worker 才能显示完整信息。
- 包含 `{{tags}}` 的整行在标签为空时会自动隐藏。
- **发送测试**:验证 Telegram 配置通不通。**立即检测**:手动跑一轮(会先保存当前配置)。
- 顶部状态条显示「上次检测 N 分钟前 · 发出 X 条」;显示「尚未运行」= 定时任务没配或没跑。

## 注册 Telegram webhook

扩展只负责配置,Telegram 实时指令需要 worker 的 HTTPS 路由能被 Telegram 公网访问:

1. 先在扩展里保存 Bot Token、至少一个通知目标、请求端点和可选 Webhook 管理密钥。
2. 访问 `https://你的域名/nodeget/worker-route/notify/registerWebhook`。如果配置了 Webhook 管理密钥,访问 `...?s=密钥`。
3. 返回 `{"ok":true,...}` 后,在 Telegram 里发送 `/chatid` 或 `/chat_id` 验证实时回复。

注销 webhook 用 `/unRegisterWebhook`,查询状态用 `/webhookInfo`。Webhook 生效后不再依赖 Telegram 轮询接口,也不需要等定时任务或手动「立即检测」。

## 安全

- **敏感字段打码**:面板不回显明文 `bot_token` / `webhook_admin_secret`,默认以密码输入框隐藏;眼睛按钮只显示本次输入的新值。已保存字段只显示尾巴提示(如 `12345…wXyz`);保存时留空 = 保留原值,重填非空才覆盖。
- **token 鉴权**:装进 board(登录后台),用安装时创建的细粒度专属 Token,经 iframe hash 传入;**不碰公开站,无需密码门**。Telegram 凭证写在 worker 的 KV(经 token RPC),不进 URL/日志。

> 流量配额提醒需已部署 `traffic-billing-worker`(notify 经 `inlineCall` 读它的告警节点)。如只更新通知 worker 而未更新流量 worker,流量百分比仍可用,已用/配额/重置日等新增变量会为空。
