/**
 * Static assets for the browser-based Elwood dev app.
 * Implements PRD §11.
 */

import { clientScript } from "./web-client.ts";
import { webStyles } from "./web-styles.ts";

export { clientScript };

export function renderHtml(cwd: string): string {
  const safeCwd = escapeHtml(cwd);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Elwood Dev</title>
    <link rel="stylesheet" href="/vendor/xterm.css" />
    <style>${webStyles()}</style>
  </head>
  <body>
    <main class="shell">
      <section class="terminal-pane">
        <header class="pane-head">
          <div class="brand">Elwood</div>
          <div class="muted">PTY mirror</div>
        </header>
        <div id="terminal"></div>
      </section>
      <aside class="debug-pane">
        <form class="control-panel" id="start">
          <div class="row">
            <select name="agent" aria-label="Agent">
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
            <input name="resume" placeholder="resume elwoodSessionId" />
          </div>
          <input name="cwd" value="${safeCwd}" aria-label="Working directory" />
          <div class="row">
            <button type="submit">Start</button>
            <button type="button" id="stop">Stop</button>
            <button class="danger" type="button" id="kill">Kill</button>
            <button class="danger" type="button" id="teardown">Teardown</button>
          </div>
          <div class="muted" id="session"></div>
        </form>
        <nav class="toolbar" aria-label="Event filters">
          <button class="filter active" type="button" data-filter="all">All</button>
          <button class="filter" type="button" data-filter="hook">Hooks</button>
          <button class="filter" type="button" data-filter="activity">Activity</button>
          <button class="filter" type="button" data-filter="warning">Warnings</button>
          <button class="filter" type="button" data-filter="hookError">Hook Errors</button>
          <button class="filter" type="button" data-filter="error">Errors</button>
          <button class="filter" type="button" data-filter="terminal">Terminal</button>
        </nav>
        <section class="event-list" id="events" aria-label="Event timeline"></section>
        <section class="inspector" aria-label="Selected event details">
          <div class="inspector-head">
            <div class="head-title" id="detail-title">No event selected</div>
            <button id="copy-json" type="button">Copy JSON</button>
          </div>
          <pre id="detail-json">{}</pre>
        </section>
        <form class="prompt-panel" id="prompt">
          <textarea name="prompt" placeholder="Send a prompt"></textarea>
          <button type="submit">Send Prompt</button>
        </form>
      </aside>
    </main>
    <script type="module" src="/client.js"></script>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
