"use strict";

const elements = Object.fromEntries([
  "security-mode", "security-copy", "connection-pulse", "connection-label", "mqtt-url", "uptime",
  "message-rate", "message-total", "byte-rate", "byte-total", "client-count", "device-client-count",
  "topic-count", "topic-rows", "topic-search", "clients-pill", "client-list", "devices-pill",
  "device-list", "scenario-buttons", "record-status", "message-list", "chart-empty", "toast-region",
].map((id) => [id, document.getElementById(id)]));

const model = {
  state: null,
  connected: false,
  rates: Array.from({ length: 60 }, () => ({ messages: 0, kib: 0 })),
  hiddenMessages: false,
};

const chart = document.getElementById("throughput-chart");
const context = chart.getContext("2d");

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
  return body;
}

async function refresh() {
  try {
    model.state = await request("/api/state");
    model.connected = true;
    render();
  } catch (error) {
    model.connected = false;
    renderConnection();
  }
}

function connectEvents() {
  const source = new EventSource("/api/events");
  source.addEventListener("open", () => {
    model.connected = true;
    renderConnection();
  });
  source.addEventListener("error", () => {
    model.connected = false;
    renderConnection();
  });
  source.addEventListener("lab", (event) => {
    const update = JSON.parse(event.data);
    if (update.type === "snapshot") {
      model.state = update.data;
      render();
      return;
    }
    if (update.type === "metrics") {
      if (model.state) model.state.throughput = update.data;
      pushRate(update.data);
      renderMetrics();
      drawChart();
      return;
    }
    if (update.type === "message" && model.state && !model.hiddenMessages) {
      model.state.recentMessages.unshift(update.data);
      model.state.recentMessages.length = Math.min(model.state.recentMessages.length, 100);
      renderMessages();
    }
    if (update.type === "warning") toast(update.data.message || "Broker warning", true);
    window.clearTimeout(connectEvents.refreshTimer);
    connectEvents.refreshTimer = window.setTimeout(refresh, 150);
  });
}

connectEvents.refreshTimer = 0;

function render() {
  if (!model.state) return;
  renderConnection();
  renderMetrics();
  renderTopics();
  renderClients();
  renderDevices();
  renderRecording();
  renderMessages();
}

function renderConnection() {
  elements["connection-pulse"].classList.toggle("online", model.connected);
  elements["connection-label"].textContent = model.connected ? "Broker online" : "Reconnecting";
  if (!model.state) return;
  elements["mqtt-url"].textContent = browserMqttUrl(model.state.mqttUrl);
  elements["security-mode"].textContent = model.state.localOnly ? "Localhost only" : "Authenticated remote mode";
  elements["security-copy"].textContent = model.state.localOnly
    ? "Anonymous access stays on this machine."
    : "Console and MQTT require credentials. Traffic is not TLS encrypted.";
}

function renderMetrics() {
  if (!model.state) return;
  const { throughput, clients, topics, devices } = model.state;
  elements["message-rate"].textContent = formatNumber(throughput.messageRate);
  elements["message-total"].textContent = `${formatNumber(throughput.totalMessages)} total messages`;
  elements["byte-rate"].textContent = `${formatBytes(throughput.byteRate)}/s`;
  elements["byte-total"].textContent = `${formatBytes(throughput.totalBytes)} transferred`;
  elements["client-count"].textContent = formatNumber(clients.length);
  elements["device-client-count"].textContent = `${devices.filter((device) => device.connected).length} PocketLab devices`;
  elements["topic-count"].textContent = formatNumber(topics.length);
  elements.uptime.textContent = formatDuration(model.state.uptimeMs);
}

function renderTopics() {
  const query = elements["topic-search"].value.toLowerCase();
  const topics = model.state.topics.filter((item) => item.topic.toLowerCase().includes(query));
  const body = document.createDocumentFragment();
  if (!topics.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.className = "empty";
    cell.textContent = query ? "No topic matches this filter." : "No topics yet. Start a scenario or publish a message.";
    row.append(cell); body.append(row);
  }
  for (const item of topics) {
    const row = document.createElement("tr");
    row.append(
      cell(item.topic, "topic"),
      cell(prettyPayload(item.payload, item.encoding), "payload", item.payload),
      badgeCell(String(item.qos), "qos"),
      badgeCell(item.retain ? "YES" : "NO", `retain ${item.retain ? "yes" : ""}`),
      cell(formatNumber(item.messages)),
      cell(relativeTime(item.updatedAt)),
    );
    body.append(row);
  }
  elements["topic-rows"].replaceChildren(body);
}

