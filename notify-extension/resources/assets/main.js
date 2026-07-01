// 消息通知扩展 · token 鉴权（和 Docker / 流量监控插件一致）
// 用 hash 里的 NodeGet token 调 js-worker_run（run_type=call）触发 notify-worker 的 onCall，
// 再轮询 js-result_query 取结果。不再跳转 worker 的 /ui，也不用 route_secret。
// 安装时按 app.json.limits 创建的 Token 需含：JsWorker::RunDefinedJsWorker + JsResult::Read，scope=notify-worker。

const WORKER_NAME = "notify-worker"; // worker 脚本名（不是 route_name）
const RPC_URL = window.location.origin + "/nodeget/rpc";

function parseHash() {
  const h = window.location.hash;
  const q = h.startsWith("#?") ? h.slice(2) : h.slice(1);
  const p = new URLSearchParams(q);
  return { token: p.get("token") || "", theme: p.get("theme") || "dark" };
}
const { token, theme } = parseHash();
document.documentElement.setAttribute("data-theme", theme === "light" ? "light" : "dark");
window.addEventListener("message", (e) => {
  if (e.data && e.data.type === "theme-change")
    document.documentElement.setAttribute("data-theme", e.data.theme === "light" ? "light" : "dark");
});

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const bannerEl = $("banner");
const toastEl = $("toast");
const EVENTS = ["offline", "online", "resource", "expire", "traffic"];
const EVENT_LABELS = { offline: "离线", online: "恢复", resource: "资源", expire: "到期", traffic: "流量" };
const DEFAULT_TARGET_EVENTS = { offline: true, online: true, resource: true, expire: true, traffic: false };
const RESOURCE_TYPES = ["cpu", "memory", "disk"];
const RESOURCE_LABELS = { cpu: "CPU", memory: "内存", disk: "磁盘" };
let targetRows = [];
let nodeRows = [];

function showBanner(m) { bannerEl.textContent = m; bannerEl.classList.remove("hidden"); }
function clearBanner() { bannerEl.textContent = ""; bannerEl.classList.add("hidden"); }
let toastTimer = null;
function toast(m, kind) {
  toastEl.textContent = m;
  toastEl.className = "toast show" + (kind ? " " + kind : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = "toast" + (kind ? " " + kind : ""); }, 2400);
}

// ---- RPC：js-worker_run（异步）+ js-result_query 轮询 ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    await sleep(350);
    const rows = await rpc("js-result_query", { token, query: { condition: [{ id }] } });
    const row = Array.isArray(rows) ? rows[0] : null;
    if (row && row.finish_time != null) {
      if (row.error_message) throw new Error(row.error_message);
      return row.result;
    }
  }
  throw new Error("worker 执行超时（25s）");
}

