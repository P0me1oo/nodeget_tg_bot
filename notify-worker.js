/**
 * notify-worker v1.3.0
 *
 * NodeGet 事件通知(对齐 Komari 通知功能):节点离线/上线、到期提醒、流量配额提醒,
 * 通过 Telegram Bot 推送。配置由 notify-extension(token 鉴权 iframe)经 onCall 读写。
 *   当前:在 v1.2.0 基础上新增 targets 通知目标列表、节点标签变量、
 *        到期/续费信息模板、流量配额提醒模板与 /chatid 命令列表注册。
 *   v1.2.0:移除内置 /ui 与 route_secret;配置面板改由 notify-extension 用 NodeGet Token
 *          调 onCall(get_config/set_config/test/run)完成;支持 Telegram /chatid 实时响应。
 *   v1.3.0:秒级离线阈值 · 首次上报等待态 ·
 *          CPU/内存/磁盘连续超阈值告警与恢复
 *   v1.1:bot_token 打码回显 · 发送失败下轮重试 · 离线/恢复同轮合并一条 ·
 *         到期每天提醒一次 · 记录 last_run
 *
 * ── 事件 ─────────────────────────────────────────────────────────
 *   offline  节点离线(只读取动态摘要;最后上报超过 offline_threshold_sec 后,同轮多台合并一条)
 *   online   节点从离线恢复(同轮多台合并一条)
 *   resource CPU/内存/磁盘连续超过阈值达到持续时间后的告警与恢复
 *   expire   metadata_expire_time 距今 <= expire_days 天(每天提醒一次,跨天重发,续费即停)
 *   traffic  流量配额提醒(经 inlineCall 读 traffic-billing-worker;从 traffic_threshold 起每 +5% 档报一次)
 *
 * ── 存储(global 命名空间) ───────────────────────────────────────
 *   notify_config : { enabled, channel, bot_token, targets:[{name,chat_id,message_thread_id,events,enabled}],
 *                     webhook_admin_secret, endpoint, template, renew_template, traffic_template,
 *                     nodes, offline_threshold_sec, resource_rules,
 *                     events:{offline,online,resource,expire,traffic}, expire_days, traffic_threshold }
 *   notify_state  : { offline:[uuid...], offline_since:{uuid:last_seen_ms...},
 *                     seen:{uuid:first_valid_report_ms...}, waiting_first_report:{uuid:since_ms...},
 *                     resource:{"uuid:type":{status,first_seen,last_seen,last_value...}},
 *                     expire_dates:{uuid:"YYYY-MM-DD"...}, traffic:{uuid:level...},
 *                     telegram_webhook_secret, telegram_webhook_url, last_run, last_sent, last_note }
 *
 * ── 入口 ─────────────────────────────────────────────────────────
 *   onCron        → 检测事件并推送(需配定时任务,建议每 30 秒一次)
 *   onCall        → action: get_config / set_config / test / run / get_state(供扩展经 js-worker_run 调用)
 *   onInlineCall  → 同 onCall
 *   onRoute       → Telegram webhook 注册/注销与 update 接收
 *
 * env: {
 *   "token": "<NodeGet 平台 Token(读 agent/kv 权限);注意:不是 Telegram bot token>",
 *   "webhook_admin_secret": "<可选;也可在扩展面板保存,用于保护 webhook 管理路由>"
 * }
 * 注:bot_token / webhook_admin_secret 经 get_config 返回时始终打码;set_config 留空 = 保留原值。
 */

var NS = "global";
var CFG_KEY = "notify_config";
var STATE_KEY = "notify_state";
var NAME_KEY = "metadata_name";
var TAGS_KEY = "metadata_tags";
var ORDER_KEY = "metadata_order";
var PRICE_KEY = "metadata_price";
var PRICE_UNIT_KEY = "metadata_price_unit";
var PRICE_CYCLE_KEY = "metadata_price_cycle";
var EXPIRE_KEY = "metadata_expire_time";
var DEFAULT_OFFLINE_THRESHOLD_SEC = 90;
var DEFAULT_RESOURCE_THRESHOLD = 90;
var DEFAULT_RESOURCE_DURATION_SEC = 300;
var SUMMARY_FIELDS = ["cpu_usage", "used_memory", "total_memory", "total_space", "available_space"];
var RESOURCE_TYPES = ["cpu", "memory", "disk"];
var RESOURCE_LABELS = { cpu: "CPU", memory: "内存", disk: "磁盘" };
var TRAFFIC_WORKER = "traffic-billing-worker";
var WEBHOOK_PATH = "/telegramWebhook";
var TELEGRAM_COMMANDS = [
  { command: "chatid", description: "获取当前会话 Chat ID" },
];

var DEFAULT_CFG = {
  enabled: false,
  channel: "telegram",
  bot_token: "",
  chat_id: "",              // 兼容旧配置;新配置使用 targets
  message_thread_id: "",    // 兼容旧配置;新配置使用 targets
  targets: [],
  webhook_admin_secret: "",
  endpoint: "https://api.telegram.org/bot",
  template: "{{emoji}} {{event}}\n服务器：{{clients}}\n标签：{{tags}}\n节点数量：{{node_count}}\n状态：{{status}}\n最后上报：{{last_seen}}\n离线持续：{{offline_duration}}\n恢复检测：{{recovery_time}}\n离线阈值：{{offline_threshold}}\n时间：{{time}}",
  resource_template: "{{event}}\n服务器：{{client}}\n标签：{{tags}}\n规则：{{resource_type}}\n状态：{{status}}\n当前值：{{resource_value}}\n告警阈值：{{resource_threshold}}\n超限持续阈值：{{resource_duration}}\n首次超过：{{resource_since}}\n恢复检测：{{recovery_time}}\n时间：{{time}}",
  renew_template: "{{emoji}} {{event}}\n服务器：{{client}}\n标签：{{tags}}\n到期时间：{{expire_time}}\n剩余时间：{{days_left_text}}\n续费信息：{{renewal_price}}\n时间：{{time}}",
  traffic_template: "{{emoji}} {{event}}\n服务器：{{client}}\n标签：{{tags}}\n已用流量：{{traffic_used}}\n流量配额：{{traffic_quota}}\n使用率：{{traffic_percent}}\n提醒档位：{{traffic_level}}\n重置日：{{traffic_reset_day}}\n时间：{{time}}",
  events: { offline: true, online: true, resource: true, expire: true, traffic: false },
  nodes: [],
  offline_threshold_sec: DEFAULT_OFFLINE_THRESHOLD_SEC,
  resource_rules: {
    cpu: { threshold_pct: DEFAULT_RESOURCE_THRESHOLD, duration_sec: DEFAULT_RESOURCE_DURATION_SEC },
    memory: { threshold_pct: DEFAULT_RESOURCE_THRESHOLD, duration_sec: DEFAULT_RESOURCE_DURATION_SEC },
    disk: { threshold_pct: DEFAULT_RESOURCE_THRESHOLD, duration_sec: DEFAULT_RESOURCE_DURATION_SEC },
  },
  expire_days: 7,
  traffic_threshold: 80,
};
var LEGACY_TEMPLATE = "{{emoji}} {{event}}\n服务器：{{client}}\n时间：{{time}}";
var LEGACY_TAG_TEMPLATE = "{{emoji}} {{event}}\n服务器：{{client}}\n标签：{{tags}}\n时间：{{time}}";
var LEGACY_RENEW_TEMPLATE = "到期时间：{{expire_time}}\n剩余时间：{{days_left_text}}\n续费信息：{{renewal_price}}\n标签：{{tags}}";
var LEGACY_RENEW_TEMPLATE_FIXED_TITLE = "{{emoji}} 到期提醒\n服务器：{{client}}\n到期时间：{{expire_time}}\n剩余时间：{{days_left_text}}\n续费信息：{{renewal_price}}\n标签：{{tags}}\n时间：{{time}}";
var LEGACY_RENEW_TEMPLATE_TAG_BEFORE_TIME = "{{emoji}} {{event}}\n服务器：{{client}}\n到期时间：{{expire_time}}\n剩余时间：{{days_left_text}}\n续费信息：{{renewal_price}}\n标签：{{tags}}\n时间：{{time}}";
var LEGACY_TRAFFIC_TEMPLATE = "{{emoji}} {{event}}\n服务器：{{client}}\n已用流量：{{traffic_used}}\n流量配额：{{traffic_quota}}\n使用率：{{traffic_percent}}\n重置日：{{traffic_reset_day}}\n标签：{{tags}}\n时间：{{time}}";
var LEGACY_TRAFFIC_TEMPLATE_FIXED_TITLE = "{{emoji}} 流量超额提醒\n服务器：{{client}}\n已用流量：{{traffic_used}}\n流量配额：{{traffic_quota}}\n使用率：{{traffic_percent}}\n重置日：{{traffic_reset_day}}\n标签：{{tags}}\n时间：{{time}}";
var LEGACY_TRAFFIC_TEMPLATE_TAG_BEFORE_TIME = "{{emoji}} {{event}}\n服务器：{{client}}\n已用流量：{{traffic_used}}\n流量配额：{{traffic_quota}}\n使用率：{{traffic_percent}}\n提醒档位：{{traffic_level}}\n重置日：{{traffic_reset_day}}\n标签：{{tags}}\n时间：{{time}}";
var LEGACY_FULL_TEMPLATE_TAG_BEFORE_TIME = "{{emoji}} {{event}}\n服务器：{{clients}}\n节点数量：{{node_count}}\n状态：{{status}}\n上报时间：{{last_seen}}\n持续时间：{{offline_duration}}\n告警延迟：{{offline_delay}}\n标签：{{tags}}\n时间：{{time}}";