function renderClients() {
  const clients = model.state.clients;
  elements["clients-pill"].textContent = `${clients.length} online`;
  const list = document.createDocumentFragment();
  if (!clients.length) list.append(empty("No MQTT clients connected."));
  for (const client of clients) {
    const item = document.createElement("div"); item.className = "client-item";
    const icon = document.createElement("span"); icon.className = "client-icon"; icon.textContent = "⌁";
    const copy = document.createElement("span");
    const name = document.createElement("strong"); name.textContent = client.id;
    const since = document.createElement("small"); since.textContent = `connected ${relativeTime(client.connectedAt)}`;
    copy.append(name, since); item.append(icon, copy); list.append(item);
  }
  elements["client-list"].replaceChildren(list);
}

function renderDevices() {
  const devices = model.state.devices;
  elements["devices-pill"].textContent = `${devices.length} running`;
  const list = document.createDocumentFragment();
  if (!devices.length) list.append(empty("Your simulated fleet will appear here."));
  for (const device of devices) {
    const card = document.createElement("article"); card.className = "device-card"; card.dataset.id = device.id;
    const glyph = document.createElement("span"); glyph.className = "device-glyph"; glyph.textContent = device.type === "meter" ? "ϟ" : device.type === "co2" ? "◎" : "◒";
    const main = document.createElement("div"); main.className = "device-main";
    const heading = document.createElement("div");
    const name = document.createElement("strong"); name.textContent = device.id;
    const online = document.createElement("span"); online.className = `online-badge ${device.connected ? "" : "offline"}`; online.textContent = device.connected ? "● ONLINE" : "● OFFLINE";
    heading.append(name, online);
    if (device.fault) { const fault = document.createElement("span"); fault.className = "fault-badge"; fault.textContent = device.fault; heading.append(fault); }
    const topic = document.createElement("code"); topic.textContent = device.topic;
    const payload = document.createElement("p"); payload.textContent = device.lastPayload ? JSON.stringify(device.lastPayload) : `seed ${device.seed} · every ${device.intervalMs} ms`;
    main.append(heading, topic, payload);
    const actions = document.createElement("div"); actions.className = "device-actions";
    actions.append(
      miniButton("Disconnect", "disconnect"), miniButton("Jitter", "jitter"), miniButton("Spike", "spike"), miniButton("Stop", "remove", "remove"),
    );
    card.append(glyph, main, actions); list.append(card);
  }
  elements["device-list"].replaceChildren(list);
}

function renderRecording() {
  const recording = model.state.recording;
  const replay = model.state.replay;
  const dropped = recording.dropped > 0 ? ` · DROPPED ${recording.dropped}` : "";
  elements["record-status"].textContent = recording.active ? `REC ${recording.records}${dropped}` : replay.active ? `REPLAY ${replay.published}` : dropped ? `IDLE${dropped}` : "IDLE";
  elements["record-status"].classList.toggle("active", recording.active);
  elements["record-status"].classList.toggle("warning", recording.dropped > 0);
  document.getElementById("record-start").disabled = recording.active;
  document.getElementById("record-stop").disabled = !recording.active;
  document.getElementById("replay-stop").disabled = !replay.active;
}

function renderMessages() {
  const messages = model.hiddenMessages ? [] : model.state.recentMessages;
  const list = document.createDocumentFragment();
  if (!messages.length) list.append(empty(model.hiddenMessages ? "Message view cleared. New messages will appear here." : "Messages will stream in live."));
  for (const message of messages) {
    const item = document.createElement("article"); item.className = "message-item";
    const heading = document.createElement("div");
    const topic = document.createElement("strong"); topic.textContent = message.topic;
    const qos = document.createElement("span"); qos.className = "qos"; qos.textContent = `Q${message.qos}`;
    const time = document.createElement("time"); time.textContent = new Date(message.ts).toLocaleTimeString();
    heading.append(topic, qos, time);
    const payload = document.createElement("p"); payload.textContent = prettyPayload(message.payload, message.encoding);
    item.append(heading, payload); list.append(item);
  }
  elements["message-list"].replaceChildren(list);
}

