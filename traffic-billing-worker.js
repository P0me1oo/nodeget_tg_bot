/**
 * traffic-billing-worker v3.0
 *
 * 逐台 opt-in 的节点流量记账 + 可选配额告警 + 对外汇总接口 + 内置配置 UI。
 * 完全在 NodeGet 边缘端运行，不改探针任何代码。
 *
 * ── 与 v2 的关键区别 ──────────────────────────────────────────────
 *   · 没有默认配额。每台机器单独开启、单独配置。
 *   · 配置(config)与运行状态(ledger)分离存储：
 *       config: 该节点命名空间 key "traffic_billing_config"
 *               { enabled, billing_day, mode, quota_gb|null }
 *       ledger: 该节点命名空间 key "traffic_billing_ledger"
 *               { snapshot:{ last_total_tx, last_total_rx, last_boot_time,
 *                            current_period_start, accumulated_bytes,
 *                            alerts_triggered, last_update } }
 *   · onCron 只审计 enabled === true 的机器；未开启的机器完全不碰。
 *   · quota_gb 为 null/0 → 只记用量、不设配额、不告警。
 *
 * ── 数据源(已对照文档 + 实例核实) ───────────────────────────────
 *   agent_dynamic_summary_multi_last_query
 *     fields:["total_transmitted","total_received","boot_time"]
 *   total_* = u64 字节整机累计计数器(单调递增)。
 *   boot_time 单位不统一(部分探针是 uptime 式递增)，不可靠 → 重启判定只看
 *   计数器方向(curr<last 才算归零)。
 *
 * ── 入口 ─────────────────────────────────────────────────────────
 *   onCron       → 审计所有 enabled 机器
 *   onCall/onInlineCall → action: list / get_summary / get_config / set_config / audit_now
 *   onRoute      → GET /ui(配置页) /list /summary /config?uuid=  POST /config /audit
 *
 * env: {
 *   "token":        "<拥有相应权限的 NodeGet Token(读 agent/动态摘要 + KV 读写)>",
 *   "route_secret": "<可选;设了后打开配置页 /ui 先出登录页需输入密钥(本机记住);读写配置接口无密钥 401;
 *                     数据接口 /list /summary 始终公开,供探针前端面板拉取>"
 * }
 * 注:route_secret 未设=全公开;设了=打开配置页先登录(密钥本机 localStorage 记住,扩展图标直接进),数据接口仍公开。
 */

// ─── 常量 ───────────────────────────────────────────────────────────

var CONFIG_KEY = "traffic_billing_config";
var LEDGER_KEY = "traffic_billing_ledger";
var NAME_KEY = "metadata_name";
var CST_OFFSET = 8 * 3600000;
var ALERT_THRESHOLDS = [0.8, 0.95];
var GiB = 1073741824;