var EMOJI = { offline: "🔴", online: "🟢", resource: "", expire: "⏰", traffic: "📊", test: "✅" };
var EVENT_TEXT = { offline: "节点离线", online: "节点恢复在线", resource: "资源规则告警", expire: "节点即将到期", traffic: "流量配额提醒", test: "测试通知" };

// ─── 工具 ───────────────────────────────────────────────────────────

// bot_token 打码:回显只给提示尾巴,绝不吐明文
function maskToken(t) {
  t = String(t || "");
  if (!t) return "";
  return t.length <= 8 ? "****" : t.slice(0, 5) + "…" + t.slice(-4);
}
function maskCfg(cfg) {
  return {
    ...cfg,
    bot_token: "",
    bot_token_set: !!cfg.bot_token,
    bot_token_hint: maskToken(cfg.bot_token),
    webhook_admin_secret: "",
    webhook_admin_secret_set: !!cfg.webhook_admin_secret,
    webhook_admin_secret_hint: maskToken(cfg.webhook_admin_secret),
  };
}
function maskState(st) {
  return {
    ...st,
    telegram_webhook_secret: st.telegram_webhook_secret ? "****" : "",
  };
}
function parseChatIds(raw) {
  return String(raw || "")
    .split(/[,\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((id, idx, arr) => arr.indexOf(id) === idx);
}
function normalizeEventFlags(raw, fallback) {
  raw = raw && typeof raw === "object" ? raw : {};
  fallback = fallback && typeof fallback === "object" ? fallback : DEFAULT_CFG.events;
  return {
    offline: raw.offline != null ? raw.offline !== false : fallback.offline !== false,
    online: raw.online != null ? raw.online !== false : fallback.online !== false,
    resource: raw.resource != null ? raw.resource === true : fallback.resource === true,
    expire: raw.expire != null ? raw.expire !== false : fallback.expire !== false,
    traffic: raw.traffic != null ? raw.traffic === true : fallback.traffic === true,
  };
}
function normalizeTarget(raw, fallbackEvents, fallbackThreadId) {
  raw = raw && typeof raw === "object" ? raw : {};
  const chatId = String(raw.chat_id || raw.chatId || "").trim();
  if (!chatId) return null;
  return {
    name: String(raw.name || "").trim(),
    chat_id: chatId,
    message_thread_id: String(raw.message_thread_id || raw.messageThreadId || fallbackThreadId || "").trim(),
    events: normalizeEventFlags(raw.events, fallbackEvents),
    enabled: raw.enabled !== false,
  };
}
function normalizeTargets(raw, legacyChatId, legacyThreadId, fallbackEvents) {
  const targets = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const target = normalizeTarget(item, fallbackEvents, "");
      if (target) targets.push(target);
    }
  }
  if (!targets.length) {
    for (const chatId of parseChatIds(legacyChatId)) {
      targets.push(normalizeTarget({ chat_id: chatId, message_thread_id: legacyThreadId, events: fallbackEvents }, fallbackEvents, legacyThreadId));
    }
  }
  return targets.filter(Boolean);
}
function enabledTargets(cfg) {
  return (Array.isArray(cfg.targets) ? cfg.targets : []).filter((target) => target && target.enabled !== false && target.chat_id);
}
function targetsForEvent(cfg, type) {
  return enabledTargets(cfg).filter((target) => target.events && target.events[type] === true);
}
function hasTargetsForEvent(cfg, type) {
  return targetsForEvent(cfg, type).length > 0;
}
function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
function makeWebhookSecret() {
  return randomUUID() + "-" + randomUUID();
}
function telegramApiUrl(cfg, method, params) {
  if (!cfg.bot_token) throw new Error("missing bot_token");
  const base = (cfg.endpoint || DEFAULT_CFG.endpoint).replace(/\/$/, "");
  let url = base + cfg.bot_token + "/" + method;
  if (params && typeof params === "object") {
    const q = new URLSearchParams();
    Object.keys(params).forEach((key) => {
      if (params[key] != null) q.append(key, String(params[key]));
    });
    const qs = q.toString();
    if (qs) url += "?" + qs;
  }
  return url;
}
async function telegramRequest(cfg, method, body, params) {
  const r = await fetch(telegramApiUrl(cfg, method, params), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    throw new Error("Telegram HTTP " + r.status + ": " + text.slice(0, 200));
  }
  if (!data || data.ok !== true) {
    throw new Error((data && data.description) || ("Telegram HTTP " + r.status));
  }
  return data;
}
async function rpc(method, params) {
  const r = await nodeget(method, params);
  if (r && r.error) throw new Error(`RPC ${method}: ${JSON.stringify(r.error)}`);
  return r ? r.result : undefined;
}
function nowCST() {
  return new Date(Date.now() + 8 * 3600000).toISOString().replace("T", " ").slice(0, 19);
}
function nowDateCST() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); // YYYY-MM-DD(东八区)
}
function formatCST(ms) {
  ms = Number(ms);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return new Date(ms + 8 * 3600000).toISOString().replace("T", " ").slice(0, 19);
}
function durationText(ms) {
  ms = Number(ms);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return d + " 天 " + h + " 小时";
  if (h > 0) return h + " 小时 " + m + " 分钟";
  if (m > 0) return m + " 分钟 " + s + " 秒";
  return s + " 秒";
}
function secondsText(seconds) {
  seconds = Number(seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  return durationText(seconds * 1000);
}
function pctText(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? trimNumberText(n) + "%" : "";
}
// 解析到期时间:支持 ISO 日期串(如 "2026-06-19")、毫秒、秒 时间戳
function parseExpireMs(raw) {
  if (raw == null || raw === "") return NaN;
  if (typeof raw === "number") return raw > 1e11 ? raw : raw * 1000;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) { const n = Number(s); return n > 1e11 ? n : n * 1000; }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}
