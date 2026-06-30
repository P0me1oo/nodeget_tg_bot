/**
 * notify-worker v1.3
 *
 * NodeGet 事件通知(对齐 Komari 通知功能):节点离线/上线、到期提醒、流量超限,
 * 通过 Telegram Bot 推送。配置由 notify-extension(token 鉴权 iframe)经 onCall 读写。
 *   当前:新增 targets 通知目标列表,每个目标可单独选择接收离线/恢复/到期/流量事件。
 *   v1.3:chat_id 支持逗号/换行分隔的多个目标;Telegram /chatid 改为 webhook 实时响应。
 *   v1.2:移除内置 /ui 与 route_secret —— 配置面板改由 notify-extension 用 NodeGet Token
 *         调 onCall(get_config/set_config/test/run)完成。
 *   v1.1:bot_token 打码回显 · 发送失败下轮重试 · 离线/恢复同轮合并一条 ·
 *         到期每天提醒一次 · 记录 last_run
 *
 * ── 事件 ─────────────────────────────────────────────────────────
 *   offline  节点离线(动态摘要超过 OFFLINE_MS 无上报、且持续达 offline_delay 分钟;同轮多台合并一条)
 *   online   节点从离线恢复(同轮多台合并一条)
 *   expire   metadata_expire_time 距今 <= expire_days 天(每天提醒一次,跨天重发,续费即停)
 *   traffic  流量超配额(经 inlineCall 读 traffic-billing-worker;从 80% 起每 +5% 档报一次)
 *
 * ── 存储(global 命名空间) ───────────────────────────────────────
 *   notify_config : { enabled, channel, bot_token, targets:[{name,chat_id,message_thread_id,events,enabled}],
 *                     webhook_admin_secret, endpoint, template, events:{offline,online,expire,traffic},
 *                     expire_days, offline_delay }
 *   notify_state  : { offline:[uuid...], expire_dates:{uuid:"YYYY-MM-DD"...}, traffic:{uuid:level...},
 *                     telegram_webhook_secret, telegram_webhook_url, last_run, last_sent, last_note }
 *
 * ── 入口 ─────────────────────────────────────────────────────────
 *   onCron        → 检测事件并推送(需配定时任务,建议每 2 分钟一次)
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
var EXPIRE_KEY = "metadata_expire_time";
var OFFLINE_MS = 90000;            // 90s 无上报视为"当前掉线"(用于恢复判定)
var DEFAULT_OFFLINE_DELAY = 5;     // 离线持续达到该分钟数才告警(默认 5min,宽限期内恢复不报)
var TRAFFIC_WORKER = "traffic-billing-worker";
var WEBHOOK_PATH = "/telegramWebhook";

var DEFAULT_CFG = {
  enabled: false,
  channel: "telegram",
  bot_token: "",
  chat_id: "",              // 兼容旧配置;新配置使用 targets
  message_thread_id: "",    // 兼容旧配置;新配置使用 targets
  targets: [],
  webhook_admin_secret: "",
  endpoint: "https://api.telegram.org/bot",
  template: "{{emoji}} {{event}}\n服务器：{{client}}\n时间：{{time}}",
  events: { offline: true, online: true, expire: true, traffic: false },
  expire_days: 7,
  offline_delay: DEFAULT_OFFLINE_DELAY,
};

var EMOJI = { offline: "🔴", online: "🟢", expire: "⏰", traffic: "📊", test: "✅" };
var EVENT_TEXT = { offline: "节点离线", online: "节点恢复在线", expire: "即将到期", traffic: "流量超配额", test: "测试通知" };

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

// ─── 配置 / 状态 ────────────────────────────────────────────────────

function normalizeCfg(raw) {
  raw = raw && typeof raw === "object" ? raw : {};
  const ev = normalizeEventFlags(raw.events, DEFAULT_CFG.events);
  let ed = Number(raw.expire_days);
  if (!(ed >= 1 && ed <= 90)) ed = 7;
  let od = Number(raw.offline_delay);
  if (!(od >= 0 && od <= 1440)) od = DEFAULT_OFFLINE_DELAY; // 0=立即;上限 24h
  const targets = normalizeTargets(raw.targets, raw.chat_id, raw.message_thread_id, ev);
  return {
    enabled: raw.enabled === true,
    channel: "telegram",
    bot_token: String(raw.bot_token || ""),
    chat_id: targets.map((target) => target.chat_id).join("\n"),
    message_thread_id: targets.length === 1 ? targets[0].message_thread_id : "",
    targets,
    webhook_admin_secret: String(raw.webhook_admin_secret || ""),
    endpoint: String(raw.endpoint || DEFAULT_CFG.endpoint),
    template: String(raw.template || DEFAULT_CFG.template),
    events: ev,
    expire_days: Math.trunc(ed),
    offline_delay: Math.trunc(od),
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
    expired: Array.isArray(v && v.expired) ? v.expired : [],
    expire_dates: (v && v.expire_dates && typeof v.expire_dates === "object") ? v.expire_dates : {}, // uuid→上次提醒日期(CST),用于每天提醒
    traffic: (v && v.traffic && typeof v.traffic === "object" && !Array.isArray(v.traffic)) ? v.traffic : {}, // uuid→已报最高档位(%),阶梯报警
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
  return String(tpl).replace(/\{\{(\w+)\}\}/g, function (_, k) {
    return ctx[k] != null ? String(ctx[k]) : "";
  });
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
function notify(cfg, type, client, extra) {
  const text = render(cfg.template, {
    emoji: EMOJI[type] || "", event: (EVENT_TEXT[type] || type) + (extra ? " " + extra : ""),
    client: client || "", time: nowCST(), type,
  });
  return sendTelegramForEvent(cfg, type, text);
}
// 聚合:同一轮多台离线/恢复合并成一条消息(单台时与原来一致)
function groupClient(names) {
  const n = names.length;
  return n <= 6 ? names.join("、") : names.slice(0, 6).join("、") + " 等 " + n + " 台";
}
function notifyGroup(cfg, type, names) {
  const n = names.length;
  return notify(cfg, type, groupClient(names), n > 1 ? "（共 " + n + " 台）" : "");
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
async function getMulti(token, uuids, key) {
  if (!uuids.length) return new Map();
  const rows = await rpc("kv_get_multi_value", { token, namespace_key: uuids.map((u) => ({ namespace: u, key })) });
  const m = new Map();
  for (const r of rows || []) m.set(r.namespace, r.value);
  return m;
}
async function getTimestamps(token, uuids) {
  if (!uuids.length) return new Map();
  const rows = await rpc("agent_dynamic_summary_multi_last_query", { token, uuids, fields: ["cpu_usage"] });
  const m = new Map();
  for (const r of rows || []) m.set(r.uuid, r.timestamp || 0);
  return m;
}

// ─── 核心:检测事件并推送 ───────────────────────────────────────────

async function runCheck(token, ctx) {
  const cfg = await getCfg(token);
  let st = await getState(token);
  st.last_run = Date.now();

  if (!cfg.enabled) { st.last_sent = 0; st.last_note = "通知未开启"; await setState(token, st); return { ok: true, skipped: "通知未开启" }; }
  if (!cfg.bot_token || !enabledTargets(cfg).length) { st.last_sent = 0; st.last_note = "未配置 bot_token / 通知目标"; await setState(token, st); return { ok: true, skipped: "未配置 bot_token / 通知目标" }; }

  const uuids = await listUuids(token);
  if (!uuids.length) { st.last_sent = 0; st.last_note = "无节点"; await setState(token, st); return { ok: true, sent: 0, note: "无节点" }; }

  const [tsMap, nameMap, expireMap] = await Promise.all([
    getTimestamps(token, uuids),
    getMulti(token, uuids, NAME_KEY),
    getMulti(token, uuids, EXPIRE_KEY),
  ]);
  const nameOf = (u) => {
    const n = nameMap.get(u);
    return (typeof n === "string" && n) ? n : u.slice(0, 8);
  };

  const now = Date.now();
  const sent = [];

  // 1) 离线/上线 —— 同一轮多台合并成一条;仅在通知成功时才并入状态,失败者整批下轮重试
  //    st.offline 语义:已就「离线」成功通知过、且仍被视作离线的节点集合
  //    宽限期:节点掉线(90s 无上报)后,需持续静默达 offline_delay 分钟才告警;
  //            期间恢复上报则自然不报(靠 lastReport 时间戳判断,无需额外状态)
  const prevOffline = new Set(st.offline);
  const nowOffline = uuids.filter((u) => now - (tsMap.get(u) || 0) > OFFLINE_MS); // 90s:当前掉线(供恢复判定)
  const nowOfflineSet = new Set(nowOffline);
  const alertMs = Math.max(OFFLINE_MS, (cfg.offline_delay || 0) * 60000);          // 达到该静默时长才告警
  const sendOffline = hasTargetsForEvent(cfg, "offline");
  const sendOnline = hasTargetsForEvent(cfg, "online");
  const trackOff = sendOffline || sendOnline;
  if (trackOff) {
    const nextOffline = [];
    const offlineNew = []; // 本轮新离线、已过宽限期、需要通知的
    for (const u of nowOffline) {
      if (prevOffline.has(u)) { nextOffline.push(u); continue; }   // 之前已通知,保留
      if (now - (tsMap.get(u) || 0) < alertMs) continue;           // 宽限期内:暂不报也不记,恢复则自然消失
      if (sendOffline) offlineNew.push(u);
      else nextOffline.push(u);                                    // 离线通知没开,但记录状态供「恢复」判定
    }
    if (offlineNew.length) {
      const r = await notifyGroup(cfg, "offline", offlineNew.map(nameOf));
      if (r.ok) { offlineNew.forEach((u) => nextOffline.push(u)); sent.push("offline×" + offlineNew.length); }
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
      const r = await notifyGroup(cfg, "online", recovered.map(nameOf));
      if (r.ok) { sent.push("online×" + recovered.length); }       // 成功→正常移除
      else { recovered.forEach((u) => nextOffline.push(u)); }      // 失败→保留离线态,下轮重发恢复
    }
    st.offline = nextOffline;
  }

  // 2) 到期提醒(每天提醒一次:同一东八区日期内只发一次,跨天重发;续费出窗后清除;发送失败当天重试)
  if (hasTargetsForEvent(cfg, "expire")) {
    const prevDates = st.expire_dates || {};
    const today = nowDateCST();
    const nextDates = {};
    for (const u of uuids) {
      const days = expireDaysLeft(expireMap.get(u));
      if (days == null) continue;
      if (days > cfg.expire_days) continue;                       // 不在窗口→不保留(含续费,出窗后再进窗可重发)
      if (prevDates[u] === today) { nextDates[u] = today; continue; } // 今天已发,跳过
      const r = await notify(cfg, "expire", nameOf(u), days >= 0 ? "剩 " + days + " 天" : "已过期");
      if (r.ok) { nextDates[u] = today; sent.push("expire:" + nameOf(u)); } // 成功→记今天
      // 失败:不记今天,同一天下轮会重试
    }
    st.expire_dates = nextDates;
    st.expired = Object.keys(nextDates); // 兼容旧字段
  }

  // 3) 流量超配额(读 traffic-billing-worker;从 80% 起每升 5% 档位报一次;失败下轮重试)
  if (hasTargetsForEvent(cfg, "traffic") && ctx && ctx.inlineCall) {
    try {
      const prevLevels = st.traffic || {};
      const sum = await ctx.inlineCall(TRAFFIC_WORKER, { action: "get_summary" }, 20);
      const alerting = (sum && sum.alerting) || [];
      const nextLevels = {};
      for (const a of alerting) {
        const lvl = a.level != null ? a.level : 80;     // 当前档位(80/85/90…)
        const prev = prevLevels[a.uuid] || 0;           // 已报到的最高档
        if (lvl > prev) {
          const r = await notify(cfg, "traffic", a.name || a.uuid.slice(0, 8), (a.percent != null ? a.percent + "%" : lvl + "%"));
          if (r.ok) { nextLevels[a.uuid] = lvl; sent.push("traffic:" + (a.name || a.uuid.slice(0, 8)) + "@" + lvl + "%"); } // 升档→报并记新档
          else { nextLevels[a.uuid] = prev; }           // 失败→保留旧档,下轮重试
        } else {
          nextLevels[a.uuid] = prev;                    // 未升档→保留水位(小幅波动不重复报)
        }
      }
      st.traffic = nextLevels;                           // 不在 alerting(降回 80% 以下/重置)的节点自动清除,下次重新从 80% 报
    } catch (e) { /* traffic-billing 未装或调用失败,忽略,保留旧 traffic 状态 */ }
  }

  st.last_sent = sent.length;
  st.last_note = "";
  await setState(token, st);
  return { ok: true, sent: sent.length, events: sent };
}

// ─── 入口 ───────────────────────────────────────────────────────────

async function dispatch(token, params, ctx) {
  if (!token) return { ok: false, error: "missing token in env" };
  const action = (params && params.action) || "get_config";
  if (action === "get_config") return { ok: true, config: maskCfg(await getCfg(token)), state: maskState(await getState(token)) };
  if (action === "get_state") return { ok: true, state: maskState(await getState(token)) };
  if (action === "set_config") {
    const incoming = params.config || params;
    const prev = await getCfg(token);
    const merged = { ...incoming };
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
  const r = await telegramRequest(cfg, "setWebhook", {
    url: webhookUrl,
    secret_token: secret,
    drop_pending_updates: true,
    allowed_updates: ["message", "channel_post", "edited_message", "edited_channel_post"],
  });
  st.telegram_webhook_secret = secret;
  st.telegram_webhook_url = webhookUrl;
  await setState(token, st);
  return { ok: true, webhook_url: webhookUrl, telegram: r.result };
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