// ---- 表单填充 / 收集 ----
function configureSecretInput(id, isSet, hint, emptyPlaceholder) {
  const input = $(id);
  const toggle = document.querySelector('.secret-toggle[data-target="' + id + '"]');
  input.value = "";
  input.type = "password";
  input.dataset.maskedPlaceholder = isSet ? "********，留空不修改" : emptyPlaceholder;
  input.dataset.visiblePlaceholder = isSet ? "已配置 " + (hint || "") + "，留空不修改" : emptyPlaceholder;
  input.placeholder = input.dataset.maskedPlaceholder;
  if (toggle) {
    toggle.classList.remove("on");
    const label = toggle.getAttribute("aria-label") || "显示";
    const normalized = label.replace(/^隐藏/, "显示");
    toggle.setAttribute("aria-label", normalized);
    toggle.setAttribute("title", normalized);
  }
}
function setupSecretToggles() {
  document.querySelectorAll(".secret-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = $(btn.dataset.target);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      input.placeholder = show ? input.dataset.visiblePlaceholder : input.dataset.maskedPlaceholder;
      btn.classList.toggle("on", show);
      const base = btn.dataset.target === "bot_token" ? "Bot Token" : "Webhook 管理密钥";
      const label = (show ? "隐藏 " : "显示 ") + base;
      btn.setAttribute("aria-label", label);
      btn.setAttribute("title", label);
    });
  });
}
function normalizeEventFlags(events, fallback) {
  events = events && typeof events === "object" ? events : {};
  fallback = fallback && typeof fallback === "object" ? fallback : DEFAULT_TARGET_EVENTS;
  return {
    offline: events.offline != null ? events.offline !== false : fallback.offline !== false,
    online: events.online != null ? events.online !== false : fallback.online !== false,
    resource: events.resource != null ? events.resource === true : fallback.resource === true,
    expire: events.expire != null ? events.expire !== false : fallback.expire !== false,
    traffic: events.traffic != null ? events.traffic === true : fallback.traffic === true,
  };
}
function blankTarget() {
  return { name: "", chat_id: "", message_thread_id: "", events: { ...DEFAULT_TARGET_EVENTS }, enabled: true };
}
function normalizeTarget(target, fallbackEvents) {
  target = target && typeof target === "object" ? target : {};
  return {
    name: String(target.name || "").trim(),
    chat_id: String(target.chat_id || target.chatId || "").trim(),
    message_thread_id: String(target.message_thread_id || target.messageThreadId || "").trim(),
    events: normalizeEventFlags(target.events, fallbackEvents),
    enabled: target.enabled !== false,
  };
}
function parseLegacyTargets(c) {
  const fallbackEvents = normalizeEventFlags(c.events);
  return String(c.chat_id || "")
    .split(/[,\r\n]+/)
    .map((chatId) => chatId.trim())
    .filter(Boolean)
    .map((chatId) => normalizeTarget({ chat_id: chatId, message_thread_id: c.message_thread_id, events: fallbackEvents }, fallbackEvents));
}
function setCellLabel(cell, text) {
  const span = document.createElement("span");
  span.className = "cell-label";
  span.textContent = text;
  cell.appendChild(span);
}
function makeTextInput(value, placeholder, onInput) {
  const input = document.createElement("input");
  input.className = "input target-input";
  input.value = value || "";
  input.placeholder = placeholder;
  input.addEventListener("input", () => onInput(input.value));
  return input;
}
function makeCheckbox(checked, label, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "target-check";
  wrap.title = label;
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = !!checked;
  input.setAttribute("aria-label", label);
  input.addEventListener("change", () => onChange(input.checked));
  wrap.appendChild(input);
  return wrap;
}
function makePillSwitch(checked, label, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "pill-switch";
  wrap.title = label;
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = !!checked;
  input.setAttribute("aria-label", label);
  const track = document.createElement("span");
  track.className = "pill-track";
  input.addEventListener("change", () => onChange(input.checked));
  wrap.appendChild(input);
  wrap.appendChild(track);
  return wrap;
}
function renderTargets() {
  const body = $("targets_body");
  body.textContent = "";
  targetRows.forEach((target, index) => {
    const row = document.createElement("tr");

    const nameCell = document.createElement("td");
    setCellLabel(nameCell, "名称");
    nameCell.appendChild(makeTextInput(target.name, "可选", (value) => { targetRows[index].name = value.trim(); }));
    row.appendChild(nameCell);

    const chatCell = document.createElement("td");
    setCellLabel(chatCell, "Chat ID");
    chatCell.appendChild(makeTextInput(target.chat_id, "-100xxxxxx", (value) => { targetRows[index].chat_id = value.trim(); }));
    row.appendChild(chatCell);

    const threadCell = document.createElement("td");
    setCellLabel(threadCell, "话题 ID");
    threadCell.appendChild(makeTextInput(target.message_thread_id, "可选", (value) => { targetRows[index].message_thread_id = value.trim(); }));
    row.appendChild(threadCell);

    EVENTS.forEach((ev) => {
      const cell = document.createElement("td");
      cell.className = "target-flag";
      setCellLabel(cell, EVENT_LABELS[ev]);
      cell.appendChild(makeCheckbox(target.events[ev], EVENT_LABELS[ev], (checked) => { targetRows[index].events[ev] = checked; }));
      row.appendChild(cell);
    });

    const enabledCell = document.createElement("td");
    enabledCell.className = "target-flag";
    setCellLabel(enabledCell, "启用");
    enabledCell.appendChild(makeCheckbox(target.enabled, "启用", (checked) => { targetRows[index].enabled = checked; }));
    row.appendChild(enabledCell);

    const actionCell = document.createElement("td");
    actionCell.className = "target-action";
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn btn-ghost btn-xs";
    del.textContent = "删除";
    del.addEventListener("click", () => {
      targetRows.splice(index, 1);
      if (!targetRows.length) targetRows.push(blankTarget());
      renderTargets();
    });
    actionCell.appendChild(del);
    row.appendChild(actionCell);

    body.appendChild(row);
  });
}
function collectTargets() {
  const rows = targetRows.map((target) => normalizeTarget(target, DEFAULT_TARGET_EVENTS));
  const filled = rows.filter((target) => target.chat_id || target.name || target.message_thread_id);
  const missingChat = filled.find((target) => !target.chat_id);
  if (missingChat) throw new Error("通知目标「" + (missingChat.name || "未命名") + "」缺少 Chat ID");
  return filled.filter((target) => target.chat_id);
}
function normalizeResourceRules(rules) {
  rules = rules && typeof rules === "object" ? rules : {};
  const out = {};
  RESOURCE_TYPES.forEach((type) => {
    const rule = rules[type] || {};
    out[type] = {
      threshold_pct: Number(rule.threshold_pct) || 90,
      duration_sec: Number(rule.duration_sec) || 300,
    };
  });
  return out;
}
function normalizeNodeRuleFlags(rules) {
  rules = rules && typeof rules === "object" ? rules : {};
  const out = {};
  RESOURCE_TYPES.forEach((type) => {
    out[type] = { enabled: !!(rules[type] && rules[type].enabled) };
  });
  return out;
}
function buildNodeRows(configNodes, availableNodes) {
  const configMap = new Map((Array.isArray(configNodes) ? configNodes : []).map((node) => [node.uuid, node]));
  return (Array.isArray(availableNodes) ? availableNodes : []).map((node) => {
    const saved = configMap.get(node.uuid) || {};
    return {
      uuid: node.uuid,
      name: saved.name || node.name || node.uuid.slice(0, 8),
      order: node.order == null ? null : node.order,
      rules: normalizeNodeRuleFlags(saved.rules),
    };
  });
}
function renderNodes() {
  const body = $("nodes_body");
  if (!body) return;
  body.textContent = "";
  if (!nodeRows.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.className = "muted empty-cell";
    cell.textContent = "未读取到节点列表";
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }
  nodeRows.forEach((node, index) => {
    const row = document.createElement("tr");

    const nameCell = document.createElement("td");
    setCellLabel(nameCell, "节点");
    const name = document.createElement("div");
    name.className = "node-name";
    name.textContent = node.name || node.uuid.slice(0, 8);
    const uuid = document.createElement("div");
    uuid.className = "node-uuid";
    uuid.textContent = node.uuid;
    nameCell.appendChild(name);
    nameCell.appendChild(uuid);
    row.appendChild(nameCell);

    RESOURCE_TYPES.forEach((type) => {
      const cell = document.createElement("td");
      cell.className = "target-flag";
      setCellLabel(cell, RESOURCE_LABELS[type]);
      cell.appendChild(makePillSwitch(node.rules[type].enabled, RESOURCE_LABELS[type], (checked) => { nodeRows[index].rules[type].enabled = checked; }));
      row.appendChild(cell);
    });

    body.appendChild(row);
  });
}
function collectNodes() {
  return nodeRows.map((node) => ({
    uuid: node.uuid,
    name: node.name,
    order: node.order == null ? null : node.order,
    rules: normalizeNodeRuleFlags(node.rules),
  }));
}
function fill(c, availableNodes) {
  c = c || {};
  $("enabled").checked = !!c.enabled;
  $("offline_threshold_sec").value = c.offline_threshold_sec || 90;
  $("template").value = c.template || "";
  $("resource_template").value = c.resource_template || "";
  $("renew_template").value = c.renew_template || "";
  $("traffic_template").value = c.traffic_template || "";
  configureSecretInput("bot_token", c.bot_token_set, c.bot_token_hint, "123456:ABC-DEF...");
  targetRows = Array.isArray(c.targets) && c.targets.length
    ? c.targets.map((target) => normalizeTarget(target, c.events))
    : parseLegacyTargets(c);
  if (!targetRows.length) targetRows = [blankTarget()];
  renderTargets();
  $("endpoint").value = c.endpoint || "https://api.telegram.org/bot";
  configureSecretInput("webhook_admin_secret", c.webhook_admin_secret_set, c.webhook_admin_secret_hint, "可选，建议使用长随机字符");
  const resourceRules = normalizeResourceRules(c.resource_rules);
  $("cpu_threshold").value = resourceRules.cpu.threshold_pct;
  $("memory_threshold").value = resourceRules.memory.threshold_pct;
  $("disk_threshold").value = resourceRules.disk.threshold_pct;
  $("resource_duration_sec").value = resourceRules.cpu.duration_sec || 300;
  $("expire_days").value = c.expire_days || 7;
  $("traffic_threshold").value = c.traffic_threshold || 80;
  nodeRows = buildNodeRows(c.nodes, availableNodes || []);
  renderNodes();
}
function collect() {
  const targets = collectTargets();
  const duration = Number($("resource_duration_sec").value) || 300;
  return {
    enabled: $("enabled").checked,
    channel: "telegram",
    bot_token: $("bot_token").value.trim(), // 留空 = 保留原 token（worker 端处理）
    targets,
    webhook_admin_secret: $("webhook_admin_secret").value.trim(),
    endpoint: $("endpoint").value.trim(),
    nodes: collectNodes(),
    offline_threshold_sec: Number($("offline_threshold_sec").value) || 90,
    resource_rules: {
      cpu: { threshold_pct: Number($("cpu_threshold").value) || 90, duration_sec: duration },
      memory: { threshold_pct: Number($("memory_threshold").value) || 90, duration_sec: duration },
      disk: { threshold_pct: Number($("disk_threshold").value) || 90, duration_sec: duration },
    },
    template: $("template").value,
    resource_template: $("resource_template").value,
    renew_template: $("renew_template").value,
    traffic_template: $("traffic_template").value,
    expire_days: Number($("expire_days").value) || 7,
    traffic_threshold: Number($("traffic_threshold").value) || 80,
  };
}