// 还剩几天(按东八区零点对齐,与前端展示口径一致;负数=已过期;null=无有效到期时间)
function expireDaysLeft(raw) {
  const exp = parseExpireMs(raw);
  if (!Number.isFinite(exp)) return null;
  const DAY = 86400000, off = 8 * 3600000;
  return Math.floor((exp + off) / DAY) - Math.floor((Date.now() + off) / DAY);
}
function isDateOnly(raw) {
  return typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim());
}
function formatExpireTime(raw) {
  if (isDateOnly(raw)) return raw.trim();
  const exp = parseExpireMs(raw);
  if (!Number.isFinite(exp)) return "";
  return new Date(exp + 8 * 3600000).toISOString().replace("T", " ").slice(0, 19);
}
function scalarText(raw) {
  if (raw == null) return "";
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (typeof raw === "string") return raw.trim();
  return "";
}
function parseOrder(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
function stableNodeKey(n) {
  return String(n.uuid || n.name || "");
}
function normalizeTags(raw) {
  let arr = [];
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (typeof raw === "string") {
    const s = raw.trim();
    if (s) {
      try {
        const parsed = JSON.parse(s);
        arr = Array.isArray(parsed) ? parsed : s.split(/[,\n]+/);
      } catch (e) {
        arr = s.split(/[,\n]+/);
      }
    }
  }
  const out = [];
  for (const item of arr) {
    const tag = String(item || "").trim();
    if (tag && out.indexOf(tag) < 0) out.push(tag);
  }
  return out;
}
function tagsText(raw) {
  return normalizeTags(raw).join(", ");
}
function combineTags(values) {
  const out = [];
  for (const value of values || []) {
    for (const tag of normalizeTags(value)) {
      if (out.indexOf(tag) < 0) out.push(tag);
    }
  }
  return out.join(", ");
}
function daysLeftText(days) {
  if (days == null) return "";
  return days >= 0 ? "剩 " + days + " 天" : "已过期 " + Math.abs(days) + " 天";
}
function expireEventText(days) {
  if (days == null) return EVENT_TEXT.expire;
  if (days < 0) return "节点已过期";
  if (days === 0) return "节点今日到期";
  return "节点即将到期";
}
function expireStatusText(days) {
  if (days == null) return "";
  if (days < 0) return "已过期";
  if (days === 0) return "今日到期";
  return "即将到期";
}
function renewalPriceText(price, unit, cycle) {
  price = scalarText(price);
  unit = scalarText(unit);
  cycle = scalarText(cycle);
  const prefixUnits = "$€£¥₽₣₹₫฿";
  const amount = price ? (unit ? (prefixUnits.indexOf(unit) >= 0 ? unit + price : price + " " + unit) : price) : "";
  if (amount && cycle) return amount + " / " + cycle + " 天";
  if (amount) return amount;
  if (cycle) return cycle + " 天/周期";
  return "";
}
function trimNumberText(n) {
  if (!Number.isFinite(n)) return "";
  return String(Math.round(n * 100) / 100);
}
function trafficGbText(raw) {
  if (raw == null || raw === "") return "";
  const n = Number(raw);
  return Number.isFinite(n) ? trimNumberText(n) + " GB" : "";
}
function trafficPercentText(raw, fallbackLevel) {
  const value = raw == null || raw === "" ? fallbackLevel : raw;
  if (value == null || value === "") return "";
  const n = Number(value);
  return Number.isFinite(n) ? trimNumberText(n) + "%" : "";
}
function trafficEventText(percent, fallbackLevel) {
  const value = percent == null || percent === "" ? fallbackLevel : percent;
  const n = Number(value);
  if (!Number.isFinite(n)) return EVENT_TEXT.traffic;
  if (n > 100) return "流量已超配额";
  if (n === 100) return "流量已达配额";
  if (n >= 90) return "流量接近配额";
  return "流量配额提醒";
}
function trafficStatusText(percent, fallbackLevel) {
  const value = percent == null || percent === "" ? fallbackLevel : percent;
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  if (n > 100) return "已超配额";
  if (n === 100) return "已达配额";
  if (n >= 90) return "接近配额";
  return "提醒阈值";
}
function trafficBillingDayText(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= 31 ? "每月 " + Math.trunc(n) + " 日" : "";
}

// ─── 配置 / 状态 ────────────────────────────────────────────────────

function normalizeOfflineThresholdSec(raw) {
  let n = Number(raw && raw.offline_threshold_sec);
  if (!(n >= 1 && n <= 604800)) {
    const legacyDelay = Number(raw && raw.offline_delay);
    n = legacyDelay >= 0 && legacyDelay <= 1440
      ? Math.max(1, Math.trunc(legacyDelay * 60))
      : DEFAULT_OFFLINE_THRESHOLD_SEC;
  }
  return Math.trunc(n);
}
function normalizeResourceRule(raw, fallback) {
  raw = raw && typeof raw === "object" ? raw : {};
  fallback = fallback && typeof fallback === "object" ? fallback : {};
  let threshold = Number(raw.threshold_pct != null ? raw.threshold_pct : fallback.threshold_pct);
  if (!(threshold >= 1 && threshold <= 100)) threshold = DEFAULT_RESOURCE_THRESHOLD;
  let duration = Number(raw.duration_sec != null ? raw.duration_sec : fallback.duration_sec);
  if (!(duration >= 0 && duration <= 604800)) duration = DEFAULT_RESOURCE_DURATION_SEC;
  return {
    threshold_pct: Math.trunc(threshold),
    duration_sec: Math.trunc(duration),
  };
}
function normalizeResourceRules(raw) {
  raw = raw && typeof raw === "object" ? raw : {};
  return {
    cpu: normalizeResourceRule(raw.cpu, DEFAULT_CFG.resource_rules.cpu),
    memory: normalizeResourceRule(raw.memory, DEFAULT_CFG.resource_rules.memory),
    disk: normalizeResourceRule(raw.disk, DEFAULT_CFG.resource_rules.disk),
  };
}
function normalizeNodeResourceFlags(raw) {
  raw = raw && typeof raw === "object" ? raw : {};
  return {
    cpu: { enabled: raw.cpu && raw.cpu.enabled === true },
    memory: { enabled: raw.memory && raw.memory.enabled === true },
    disk: { enabled: raw.disk && raw.disk.enabled === true },
  };
}
function normalizeMonitorNode(raw) {
  raw = raw && typeof raw === "object" ? raw : {};
  const uuid = String(raw.uuid || "").trim();
  if (!uuid) return null;
  return {
    uuid,
    name: String(raw.name || "").trim(),
    rules: normalizeNodeResourceFlags(raw.rules),
  };
}
function normalizeMonitorNodes(raw) {
  const out = [];
  const seen = {};
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const node = normalizeMonitorNode(item);
      if (!node || seen[node.uuid]) continue;
      seen[node.uuid] = true;
      out.push(node);
    }
  }
  return out;
}
function normalizeCfg(raw) {
  raw = raw && typeof raw === "object" ? raw : {};
  const ev = normalizeEventFlags(raw.events, DEFAULT_CFG.events);
  let ed = Number(raw.expire_days);
  if (!(ed >= 1 && ed <= 90)) ed = 7;
  let tt = Number(raw.traffic_threshold);
  if (!(tt >= 1 && tt <= 200)) tt = DEFAULT_CFG.traffic_threshold;
  const targets = normalizeTargets(raw.targets, raw.chat_id, raw.message_thread_id, ev);
  const template = String(raw.template || DEFAULT_CFG.template);
  const resourceTemplate = String(raw.resource_template || DEFAULT_CFG.resource_template);
  const renewTemplate = String(raw.renew_template || DEFAULT_CFG.renew_template);
  const trafficTemplate = String(raw.traffic_template || DEFAULT_CFG.traffic_template);
  return {
    enabled: raw.enabled === true,
    channel: "telegram",
    bot_token: String(raw.bot_token || ""),
    chat_id: targets.map((target) => target.chat_id).join("\n"),
    message_thread_id: targets.length === 1 ? targets[0].message_thread_id : "",
    targets,
    webhook_admin_secret: String(raw.webhook_admin_secret || ""),
    endpoint: String(raw.endpoint || DEFAULT_CFG.endpoint),
    template: (template === LEGACY_TEMPLATE || template === LEGACY_TAG_TEMPLATE || template === LEGACY_FULL_TEMPLATE_TAG_BEFORE_TIME) ? DEFAULT_CFG.template : template,
    resource_template: resourceTemplate,
    renew_template: (renewTemplate === LEGACY_RENEW_TEMPLATE || renewTemplate === LEGACY_RENEW_TEMPLATE_FIXED_TITLE || renewTemplate === LEGACY_RENEW_TEMPLATE_TAG_BEFORE_TIME) ? DEFAULT_CFG.renew_template : renewTemplate,
    traffic_template: (trafficTemplate === LEGACY_TRAFFIC_TEMPLATE || trafficTemplate === LEGACY_TRAFFIC_TEMPLATE_FIXED_TITLE || trafficTemplate === LEGACY_TRAFFIC_TEMPLATE_TAG_BEFORE_TIME) ? DEFAULT_CFG.traffic_template : trafficTemplate,
    events: ev,
    nodes: normalizeMonitorNodes(raw.nodes),
    offline_threshold_sec: normalizeOfflineThresholdSec(raw),
    resource_rules: normalizeResourceRules(raw.resource_rules),
    expire_days: Math.trunc(ed),
    traffic_threshold: Math.trunc(tt),
  };
}
async function getCfg(token) {
  const v = await rpc("kv_get_value", { token, namespace: NS, key: CFG_KEY });
  return normalizeCfg(v);
}
async function setCfg(token, cfg) {
  await rpc("kv_set_value", { token, namespace: NS, key: CFG_KEY, value: cfg });
}
async function getState(token) {
  const v = await rpc("kv_get_value", { token, namespace: NS, key: STATE_KEY });
  return {
    offline: Array.isArray(v && v.offline) ? v.offline : [],
    offline_since: (v && v.offline_since && typeof v.offline_since === "object" && !Array.isArray(v.offline_since)) ? v.offline_since : {}, // uuid→离线前最后上报时间(ms),用于恢复时计算持续时间
    seen: (v && v.seen && typeof v.seen === "object" && !Array.isArray(v.seen)) ? v.seen : {}, // uuid→首次见到有效上报时的时间戳;用于避免新节点直接报离线
    waiting_first_report: (v && v.waiting_first_report && typeof v.waiting_first_report === "object" && !Array.isArray(v.waiting_first_report)) ? v.waiting_first_report : {}, // uuid→开始等待首次上报时间(ms)
    resource: (v && v.resource && typeof v.resource === "object" && !Array.isArray(v.resource)) ? v.resource : {}, // "uuid:type"→资源规则状态
    expired: Array.isArray(v && v.expired) ? v.expired : [],
    expire_dates: (v && v.expire_dates && typeof v.expire_dates === "object") ? v.expire_dates : {}, // uuid→上次提醒日期(CST),用于每天提醒
    traffic: (v && v.traffic && typeof v.traffic === "object" && !Array.isArray(v.traffic)) ? v.traffic : {}, // uuid→已报最高档位(%),阶梯报警
    traffic_threshold: (v && Number(v.traffic_threshold)) || 0, // 上次运行使用的流量提醒起始阈值,变更后清阶梯状态
    telegram_webhook_secret: String((v && v.telegram_webhook_secret) || ""), // Telegram webhook secret_token,用于校验来源
    telegram_webhook_url: String((v && v.telegram_webhook_url) || ""),       // 当前注册的 webhook URL,便于排查
    last_run: (v && Number(v.last_run)) || 0,   // 上次 onCron/检测时间(ms),0=从未运行
    last_sent: (v && Number(v.last_sent)) || 0, // 上次发出条数
    last_note: (v && v.last_note) || "",        // 上次跳过原因(未开启/未配置…)
  };
}
async function setState(token, st) {
  await rpc("kv_set_value", { token, namespace: NS, key: STATE_KEY, value: st });
}

