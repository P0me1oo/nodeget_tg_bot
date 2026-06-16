# traffic-monitor 扩展

NodeGet Dashboard 扩展,为「流量监控」提供图形配置入口。
本扩展只是**前端壳**:打开后同源跳转到 `traffic-billing-worker` 内置的 `/ui` 页面,
数据读写都由该 worker 用自身 `env.token` 完成,扩展本身不需要任何权限(`limits` 为空)。

## 功能

- 逐台开关监控、设「起算日 / 计费方向 / 配额」,即时保存。
- 汇总卡片(节点总数 / 已监控 / 合计已用 / 触发告警)、搜索、排序、标签页筛选。
- 批量开关 / 批量设配额方向起算日 / 批量重置本期。
- 用量进度条 + 80%/95% 告警状态徽章。
- 从某台机器页面进入时自动定位高亮该机器。

## 前置:部署 traffic-billing-worker

worker 文件在上级目录 `../traffic-billing-worker.js`。**单文件**,在面板里部署即可,不依赖外部脚本:

1. Dashboard → **JS Worker** → 新建,名称 `traffic-billing-worker`。
2. 把 `traffic-billing-worker.js` 全文贴进代码框,点**保存代码**。
3. **环境变量** 加一条 `token` = 你的 NodeGet Token(需含读 agent/动态摘要 + KV 读写权限;cron 触发还需 `JsWorker::RunDefinedJsWorker`)。
4. **设置** 里 `route_name` 填 `traffic-billing`(改了的话同步改本扩展 `resources/index.html` 的跳转地址)。
5. Dashboard → **定时任务** 新建一个 JsWorker 任务,脚本 `traffic-billing-worker`,cron 建议 `0 */5 * * * *`(每 5 分钟)。**必须有这个定时任务**,否则用量不累计、到点不重置。

## 安装扩展

1. NodeGet Dashboard → **扩展管理** → 安装。
2. 选本 `extension` 文件夹,或 `traffic-monitor-extension.zip`。
3. 装后:「应用扩展」区出现「流量监控」入口;每台机器页面也有「流量监控」标签(自动定位该机器)。

## 计费规则

- 配额留空 = 只统计用量、不限额、不告警;填数字 = 到 80% / 95% 在账本置告警位。
- 按**日历月**重置:每月「起算日」0 点(东八区)清零;短月(如 2 月)自动落到月末。
- 计费方向:出网(上传)/ 入网(下载)/ 双向。
- 「保存」即时写入该机器命名空间的 `traffic_billing_config`,下一轮 cron 起按新设置累计。
- 「重置本期」把当前周期已用清零,从当下重新计。

## 前端卡片显示(可选)

`NodeGet-StatusShow` 前端已原生集成:卡片底部 / 表格列会显示「本月流量」,数据取自本 worker 的 `/list`。
worker 没部署时前端自动隐藏该行/列,不影响正常显示。

## 安全(可选)

- **登录保护**:给 worker 环境变量加 `route_secret`(任意随机串)后,打开**配置页**会先出登录页:
  - 从「应用扩展」图标点进 → 登录页 → 输入 `route_secret` → 进入,**本机记住,以后直接进**;
  - 没登录 / 密钥错 → 只看到登录框,改不了配置;也可用 `…/traffic-billing/ui#s=<route_secret>` 免登录直达(`#` hash 不进日志)。
  - 不设 `route_secret` = 全公开(打开即用)。
- **数据接口始终公开**:`GET /list`、`/summary` **不受登录限制**——你的探针前端面板要拉 `/list` 显示「本月流量」,所以必须公开(只读用量数字,不含凭证)。受保护的只有配置/写操作(`/config`、`/audit`、`/reset`)。

> 说明:NodeGet 的 `worker-route` 是**公开端点**(平台无账号级鉴权),上面是**应用层登录**——知道密钥的人能进配置页,不知道的看不到/改不了配置;但用量数据接口公开(前端要用)。