function pushRate(throughput) {
  model.rates.push({ messages: throughput.messageRate, kib: throughput.byteRate / 1024 });
  model.rates.shift();
}

function drawChart() {
  const ratio = window.devicePixelRatio || 1;
  const bounds = chart.getBoundingClientRect();
  chart.width = Math.max(1, Math.floor(bounds.width * ratio));
  chart.height = Math.max(1, Math.floor(bounds.height * ratio));
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const width = bounds.width, height = bounds.height, padding = 8;
  context.clearRect(0, 0, width, height);
  context.strokeStyle = "#202522"; context.lineWidth = 1;
  for (let index = 1; index < 4; index += 1) {
    const y = (height / 4) * index;
    context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
  }
  const maxMessage = Math.max(1, ...model.rates.map((point) => point.messages));
  const maxKib = Math.max(1, ...model.rates.map((point) => point.kib));
  plot("#45a3ff", (point) => point.kib / maxKib, 1.2);
  plot("#c7ff4a", (point) => point.messages / maxMessage, 1.7, true);
  elements["chart-empty"].hidden = maxMessage > 1 || maxKib > 1;

  function plot(color, normalize, lineWidth, fill = false) {
    context.beginPath();
    model.rates.forEach((point, index) => {
      const x = padding + (index / (model.rates.length - 1)) * (width - padding * 2);
      const y = height - padding - normalize(point) * (height - padding * 2);
      if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
    });
    if (fill) {
      const lastX = width - padding;
      context.lineTo(lastX, height - padding); context.lineTo(padding, height - padding); context.closePath();
      const gradient = context.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, "#c7ff4a23"); gradient.addColorStop(1, "#c7ff4a00"); context.fillStyle = gradient; context.fill();
      context.beginPath();
      model.rates.forEach((point, index) => {
        const x = padding + (index / (model.rates.length - 1)) * (width - padding * 2);
        const y = height - padding - normalize(point) * (height - padding * 2);
        if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
      });
    }
    context.strokeStyle = color; context.lineWidth = lineWidth; context.stroke();
  }
}

function cell(text, className = "", title = "") { const value = document.createElement("td"); value.textContent = text; value.className = className; if (title) value.title = title; return value; }
function badgeCell(text, className) { const value = document.createElement("td"); const badge = document.createElement("span"); badge.className = className; badge.textContent = text; value.append(badge); return value; }
function miniButton(label, action, className = "") { const button = document.createElement("button"); button.type = "button"; button.className = `mini-button ${className}`; button.dataset.action = action; button.textContent = label; return button; }
function empty(copy) { const value = document.createElement("p"); value.className = "empty"; value.textContent = copy; return value; }
function formatNumber(value) { return new Intl.NumberFormat(undefined, { notation: value >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value); }
function formatBytes(bytes) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KiB`; return `${(bytes / 1048576).toFixed(1)} MiB`; }
function formatDuration(milliseconds) { const seconds = Math.floor(milliseconds / 1000); return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60].map((part) => String(part).padStart(2, "0")).join(":"); }
function relativeTime(timestamp) { const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000)); if (seconds < 5) return "now"; if (seconds < 60) return `${seconds}s ago`; if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`; return `${Math.floor(seconds / 3600)}h ago`; }
function prettyPayload(payload, encoding) { if (encoding === "base64") return `[binary · base64] ${payload}`; try { return JSON.stringify(JSON.parse(payload)); } catch { return payload; } }
function browserMqttUrl(configuredUrl) {
  try {
    const parsed = new URL(configuredUrl);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
    if (hostname === "0.0.0.0" || hostname === "::") {
      parsed.hostname = window.location.hostname;
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return configuredUrl;
  }
}

function toast(message, isError = false) {
  const item = document.createElement("div"); item.className = `toast ${isError ? "error" : ""}`; item.textContent = message;
  elements["toast-region"].append(item); window.setTimeout(() => item.remove(), 3800);
}

document.getElementById("publish-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const data = new FormData(event.currentTarget);
  try { await request("/api/publish", { method: "POST", body: JSON.stringify({ topic: data.get("topic"), payload: data.get("payload"), qos: Number(data.get("qos")), retain: data.get("retain") === "on" }) }); toast("Message accepted by the broker."); }
  catch (error) { toast(error.message, true); }
});