// ─── Telegram 发送 + 模板 ───────────────────────────────────────────

function render(tpl, ctx) {
  return String(tpl)
    .split(/\r?\n/)
    .filter((line) => {
      if (line.indexOf("{{tags}}") < 0) return true;
      return ctx.tags != null && String(ctx.tags).trim() !== "";
    })
    .map((line) => line.replace(/\{\{(\w+)\}\}/g, function (_, k) {
      return ctx[k] != null ? String(ctx[k]) : "";
    }))
    .join("\n");
}
function templateUses(tpl, names) {
  tpl = String(tpl || "");
  return (names || []).some((name) => tpl.indexOf("{{" + name + "}}") >= 0);
}
function templateForEvent(cfg, type) {
  if (type === "expire") return String(cfg.renew_template || DEFAULT_CFG.renew_template);
  if (type === "traffic") return String(cfg.traffic_template || DEFAULT_CFG.traffic_template);
  if (type === "resource") return String(cfg.resource_template || DEFAULT_CFG.resource_template);
  return String(cfg.template || DEFAULT_CFG.template);
}
async function sendTelegram(cfg, text) {
  const targets = enabledTargets(cfg);
  if (!cfg.bot_token || !targets.length) return { ok: false, error: "missing bot_token / target" };
  return await sendTelegramToTargets(cfg, targets, text);
}
async function sendTelegramForEvent(cfg, type, text) {
  const targets = targetsForEvent(cfg, type);
  if (!cfg.bot_token || !targets.length) return { ok: false, error: "missing bot_token / target" };
  return await sendTelegramToTargets(cfg, targets, text);
}
async function sendTelegramToTargets(cfg, targets, text, options) {
  const errors = [];
  let sent = 0;
  for (const target of targets) {
    const body = { chat_id: target.chat_id, text };
    const threadId = options && Object.prototype.hasOwnProperty.call(options, "message_thread_id")
      ? options.message_thread_id
      : target.message_thread_id;
    if (threadId) body.message_thread_id = threadId;
    try {
      await telegramRequest(cfg, "sendMessage", body);
      sent += 1;
    } catch (e) {
      const label = target.name ? target.name + "(" + target.chat_id + ")" : target.chat_id;
      errors.push(label + ": " + String(e && e.message ? e.message : e));
    }
  }
  return errors.length ? { ok: false, sent, error: errors.join("; ") } : { ok: true, sent };
}
async function sendTelegramToChat(cfg, chatId, text, options) {
  return await sendTelegramToTargets(cfg, [{ chat_id: String(chatId), message_thread_id: "" }], text, options);
}
function notifyWithContext(cfg, type, client, extra, extraCtx) {
  const ctx = {
    emoji: EMOJI[type] || "",
    event: (EVENT_TEXT[type] || type) + (extra ? " " + extra : ""),
    client: client || "",
    clients: client || "",
    time: nowCST(),
    type,
    status: "",
    node_count: "",
    last_seen: "",
    last_seen_list: "",
    offline_duration: "",
    offline_duration_list: "",
    offline_threshold: "",
    offline_delay: "",
    recovery_time: "",
    resource_type: "",
    resource_value: "",
    resource_threshold: "",
    resource_duration: "",
    resource_since: "",
    tags: "",
    tag_count: "",
    expire_time: "",
    days_left: "",
    days_left_text: "",
    price: "",
    price_unit: "",
    price_cycle: "",
    renewal_price: "",
    renewal: "",
    traffic_used: "",
    traffic_quota: "",
    traffic_percent: "",
    traffic_level: "",
    traffic_reset_day: "",
    traffic_billing_day: "",
    traffic_used_gb: "",
    traffic_quota_gb: "",
    traffic_remaining: "",
    traffic_remaining_gb: "",
    ...(extraCtx || {}),
  };
  const text = render(templateForEvent(cfg, type), ctx).replace(/\n{3,}/g, "\n\n").trim();
  return sendTelegramForEvent(cfg, type, text);
}
// 聚合:同一轮多台离线/恢复合并成一条消息(单台时与原来一致)
function groupClient(names) {
  const n = names.length;
  return n <= 6 ? names.join("、") : names.slice(0, 6).join("、") + " 等 " + n + " 台";
}
function notifyGroup(cfg, type, names, extraCtx) {
  const n = names.length;
  return notifyWithContext(cfg, type, groupClient(names), n > 1 ? "（共 " + n + " 台）" : "", extraCtx || {});
}

// ─── Telegram /chatid 指令 ─────────────────────────────────────────

