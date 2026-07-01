# traffic-monitor 扩展

NodeGet Dashboard 扩展，为「流量监控」提供图形化配置面板。

扩展 iframe 内即是完整界面（不跳转），鉴权方式**和 Docker 插件一致**：用安装时按 `app.json.limits` 创建的 NodeGet Token（经 iframe hash 传入），调 `js-worker_run`（`run_type=call`）触发 worker 的 `onCall`，再轮询 `js-result_query` 取结果。**不再使用 worker 的 `route_secret`**。

所需权限（`app.json.limits` 已声明，安装时确认）：

- `JsWorker::RunDefinedJsWorker` — 运行 worker
- `JsResult::Read` — 读执行结果
- Scope：`JsWorker(traffic-billing-worker)`

> ⚠️ `WORKER_NAME` 默认 `traffic-billing-worker`，须与 worker 的**脚本名**一致（不是 route_name）。改了脚本名要同步 `resources/assets/main.js` 顶部的 `WORKER_NAME` 与 `app.json` 的 scope。

## 功能

- 汇总卡片：节点总数 / 已监控 / 本期或已用合计 / 触发告警。
- 逐台开关监控、设「计费方向 / 计费模式 / 起算日 / 配额或预算」，即时保存；一键重置用量。
- 支持按周期计费和“不限时流量包”两种模式；流量包可按总流量 GB 或按单价 + 预算金额提醒。
- 配置弹窗可点击「从到期日设置」读取节点 `metadata_expire_time`,支持 `YYYY-MM-DD`、`YYYY/MM/DD`、秒时间戳和毫秒时间戳;解析失败时填入 1 号。
- 用量进度条 + 80% 起每 5% 档位告警配色；搜索；从某台机器页面进入显示**单机视图**（仅该机的用量大图 + 配置 + 重置）。
- 每 15s 静默刷新（数据未变不重绘、不闪），跟随 Dashboard 明暗主题。

> 两个入口（`app.json` 的 `routes`）：应用扩展区 = 全部节点表格；每台机器页面 = 该机单机视图。

## 前置:部署 traffic-billing-worker

worker 文件在上级目录 `../traffic-billing-worker.js`。**单文件**,在面板里部署即可,不依赖外部脚本:

1. Dashboard → **JS Worker** → 新建,名称 `traffic-billing-worker`。
2. 把 `traffic-billing-worker.js` 全文贴进代码框,点**保存代码**。
3. **环境变量** 加一条 `token` = 你的 NodeGet Token(需含读 agent/动态摘要 + KV 读写权限;cron 触发还需 `JsWorker::RunDefinedJsWorker`)。
4. **设置** 里 `route_name` 填 `traffic-billing`(供 StatusShow 前端读 `/list`、`/summary`;扩展本身用脚本名 `WORKER_NAME` 调 onCall,与 route_name 无关)。
5. Dashboard → **定时任务** 新建一个 JsWorker 任务,脚本 `traffic-billing-worker`,cron 建议 `0 */5 * * * *`(每 5 分钟)。**必须有这个定时任务**,否则用量不累计、到点不重置。

## 安装扩展

1. NodeGet Dashboard → **扩展管理** → 安装。
2. 选本 `traffic-extension` 文件夹,或 `traffic-monitor-extension.zip`。
3. 装后:「应用扩展」区出现「流量监控」入口;每台机器页面也有「流量监控」标签(自动定位该机器)。

## 计费规则

- 旧配置没有 `billing_mode` 时按周期计费,行为保持不变。
- 周期模式:配额留空 = 只统计用量、不限额、不告警;填数字 = 80% 起每 +5% 在账本置告警位。
- 周期模式按**日历月**重置:每月「起算日」0 点(东八区)清零;短月(如 2 月)自动落到月末。
- 流量包模式:不限时,不会按起算日自动重置;累计用量一直增长,直到手动重置。
- 流量包按流量额度时使用 `quota_gb`;按金额额度时使用 `unit_price_per_gb * used_gb / budget_amount`,金额单位 `budget_unit` 可自由填写,例如 `$`。
- 计费方向:出网(上传)/ 入网(下载)/ 双向;新配置和未设置方向的旧配置默认双向。
- 「保存」即时写入该机器命名空间的 `traffic_billing_config`,下一轮 cron 起按新设置累计。
- 「追加流量」只增加 `quota_gb`,不修改已用量,仅适用于流量包的流量额度方式。
- 「重置用量」把已统计用量清零,不修改额度、单价或预算。

## 前端卡片显示(可选)

`NodeGet-StatusShow` 前端已原生集成:卡片底部 / 表格列会显示「本月流量」,数据取自本 worker 的 `/list`。
worker 没部署时前端自动隐藏该行/列,不影响正常显示。

## 安全

- **token 鉴权**:扩展用安装时按 `app.json.limits` 创建的专属 Token(经 iframe hash 传入)调 `js-worker_run` → `onCall`,**没有登录页、不用 `route_secret`**,装进 board(登录后台)、不碰公开站。
- **数据接口公开**:worker 的 `GET /list`、`/summary` 不需鉴权——StatusShow 前端要拉它显示「本月流量」(只读用量数字,不含凭证)。worker 仍可选用 `route_secret` 保护 `/config` 等 HTTP 写路由,但本扩展走 onCall、不经那些路由。
