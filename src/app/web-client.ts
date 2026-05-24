/**
 * Browser dev app client script.
 * Implements PRD §11.
 */

export function clientScript(): string {
  return `import { Terminal } from "/vendor/xterm.mjs";
import { FitAddon } from "/vendor/addon-fit.mjs";

const terminal = new Terminal({
  convertEol: true,
  cursorBlink: true,
  fontSize: 13,
  theme: { background: "#05070a" },
});
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(document.getElementById("terminal"));
fit.fit();

const socket = new WebSocket("ws://" + location.host);
const events = [];
const list = document.getElementById("events");
const session = document.getElementById("session");
const detailTitle = document.getElementById("detail-title");
const detailJson = document.getElementById("detail-json");
let activeFilter = "all";
let selectedId = "";
let sessionActive = false;

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.type === "terminal") terminal.write(message.data);
  if (message.type === "event") addEvent(message.entry);
  if (message.type === "log") addEvent(logEntry(message));
  if (message.type === "status") session.dataset.status = message.status;
  if (message.type === "session") {
    sessionActive = true;
    session.textContent = message.id + " / " + message.status;
  }
  if (message.type === "error") addEvent(errorEntry(message));
});

terminal.onData((value) => {
  if (sessionActive) send({ type: "keys", value });
});
window.addEventListener("resize", () => {
  fit.fit();
  if (sessionActive) send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
});

document.getElementById("start").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  send({
    type: "start",
    agent: String(form.get("agent") || "claude"),
    cwd: String(form.get("cwd") || "."),
    resumeSessionId: String(form.get("resume") || "") || undefined,
    cols: terminal.cols,
    rows: terminal.rows,
  });
});

document.getElementById("prompt").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  send({ type: "prompt", value: String(form.get("prompt") || "") });
});

document.getElementById("kill").addEventListener("click", () => {
  if (sessionActive) send({ type: "kill" });
});
document.getElementById("copy-json").addEventListener("click", () => {
  if (navigator.clipboard) void navigator.clipboard.writeText(detailJson.textContent || "");
});

for (const button of document.querySelectorAll("[data-filter]")) {
  button.addEventListener("click", () => {
    activeFilter = button.dataset.filter || "all";
    for (const entry of document.querySelectorAll("[data-filter]")) {
      entry.classList.toggle("active", entry === button);
    }
    renderEvents();
  });
}

function send(message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function addEvent(entry) {
  events.push(entry);
  if (events.length > 500) events.shift();
  selectedId ||= entry.id;
  renderEvents();
  if (selectedId === entry.id) renderDetail(entry);
}

function renderEvents() {
  const rows = events.filter((entry) => activeFilter === "all" || entry.kind === activeFilter);
  list.replaceChildren(...rows.map(eventRow));
  list.scrollTop = list.scrollHeight;
  if (rows.length && !rows.some((entry) => entry.id === selectedId)) selectEvent(rows[rows.length - 1]);
}

function eventRow(entry) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "event-row kind-" + entry.kind + " level-" + entry.level;
  row.classList.toggle("selected", entry.id === selectedId);
  row.addEventListener("click", () => selectEvent(entry));
  row.append(badge(entry), main(entry), time(entry.timestamp));
  return row;
}

function badge(entry) {
  const node = document.createElement("span");
  node.className = "badge";
  node.textContent = entry.badge;
  return node;
}

function main(entry) {
  const node = document.createElement("span");
  node.className = "event-main";
  const title = document.createElement("span");
  title.className = "event-title";
  title.textContent = entry.title;
  const summary = document.createElement("span");
  summary.className = "event-summary";
  summary.textContent = entry.summary;
  node.append(title, summary, tags(entry.tags || []));
  return node;
}

function tags(values) {
  const node = document.createElement("span");
  node.className = "event-meta";
  for (const value of values.slice(0, 4)) {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = value;
    node.append(tag);
  }
  return node;
}

function time(timestamp) {
  const node = document.createElement("span");
  node.className = "event-time";
  node.textContent = new Date(timestamp).toLocaleTimeString();
  return node;
}

function selectEvent(entry) {
  selectedId = entry.id;
  renderDetail(entry);
  renderEvents();
}

function renderDetail(entry) {
  detailTitle.textContent = entry.badge + " " + entry.title;
  detailJson.textContent = JSON.stringify(entry.raw ?? entry, null, 2);
}

function nowEntry(kind, level, badge, title, summary, raw) {
  return {
    id: "client-" + Date.now() + "-" + Math.random().toString(16).slice(2),
    timestamp: new Date().toISOString(),
    kind,
    level,
    badge,
    title,
    summary,
    raw,
  };
}

function logEntry(message) {
  return nowEntry("log", message.level, "LOG", "Legacy log", message.text, message);
}

function errorEntry(message) {
  return nowEntry("error", "error", "ERR", "Runtime error", message.message, message);
}`;
}