function chatTitle(chat) {
  if (!chat) return "";
  return chat.title || chat.username || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || "";
}
function commandMessage(update) {
  if (!update) return null;
  return update.message || update.channel_post || update.edited_message || update.edited_channel_post || null;
}
function isChatIdCommand(msg) {
  const text = String((msg && msg.text) || "").trim().toLowerCase();
  return text === "/chatid" || text === "/chat_id" || text.startsWith("/chatid@") || text.startsWith("/chat_id@");
}
function chatInfoText(chat) {
  const title = chatTitle(chat) || "未命名会话";
  const type = chat && chat.type ? chat.type : "unknown";
  const username = chat && chat.username ? "\nusername: @" + chat.username : "";
  return "chat_id: " + String(chat && chat.id) + "\n类型: " + type + "\n名称: " + title + username;
}
async function handleChatIdUpdate(cfg, update) {
  const msg = commandMessage(update);
  if (!isChatIdCommand(msg) || !msg.chat || msg.chat.id == null) {
    return { ok: true, handled: false };
  }
  const options = {};
  if (msg.message_thread_id != null) options.message_thread_id = msg.message_thread_id;
  const r = await sendTelegramToChat(cfg, msg.chat.id, chatInfoText(msg.chat), options);
  return r.ok ? { ok: true, handled: true } : { ok: false, handled: true, error: r.error };
}

// ─── agent 数据 ─────────────────────────────────────────────────────

