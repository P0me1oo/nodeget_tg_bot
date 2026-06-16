/**
 * notify-worker v1.1
 *
 * NodeGet 事件通知(对齐 Komari 通知功能):节点离线/上线、到期提醒、流量超限,
 * 通过 Telegram Bot 推送。配置 + 模板 + 测试都在内置 /ui 里,可装进应用扩展区。
 *   v1.1:bot_token 打码回显 · 可选 route_secret 写鉴权 · 发送失败下轮重试 ·
 *         离线/恢复同轮合并一条 · 到期每天提醒一次 · 记录 last_run
 *
 * ── 事件 ─────────────────────────────────────────────────────────
 *   offline  节点离线(动态摘要超过 OFFLINE_MS 无上报;同轮多台合并一条)
 *   online   节点从离线恢复(同轮多台合并一条)
 *   expire   metadata_expire_time 距今 <= expire_days 天(每天提醒一次,跨天重发,续费即停)
 *   traffic  流量超配额(经 inlineCall 读 traffic-billing-worker;从 80% 起每 +5% 档报一次)
 *
 * ── 存储(global 命名空间) ───────────────────────────────────────
 *   notify_config : { enabled, channel, bot_token, chat_id, message_thread_id,
 *                     endpoint, template, events:{offline,online,expire,traffic}, expire_days }
 *   notify_state  : { offline:[uuid...], expire_dates:{uuid:"YYYY-MM-DD"...}, traffic:{uuid:level...},
 *                     last_run, last_sent, last_note }
 *
 * ── 入口 ─────────────────────────────────────────────────────────
 *   onCron  → 检测事件并推送(需配定时任务,建议每 2 分钟一次)
 *   onCall  → action: get_config / set_config / test / run / get_state
 *   onRoute → GET /ui(公开,出登录页) /config · POST /config /test /run(设了 route_secret 后需登录密钥)
 *
 * env: {
 *   "token":        "<NodeGet 平台 Token(读 agent/kv 权限);注意:不是 Telegram bot token>",
 *   "route_secret": "<可选;设了后打开 /ui 先出登录页,输入此密钥登录(本机记住);数据接口无密钥一律 401>"
 * }
 * 注:route_secret 未设=公开;设了=打开 /ui 先登录(输入密钥→本机 localStorage 记住→扩展图标直接进);
 *     也可用 …/ui#s=<密钥> 免登录直达(hash 不进日志)。登录后密钥走 x-route-secret 头,不进 URL/日志。
 *     worker-route 是公开端点(平台无账号级鉴权),这是应用层登录。bot_token 始终打码。
 */

var NS = "global";
var CFG_KEY = "notify_config";
var STATE_KEY = "notify_state";
var NAME_KEY = "metadata_name";
var EXPIRE_KEY = "metadata_expire_time";
var OFFLINE_MS = 90000;            // 90s 无上报视为离线
var TRAFFIC_WORKER = "traffic-billing-worker";

var DEFAULT_CFG = {
  enabled: false,
  channel: "telegram",
  bot_token: "",
  chat_id: "",
  message_thread_id: "",
  endpoint: "https://api.telegram.org/bot",
  template: "{{emoji}} {{event}}\n服务器：{{client}}\n时间：{{time}}",
  events: { offline: true, online: true, expire: true, traffic: false },
  expire_days: 7,
};

var EMOJI = { offline: "🔴", online: "🟢", expire: "⏰", traffic: "📊", test: "✅" };
var EVENT_TEXT = { offline: "节点离线", online: "节点恢复在线", expire: "即将到期", traffic: "流量超配额", test: "测试通知" };

