// 流量监控扩展 · token 鉴权（和 Docker 插件一致）
// 用 hash 里的 NodeGet token 调 js-worker_run（run_type=call）触发 worker 的 onCall，
// 再轮询 js-result_query 取结果。不再使用 worker 的 HTTP 路由 / route_secret。
// 安装时按 app.json.limits 创建的 Token 需含：JsWorker::RunDefinedJsWorker + JsResult::Read，scope=traffic-billing-worker。

const WORKER_NAME = "traffic-billing-worker"; // worker 脚本名（不是 route_name）
const RPC_URL = window.location.origin + "/nodeget/rpc";

function parseHash() {
  const h = window.location.hash;
  const q = h.startsWith("#?") ? h.slice(2) : h.slice(1);
  const p = new URLSearchParams(q);
  return { token: p.get("token") || "", node: p.get("node") || "", theme: p.get("theme") || "dark" };
}
const { token, node, theme } = parseHash();
document.documentElement.setAttribute("data-theme", theme === "light" ? "light" : "dark");
window.addEventListener("message", (e) => {
  if (e.data && e.data.type === "theme-change")
    document.documentElement.setAttribute("data-theme", e.data.theme === "light" ? "light" : "dark");
});

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const rowsEl = $("rows");
const summaryEl = $("summary");
const bannerEl = $("banner");
const cfgModal = $("cfgmodal");
const cfgError = $("cfg-error");
const confirmModal = $("confirmmodal");
const confirmMsg = $("confirm-msg");
const viewAll = $("view-all");
const viewSingle = $("view-single");
const isNode = !!node;

if (node) $("scope-label").textContent = "· 节点 " + node.slice(0, 12);
if (isNode) {
  viewAll.classList.add("hidden");
  viewSingle.classList.remove("hidden");
  $("search").style.display = "none";
}

// ---- 工具 ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function showBanner(m) { bannerEl.textContent = m; bannerEl.classList.remove("hidden"); }
function clearBanner() { bannerEl.textContent = ""; bannerEl.classList.add("hidden"); }
function updateModalLock() {
  document.body.classList.toggle("modal-open", anyModalOpen());
}
function showModal(el) {
  el.classList.remove("hidden");
  updateModalLock();
}
function hideModal(el) {
  el.classList.add("hidden");
  updateModalLock();
}
const MODE_LABEL = { outbound: "出网 ↑", inbound: "入网 ↓", both: "双向 ↕" };
const BILLING_MODE_LABEL = { period: "按周期", traffic_package: "流量包" };
const LIMIT_TYPE_LABEL = { traffic: "流量额度", cost: "金额额度" };
const CHOICE_META = {
  "cfg-mode": {
    outbound: ["出网", "上传"],
    inbound: ["入网", "下载"],
    both: ["双向", "上传 + 下载"],
  },
  "cfg-billing-mode": {
    period: ["周期", "按月重置"],
    traffic_package: ["流量包", "不限时累计"],
  },
  "cfg-limit-type": {
    traffic: ["流量", "GB 额度"],
    cost: ["金额", "单价 + 预算"],
  },
};
function billingMode(n) { return n.billing_mode === "traffic_package" ? "traffic_package" : "period"; }
function limitType(n) { return n.package_limit_type === "cost" ? "cost" : "traffic"; }
function money(unit, value) {
  if (value == null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const text = n >= 1 ? n.toFixed(2) : n.toFixed(6).replace(/0+$/, "").replace(/\.$/, ".0");
  return `${escapeHtml(unit || "$")}${text}`;
}
function readPositiveOrNull(id) {
  const raw = $(id).value.trim();
  if (raw === "") return null;
  const n = Number(raw);
  return n > 0 ? n : NaN;
}
function syncChoiceGroup(select) {
  const group = document.querySelector(`[data-choice-for="${select.id}"]`);
  if (!group) return;
  Array.from(group.children).forEach((btn) => {
    const active = btn.dataset.value === select.value;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });
}
function initChoiceGroups() {
  document.querySelectorAll("[data-choice-for]").forEach((group) => {
    const select = $(group.dataset.choiceFor);
    if (!select) return;
    const meta = CHOICE_META[select.id] || {};
    const options = Array.from(select.options);
    group.style.setProperty("--choice-count", String(options.length));
    group.innerHTML = options.map((opt) => {
      const text = meta[opt.value] || [opt.textContent, ""];
      return `<button class="choice-option" type="button" data-value="${escapeHtml(opt.value)}" aria-pressed="false">
        <span class="choice-title">${escapeHtml(text[0])}</span>
        <span class="choice-sub">${escapeHtml(text[1])}</span>
      </button>`;
    }).join("");
    group.addEventListener("click", (e) => {
      const btn = e.target.closest(".choice-option");
      if (!btn || select.value === btn.dataset.value) return;
      select.value = btn.dataset.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    select.addEventListener("change", () => syncChoiceGroup(select));
    syncChoiceGroup(select);
  });
}

// ---- RPC：js-worker_run（异步）+ js-result_query 轮询 ----
let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: ++rpcId }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const d = await res.json();
  if (d.error) throw new Error(d.error.message || "RPC error");
  return d.result;
}

async function call(action, extra) {
  const run = await rpc("js-worker_run", {
    token,
    js_script_name: WORKER_NAME,
    run_type: "call",
    params: Object.assign({ action }, extra || {}),
  });
  const id = run && run.id;
  if (id == null) throw new Error("js-worker_run 未返回 id");
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(350);
    const rows = await rpc("js-result_query", { token, query: { condition: [{ id }] } });
    const row = Array.isArray(rows) ? rows[0] : null;
    if (row && row.finish_time != null) {
      if (row.error_message) throw new Error(row.error_message);
      return row.result;
    }
  }
  throw new Error("worker 执行超时（20s）");
}

