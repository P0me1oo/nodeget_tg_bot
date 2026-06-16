# 消息通知 扩展

NodeGet Dashboard 扩展,为「消息通知」提供图形配置入口(对齐 Komari 通知)。
前端壳,打开后同源跳转到 `notify-worker` 的 `/ui`;数据读写由该 worker 用自身 `env.token` 完成,扩展本身无需权限。

## 前置:部署 notify-worker

worker 文件:`../notify-worker.js`,`route_name = notify`,env 设 `token`。
再到「定时任务」建一个 Server/JsWorker 任务,脚本名 `notify-worker`,cron 建议 `0 */2 * * * *`(每 2 分钟检测一次离线/上线/到期)。

## 安装

NodeGet Dashboard → 扩展管理 → 安装 → 选本 `notify-extension` 文件夹或 zip。
装后「应用扩展」区出现「消息通知」入口。

## 使用

- 开启通知总开关。
- 填 Telegram Bot Token / Chat ID(可 @频道名)/(可选)thread / 请求端点。
- 选事件:离线 / 上线 / 到期 / 流量超配额。同一轮多台离线/恢复会**合并成一条**;到期为**每天提醒一次**(临期后每天叮,续费即停)。
- 编辑消息模板,变量:`{{emoji}}` `{{event}}` `{{client}}` `{{time}}` `{{type}}`。
- 「发送测试消息」验证通,「立即检测一次」手动跑一轮。

> 流量超配额事件需已部署 traffic-billing-worker。

## 安全(可选)

- **bot_token 打码**(默认开):配置页不再回显明文 token,只显示尾巴提示(如 `12345…wXyz`)。保存时 token **留空 = 保留原值**,重填非空才覆盖。

- **登录保护**:给 worker 环境变量加 `route_secret`(任意随机串)后,打开配置页会**先出登录页**:
  - 从「应用扩展」图标点进 → 出登录页 → 输入 `route_secret` → 登录成功进入,**本机记住(localStorage),以后直接进**;
  - 没登录 / 密钥错 → 只看到登录框,**读不到任何配置数据**(数据接口返回 401);
  - 也可用 `https://你的域名/nodeget/worker-route/notify/ui#s=<route_secret>` 免登录直达(`#` hash 不进服务器日志,适合存书签);
  - 不设 `route_secret` = 公开(打开即用,无登录页)。

- **上次检测时间**:配置页顶部显示「上次检测:N 分钟前 · 发出 X 条」;显示「尚未运行」=定时任务没配或没跑。

> 说明:NodeGet 的 `worker-route` 本身是**公开 HTTP 端点**(平台不提供账号级鉴权),上面是**应用层登录** —— 知道密钥的人能进,不知道的看不到数据。登录后密钥走 `x-route-secret` 请求头(不进 URL/日志),bot_token 始终打码。