// ---- 状态条 ----
function fmtAgo(ms) {
  if (!ms) return null;
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return s + " 秒前";
  if (s < 3600) return Math.floor(s / 60) + " 分钟前";
  if (s < 86400) return Math.floor(s / 3600) + " 小时前";
  return Math.floor(s / 86400) + " 天前";
}
function showStatus(st) {
  const el = $("status"), tx = $("status-text");
  if (!st) { el.className = "statusbar idle"; tx.textContent = "—"; return; }
  const ago = fmtAgo(st.last_run);
  if (!ago) {
    el.className = "statusbar warn";
    tx.textContent = "尚未运行过检测 —— 请在「定时任务」配置 notify-worker（建议 cron */30 * * * * *）";
  } else {
    el.className = "statusbar";
    tx.textContent = "上次检测 " + ago + " · 发出 " + (st.last_sent || 0) + " 条" + (st.last_note ? " · " + st.last_note : "");
  }
}

// ---- 加载 / 保存 / 测试 / 检测 ----
async function load() {
  try {
    const d = await call("get_config");
    if (!d || d.ok === false) throw new Error((d && d.error) || "加载失败");
    fill(d.config, d.available_nodes);
    showStatus(d.state);
    if (d.node_error) showBanner("节点列表读取失败：" + d.node_error);
    else clearBanner();
  } catch (e) {
    showBanner("加载失败：" + (e && e.message ? e.message : String(e)) +
      "\n（确认已部署 " + WORKER_NAME + "，且本扩展安装时授予了 JsWorker 运行 + JsResult 读取权限）");
    $("status").className = "statusbar idle";
    $("status-text").textContent = "—";
  }
}
async function save() {
  const btn = $("save");
  btn.disabled = true;
  try {
    const d = await call("set_config", { config: collect() });
    if (!d || d.ok === false) throw new Error((d && d.error) || "保存失败");
    fill(d.config); // 回填打码后的最新配置
    toast("已保存", "ok");
    return true;
  } catch (e) {
    toast("保存失败：" + (e && e.message ? e.message : String(e)), "err");
    return false;
  } finally {
    btn.disabled = false;
  }
}
async function testSend() {
  if (!(await save())) return;
  const btn = $("test");
  btn.disabled = true;
  toast("发送中…");
  try {
    const d = await call("test");
    toast(d && d.ok ? "测试消息已发送" : "发送失败：" + ((d && d.error) || ""), d && d.ok ? "ok" : "err");
  } catch (e) {
    toast("发送失败：" + (e && e.message ? e.message : String(e)), "err");
  } finally {
    btn.disabled = false;
  }
}
async function runNow() {
  if (!(await save())) return;
  const btn = $("run");
  btn.disabled = true;
  toast("检测中…");
  try {
    const d = await call("run");
    if (d && d.ok) {
      toast(d.skipped ? "已跳过：" + d.skipped : "已检测 · 发出 " + (d.sent || 0) + " 条", "ok");
      await load();
    } else {
      toast("检测失败：" + ((d && d.error) || ""), "err");
    }
  } catch (e) {
    toast("检测失败：" + (e && e.message ? e.message : String(e)), "err");
  } finally {
    btn.disabled = false;
  }
}

// ---- 事件绑定 ----
$("save").addEventListener("click", save);
$("test").addEventListener("click", testSend);
$("run").addEventListener("click", runNow);
$("add_target").addEventListener("click", () => {
  targetRows.push(blankTarget());
  renderTargets();
});
setupSecretToggles();

// ---- 启动 ----
if (!token) {
  showBanner("缺少 token：请通过 board 的扩展入口打开本页面。");
} else {
  load();
}