function showConfirm(msg) {
  return new Promise((resolve) => {
    confirmMsg.textContent = msg;
    showModal(confirmModal);
    const done = (v) => { hideModal(confirmModal); $("confirm-ok").onclick = null; $("confirm-cancel").onclick = null; resolve(v); };
    $("confirm-ok").onclick = () => done(true);
    $("confirm-cancel").onclick = () => done(false);
  });
}

// ---- 数据 / 渲染 ----
let nodes = [];
let loaded = false;
let lastSig = null;

function pctClass(p) { return p == null ? "" : (p >= 95 ? "crit" : (p >= 80 ? "warn" : "")); }

function renderSummary(list) {
  const monitored = list.filter((n) => n.enabled);
  const usedGb = monitored.reduce((s, n) => s + (Number(n.used_gb) || 0), 0);
  const alerting = list.filter((n) => n.percent != null && n.percent >= 80).length;
  const packageCount = monitored.filter((n) => billingMode(n) === "traffic_package").length;
  const cards = [
    { k: "节点总数", v: String(list.length) },
    { k: "已监控", v: String(monitored.length) },
    { k: packageCount ? "已用合计" : "本期合计", v: usedGb.toFixed(2) + " GB" },
    { k: "触发告警", v: String(alerting), warn: alerting > 0 },
  ];
  summaryEl.innerHTML = cards.map((c) =>
    `<div class="sumcard"><div class="k">${c.k}</div><div class="v${c.warn ? " warn" : ""}">${c.v}</div></div>`).join("");
}

function usageCell(n) {
  if (billingMode(n) === "traffic_package" && limitType(n) === "cost") {
    const pct = n.percent == null ? 0 : n.percent;
    const w = Math.min(100, Math.max(0, pct));
    if (n.budget_amount && n.unit_price_per_gb) {
      return `<div class="usage">
        <div class="txt">${(n.used_gb || 0).toFixed(2)} GB · ${money(n.budget_unit, n.cost_amount)} / ${money(n.budget_unit, n.budget_amount)}<span class="pct">${pct}%</span></div>
        <div class="progress"><i class="${pctClass(pct)}" style="width:${w}%"></i></div></div>`;
    }
    return `<span class="muted">${(n.used_gb || 0).toFixed(2)} GB · 未设置有效预算</span>`;
  }
  if (n.quota_gb) {
    const pct = n.percent == null ? 0 : n.percent;
    const w = Math.min(100, Math.max(0, pct));
    const label = billingMode(n) === "traffic_package" ? "已用流量" : "本期用量";
    return `<div class="usage">
      <div class="txt">${label} ${(n.used_gb || 0).toFixed(2)} / ${n.quota_gb} GB<span class="pct">${pct}%</span></div>
      <div class="progress"><i class="${pctClass(pct)}" style="width:${w}%"></i></div></div>`;
  }
  return `<span class="muted">${(n.used_gb || 0).toFixed(2)} GB · 不限额</span>`;
}

