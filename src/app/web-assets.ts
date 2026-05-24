/**
 * Static assets for the browser-based Elwood dev app.
 * Implements PRD §10.
 */

export function renderHtml(cwd: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Elwood Dev</title>
    <link rel="stylesheet" href="/vendor/xterm.css" />
    <style>
      :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; background: #111318; color: #e6e8ee; }
      main { display: grid; grid-template-columns: minmax(0, 1fr) 380px; height: 100vh; }
      #terminal { min-width: 0; height: 100%; background: #05070a; }
      aside { border-left: 1px solid #30343d; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; }
      form, .controls { display: grid; gap: 8px; padding: 12px; border-bottom: 1px solid #30343d; }
      input, textarea, button { font: inherit; color: inherit; background: #1a1d24; border: 1px solid #3b404c; border-radius: 6px; padding: 8px; }
      button { cursor: pointer; background: #24533f; border-color: #347755; }
      textarea { min-height: 96px; resize: vertical; }
      #log { overflow: auto; padding: 10px 12px; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; }
      .row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .error { color: #ff8a8a; }
      .muted { color: #9aa3b2; }
    </style>
  </head>
  <body>
    <main>
      <div id="terminal"></div>
      <aside>
        <form id="start">
          <select name="agent">
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
          <input name="cwd" value="${cwd}" />
          <input name="resume" placeholder="resume elwoodSessionId" />
          <div class="row">
            <button type="submit">Start</button>
            <button type="button" id="kill">Kill</button>
          </div>
          <div class="muted" id="session"></div>
        </form>
        <div id="log"></div>
        <form id="prompt">
          <textarea name="prompt" placeholder="Send a prompt"></textarea>
          <button type="submit">Send Prompt</button>
        </form>
      </aside>
    </main>
    <script type="module" src="/client.js"></script>
  </body>
</html>`;
}

export function clientScript(): string {
  return `import { Terminal } from "/vendor/xterm.mjs";
import { FitAddon } from "/vendor/addon-fit.mjs";

const terminal = new Terminal({ convertEol: true, cursorBlink: true, fontSize: 13, theme: { background: "#05070a" } });
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(document.getElementById("terminal"));
fit.fit();

const socket = new WebSocket(\`ws://\${location.host}\`);
const log = document.getElementById("log");
const session = document.getElementById("session");

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.type === "terminal") terminal.write(message.data);
  if (message.type === "log") appendLog(message.text, message.level);
  if (message.type === "status") appendLog(\`status \${message.status}\`);
  if (message.type === "session") session.textContent = message.id;
  if (message.type === "error") appendLog(message.message, "error");
});

terminal.onData((value) => send({ type: "keys", value }));
window.addEventListener("resize", () => {
  fit.fit();
  send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
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

document.getElementById("kill").addEventListener("click", () => send({ type: "kill" }));

function send(message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function appendLog(text, level = "info") {
  const line = document.createElement("div");
  line.className = level === "error" ? "error" : "";
  line.textContent = \`\${new Date().toLocaleTimeString()}  \${text}\`;
  log.append(line);
  log.scrollTop = log.scrollHeight;
}`;
}