async function listUuids(token) {
  const u = await rpc("agent-uuid_list_all", { token });
  return Array.isArray(u) ? u : [];
}
function emptyMetadataMaps(keys) {
  const maps = {};
  for (const key of keys || []) maps[key] = new Map();
  return maps;
}
async function getMetadataMaps(token, uuids, keys, optional) {
  keys = (keys || []).filter(Boolean);
  if (!uuids.length || !keys.length) return emptyMetadataMaps(keys);
  const namespaceKey = [];
  for (const u of uuids) {
    for (const key of keys) namespaceKey.push({ namespace: u, key });
  }
  try {
    const rows = await rpc("kv_get_multi_value", { token, namespace_key: namespaceKey });
    const maps = emptyMetadataMaps(keys);
    for (const r of rows || []) {
      if (!maps[r.key]) maps[r.key] = new Map();
      maps[r.key].set(r.namespace, r.value);
    }
    return maps;
  } catch (e) {
    if (optional) {
      const maps = emptyMetadataMaps(keys);
      for (const key of keys) {
        try {
          const partial = await getMetadataMaps(token, uuids, [key], false);
          maps[key] = partial[key] || new Map();
        } catch (inner) {
          maps[key] = new Map();
        }
      }
      return maps;
    }
    throw e;
  }
}
async function getTimestamps(token, uuids) {
  if (!uuids.length) return new Map();
  const rows = await rpc("agent_dynamic_summary_multi_last_query", { token, uuids, fields: ["cpu_usage"] });
  const m = new Map();
  for (const r of rows || []) m.set(r.uuid, r.timestamp || 0);
  return m;
}
async function getDynamicSummary(token, uuids) {
  if (!uuids.length) return [];
  const rows = await rpc("agent_dynamic_summary_multi_last_query", { token, uuids, fields: SUMMARY_FIELDS });
  return Array.isArray(rows) ? rows : [];
}
function rowTimestamp(row) {
  const ts = Number(row && row.timestamp);
  return Number.isFinite(ts) && ts > 0 ? ts : 0;
}
function percent(used, total) {
  used = Number(used);
  total = Number(total);
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return (used / total) * 100;
}
function resourceValue(row, type) {
  if (!row) return null;
  if (type === "cpu") {
    const v = Number(row.cpu_usage);
    return Number.isFinite(v) ? v : null;
  }
  if (type === "memory") return percent(row.used_memory, row.total_memory);
  if (type === "disk") {
    const total = Number(row.total_space);
    const available = Number(row.available_space);
    if (!Number.isFinite(total) || !Number.isFinite(available) || total <= 0) return null;
    return ((total - available) / total) * 100;
  }
  return null;
}
function nodeConfigMap(cfg) {
  const m = new Map();
  for (const node of cfg.nodes || []) m.set(node.uuid, node);
  return m;
}
function monitoredUuids(cfg, activeUuids) {
  return activeUuids.slice();
}
function cleanObjectByUuids(obj, allowedSet) {
  const next = {};
  let changed = false;
  obj = obj && typeof obj === "object" ? obj : {};
  for (const key in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    if (allowedSet.has(key)) next[key] = obj[key];
    else changed = true;
  }
  return { value: next, changed };
}
function cleanResourceStates(obj, allowedSet) {
  const next = {};
  let changed = false;
  obj = obj && typeof obj === "object" ? obj : {};
  for (const key in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const uuid = key.split(":")[0];
    if (allowedSet.has(uuid)) next[key] = obj[key];
    else changed = true;
  }
  return { value: next, changed };
}
function resourceRuleFor(cfg, nodeMap, uuid, type) {
  const globalRule = cfg.resource_rules && cfg.resource_rules[type] ? cfg.resource_rules[type] : DEFAULT_CFG.resource_rules[type];
  const node = nodeMap.get(uuid);
  const nodeRule = node && node.rules && node.rules[type] ? node.rules[type] : {};
  return {
    enabled: nodeRule.enabled === true,
    threshold_pct: globalRule.threshold_pct,
    duration_sec: globalRule.duration_sec,
  };
}
async function listAvailableNodes(token) {
  const uuids = await listUuids(token);
  const meta = await getMetadataMaps(token, uuids, [NAME_KEY, ORDER_KEY], true);
  const nameMap = meta[NAME_KEY] || new Map();
  const orderMap = meta[ORDER_KEY] || new Map();
  const nodes = uuids.map((uuid) => {
    const name = nameMap.get(uuid);
    return {
      uuid,
      name: typeof name === "string" && name ? name : uuid.slice(0, 8),
      order: parseOrder(orderMap.get(uuid)),
    };
  });
  nodes.sort((a, b) => {
    const ao = a.order, bo = b.order;
    if (ao != null && bo != null && ao !== bo) return ao - bo;
    if (ao != null && bo == null) return -1;
    if (ao == null && bo != null) return 1;
    const ak = stableNodeKey(a), bk = stableNodeKey(b);
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
  return nodes;
}

// ─── 核心:检测事件并推送 ───────────────────────────────────────────

async function runCheck(token, ctx) {
  const cfg = await getCfg(token);
  let st = await getState(token);
  const now = Date.now();
  const sent = [];
  let dirty = false;

  async function finish(result, forceNote) {
    const note = forceNote || "";
    if (dirty || note !== st.last_note) {
      st.last_run = now;
      st.last_sent = sent.length;
      st.last_note = note;
      await setState(token, st);
    }
    return result;
  }

  if (!cfg.enabled) return await finish({ ok: true, skipped: "通知未开启" }, "通知未开启");
  if (!cfg.bot_token || !enabledTargets(cfg).length) return await finish({ ok: true, skipped: "未配置 bot_token / 通知目标" }, "未配置 bot_token / 通知目标");

  const activeUuids = await listUuids(token);
  if (!activeUuids.length) return await finish({ ok: true, sent: 0, note: "无节点" }, "无节点");
  const uuids = monitoredUuids(cfg, activeUuids);
  const monitoredSet = new Set(uuids);

  const cleanSeen = cleanObjectByUuids(st.seen, monitoredSet);
  const cleanWaiting = cleanObjectByUuids(st.waiting_first_report, monitoredSet);
  const cleanOfflineSince = cleanObjectByUuids(st.offline_since, monitoredSet);
  const cleanResource = cleanResourceStates(st.resource, monitoredSet);
  const cleanExpire = cleanObjectByUuids(st.expire_dates, monitoredSet);
  const cleanTraffic = cleanObjectByUuids(st.traffic, monitoredSet);
  st.seen = cleanSeen.value;
  st.waiting_first_report = cleanWaiting.value;
  st.offline_since = cleanOfflineSince.value;
  st.resource = cleanResource.value;
  st.expire_dates = cleanExpire.value;
  st.traffic = cleanTraffic.value;
  const filteredOffline = (st.offline || []).filter((u) => monitoredSet.has(u));
  if (filteredOffline.length !== (st.offline || []).length) dirty = true;
  st.offline = filteredOffline;
  if (cleanSeen.changed || cleanWaiting.changed || cleanOfflineSince.changed || cleanResource.changed || cleanExpire.changed || cleanTraffic.changed) dirty = true;

  if (!uuids.length) return await finish({ ok: true, sent: 0, note: "无监控节点" }, "无监控节点");

  const needsExpire = hasTargetsForEvent(cfg, "expire");
  const needsTraffic = hasTargetsForEvent(cfg, "traffic");
  const needsResource = hasTargetsForEvent(cfg, "resource");
  const requiredKeys = needsExpire ? [NAME_KEY, EXPIRE_KEY] : [NAME_KEY];
  const optionalKeys = [];
  const templateText = String(cfg.template || "")
    + (needsResource ? "\n" + String(cfg.resource_template || "") : "")
    + (needsExpire ? "\n" + String(cfg.renew_template || "") : "")
    + (needsTraffic ? "\n" + String(cfg.traffic_template || "") : "");
  if (templateUses(templateText, ["tags", "tag_count"])) optionalKeys.push(TAGS_KEY);
  if (needsExpire && templateUses(cfg.renew_template, ["price", "price_unit", "price_cycle", "renewal_price"])) {
    optionalKeys.push(PRICE_KEY, PRICE_UNIT_KEY, PRICE_CYCLE_KEY);
  }
  const [summaryRows, requiredMeta, optionalMeta] = await Promise.all([
    getDynamicSummary(token, uuids),
    getMetadataMaps(token, uuids, requiredKeys, false),
    getMetadataMaps(token, uuids, optionalKeys, true),
  ]);
  const rowMap = new Map();
  for (const row of summaryRows) rowMap.set(row.uuid, row);
  const tsMap = new Map();
  for (const row of summaryRows) tsMap.set(row.uuid, rowTimestamp(row));
  const nameMap = requiredMeta[NAME_KEY] || new Map();
  const expireMap = requiredMeta[EXPIRE_KEY] || new Map();
  const tagsMap = optionalMeta[TAGS_KEY] || new Map();
  const priceMap = optionalMeta[PRICE_KEY] || new Map();
  const priceUnitMap = optionalMeta[PRICE_UNIT_KEY] || new Map();
  const priceCycleMap = optionalMeta[PRICE_CYCLE_KEY] || new Map();
  const nameOf = (u) => {
    const n = nameMap.get(u);
    return (typeof n === "string" && n) ? n : u.slice(0, 8);
  };
  const tagsOf = (u) => tagsText(tagsMap.get(u));
  const groupCtxOf = (nodes) => {
    const tags = combineTags(nodes.map((u) => tagsMap.get(u)));
    return { tags, tag_count: tags ? String(tags.split(", ").filter(Boolean).length) : "" };
  };
  const expireCtxOf = (u, days) => {
    const tags = tagsOf(u);
    const price = scalarText(priceMap.get(u));
    const priceUnit = scalarText(priceUnitMap.get(u));
    const priceCycle = scalarText(priceCycleMap.get(u));
    const ctx = {
      event: expireEventText(days),
      status: expireStatusText(days),
      tags,
      tag_count: tags ? String(tags.split(", ").filter(Boolean).length) : "",
      expire_time: formatExpireTime(expireMap.get(u)),
      days_left: days == null ? "" : String(days),
      days_left_text: daysLeftText(days),
      price,
      price_unit: priceUnit,
      price_cycle: priceCycle,
      renewal_price: renewalPriceText(price, priceUnit, priceCycle),
    };
    return ctx;
  };
  const nodeCtxOf = (u) => {
    const tags = tagsOf(u);
    return { tags, tag_count: tags ? String(tags.split(", ").filter(Boolean).length) : "" };
  };
  const offlineEventCtxOf = (type, nodes, offlineSinceMap) => {
    const names = nodes.map(nameOf);
    const lines = [];
    const durationLines = [];
    let firstSeen = 0;
    let maxDuration = 0;
    for (const u of nodes) {
      const seen = type === "online"
        ? Number(offlineSinceMap && offlineSinceMap[u])
        : (Number(tsMap.get(u) || 0) || Number(st.seen[u]) || 0);
      if (seen > 0) {
        if (!firstSeen || seen < firstSeen) firstSeen = seen;
        lines.push(nameOf(u) + ": " + formatCST(seen));
        const dur = now - seen;
        if (dur > maxDuration) maxDuration = dur;
        durationLines.push(nameOf(u) + ": " + durationText(dur));
      }
    }
    const tags = combineTags(nodes.map((u) => tagsMap.get(u)));
    return {
      client: groupClient(names),
      clients: names.join("、"),
      node_count: String(nodes.length),
      status: type === "online" ? "已恢复在线" : "离线",
      last_seen: nodes.length === 1 ? (lines[0] || "") : (firstSeen ? formatCST(firstSeen) : ""),
      last_seen_list: lines.join("\n"),
      offline_duration: maxDuration ? durationText(maxDuration) : "",
      offline_duration_list: durationLines.join("\n"),
      offline_threshold: secondsText(cfg.offline_threshold_sec),
      offline_delay: secondsText(cfg.offline_threshold_sec),
      recovery_time: type === "online" ? nowCST() : "",
      tags,
      tag_count: tags ? String(tags.split(", ").filter(Boolean).length) : "",
    };
  };
  const resourceCtxOf = (u, type, value, rule, state, recovered) => {
    const base = nodeCtxOf(u);
    return {
      ...base,
      event: recovered ? "资源规则恢复" : "资源规则告警",
      status: recovered ? "已恢复" : "告警中",
      resource_type: RESOURCE_LABELS[type] || type,
      resource_value: pctText(value),
      resource_threshold: pctText(rule.threshold_pct),
      resource_duration: secondsText(rule.duration_sec),
      resource_since: state && state.first_seen ? formatCST(state.first_seen) : "",
      recovery_time: recovered ? nowCST() : "",
    };
  };
  const trafficCtxOf = (a) => {
    const base = nodeCtxOf(a.uuid);
    const level = a.level != null ? a.level : 80;
    const usedGb = scalarText(a.used_gb);
    const quotaGb = scalarText(a.quota_gb);
    const remainingGb = scalarText(a.remaining_gb);
    return {
      ...base,
      event: trafficEventText(a.percent, level),
      status: trafficStatusText(a.percent, level),
      traffic_used: trafficGbText(a.used_gb),
      traffic_quota: trafficGbText(a.quota_gb),
      traffic_percent: trafficPercentText(a.percent, level),
      traffic_level: trafficPercentText(level, ""),
      traffic_reset_day: scalarText(a.reset_day) || trafficBillingDayText(a.billing_day),
      traffic_billing_day: trafficBillingDayText(a.billing_day),
      traffic_used_gb: usedGb,
      traffic_quota_gb: quotaGb,
      traffic_remaining: trafficGbText(a.remaining_gb),
      traffic_remaining_gb: remainingGb,
    };
  };

  for (const u of uuids) {
    const ts = Number(tsMap.get(u) || 0);
    const oldSeen = Number(st.seen[u]) || 0;
    if (ts > 0) {
      if (!oldSeen) { st.seen[u] = ts; dirty = true; }
      if (st.waiting_first_report[u]) { delete st.waiting_first_report[u]; dirty = true; }
    } else if (!oldSeen && !st.waiting_first_report[u]) {
      st.waiting_first_report[u] = now;
      dirty = true;
    }
  }
  const nodeMapForRules = nodeConfigMap(cfg);
  const allowedResourceKeys = new Set();
  if (needsResource) {
    for (const u of uuids) {
      for (const type of RESOURCE_TYPES) {
        if (resourceRuleFor(cfg, nodeMapForRules, u, type).enabled) allowedResourceKeys.add(u + ":" + type);
      }
    }
  }
  for (const key in st.resource) {
    if (!Object.prototype.hasOwnProperty.call(st.resource, key)) continue;
    if (!needsResource || !allowedResourceKeys.has(key)) {
      delete st.resource[key];
      dirty = true;
    }
  }

  // 1) 离线/上线 —— 同一轮多台合并成一条;仅在通知成功时才并入状态,失败者整批下轮重试
  //    st.offline 语义:已就「离线」成功通知过、且仍被视作离线的节点集合
  //    新节点未见过有效上报时只进入 waiting_first_report,不直接报离线。
  const prevOffline = new Set(st.offline);
  const prevOfflineSince = (st.offline_since && typeof st.offline_since === "object") ? st.offline_since : {};
  const offlineMs = Math.max(1000, Number(cfg.offline_threshold_sec || DEFAULT_OFFLINE_THRESHOLD_SEC) * 1000);
  const nowOffline = uuids.filter((u) => {
    const lastSeen = Number(tsMap.get(u) || 0) || Number(st.seen[u]) || 0;
    return lastSeen > 0 && now - lastSeen > offlineMs;
  });
  const nowOfflineSet = new Set(nowOffline);
  const sendOffline = hasTargetsForEvent(cfg, "offline");
  const sendOnline = hasTargetsForEvent(cfg, "online");
  const trackOff = sendOffline || sendOnline;
  if (trackOff) {
    const nextOffline = [];
    const nextOfflineSince = {};
    const offlineNew = []; // 本轮新离线、已过宽限期、需要通知的
    for (const u of nowOffline) {
      if (prevOffline.has(u)) {
        nextOffline.push(u);
        nextOfflineSince[u] = Number(prevOfflineSince[u]) || Number(tsMap.get(u) || 0) || Number(st.seen[u]) || now;
        continue;
      }                                                            // 之前已通知,保留
      if (sendOffline) offlineNew.push(u);
      else {
        nextOffline.push(u);                                       // 离线通知没开,但记录状态供「恢复」判定
        nextOfflineSince[u] = Number(tsMap.get(u) || 0) || Number(st.seen[u]) || now;
        dirty = true;
      }
    }
    if (offlineNew.length) {
      const r = await notifyGroup(cfg, "offline", offlineNew.map(nameOf), offlineEventCtxOf("offline", offlineNew, prevOfflineSince));
      if (r.ok) {
        offlineNew.forEach((u) => {
          nextOffline.push(u);
          nextOfflineSince[u] = Number(tsMap.get(u) || 0) || Number(st.seen[u]) || now;
        });
        sent.push("offline×" + offlineNew.length);
        dirty = true;
      }
      // 失败:整批不记,下轮仍是「新离线」会重发
    }
    // 恢复在线:之前离线、现在在线、且仍在节点列表 → 合并成一条
    const recovered = [];
    for (const u of prevOffline) {
      if (nowOfflineSet.has(u)) continue;        // 还离线,上面已处理
      if (uuids.indexOf(u) < 0) continue;        // 节点已删除,丢弃
      if (sendOnline) recovered.push(u);
      // online 没开:正常移除(不 push)
    }
    if (recovered.length) {
      const r = await notifyGroup(cfg, "online", recovered.map(nameOf), offlineEventCtxOf("online", recovered, prevOfflineSince));
      if (r.ok) { sent.push("online×" + recovered.length); dirty = true; }       // 成功→正常移除
      else {
        recovered.forEach((u) => {
          nextOffline.push(u);
          nextOfflineSince[u] = Number(prevOfflineSince[u]) || now;
        });
      }                                                            // 失败→保留离线态,下轮重发恢复
    }
    const nextOfflineSig = nextOffline.slice().sort().join(",");
    const prevOfflineSig = st.offline.slice().sort().join(",");
    if (nextOfflineSig !== prevOfflineSig || JSON.stringify(nextOfflineSince) !== JSON.stringify(st.offline_since || {})) dirty = true;
    st.offline = nextOffline;
    st.offline_since = nextOfflineSince;
  } else if ((st.offline && st.offline.length) || Object.keys(st.offline_since || {}).length) {
    st.offline = [];
    st.offline_since = {};
    dirty = true;
  }

  // 2) 资源告警 —— 仅使用本轮动态摘要;连续超过阈值达到持续时间后触发,恢复后只发一次恢复。
  if (needsResource) {
    for (const u of uuids) {
      const row = rowMap.get(u);
      const lastSeen = Number(tsMap.get(u) || 0) || Number(st.seen[u]) || 0;
      if (!row || !lastSeen || now - lastSeen > offlineMs) continue;
      for (const type of RESOURCE_TYPES) {
        const rule = resourceRuleFor(cfg, nodeMapForRules, u, type);
        const key = u + ":" + type;
        if (!rule.enabled) continue;
        const value = resourceValue(row, type);
        if (value == null) continue;
        const old = st.resource[key] && typeof st.resource[key] === "object" ? st.resource[key] : null;
        if (value >= rule.threshold_pct) {
          const firstSeen = old && (old.status === "pending" || old.status === "firing") ? Number(old.first_seen) || now : now;
          const ready = now - firstSeen >= Math.max(0, Number(rule.duration_sec) || 0) * 1000;
          if (!ready) {
            if (!old || old.status !== "pending") {
              st.resource[key] = { status: "pending", first_seen: firstSeen, last_seen: now, last_value: value, threshold: rule.threshold_pct };
              dirty = true;
            }
            continue;
          }
          if (old && old.status === "firing") continue;
          const nextState = { status: "firing", first_seen: firstSeen, last_seen: now, last_value: value, threshold: rule.threshold_pct };
          const r = await notifyWithContext(cfg, "resource", nameOf(u), "", resourceCtxOf(u, type, value, rule, nextState, false));
          if (r.ok) {
            st.resource[key] = nextState;
            sent.push("resource:" + nameOf(u) + ":" + type);
            dirty = true;
          }
          continue;
        }
        if (old && old.status === "firing") {
          const r = await notifyWithContext(cfg, "resource", nameOf(u), "", resourceCtxOf(u, type, value, rule, old, true));
          if (r.ok) {
            delete st.resource[key];
            sent.push("resource-ok:" + nameOf(u) + ":" + type);
            dirty = true;
          }
        } else if (old) {
          delete st.resource[key];
          dirty = true;
        }
      }
    }
  }

  // 3) 到期提醒(每天提醒一次:同一东八区日期内只发一次,跨天重发;续费出窗后清除;发送失败当天重试)
  if (hasTargetsForEvent(cfg, "expire")) {
    const prevDates = st.expire_dates || {};
    const today = nowDateCST();
    const nextDates = {};
    for (const u of uuids) {
      const days = expireDaysLeft(expireMap.get(u));
      if (days == null) continue;
      if (days > cfg.expire_days) continue;                       // 不在窗口→不保留(含续费,出窗后再进窗可重发)
      if (prevDates[u] === today) { nextDates[u] = today; continue; } // 今天已发,跳过
      const r = await notifyWithContext(cfg, "expire", nameOf(u), "", expireCtxOf(u, days));
      if (r.ok) { nextDates[u] = today; sent.push("expire:" + nameOf(u)); dirty = true; } // 成功→记今天
      // 失败:不记今天,同一天下轮会重试
    }
    if (JSON.stringify(nextDates) !== JSON.stringify(st.expire_dates || {})) dirty = true;
    st.expire_dates = nextDates;
    st.expired = Object.keys(nextDates); // 兼容旧字段
  }

  // 4) 流量配额提醒(读 traffic-billing-worker;从配置阈值起每升 5% 档位报一次;失败下轮重试)
  if (hasTargetsForEvent(cfg, "traffic") && ctx && ctx.inlineCall) {
    try {
      const prevLevels = Number(st.traffic_threshold) === Number(cfg.traffic_threshold) ? (st.traffic || {}) : {};
      const sum = await ctx.inlineCall(TRAFFIC_WORKER, { action: "get_summary", alert_threshold: cfg.traffic_threshold }, 20);
      const alerting = (sum && sum.alerting) || [];
      const nextLevels = {};
      for (const a of alerting) {
        if (!a || !monitoredSet.has(a.uuid)) continue;
        const lvl = a.level != null ? a.level : 80;     // 当前档位(80/85/90…)
        const prev = prevLevels[a.uuid] || 0;           // 已报到的最高档
        if (lvl > prev) {
          const r = await notifyWithContext(cfg, "traffic", a.name || nameOf(a.uuid), "", trafficCtxOf(a));
          if (r.ok) { nextLevels[a.uuid] = lvl; sent.push("traffic:" + (a.name || a.uuid.slice(0, 8)) + "@" + lvl + "%"); dirty = true; } // 升档→报并记新档
          else { nextLevels[a.uuid] = prev; }           // 失败→保留旧档,下轮重试
        } else {
          nextLevels[a.uuid] = prev;                    // 未升档→保留水位(小幅波动不重复报)
        }
      }
      if (JSON.stringify(nextLevels) !== JSON.stringify(st.traffic || {})) dirty = true;
      st.traffic = nextLevels;                           // 不在 alerting(降回阈值以下/重置)的节点自动清除,下次重新从阈值报
      st.traffic_threshold = cfg.traffic_threshold;
    } catch (e) { /* traffic-billing 未装或调用失败,忽略,保留旧 traffic 状态 */ }
  }

  return await finish({ ok: true, sent: sent.length, events: sent, checked: uuids.length, wrote_state: dirty }, "");
}

// ─── 入口 ───────────────────────────────────────────────────────────

async function dispatch(token, params, ctx) {
  if (!token) return { ok: false, error: "missing token in env" };
  const action = (params && params.action) || "get_config";
  if (action === "get_config") {
    const cfg = await getCfg(token);
    let availableNodes = [];
    let nodeError = "";
    try {
      availableNodes = await listAvailableNodes(token);
    } catch (e) {
      nodeError = String(e && e.message ? e.message : e);
    }
    return { ok: true, config: maskCfg(cfg), state: maskState(await getState(token)), available_nodes: availableNodes, node_error: nodeError };
  }
  if (action === "list_nodes") return { ok: true, nodes: await listAvailableNodes(token) };
  if (action === "get_state") return { ok: true, state: maskState(await getState(token)) };
  if (action === "set_config") {
    const incoming = params.config || params;
    const prev = await getCfg(token);
    const merged = { ...prev, ...incoming };
    if (!incoming.bot_token) merged.bot_token = prev.bot_token; // 前端留空=保留原 token,不覆盖成空
    if (!incoming.webhook_admin_secret) merged.webhook_admin_secret = prev.webhook_admin_secret; // 留空=保留原管理密钥
    const cfg = normalizeCfg(merged);
    await setCfg(token, cfg);
    return { ok: true, config: maskCfg(cfg) };
  }
  if (action === "test") {
    const cfg = await getCfg(token);
    const r = await sendTelegram(cfg, render(cfg.template, { emoji: EMOJI.test, event: EVENT_TEXT.test, client: "NodeGet", time: nowCST(), type: "test" }));
    return r.ok ? { ok: true, sent: r.sent || 0 } : { ok: false, sent: r.sent || 0, error: r.error };
  }
  if (action === "run") return await runCheck(token, ctx);
  return { ok: false, error: "unknown action: " + action };
}

// ─── Telegram webhook 路由 ──────────────────────────────────────────

function routeWebhookUrl(requestUrl) {
  const url = new URL(requestUrl);
  let path = url.pathname.replace(/\/+$/, "");
  const suffixes = ["/registerWebhook", "/unRegisterWebhook", "/webhookInfo", WEBHOOK_PATH];
  for (const suffix of suffixes) {
    if (path.endsWith(suffix)) {
      path = path.slice(0, -suffix.length);
      break;
    }
  }
  return url.protocol + "//" + url.host + path + WEBHOOK_PATH;
}
function routeSecret(request) {
  const url = new URL(request.url);
  return url.searchParams.get("s") || url.searchParams.get("secret") || request.headers.get("x-webhook-admin-secret") || "";
}
function webhookAdminAuthed(request, env, cfg) {
  const input = routeSecret(request);
  const secrets = [
    env && env.webhook_admin_secret ? String(env.webhook_admin_secret) : "",
    cfg && cfg.webhook_admin_secret ? String(cfg.webhook_admin_secret) : "",
  ].filter(Boolean);
  return !secrets.length || secrets.indexOf(input) >= 0;
}

async function registerWebhook(token, cfg, request) {
  if (!cfg.bot_token) return { ok: false, error: "missing bot_token" };
  const webhookUrl = routeWebhookUrl(request.url);
  const st = await getState(token);
  const secret = st.telegram_webhook_secret || makeWebhookSecret();
  const webhook = await telegramRequest(cfg, "setWebhook", {
    url: webhookUrl,
    secret_token: secret,
    drop_pending_updates: true,
    allowed_updates: ["message", "channel_post", "edited_message", "edited_channel_post"],
  });
  const commands = await telegramRequest(cfg, "setMyCommands", { commands: TELEGRAM_COMMANDS });
  st.telegram_webhook_secret = secret;
  st.telegram_webhook_url = webhookUrl;
  await setState(token, st);
  return { ok: true, webhook_url: webhookUrl, telegram: webhook.result, commands: commands.result };
}

async function unRegisterWebhook(token, cfg) {
  if (!cfg.bot_token) return { ok: false, error: "missing bot_token" };
  const r = await telegramRequest(cfg, "deleteWebhook", { drop_pending_updates: false });
  const st = await getState(token);
  st.telegram_webhook_secret = "";
  st.telegram_webhook_url = "";
  await setState(token, st);
  return { ok: true, telegram: r.result };
}

async function getWebhookInfo(cfg) {
  if (!cfg.bot_token) return { ok: false, error: "missing bot_token" };
  const r = await telegramRequest(cfg, "getWebhookInfo", {});
  return { ok: true, telegram: r.result };
}

async function handleTelegramWebhook(token, request) {
  const cfg = await getCfg(token);
  const st = await getState(token);
  const expectedSecret = st.telegram_webhook_secret;
  const inputSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (!expectedSecret || inputSecret !== expectedSecret) {
    return new Response("bad secret", { status: 403 });
  }
  let update;
  try {
    update = await request.json();
  } catch (e) {
    return json({ ok: false, error: "invalid json" }, 400);
  }
  return json(await handleChatIdUpdate(cfg, update));
}

export default {
  async onCron(params, env, ctx) {
    const token = (env && env.token) || (params && params.token);
    if (!token) return { ok: false, error: "missing token in env" };
    try { return await runCheck(token, ctx); }
    catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  },
  async onCall(params, env, ctx) {
    const token = (env && env.token) || (params && params.token);
    try { return await dispatch(token, params, ctx); }
    catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  },
  async onInlineCall(params, env, ctx) {
    const token = (env && env.token) || (params && params.token);
    try { return await dispatch(token, params, ctx); }
    catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  },
  async onRoute(request, env, ctx) {
    const token = env && env.token;
    if (!token) return json({ ok: false, error: "missing token in env" }, 500);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");
    const method = request.method.toUpperCase();
    try {
      const cfg = await getCfg(token);
      if ((method === "GET" || method === "POST") && path.endsWith("/registerWebhook")) {
        if (!webhookAdminAuthed(request, env, cfg)) return json({ ok: false, error: "unauthorized" }, 401);
        return json(await registerWebhook(token, cfg, request));
      }
      if ((method === "GET" || method === "POST") && path.endsWith("/unRegisterWebhook")) {
        if (!webhookAdminAuthed(request, env, cfg)) return json({ ok: false, error: "unauthorized" }, 401);
        return json(await unRegisterWebhook(token, cfg));
      }
      if (method === "GET" && path.endsWith("/webhookInfo")) {
        if (!webhookAdminAuthed(request, env, cfg)) return json({ ok: false, error: "unauthorized" }, 401);
        return json(await getWebhookInfo(cfg));
      }
      if (path.endsWith(WEBHOOK_PATH)) {
        if (method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
        return await handleTelegramWebhook(token, request);
      }
      return json({ ok: false, error: "not found" }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
    }
  },
};