function renderRows() {
  const q = $("search").value.trim().toLowerCase();
  let list = nodes.slice();
  if (q) list = list.filter((n) => (n.name + " " + n.uuid).toLowerCase().includes(q));
  if (!list.length) { rowsEl.innerHTML = '<tr><td colspan="6" class="muted center">没有节点</td></tr>'; return; }
  rowsEl.innerHTML = list.map((n) => {
    const badge = n.enabled ? '<span class="badge on">监控中</span>' : '<span class="badge off">未开启</span>';
    return "<tr>" +
      `<td class="name">${escapeHtml(n.name)}</td>` +
      `<td>${badge}</td>` +
      `<td>${usageCell(n)}</td>` +
      `<td class="muted">${MODE_LABEL[n.mode] || n.mode || "—"}</td>` +
      `<td class="muted">${billingMode(n) === "traffic_package" ? `${BILLING_MODE_LABEL[billingMode(n)]} · ${LIMIT_TYPE_LABEL[limitType(n)]}` : `每月 ${n.billing_day} 号`}</td>` +
      `<td><div class="row-actions"><button class="btn btn-sm" data-cfg="${escapeHtml(n.uuid)}">配置</button></div></td>` +
      "</tr>";
  }).join("");
}

// ---- 单机视图 ----
function usageBig(n) {
  if (billingMode(n) === "traffic_package" && limitType(n) === "cost") {
    const pct = n.percent == null ? 0 : n.percent;
    const w = Math.min(100, Math.max(0, pct));
    if (n.budget_amount && n.unit_price_per_gb) {
      return `<div class="big-num">${(n.used_gb || 0).toFixed(2)} <span class="unit">GB · ${money(n.budget_unit, n.cost_amount)} / ${money(n.budget_unit, n.budget_amount)}</span> <span class="big-pct ${pctClass(pct)}">${pct}%</span></div>
        <div class="progress big"><i class="${pctClass(pct)}" style="width:${w}%"></i></div>`;
    }
    return `<div class="big-num">${(n.used_gb || 0).toFixed(2)} <span class="unit">GB</span></div><div class="muted" style="margin-top:4px">未设置有效预算 · 仅统计用量</div>`;
  }
  if (n.quota_gb) {
    const pct = n.percent == null ? 0 : n.percent;
    const w = Math.min(100, Math.max(0, pct));
    return `<div class="big-num">${(n.used_gb || 0).toFixed(2)} <span class="unit">/ ${n.quota_gb} GB</span> <span class="big-pct ${pctClass(pct)}">${pct}%</span></div>
      <div class="progress big"><i class="${pctClass(pct)}" style="width:${w}%"></i></div>`;
  }
  return `<div class="big-num">${(n.used_gb || 0).toFixed(2)} <span class="unit">GB</span></div><div class="muted" style="margin-top:4px">不限额 · 仅统计用量</div>`;
}

function renderSingle() {
  const n = nodes.find((x) => x.uuid === node);
  if (!n) {
    $("sg-name").textContent = node.slice(0, 12);
    $("sg-badge").innerHTML = '<span class="badge off">无数据</span>';
    $("sg-usage").innerHTML = '<span class="muted">该节点暂无记账数据（可能未开启监控，或 worker 尚未审计一轮）</span>';
    $("sg-meta").textContent = "";
    return;
  }
  $("sg-name").textContent = n.name;
  $("sg-badge").innerHTML = n.enabled ? '<span class="badge on">监控中</span>' : '<span class="badge off">未开启</span>';
  $("sg-usage").innerHTML = usageBig(n);
  let meta = `计费方向：${MODE_LABEL[n.mode] || n.mode || "—"} ｜ 计费模式：${BILLING_MODE_LABEL[billingMode(n)]}`;
  if (billingMode(n) === "period") meta += ` ｜ 起算日：每月 ${n.billing_day} 号`;
  if (n.remaining_gb != null) meta += ` ｜ 剩余额度 ${n.remaining_gb} GB`;
  if (n.remaining_budget_amount != null) meta += ` ｜ 剩余预算 ${n.budget_unit || "$"}${n.remaining_budget_amount}`;
  $("sg-meta").textContent = meta;
}

async function doReset(uuid, name) {
  if (!(await showConfirm(`确定重置 “${name || uuid}” 的已统计用量吗？这会把已统计用量重置为 0。`))) return;
  try {
    const r = await call("reset_node", { uuid });
    if (r && r.ok === false) throw new Error(r.error || "重置失败");
    load(true);
  } catch (e) {
    showBanner("重置失败：" + (e && e.message ? e.message : String(e)));
  }
}