// ─── 工具 ───────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*", // 允许 StatusShow 跨域(如部署到 Cloudflare Pages)拉取
    },
  });
}
function html(s, status = 200) {
  return new Response(s, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
function bytesToGB(b) {
  return Math.round((b / GiB) * 100) / 100;
}
// 私密链接鉴权:env.route_secret 未设→公开;设了→除公开数据接口(/list /summary,前端面板要拉)外,
// 其余(/ui /config /audit /reset)必须带 ?s=<secret>(或 ?secret= / x-route-secret 头),URL 不对一律拒绝。
function getSecret(request) {
  const u = new URL(request.url);
  return u.searchParams.get("s") || u.searchParams.get("secret") || request.headers.get("x-route-secret") || "";
}
function authed(request, env) {
  const want = env && env.route_secret ? String(env.route_secret) : "";
  return !want || getSecret(request) === want;
}

async function rpc(method, params) {
  const r = await nodeget(method, params);
  if (r && r.error) throw new Error(`RPC ${method}: ${JSON.stringify(r.error)}`);
  return r ? r.result : undefined;
}

// ─── 周期边界(按 CST 结算日) ───────────────────────────────────────

function periodStartFor(nowMs, billingDay) {
  const d = new Date(nowMs + CST_OFFSET);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  const day = d.getUTCDate();
  if (day < billingDay) {
    m -= 1;
    if (m < 0) { m = 11; y -= 1; }
  }
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const bd = Math.min(billingDay, daysInMonth);
  return Date.UTC(y, m, bd, 0, 0, 0, 0) - CST_OFFSET;
}

// ─── 配置 ───────────────────────────────────────────────────────────

function normalizeConfig(raw) {
  raw = raw && typeof raw === "object" ? raw : {};
  let bd = Number(raw.billing_day);
  if (!(bd >= 1 && bd <= 31)) bd = 1;
  bd = Math.trunc(bd);
  const mode = ["outbound", "inbound", "both"].includes(raw.mode) ? raw.mode : "outbound";
  let q = Number(raw.quota_gb);
  const quota_gb = Number.isFinite(q) && q > 0 ? q : null; // null = 不限额
  return { enabled: raw.enabled === true, billing_day: bd, mode, quota_gb };
}

// ─── 运行状态(snapshot) ───────────────────────────────────────────

function defaultSnapshot(nowMs, billingDay) {
  return {
    last_total_tx: null,
    last_total_rx: null,
    last_boot_time: null,
    current_period_start: periodStartFor(nowMs, billingDay),
    accumulated_bytes: 0,
    alerts_triggered: {},
    last_update: nowMs,
  };
}
function normalizeSnapshot(raw, nowMs, billingDay) {
  const base = defaultSnapshot(nowMs, billingDay);
  if (raw && typeof raw === "object" && raw.snapshot) {
    return { ...base, ...raw.snapshot };
  }
  return base;
}

// ─── 增量(纯计数器方向，重启容错) ─────────────────────────────────

function deltaBytes(curr, last) {
  const c = Number(curr) || 0;
  if (last == null) return 0;
  const l = Number(last) || 0;
  const diff = c - l;
  return diff >= 0 ? diff : Math.max(0, c); // 回退=归零→计入当前值
}

// ─── KV ─────────────────────────────────────────────────────────────

async function getValue(token, namespace, key) {
  return await rpc("kv_get_value", { token, namespace, key });
}
async function setValue(token, namespace, key, value) {
  await rpc("kv_set_value", { token, namespace, key, value });
}
// 批量读多个 namespace 下同一 key → Map<namespace, value|null>
async function getMulti(token, uuids, key) {
  if (!uuids.length) return new Map();
  const rows = await rpc("kv_get_multi_value", {
    token,
    namespace_key: uuids.map((u) => ({ namespace: u, key })),
  });
  const map = new Map();
  for (const r of rows || []) map.set(r.namespace, r.value);
  return map;
}

async function listAgentUuids(token) {
  const u = await rpc("agent-uuid_list_all", { token });
  return Array.isArray(u) ? u : [];
}
async function fetchTraffic(token, uuids) {
  if (!uuids.length) return new Map();
  const rows = await rpc("agent_dynamic_summary_multi_last_query", {
    token, uuids, fields: ["total_transmitted", "total_received", "boot_time"],
  });
  const map = new Map();
  for (const r of rows || []) map.set(r.uuid, r);
  return map;
}

// ─── 单节点审计(snapshot + config + sample → snapshot|null) ──────────

function auditSnapshot(snap, config, sample, nowMs) {
  const rawTx = Number(sample.total_transmitted);
  const rawRx = Number(sample.total_received);
  if (!Number.isFinite(rawTx) || !Number.isFinite(rawRx)) return null; // 跳过

  // 周期重置
  const expected = periodStartFor(nowMs, config.billing_day);
  if (expected > (snap.current_period_start || 0)) {
    snap.current_period_start = expected;
    snap.accumulated_bytes = 0;
    snap.alerts_triggered = {};
  }

  // 增量累加
  if (snap.last_total_tx != null) {
    const dTx = deltaBytes(rawTx, snap.last_total_tx);
    const dRx = deltaBytes(rawRx, snap.last_total_rx);
    let inc = 0;
    if (config.mode === "outbound" || config.mode === "both") inc += dTx;
    if (config.mode === "inbound" || config.mode === "both") inc += dRx;
    snap.accumulated_bytes += inc;
  }
  snap.last_total_tx = rawTx;
  snap.last_total_rx = rawRx;
  snap.last_boot_time = sample.boot_time != null ? Number(sample.boot_time) : null;
  snap.last_update = nowMs;

  // 告警(仅在设了配额时)
  if (config.quota_gb && config.quota_gb > 0) {
    const quotaBytes = config.quota_gb * GiB;
    const ratio = snap.accumulated_bytes / quotaBytes;
    for (const t of ALERT_THRESHOLDS) {
      const k = String(t);
      if (ratio >= t && !snap.alerts_triggered[k]) snap.alerts_triggered[k] = true;
    }
  }
  return snap;
}

// ─── 视图 ───────────────────────────────────────────────────────────

function nodeView(uuid, name, config, snap) {
  const used = snap ? snap.accumulated_bytes || 0 : 0;
  const quotaBytes = config.quota_gb ? config.quota_gb * GiB : null;
  const percent = quotaBytes ? Math.round((used / quotaBytes) * 10000) / 100 : null;
  const alerts = snap ? snap.alerts_triggered || {} : {};
  return {
    uuid,
    name: name || uuid.slice(0, 8),
    enabled: config.enabled,
    billing_day: config.billing_day,
    mode: config.mode,
    quota_gb: config.quota_gb,
    used_bytes: used,
    used_gb: bytesToGB(used),
    percent,
    remaining_gb: quotaBytes ? bytesToGB(Math.max(0, quotaBytes - used)) : null,
    alerts_triggered: alerts,
    current_period_start: snap ? snap.current_period_start : null,
    last_update: snap ? snap.last_update : null,
  };
}

// ─── 核心:审计所有 enabled 机器 ───────────────────────────────────

async function auditAll(token) {
  const nowMs = Date.now();
  const uuids = await listAgentUuids(token);
  if (!uuids.length) return { ok: true, audited: 0, results: [] };

  const configMap = await getMulti(token, uuids, CONFIG_KEY);
  const enabled = uuids.filter((u) => {
    const c = configMap.get(u);
    return c && c.enabled === true;
  });
  if (!enabled.length) {
    return { ok: true, audited: 0, results: [], note: "no enabled node" };
  }

  const [trafficMap, ledgerMap] = await Promise.all([
    fetchTraffic(token, enabled),
    getMulti(token, enabled, LEDGER_KEY),
  ]);

  const results = [];
  for (const uuid of enabled) {
    const sample = trafficMap.get(uuid);
    if (!sample) { results.push({ uuid, skipped: "no traffic sample" }); continue; }
    try {
      const config = normalizeConfig(configMap.get(uuid));
      const snap = normalizeSnapshot(ledgerMap.get(uuid), nowMs, config.billing_day);
      const updated = auditSnapshot(snap, config, sample, nowMs);
      if (!updated) { results.push({ uuid, skipped: "invalid sample" }); continue; }
      await setValue(token, uuid, LEDGER_KEY, { snapshot: updated });
      results.push(nodeView(uuid, null, config, updated));
    } catch (e) {
      results.push({ uuid, error: String(e && e.message ? e.message : e) });
    }
  }
  return { ok: true, audited: results.length, results };
}

// ─── 列表(所有机器，含未开启的，供 UI 展示) ──────────────────────

async function listAll(token) {
  const nowMs = Date.now();
  const uuids = await listAgentUuids(token);
  const [configMap, ledgerMap, nameMap] = await Promise.all([
    getMulti(token, uuids, CONFIG_KEY),
    getMulti(token, uuids, LEDGER_KEY),
    getMulti(token, uuids, NAME_KEY),
  ]);
  const nodes = uuids.map((uuid) => {
    const config = normalizeConfig(configMap.get(uuid));
    const rawLedger = ledgerMap.get(uuid);
    const snap = rawLedger && rawLedger.snapshot ? rawLedger.snapshot : null;
    const name = nameMap.get(uuid);
    return nodeView(uuid, typeof name === "string" ? name : null, config, snap);
  });
  nodes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { ok: true, count: nodes.length, nodes };
}

async function getSummary(token) {
  const { nodes } = await listAll(token);
  const enabled = nodes.filter((n) => n.enabled);
  let used = 0, quota = 0;
  const alerting = [];
  for (const n of enabled) {
    used += n.used_bytes;
    if (n.quota_gb) quota += n.quota_gb * GiB;
    // 从 80% 起每 5% 一个档位(80/85/90/95/100/105…),供 notify 做阶梯报警
    if (n.percent != null && n.percent >= 80) {
      const level = Math.floor((n.percent - 80) / 5) * 5 + 80;
      const hit = Object.keys(n.alerts_triggered || {}).filter((k) => n.alerts_triggered[k]);
      alerting.push({ uuid: n.uuid, name: n.name, percent: n.percent, level, thresholds: hit });
    }
  }
  return {
    ok: true,
    generated_at: Date.now(),
    enabled_count: enabled.length,
    total_count: nodes.length,
    total_used_gb: bytesToGB(used),
    total_quota_gb: quota ? bytesToGB(quota) : null,
    alerting,
    nodes: enabled,
  };
}

async function getConfig(token, uuid) {
  if (!uuid) return { ok: false, error: "missing uuid" };
  const raw = await getValue(token, uuid, CONFIG_KEY);
  return { ok: true, uuid, config: normalizeConfig(raw), exists: raw != null };
}

async function setConfig(token, params) {
  const uuid = params && params.uuid;
  if (!uuid) return { ok: false, error: "missing uuid" };

  const cur = normalizeConfig(await getValue(token, uuid, CONFIG_KEY));
  const next = { ...cur };
  if (params.enabled != null) next.enabled = params.enabled === true || params.enabled === "true";
  if (params.billing_day != null) {
    const bd = Number(params.billing_day);
    if (!(bd >= 1 && bd <= 31)) return { ok: false, error: "billing_day must be 1-31" };
    next.billing_day = Math.trunc(bd);
  }
  if (params.mode != null) {
    if (!["outbound", "inbound", "both"].includes(params.mode))
      return { ok: false, error: "mode must be outbound|inbound|both" };
    next.mode = params.mode;
  }
  if (params.quota_gb !== undefined) {
    const q = Number(params.quota_gb);
    next.quota_gb = params.quota_gb === null || params.quota_gb === "" || !(q > 0) ? null : q;
  }
  const config = normalizeConfig(next);
  await setValue(token, uuid, CONFIG_KEY, config);

  // 配置变更后清告警锁，让下轮按新配额重新评估
  const rawLedger = await getValue(token, uuid, LEDGER_KEY);
  if (rawLedger && rawLedger.snapshot) {
    rawLedger.snapshot.alerts_triggered = {};
    await setValue(token, uuid, LEDGER_KEY, rawLedger);
  }
  return { ok: true, uuid, config };
}

async function resetNode(token, uuid) {
  if (!uuid) return { ok: false, error: "missing uuid" };
  const raw = await getValue(token, uuid, LEDGER_KEY);
  if (raw && raw.snapshot) {
    raw.snapshot.accumulated_bytes = 0;
    raw.snapshot.alerts_triggered = {};
    // 保留 last_total_* 与 current_period_start:下轮按差值从当前起继续累计
    await setValue(token, uuid, LEDGER_KEY, raw);
  }
  return { ok: true, uuid };
}

async function dispatch(token, params) {
  if (!token) return { ok: false, error: "missing token in env" };
  const action = (params && params.action) || "get_summary";
  switch (action) {
    case "list": return await listAll(token);
    case "get_summary": return await getSummary(token);
    case "get_config": return await getConfig(token, params.uuid);
    case "set_config": return await setConfig(token, params);
    case "audit_now": return await auditAll(token);
    case "reset_node": return await resetNode(token, params.uuid);
    default: return { ok: false, error: `unknown action: ${action}` };
  }
}

// ─── 主入口 ─────────────────────────────────────────────────────────

export default {
  async onCron(params, env, ctx) {
    const token = (env && env.token) || (params && params.token);
    if (!token) return { ok: false, error: "missing token in env" };
    try { return await auditAll(token); }
    catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  },

  async onCall(params, env, ctx) {
    const token = (env && env.token) || (params && params.token);
    try { return await dispatch(token, params); }
    catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  },

  async onInlineCall(params, env, ctx) {
    const token = (env && env.token) || (params && params.token);
    try { return await dispatch(token, params); }
    catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  },

  async onRoute(request, env, ctx) {
    const token = env && env.token;
    if (!token) return json({ ok: false, error: "missing token in env" }, 500);
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();
    // CORS 预检(跨域 POST /config 等)
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type,x-route-secret",
        },
      });
    }
    try {
      // /ui /list /summary 公开(/ui 返回带登录遮罩的页面,前端据 401 弹登录);其余设了 route_secret 后必须带密钥
      const isPublic = method === "GET" && (path.endsWith("/ui") || path.endsWith("/list") || path.endsWith("/summary"));
      if (!isPublic && !authed(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
      if (method === "GET" && path.endsWith("/ui")) return html(UI_HTML);
      if (method === "GET" && path.endsWith("/list")) return json(await listAll(token));
      if (method === "GET" && path.endsWith("/summary")) return json(await getSummary(token));
      if (method === "GET" && path.endsWith("/config")) {
        return json(await getConfig(token, url.searchParams.get("uuid")));
      }
      if (method === "POST" && path.endsWith("/config")) {
        return json(await setConfig(token, await request.json()));
      }
      if (method === "POST" && path.endsWith("/audit")) return json(await auditAll(token));
      if (method === "POST" && path.endsWith("/reset")) return json(await resetNode(token, (await request.json()).uuid));
      if (method === "GET") return html(UI_HTML); // 默认给 UI
      return json({ ok: false, error: "not found" }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
    }
  },
};

// ─── 内置配置 UI(同源调用本 worker 的 /list、/config) ────────────────

var UI_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>流量监控</title>
<style>
*{box-sizing:border-box}
:root{--bg:#0a0e1a;--card:rgba(255,255,255,.035);--line:rgba(255,255,255,.08);--mut:#8b93a7;--fg:#e8ebf2;--ac1:#6366f1;--ac2:#8b5cf6}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--fg);padding:20px;min-height:100vh;
 background:radial-gradient(900px 500px at 80% -10%,rgba(124,131,255,.12),transparent),radial-gradient(700px 400px at -10% 8%,rgba(139,92,246,.10),transparent),var(--bg)}
.wrap{max-width:1220px;margin:0 auto}
.title{font-size:22px;font-weight:800;letter-spacing:.3px;background:linear-gradient(90deg,#a5b4fc,#c4b5fd);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{color:var(--mut);font-size:13px;margin-top:3px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:18px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
.stat .l{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.06em}
.stat .v{font-size:24px;font-weight:700;margin-top:6px;font-variant-numeric:tabular-nums}
.toolbar{display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap}
.search{flex:1;min-width:150px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:9px 12px;color:var(--fg);font-size:13px;outline:none}
.search::placeholder{color:var(--mut)}
.search:focus{border-color:var(--ac1)}
select,input[type=number]{background:rgba(255,255,255,.04);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:6px 8px;font-size:13px;outline:none}
select:focus,input:focus{border-color:var(--ac1)}
input[type=number]{width:74px}
.btn{border:0;border-radius:10px;padding:9px 16px;font-size:13px;font-weight:600;cursor:pointer;color:#fff;background:linear-gradient(135deg,var(--ac1),var(--ac2));transition:.15s}
.btn:hover{filter:brightness(1.12)}
.btn.ghost{background:var(--card);border:1px solid var(--line);color:var(--fg)}
.tabs{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.tab{padding:6px 14px;border-radius:999px;font-size:13px;cursor:pointer;background:var(--card);border:1px solid var(--line);color:var(--mut);transition:.15s}
.tab.on{background:linear-gradient(135deg,var(--ac1),var(--ac2));color:#fff;border-color:transparent}
.bulk{display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:linear-gradient(135deg,rgba(99,102,241,.10),rgba(139,92,246,.08));border:1px solid rgba(124,131,255,.35);border-radius:12px;padding:10px 14px;margin-bottom:12px}
.bulk.hide{display:none}
.bulk .cnt{font-weight:700}
.bulk .sep{width:1px;height:20px;background:var(--line)}
.bulk .lab{color:var(--mut);font-size:12px}
.mini{border:1px solid var(--line);border-radius:8px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;background:rgba(255,255,255,.07);color:var(--fg);transition:.15s}
.mini:hover{filter:brightness(1.15)}
.mini.warn{color:#fbbf24}.mini.danger{color:#fca5a5}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden}
.tblwrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px;min-width:860px}
th{text-align:left;padding:12px 14px;color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.05em;font-weight:600;border-bottom:1px solid var(--line)}
td{padding:11px 14px;border-bottom:1px solid rgba(255,255,255,.05);vertical-align:middle}
tr:last-child td{border-bottom:0}
tr.off{opacity:.5}
tr.focus td{background:rgba(124,131,255,.09)}
tr:hover td{background:rgba(255,255,255,.025)}
tr.sel td{background:rgba(99,102,241,.08)}
.nm{font-weight:600}
.uid{color:var(--mut);font-size:11px;font-family:ui-monospace,monospace;margin-top:2px}
.r{text-align:right}
.num{font-variant-numeric:tabular-nums;font-family:ui-monospace,monospace}
.chk{width:16px;height:16px;accent-color:var(--ac1);cursor:pointer}
.qa{display:inline-flex;align-items:center;gap:5px}
.qa .u{color:var(--mut);font-size:11px}
.sw{position:relative;display:inline-block;width:40px;height:22px}
.sw input{opacity:0;width:0;height:0}
.sl{position:absolute;inset:0;background:#2a323d;border-radius:22px;cursor:pointer;transition:.2s}
.sl:before{content:"";position:absolute;height:16px;width:16px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s}
.sw input:checked+.sl{background:linear-gradient(135deg,var(--ac1),var(--ac2))}
.sw input:checked+.sl:before{transform:translateX(18px)}
.use{min-width:128px}
.bar2{height:5px;background:rgba(255,255,255,.07);border-radius:3px;overflow:hidden;margin-top:5px}
.bar2 i{display:block;height:100%;background:linear-gradient(90deg,var(--ac1),var(--ac2))}
.bar2 i.warn{background:linear-gradient(90deg,#f59e0b,#fbbf24)}
.bar2 i.over{background:linear-gradient(90deg,#ef4444,#f87171)}
.pill{padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap}
.pill.ok{background:rgba(74,222,128,.13);color:#4ade80}
.pill.warn{background:rgba(251,191,36,.15);color:#fbbf24}
.pill.over{background:rgba(248,113,113,.15);color:#f87171}
.pill.off{background:rgba(139,149,165,.12);color:var(--mut)}
.ops{display:flex;gap:6px;justify-content:flex-end}
.save{border:1px solid var(--line);border-radius:8px;padding:6px 13px;font-size:12px;font-weight:600;cursor:pointer;background:rgba(255,255,255,.06);color:var(--fg);transition:.15s}
.save.dirty{background:linear-gradient(135deg,var(--ac1),var(--ac2));color:#fff;border-color:transparent}
.rst{border:1px solid var(--line);border-radius:8px;padding:6px 9px;font-size:12px;cursor:pointer;background:transparent;color:var(--mut)}
.rst:hover{color:#fbbf24}
.foot{color:var(--mut);font-size:12px;margin:16px 2px;line-height:1.7}
.toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(20px);background:#161b2b;border:1px solid var(--line);color:var(--fg);padding:10px 18px;border-radius:12px;font-size:13px;opacity:0;transition:.25s;pointer-events:none;box-shadow:0 10px 34px rgba(0,0,0,.45);z-index:9}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.toast.err{border-color:#f87171;color:#fca5a5}
@media(max-width:560px){body{padding:12px}.title{font-size:19px}}
</style></head><body>
<div class="wrap">
  <div class="title">流量监控</div>
  <div class="sub" id="sub">加载中…</div>
  <div class="stats" id="stats"></div>
  <div class="toolbar">
    <input class="search" id="q" placeholder="搜索节点名 / UUID…">
    <select id="sort">
      <option value="default">默认排序</option>
      <option value="used">按用量 ↓</option>
      <option value="percent">按占比 ↓</option>
      <option value="name">按名称</option>
    </select>
    <button class="btn ghost" id="refresh">刷新</button>
    <button class="btn" id="audit">立即审计</button>
  </div>
  <div class="tabs" id="tabs"></div>
  <div class="bulk hide" id="bulk">
    <span class="cnt" id="bcnt">已选 0</span>
    <span class="sep"></span>
    <button class="mini" data-bulk="on">开启监控</button>
    <button class="mini" data-bulk="off">关闭监控</button>
    <button class="mini danger" data-bulk="reset">重置本期</button>
    <span class="sep"></span>
    <span class="lab">批量设</span>
    <span class="qa"><input type="number" id="bq" min="0" placeholder="配额"><span class="u">GB</span></span>
    <select id="bmode"><option value="">方向…</option><option value="outbound">出网/上传</option><option value="inbound">入网/下载</option><option value="both">双向</option></select>
    <span class="qa"><input type="number" id="bday" min="1" max="31" placeholder="起算日"></span>
    <button class="mini" data-bulk="apply">应用到选中</button>
  </div>
  <div class="card"><div class="tblwrap"><table>
    <thead><tr>
      <th style="width:34px"><input type="checkbox" class="chk" id="all"></th>
      <th>节点</th><th>监控</th><th>起算日</th><th>计费方向</th><th>配额</th>
      <th class="r">本周期已用</th><th>状态</th><th class="r">操作</th>
    </tr></thead>
    <tbody id="rows"></tbody>
  </table></div></div>
  <div class="foot">配额留空 = 只统计用量、不限额、不告警 · 达 80% / 95% 在状态标记告警 · 「保存」即时写入,下一轮 cron 起按新设置累计 · 「重置本期」把当前周期已用清零,从现在重新计</div>
</div>
<div class="toast" id="toast"></div>
<div id="login" style="display:none;position:fixed;inset:0;z-index:99;place-items:center;background:radial-gradient(800px 500px at 50% 0%,rgba(124,131,255,.16),transparent),#0a0e1a">
  <div style="width:300px;text-align:center;padding:24px">
    <div style="font-size:44px">🔒</div>
    <div style="font-size:20px;font-weight:800;margin:8px 0;background:linear-gradient(90deg,#a5b4fc,#c4b5fd);-webkit-background-clip:text;background-clip:text;color:transparent">流量监控</div>
    <div style="color:#8b93a7;font-size:13px;margin-bottom:16px">请输入访问密钥(route_secret)登录</div>
    <input id="lk" type="password" placeholder="访问密钥" style="width:100%;background:rgba(255,255,255,.05);color:#e8ebf2;border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:11px 13px;font-size:14px;outline:none">
    <button id="lb" style="width:100%;margin-top:12px;border:0;border-radius:10px;padding:11px;font-size:14px;font-weight:700;color:#fff;background:linear-gradient(135deg,#6366f1,#8b5cf6);cursor:pointer">登录</button>
    <div id="le" style="color:#fca5a5;font-size:12px;margin-top:10px;min-height:16px"></div>
  </div>
</div>
<script>
(function(){
  var BASE=location.pathname.replace(/\\/ui$/,"").replace(/\\/$/,"");
  var HASH=new URLSearchParams(location.hash.slice(1).replace(/^\\?/,""));
  var FOCUS=HASH.get("node")||"";
  var MODES={outbound:"出网/上传",inbound:"入网/下载",both:"双向"};
  var TABS=[["all","全部"],["on","已监控"],["off","未监控"],["alert","告警"]];
  var all=[],sel=new Set(),filter="all",sortBy="default";
  function $(id){return document.getElementById(id)}
  function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
  function fmtGB(g){return g>=1024?(g/1024).toFixed(2)+" TB":(g||0).toFixed(2)+" GB"}
  var SKEY="ng_s_traffic";
  var Q=new URLSearchParams(location.search);
  var SECRET=HASH.get("s")||Q.get("s")||Q.get("secret")||localStorage.getItem(SKEY)||""; // 密钥:私密链接 #s= / ?s= / 本机记住
  function api(p,opt){
    opt=opt||{};
    if(SECRET){opt.headers=Object.assign({},opt.headers||{});opt.headers["x-route-secret"]=SECRET}
    return fetch(BASE+p,opt).then(function(r){return r.json()}); // 密钥走 header,不进 URL/日志
  }
  function toast(m,e){var t=$("toast");t.textContent=m;t.className="toast show"+(e?" err":"");setTimeout(function(){t.className="toast"+(e?" err":"")},2200)}
  function isAlert(n){var a=n.alerts_triggered||{};return n.enabled&&(a["0.8"]||a["0.95"]||(n.percent!=null&&n.percent>=80))}
  function statusPill(n){
    if(!n.enabled)return '<span class="pill off">未开启</span>';
    var a=n.alerts_triggered||{};
    if((n.percent!=null&&n.percent>=100)||a["0.95"])return '<span class="pill over">超额</span>';
    if((n.percent!=null&&n.percent>=80)||a["0.8"])return '<span class="pill warn">告警</span>';
    return '<span class="pill ok">正常</span>';
  }
  function useCell(n){
    if(!n.enabled)return '<span class="num" style="color:var(--mut)">—</span>';
    var u=fmtGB(n.used_gb||0);
    if(n.quota_gb){var p=n.percent!=null?n.percent:0,c=p>=100?"over":p>=80?"warn":"",w=Math.min(100,p);
      return '<div class="num">'+u+' / '+fmtGB(n.quota_gb)+' · '+p+'%</div><div class="bar2"><i class="'+c+'" style="width:'+w+'%"></i></div>'}
    return '<div class="num">'+u+'</div><div class="uid">不限额</div>';
  }
  function stat(l,v){return '<div class="stat"><div class="l">'+l+'</div><div class="v">'+v+'</div></div>'}
  function renderStats(){
    var en=all.filter(function(n){return n.enabled});
    var used=en.reduce(function(s,n){return s+(n.used_bytes||0)},0)/1073741824;
    var al=all.filter(isAlert).length;
    $("stats").innerHTML=stat("节点总数",all.length)+stat("已监控",en.length)+stat("合计已用",fmtGB(used))+stat("触发告警",al);
    $("sub").textContent="共 "+all.length+" 台，已开启监控 "+en.length+" 台";
  }
  function renderTabs(){
    $("tabs").innerHTML=TABS.map(function(t){
      var c={all:all.length,on:all.filter(function(n){return n.enabled}).length,off:all.filter(function(n){return !n.enabled}).length,alert:all.filter(isAlert).length}[t[0]];
      return '<div class="tab'+(filter===t[0]?" on":"")+'" data-f="'+t[0]+'">'+t[1]+' '+c+'</div>'}).join("");
    $("tabs").querySelectorAll(".tab").forEach(function(el){el.onclick=function(){filter=el.getAttribute("data-f");renderTabs();render()}});
  }
  function curList(){
    var q=($("q").value||"").trim().toLowerCase();
    var list=all.filter(function(n){
      if(filter==="on"&&!n.enabled)return false;
      if(filter==="off"&&n.enabled)return false;
      if(filter==="alert"&&!isAlert(n))return false;
      return !q||(n.name+" "+n.uuid).toLowerCase().indexOf(q)>=0;
    });
    if(sortBy==="used")list.sort(function(a,b){return (b.used_bytes||0)-(a.used_bytes||0)});
    else if(sortBy==="percent")list.sort(function(a,b){return (b.percent==null?-1:b.percent)-(a.percent==null?-1:a.percent)});
    else list.sort(function(a,b){return (a.name||"")<(b.name||"")?-1:1});
    return list;
  }
  function updateBulk(){
    $("bulk").className="bulk"+(sel.size?"":" hide");
    $("bcnt").textContent="已选 "+sel.size;
  }
  function render(){
    var list=curList(),tb=$("rows");tb.innerHTML="";
    list.forEach(function(n){
      var tr=document.createElement("tr");
      tr.className=(n.enabled?"":"off")+(n.uuid===FOCUS?" focus":"")+(sel.has(n.uuid)?" sel":"");
      tr.innerHTML=
        '<td><input type="checkbox" class="chk pick" '+(sel.has(n.uuid)?"checked":"")+'></td>'+
        '<td><div class="nm">'+esc(n.name)+'</div><div class="uid">'+n.uuid.slice(0,8)+'</div></td>'+
        '<td><label class="sw"><input type="checkbox" data-k="enabled" '+(n.enabled?"checked":"")+'><span class="sl"></span></label></td>'+
        '<td><input type="number" min="1" max="31" data-k="billing_day" value="'+n.billing_day+'"></td>'+
        '<td><select data-k="mode">'+Object.keys(MODES).map(function(m){return '<option value="'+m+'"'+(n.mode===m?" selected":"")+'>'+MODES[m]+'</option>'}).join("")+'</select></td>'+
        '<td><span class="qa"><input type="number" min="0" step="1" placeholder="不限" data-k="quota_gb" value="'+(n.quota_gb==null?"":n.quota_gb)+'"><span class="u">GB</span></span></td>'+
        '<td class="use">'+useCell(n)+'</td>'+
        '<td>'+statusPill(n)+'</td>'+
        '<td class="r"><div class="ops"><button class="save">保存</button><button class="rst" title="重置本期已用">↺</button></div></td>';
      var btn=tr.querySelector(".save");
      tr.querySelectorAll("[data-k]").forEach(function(el){el.addEventListener("change",function(){btn.classList.add("dirty")})});
      btn.onclick=function(){save(tr,n,btn)};
      tr.querySelector(".rst").onclick=function(){resetOne(n)};
      tr.querySelector(".pick").onchange=function(e){if(e.target.checked)sel.add(n.uuid);else sel.delete(n.uuid);tr.className=tr.className.replace(" sel","")+(e.target.checked?" sel":"");updateBulk()};
      tb.appendChild(tr);
    });
    $("all").checked=list.length>0&&list.every(function(n){return sel.has(n.uuid)});
    updateBulk();
    var f=tb.querySelector("tr.focus");if(f)f.scrollIntoView({block:"center"});
  }
  function payload(tr,n){var g=function(k){return tr.querySelector('[data-k="'+k+'"]')};
    return {uuid:n.uuid,enabled:g("enabled").checked,billing_day:Number(g("billing_day").value),mode:g("mode").value,quota_gb:g("quota_gb").value===""?null:Number(g("quota_gb").value)}}
  function save(tr,n,btn){btn.textContent="…";
    api("/config",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload(tr,n))}).then(function(d){
      btn.textContent="保存";if(d.ok){btn.classList.remove("dirty");toast("已保存 "+(n.name||""));load()}else toast(d.error||"保存失败",true)
    }).catch(function(e){btn.textContent="保存";toast(""+e,true)})}
  function resetOne(n){if(!confirm("重置 "+(n.name||n.uuid.slice(0,8))+" 的本期已用为 0?"))return;
    api("/reset",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({uuid:n.uuid})}).then(function(d){if(d.ok){toast("已重置 "+(n.name||""));load()}else toast(d.error||"失败",true)})}
  function bulk(act){
    var ids=[].slice.call(sel);if(!ids.length)return;
    if(act==="reset"&&!confirm("重置选中 "+ids.length+" 台的本期已用?"))return;
    var jobs=ids.map(function(uuid){
      if(act==="on")return api("/config",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({uuid,enabled:true})});
      if(act==="off")return api("/config",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({uuid,enabled:false})});
      if(act==="reset")return api("/reset",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({uuid})});
      if(act==="apply"){var b={uuid};var q=$("bq").value,m=$("bmode").value,dy=$("bday").value;
        if(q!=="")b.quota_gb=Number(q);if(m)b.mode=m;if(dy!=="")b.billing_day=Number(dy);
        return api("/config",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)})}
    });
    toast("处理 "+ids.length+" 台…");
    Promise.all(jobs).then(function(){sel.clear();toast("已应用到 "+ids.length+" 台");load()}).catch(function(e){toast(""+e,true)})
  }
  $("refresh").onclick=load;
  $("audit").onclick=function(){toast("审计中…");api("/audit",{method:"POST"}).then(function(d){toast("本轮审计 "+(d.audited||0)+" 台");load()})};
  $("q").oninput=render;
  $("sort").onchange=function(){sortBy=$("sort").value;render()};
  $("all").onchange=function(e){var list=curList();if(e.target.checked)list.forEach(function(n){sel.add(n.uuid)});else list.forEach(function(n){sel.delete(n.uuid)});render()};
  document.querySelectorAll("[data-bulk]").forEach(function(b){b.onclick=function(){bulk(b.getAttribute("data-bulk"))}});
  function load(){return api("/list").then(function(d){
    if(!d.ok){$("sub").textContent="加载失败: "+(d.error||"");return}
    all=d.nodes||[];var ids=new Set(all.map(function(n){return n.uuid}));sel.forEach(function(u){if(!ids.has(u))sel.delete(u)});
    renderStats();renderTabs();render();
  }).catch(function(e){$("sub").textContent="加载失败: "+e})}
  function showLogin(msg){$("login").style.display="grid";$("le").textContent=msg||""}
  function doLogin(){var k=$("lk").value.trim();if(!k)return;$("le").textContent="";SECRET=k;boot()}
  function boot(){api("/config").then(function(d){
    if(d&&d.error==="unauthorized"){showLogin(SECRET?"密钥错误,请重试":"");return}
    $("login").style.display="none";if(SECRET){try{localStorage.setItem(SKEY,SECRET)}catch(e){}}load();
  }).catch(function(){showLogin("")})}
  $("lb").onclick=doLogin;$("lk").onkeydown=function(e){if(e.key==="Enter")doLogin()};
  boot();
})();
</script></body></html>`;