// ─── 工具 ───────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" },
  });
}
function html(s, status = 200) {
  return new Response(s, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}
// 私密链接鉴权:env.route_secret 未设→面板公开(现状);设了→URL 必须带 ?s=<secret>(或 ?secret= / x-route-secret 头),
// 不匹配则连页面都打不开。secret 由打开页面的 URL 透传给页内所有请求,无需手动输入。
function getSecret(request) {
  const u = new URL(request.url);
  return u.searchParams.get("s") || u.searchParams.get("secret") || request.headers.get("x-route-secret") || "";
}
function authed(request, env) {
  const want = env && env.route_secret ? String(env.route_secret) : "";
  return !want || getSecret(request) === want;
}
// bot_token 打码:回显只给提示尾巴,绝不吐明文
function maskToken(t) {
  t = String(t || "");
  if (!t) return "";
  return t.length <= 8 ? "****" : t.slice(0, 5) + "…" + t.slice(-4);
}
function maskCfg(cfg) {
  return { ...cfg, bot_token: "", bot_token_set: !!cfg.bot_token, bot_token_hint: maskToken(cfg.bot_token) };
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
  const ev = raw.events && typeof raw.events === "object" ? raw.events : {};
  let ed = Number(raw.expire_days);
  if (!(ed >= 1 && ed <= 90)) ed = 7;
  return {
    enabled: raw.enabled === true,
    channel: "telegram",
    bot_token: String(raw.bot_token || ""),
    chat_id: String(raw.chat_id || ""),
    message_thread_id: String(raw.message_thread_id || ""),
    endpoint: String(raw.endpoint || DEFAULT_CFG.endpoint),
    template: String(raw.template || DEFAULT_CFG.template),
    events: {
      offline: ev.offline !== false,
      online: ev.online !== false,
      expire: ev.expire !== false,
      traffic: ev.traffic === true,
    },
    expire_days: Math.trunc(ed),
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
  if (!cfg.bot_token || !cfg.chat_id) return { ok: false, error: "missing bot_token / chat_id" };
  const base = (cfg.endpoint || DEFAULT_CFG.endpoint).replace(/\/$/, "");
  const url = base + cfg.bot_token + "/sendMessage";
  const body = { chat_id: cfg.chat_id, text };
  if (cfg.message_thread_id) body.message_thread_id = cfg.message_thread_id;
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json();
    return d && d.ok ? { ok: true } : { ok: false, error: (d && d.description) || ("HTTP " + r.status) };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}
function notify(cfg, type, client, extra) {
  const text = render(cfg.template, {
    emoji: EMOJI[type] || "", event: (EVENT_TEXT[type] || type) + (extra ? " " + extra : ""),
    client: client || "", time: nowCST(), type,
  });
  return sendTelegram(cfg, text);
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
  const st = await getState(token);
  st.last_run = Date.now();

  if (!cfg.enabled) { st.last_sent = 0; st.last_note = "通知未开启"; await setState(token, st); return { ok: true, skipped: "通知未开启" }; }
  if (!cfg.bot_token || !cfg.chat_id) { st.last_sent = 0; st.last_note = "未配置 bot_token / chat_id"; await setState(token, st); return { ok: true, skipped: "未配置 bot_token / chat_id" }; }

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
  const prevOffline = new Set(st.offline);
  const nowOffline = uuids.filter((u) => now - (tsMap.get(u) || 0) > OFFLINE_MS);
  const nowOfflineSet = new Set(nowOffline);
  const trackOff = cfg.events.offline || cfg.events.online;
  if (trackOff) {
    const nextOffline = [];
    const offlineNew = []; // 本轮新离线、需要通知的
    for (const u of nowOffline) {
      if (prevOffline.has(u)) { nextOffline.push(u); continue; }   // 之前已通知,保留
      if (cfg.events.offline) offlineNew.push(u);
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
      if (cfg.events.online) recovered.push(u);
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
  if (cfg.events.expire) {
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
  if (cfg.events.traffic && ctx && ctx.inlineCall) {
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
  if (action === "get_config") return { ok: true, config: maskCfg(await getCfg(token)), state: await getState(token) };
  if (action === "get_state") return { ok: true, state: await getState(token) };
  if (action === "set_config") {
    const incoming = params.config || params;
    const prev = await getCfg(token);
    const merged = { ...incoming };
    if (!incoming.bot_token) merged.bot_token = prev.bot_token; // 前端留空=保留原 token,不覆盖成空
    const cfg = normalizeCfg(merged);
    await setCfg(token, cfg);
    return { ok: true, config: maskCfg(cfg) };
  }
  if (action === "test") {
    const cfg = await getCfg(token);
    const r = await sendTelegram(cfg, render(cfg.template, { emoji: EMOJI.test, event: EVENT_TEXT.test, client: "NodeGet", time: nowCST(), type: "test" }));
    return r.ok ? { ok: true, sent: 1 } : { ok: false, error: r.error };
  }
  if (action === "run") return await runCheck(token, ctx);
  return { ok: false, error: "unknown action: " + action };
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
    const path = url.pathname;
    const method = request.method.toUpperCase();
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type,x-route-secret" } });
    try {
      // /ui 公开(返回带登录遮罩的页面);其余接口设了 route_secret 后必须带密钥,前端据 401 弹登录
      if (method === "GET" && path.endsWith("/ui")) return html(UI_HTML);
      if (!authed(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
      if (method === "GET" && path.endsWith("/config")) return json(await dispatch(token, { action: "get_config" }, ctx));
      if (method === "POST" && path.endsWith("/config")) return json(await dispatch(token, { action: "set_config", config: await request.json() }, ctx));
      if (method === "POST" && path.endsWith("/test")) return json(await dispatch(token, { action: "test" }, ctx));
      if (method === "POST" && path.endsWith("/run")) return json(await runCheck(token, ctx));
      if (method === "GET") return html(UI_HTML);
      return json({ ok: false, error: "not found" }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
    }
  },
};

// ─── 内置配置 UI(Komari 风格,深色) ────────────────────────────────

var UI_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>消息通知</title>
<style>
*{box-sizing:border-box}
:root{--bg:#0a0e1a;--card:rgba(255,255,255,.035);--line:rgba(255,255,255,.08);--mut:#8b93a7;--fg:#e8ebf2;--ac1:#6366f1;--ac2:#8b5cf6}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--fg);padding:22px;min-height:100vh;
 background:radial-gradient(900px 500px at 80% -10%,rgba(124,131,255,.12),transparent),radial-gradient(700px 400px at -10% 8%,rgba(139,92,246,.10),transparent),var(--bg)}
.wrap{max-width:760px;margin:0 auto}
.title{font-size:22px;font-weight:800;background:linear-gradient(90deg,#a5b4fc,#c4b5fd);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{color:var(--mut);font-size:13px;margin:3px 0 18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;margin-bottom:14px}
.card h3{margin:0 0 4px;font-size:15px}
.card .d{color:var(--mut);font-size:12px;margin-bottom:12px}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px}
label.f{display:block;font-size:13px;font-weight:600;margin:12px 0 5px}
label.f .opt{color:var(--mut);font-weight:400;font-size:11px}
input,textarea,select{width:100%;background:rgba(255,255,255,.04);color:var(--fg);border:1px solid var(--line);border-radius:9px;padding:9px 11px;font-size:13px;outline:none;font-family:inherit}
input:focus,textarea:focus,select:focus{border-color:var(--ac1)}
textarea{min-height:96px;resize:vertical;font-family:ui-monospace,monospace;line-height:1.6}
.hint{color:var(--mut);font-size:11px;margin-top:5px}
.btn{border:0;border-radius:10px;padding:9px 18px;font-size:13px;font-weight:600;cursor:pointer;color:#fff;background:linear-gradient(135deg,var(--ac1),var(--ac2));transition:.15s}
.btn:hover{filter:brightness(1.12)}
.btn.ghost{background:rgba(255,255,255,.06);border:1px solid var(--line);color:var(--fg)}
.bar{display:flex;gap:10px;margin-top:6px}
.sw{position:relative;display:inline-block;width:46px;height:25px;flex:none}
.sw input{opacity:0;width:0;height:0}
.sl{position:absolute;inset:0;background:#2a323d;border-radius:25px;cursor:pointer;transition:.2s}
.sl:before{content:"";position:absolute;height:19px;width:19px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s}
.sw input:checked+.sl{background:linear-gradient(135deg,var(--ac1),var(--ac2))}
.sw input:checked+.sl:before{transform:translateX(21px)}
.events{display:flex;gap:18px;flex-wrap:wrap;margin-top:6px}
.ev{display:flex;align-items:center;gap:7px;font-size:13px}
.ev input{width:16px;height:16px;accent-color:var(--ac1)}
.tags{color:var(--mut);font-size:12px;margin-top:8px;line-height:1.8}
.tags code{background:rgba(255,255,255,.06);padding:1px 6px;border-radius:5px;color:#c4b5fd}
.toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(20px);background:#161b2b;border:1px solid var(--line);color:var(--fg);padding:10px 18px;border-radius:12px;font-size:13px;opacity:0;transition:.25s;pointer-events:none;box-shadow:0 10px 34px rgba(0,0,0,.45)}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.toast.err{border-color:#f87171;color:#fca5a5}
.inline{display:flex;gap:10px;align-items:flex-end}
.inline>div{flex:none;width:120px}
</style></head><body>
<div class="wrap">
  <div class="title">消息通知</div>
  <div class="sub">节点离线/上线、到期、流量超限事件,通过 Telegram 推送</div>
  <div class="sub" id="status" style="margin:-12px 0 16px"></div>

  <div class="card"><div class="row">
    <div><h3>开启通知</h3><div class="d" style="margin:0">总开关。关闭后 onCron 不发送任何通知。</div></div>
    <label class="sw"><input type="checkbox" id="enabled"><span class="sl"></span></label>
  </div></div>

  <div class="card">
    <h3>消息通知模板</h3><div class="d">支持变量,见下方</div>
    <textarea id="template"></textarea>
    <div class="tags">可用变量:<code>{{emoji}}</code> <code>{{event}}</code> <code>{{client}}</code>(节点名) <code>{{time}}</code>(CST) <code>{{type}}</code></div>
  </div>

  <div class="card">
    <h3>通知渠道</h3><div class="d">当前支持 Telegram</div>
    <select id="channel"><option value="telegram">telegram</option></select>
  </div>

  <div class="card">
    <h3>Telegram 发送设置</h3><div class="d">从 @BotFather 获取 Bot Token;Chat ID 可为 @频道名 或数字 id</div>
    <label class="f">Bot Token *</label><input id="bot_token" placeholder="123456:ABC-DEF...">
    <label class="f">Chat ID *</label><input id="chat_id" placeholder="@yourchannel 或 123456789">
    <label class="f">message_thread_id <span class="opt">可选,超级群话题</span></label><input id="message_thread_id" placeholder="可选">
    <label class="f">请求端点 *</label><input id="endpoint" placeholder="https://api.telegram.org/bot">
    <div class="hint">端点通常为 https://api.telegram.org/bot(被墙时可填反代地址)</div>
  </div>

  <div class="card">
    <h3>通知事件</h3><div class="d">选择要推送的事件类型</div>
    <div class="events">
      <label class="ev"><input type="checkbox" id="ev_offline">节点离线</label>
      <label class="ev"><input type="checkbox" id="ev_online">恢复在线</label>
      <label class="ev"><input type="checkbox" id="ev_expire">到期提醒</label>
      <label class="ev"><input type="checkbox" id="ev_traffic">流量超配额</label>
    </div>
    <div class="inline" style="margin-top:14px">
      <div><label class="f" style="margin-top:0">到期提前(天)</label><input type="number" id="expire_days" min="1" max="90" value="7"></div>
    </div>
    <div class="hint" style="margin-top:8px">流量超配额需已部署 traffic-billing-worker;离线判定:90 秒无上报。</div>
  </div>

  <div class="bar">
    <button class="btn" id="save">保存配置</button>
    <button class="btn ghost" id="test">发送测试消息</button>
    <button class="btn ghost" id="run">立即检测一次</button>
  </div>
</div>
<div class="toast" id="toast"></div>
<div id="login" style="display:none;position:fixed;inset:0;z-index:99;place-items:center;background:radial-gradient(800px 500px at 50% 0%,rgba(124,131,255,.16),transparent),#0a0e1a">
  <div style="width:300px;text-align:center;padding:24px">
    <div style="font-size:44px">🔒</div>
    <div style="font-size:20px;font-weight:800;margin:8px 0;background:linear-gradient(90deg,#a5b4fc,#c4b5fd);-webkit-background-clip:text;background-clip:text;color:transparent">消息通知</div>
    <div style="color:#8b93a7;font-size:13px;margin-bottom:16px">请输入访问密钥(route_secret)登录</div>
    <input id="lk" type="password" placeholder="访问密钥" style="width:100%;background:rgba(255,255,255,.05);color:#e8ebf2;border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:11px 13px;font-size:14px;outline:none">
    <button id="lb" style="width:100%;margin-top:12px;border:0;border-radius:10px;padding:11px;font-size:14px;font-weight:700;color:#fff;background:linear-gradient(135deg,#6366f1,#8b5cf6);cursor:pointer">登录</button>
    <div id="le" style="color:#fca5a5;font-size:12px;margin-top:10px;min-height:16px"></div>
  </div>
</div>
<script>
(function(){
  var BASE=location.pathname.replace(/\\/ui$/,"").replace(/\\/$/,"");
  var SKEY="ng_s_notify";
  var H=new URLSearchParams(location.hash.slice(1).replace(/^\\?/,""));
  var Q=new URLSearchParams(location.search);
  var SECRET=H.get("s")||Q.get("s")||Q.get("secret")||localStorage.getItem(SKEY)||""; // 密钥:私密链接 #s= / ?s= / 本机记住
  function $(id){return document.getElementById(id)}
  function api(p,opt){
    opt=opt||{};
    if(SECRET){opt.headers=Object.assign({},opt.headers||{});opt.headers["x-route-secret"]=SECRET}
    return fetch(BASE+p,opt).then(function(r){return r.json()}); // 密钥走 header,不进 URL/日志
  }
  function toast(m,e){var t=$("toast");t.textContent=m;t.className="toast show"+(e?" err":"");setTimeout(function(){t.className="toast"+(e?" err":"")},2400)}
  function fill(c){
    $("enabled").checked=!!c.enabled;
    $("template").value=c.template||"";
    $("channel").value=c.channel||"telegram";
    $("bot_token").value="";
    $("bot_token").placeholder=c.bot_token_set?("已配置 "+(c.bot_token_hint||"")+",留空不修改"):"123456:ABC-DEF...";
    $("chat_id").value=c.chat_id||"";
    $("message_thread_id").value=c.message_thread_id||"";
    $("endpoint").value=c.endpoint||"https://api.telegram.org/bot";
    var ev=c.events||{};
    $("ev_offline").checked=ev.offline!==false;$("ev_online").checked=ev.online!==false;
    $("ev_expire").checked=ev.expire!==false;$("ev_traffic").checked=ev.traffic===true;
    $("expire_days").value=c.expire_days||7;
  }
  function collect(){
    return {enabled:$("enabled").checked,channel:$("channel").value,
      bot_token:$("bot_token").value.trim(),chat_id:$("chat_id").value.trim(),
      message_thread_id:$("message_thread_id").value.trim(),endpoint:$("endpoint").value.trim(),
      template:$("template").value,
      events:{offline:$("ev_offline").checked,online:$("ev_online").checked,expire:$("ev_expire").checked,traffic:$("ev_traffic").checked},
      expire_days:Number($("expire_days").value)||7};
  }
  function fmtAgo(ms){if(!ms)return null;var s=Math.floor((Date.now()-ms)/1000);if(s<60)return s+" 秒前";if(s<3600)return Math.floor(s/60)+" 分钟前";if(s<86400)return Math.floor(s/3600)+" 小时前";return Math.floor(s/86400)+" 天前"}
  function showStatus(st){
    var el=$("status");if(!st){el.textContent="";return}
    var ago=fmtAgo(st.last_run);
    if(!ago){el.style.color="#fbbf24";el.textContent="⚠️ 尚未运行过检测 —— 请确认已在「定时任务」配置 notify-worker(建议 cron 0 */2 * * * *)"}
    else{el.style.color="";el.textContent="上次检测:"+ago+" · 发出 "+(st.last_sent||0)+" 条"+(st.last_note?(" · "+st.last_note):"")}
  }
  function showLogin(msg){$("login").style.display="grid";$("le").textContent=msg||""}
  function doLogin(){var k=$("lk").value.trim();if(!k)return;$("le").textContent="";SECRET=k;load()}
  function load(){api("/config").then(function(d){
    if(d&&d.ok){$("login").style.display="none";if(SECRET){try{localStorage.setItem(SKEY,SECRET)}catch(e){}}fill(d.config);showStatus(d.state)}
    else if(d&&d.error==="unauthorized"){showLogin(SECRET?"密钥错误,请重试":"")}
    else toast((d&&d.error)||"加载失败",true)
  }).catch(function(){showLogin("")})}
  function save(){return api("/config",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(collect())}).then(function(d){if(d.ok){toast("已保存");return true}toast(d.error||"保存失败",true);return false})}
  $("save").onclick=save;
  $("test").onclick=function(){save().then(function(ok){if(!ok)return;toast("发送中…");api("/test",{method:"POST"}).then(function(d){toast(d.ok?"测试消息已发送 ✅":("发送失败: "+(d.error||"")),!d.ok)})})};
  $("run").onclick=function(){save().then(function(ok){if(!ok)return;toast("检测中…");api("/run",{method:"POST"}).then(function(d){toast(d.ok?("已检测,发出 "+(d.sent||0)+" 条"):("失败: "+(d.error||"")),!d.ok)})})};
  $("lb").onclick=doLogin;$("lk").onkeydown=function(e){if(e.key==="Enter")doLogin()};
  load();
})();
</script></body></html>`;