async function load(silent) {
  const btn = $("refresh");
  if (!silent) btn.disabled = true;
  if (!loaded) (isNode ? $("sg-usage") : rowsEl).innerHTML = isNode ? "加载中…" : '<tr><td colspan="6" class="muted center">加载中…</td></tr>';
  try {
    const data = await call("list");
    const list = (data && data.nodes) || [];
    const sig = list.map((n) => [n.uuid, n.enabled, n.used_gb, n.quota_gb, n.mode, n.billing_day, n.billing_mode, n.package_limit_type, n.unit_price_per_gb, n.budget_amount, n.budget_unit, n.percent, n.order, n.expire_billing_day].join("|")).join("\n");
    if (sig !== lastSig) {
      lastSig = sig; nodes = list;
      if (isNode) renderSingle(); else { renderRows(); renderSummary(list); }
    }
    loaded = true;
    clearBanner();
  } catch (e) {
    showBanner("加载失败：" + (e && e.message ? e.message : String(e)) +
      "\n（确认已部署 " + WORKER_NAME + "、建了每 5 分钟定时任务，且本扩展安装时授予了 JsWorker 运行 + JsResult 读取权限）");
    if (!loaded && !isNode) rowsEl.innerHTML = '<tr><td colspan="6" class="muted center">—</td></tr>';
  } finally {
    if (!silent) btn.disabled = false;
  }
}

// ---- 配置 ----
let cfgUuid = null;
function setCfgMessage(msg, isError) {
  cfgError.textContent = msg || "";
  cfgError.classList.toggle("hidden", !msg);
  cfgError.classList.toggle("note", !isError);
}
function syncCfgFields() {
  const bm = $("cfg-billing-mode").value;
  const lt = $("cfg-limit-type").value;
  syncChoiceGroup($("cfg-mode"));
  syncChoiceGroup($("cfg-billing-mode"));
  syncChoiceGroup($("cfg-limit-type"));
  $("cfg-package-fields").classList.toggle("hidden", bm !== "traffic_package");
  $("cfg-period-fields").classList.toggle("hidden", bm === "traffic_package");
  $("cfg-cost-fields").classList.toggle("hidden", !(bm === "traffic_package" && lt === "cost"));
  $("cfg-quota").closest("label").classList.toggle("hidden", !(bm === "traffic_package" && lt === "traffic"));
  $("cfg-append-quota").disabled = !(bm === "traffic_package" && lt === "traffic");
  $("cfg-add-quota").disabled = $("cfg-append-quota").disabled;
}
function openCfg(uuid) {
  const n = nodes.find((x) => x.uuid === uuid);
  if (!n) return;
  cfgUuid = uuid;
  $("cfg-title").textContent = "配置 · " + n.name;
  $("cfg-enabled").checked = !!n.enabled;
  $("cfg-mode").value = n.mode || "both";
  $("cfg-billing-mode").value = billingMode(n);
  $("cfg-limit-type").value = limitType(n);
  $("cfg-day").value = n.billing_day || 1;
  $("cfg-quota").value = n.quota_gb == null ? "" : n.quota_gb;
  $("cfg-period-quota").value = n.quota_gb == null ? "" : n.quota_gb;
  $("cfg-unit-price").value = n.unit_price_per_gb == null ? "" : n.unit_price_per_gb;
  $("cfg-budget").value = n.budget_amount == null ? "" : n.budget_amount;
  $("cfg-budget-unit").value = n.budget_unit || "$";
  $("cfg-add-quota").value = "";
  $("cfg-day-hint").textContent = n.expire_date ? `当前到期日：${n.expire_date}` : "";
  $("cfg-day-hint").classList.toggle("hidden", !n.expire_date);
  setCfgMessage("", false);
  syncCfgFields();
  showModal(cfgModal);
}

async function saveCfg() {
  setCfgMessage("", false);
  const day = Number($("cfg-day").value);
  const billing_mode = $("cfg-billing-mode").value;
  const package_limit_type = $("cfg-limit-type").value;
  if (!(day >= 1 && day <= 31)) { cfgError.textContent = "起算日需为 1–31"; cfgError.classList.remove("hidden"); return; }
  let quota = null, unitPrice = null, budget = null;
  if (billing_mode === "traffic_package") {
    if (package_limit_type === "traffic") {
      quota = readPositiveOrNull("cfg-quota");
      if (Number.isNaN(quota)) { setCfgMessage("流量额度需大于 0，或留空只统计不提醒", true); return; }
    } else {
      unitPrice = readPositiveOrNull("cfg-unit-price");
      budget = readPositiveOrNull("cfg-budget");
      if (Number.isNaN(unitPrice)) { setCfgMessage("单价需大于 0，或留空只统计不提醒", true); return; }
      if (Number.isNaN(budget)) { setCfgMessage("预算金额需大于 0，或留空只统计不提醒", true); return; }
    }
  } else {
    quota = readPositiveOrNull("cfg-period-quota");
    if (Number.isNaN(quota)) { setCfgMessage("配额需大于 0，或留空不限额", true); return; }
  }
  const body = {
    uuid: cfgUuid,
    enabled: $("cfg-enabled").checked,
    billing_day: day,
    mode: $("cfg-mode").value,
    billing_mode,
    package_limit_type,
    quota_gb: quota,
    unit_price_per_gb: unitPrice,
    budget_amount: budget,
    budget_unit: $("cfg-budget-unit").value.trim() || "$",
  };
  const btn = $("cfg-save");
  btn.disabled = true;
  try {
    const r = await call("set_config", body);
    if (r && r.ok === false) throw new Error(r.error || "保存失败");
    hideModal(cfgModal);
    load(true);
  } catch (e) {
    cfgError.textContent = "保存失败：" + (e && e.message ? e.message : String(e));
    cfgError.classList.remove("hidden");
  } finally {
    btn.disabled = false;
  }
}