document.getElementById("device-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const data = new FormData(event.currentTarget);
  try { await request("/api/devices", { method: "POST", body: JSON.stringify({ type: data.get("type"), id: data.get("id"), seed: Number(data.get("seed")), intervalMs: Number(data.get("intervalMs")) }) }); toast(`Device '${data.get("id")}' started.`); await refresh(); }
  catch (error) { toast(error.message, true); }
});

elements["device-list"].addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]"); if (!button) return;
  const id = button.closest(".device-card")?.dataset.id; if (!id) return;
  try {
    if (button.dataset.action === "remove") await request(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
    else await request(`/api/devices/${encodeURIComponent(id)}/fault`, { method: "POST", body: JSON.stringify({ kind: button.dataset.action }) });
    toast(button.dataset.action === "remove" ? `Device '${id}' stopped.` : `${button.dataset.action} injected into '${id}'.`); await refresh();
  } catch (error) { toast(error.message, true); }
});

document.getElementById("record-form").addEventListener("submit", async (event) => { event.preventDefault(); const data = new FormData(event.currentTarget); try { await request("/api/recording/start", { method: "POST", body: JSON.stringify({ file: data.get("file") }) }); toast("Recording started."); await refresh(); } catch (error) { toast(error.message, true); } });
document.getElementById("record-stop").addEventListener("click", async () => { try { await request("/api/recording/stop", { method: "POST", body: "{}" }); toast("Recording saved."); await refresh(); } catch (error) { toast(error.message, true); } });
document.getElementById("replay-form").addEventListener("submit", async (event) => { event.preventDefault(); const data = new FormData(event.currentTarget); try { await request("/api/replay/start", { method: "POST", body: JSON.stringify({ file: data.get("file"), speed: Number(data.get("speed")) }) }); toast("Replay started."); await refresh(); } catch (error) { toast(error.message, true); } });
document.getElementById("replay-stop").addEventListener("click", async () => { try { await request("/api/replay/stop", { method: "POST", body: "{}" }); toast("Replay stop requested."); } catch (error) { toast(error.message, true); } });
document.getElementById("clear-messages").addEventListener("click", () => { model.hiddenMessages = true; renderMessages(); window.setTimeout(() => { model.hiddenMessages = false; }, 100); });
elements["topic-search"].addEventListener("input", renderTopics);
document.getElementById("copy-url").addEventListener("click", async () => { if (!model.state) return; const url = browserMqttUrl(model.state.mqttUrl); try { await navigator.clipboard.writeText(url); toast("MQTT URL copied."); } catch { toast(url); } });
window.addEventListener("resize", drawChart);

async function loadScenarios() {
  try {
    const scenarios = await request("/api/scenarios"); const fragment = document.createDocumentFragment();
    for (const scenario of scenarios) { const button = document.createElement("button"); button.type = "button"; button.className = "scenario-button"; button.textContent = scenario.name; button.title = scenario.description; button.addEventListener("click", async () => { try { await request(`/api/scenarios/${encodeURIComponent(scenario.id)}/start`, { method: "POST", body: "{}" }); toast(`${scenario.name} scenario started.`); await refresh(); } catch (error) { toast(error.message, true); } }); fragment.append(button); }
    elements["scenario-buttons"].replaceChildren(fragment);
  } catch (error) { toast(error.message, true); }
}

refresh(); connectEvents(); loadScenarios(); drawChart();
window.setInterval(() => { if (model.state) { model.state.uptimeMs = Date.now() - model.state.startedAt; elements.uptime.textContent = formatDuration(model.state.uptimeMs); } }, 1000);
window.setInterval(refresh, 5000);