async function appendQuota() {
  if (!cfgUuid) return;
  const add = Number($("cfg-add-quota").value);
  if (!(add > 0)) { setCfgMessage("追加流量需大于 0 GB", true); return; }
  if ($("cfg-billing-mode").value !== "traffic_package" || $("cfg-limit-type").value !== "traffic") {
    setCfgMessage("追加流量仅适用于流量额度方式", true);
    return;
  }
  const btn = $("cfg-append-quota");
  btn.disabled = true;
  try {
    const r = await call("append_quota", { uuid: cfgUuid, add_gb: add });
    if (r && r.ok === false) throw new Error(r.error || "追加失败");
    $("cfg-quota").value = r.config && r.config.quota_gb != null ? r.config.quota_gb : add;
    $("cfg-add-quota").value = "";
    setCfgMessage("已追加流量，已用量未改变", false);
    await load(true);
  } catch (e) {
    setCfgMessage("追加失败：" + (e && e.message ? e.message : String(e)), true);
  } finally {
    btn.disabled = false;
    syncCfgFields();
  }
}

async function resetCurrent() {
  if (!cfgUuid) return;
  const n = nodes.find((x) => x.uuid === cfgUuid);
  hideModal(cfgModal);
  await doReset(cfgUuid, n ? n.name : cfgUuid);
}

async function auditNow() {
  const btn = $("audit");
  btn.disabled = true;
  clearBanner();
  try {
    await call("audit_now");
    await load(true);
  } catch (e) {
    showBanner("审计失败：" + (e && e.message ? e.message : String(e)));
  } finally {
    btn.disabled = false;
  }
}

// ---- 自动刷新（可见且无弹窗时，每 15s 静默）----
function anyModalOpen() {
  return !cfgModal.classList.contains("hidden") || !confirmModal.classList.contains("hidden");
}
function autoRefresh() { if (!document.hidden && !anyModalOpen()) load(true); }

// ---- 事件 ----
initChoiceGroups();
$("refresh").addEventListener("click", () => load(false));
$("audit").addEventListener("click", auditNow);
$("search").addEventListener("input", renderRows);
rowsEl.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-cfg]");
  if (b) openCfg(b.getAttribute("data-cfg"));
});
$("cfg-close").addEventListener("click", () => hideModal(cfgModal));
$("cfg-cancel").addEventListener("click", () => hideModal(cfgModal));
$("cfg-save").addEventListener("click", saveCfg);
$("cfg-reset").addEventListener("click", resetCurrent);
$("cfg-append-quota").addEventListener("click", appendQuota);
$("cfg-billing-mode").addEventListener("change", syncCfgFields);
$("cfg-limit-type").addEventListener("change", syncCfgFields);
$("cfg-expire-day").addEventListener("click", () => {
  const n = nodes.find((x) => x.uuid === cfgUuid);
  if (n && n.expire_billing_day >= 1 && n.expire_billing_day <= 31) {
    $("cfg-day").value = n.expire_billing_day;
    $("cfg-day-hint").textContent = `已从到期日 ${n.expire_date || n.expire_time} 填入 ${n.expire_billing_day} 号`;
  } else {
    $("cfg-day").value = 1;
    $("cfg-day-hint").textContent = "未读取到有效到期日，已填入 1 号";
  }
  $("cfg-day-hint").classList.remove("hidden");
});
cfgModal.addEventListener("click", (e) => { if (e.target === cfgModal) hideModal(cfgModal); });
$("sg-config").addEventListener("click", () => openCfg(node));
$("sg-reset").addEventListener("click", () => { const n = nodes.find((x) => x.uuid === node); doReset(node, n ? n.name : node); });

// ---- 启动 ----
if (!token) {
  showBanner("缺少 token：请通过 board 的扩展入口打开本页面。");
} else {
  load(false);
  setInterval(autoRefresh, 15000);
}
