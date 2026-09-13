/**
 * Browser dev app styles.
 * Implements PRD §11.
 */

export function webStyles(): string {
  return `
:root {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  --bg: #0c0f14;
  --panel: #131720;
  --panel-2: #191f2b;
  --line: #303846;
  --text: #e9edf5;
  --muted: #9da8bb;
  --green: #4fd08a;
  --blue: #73a7ff;
  --amber: #f3c969;
  --red: #ff7b7b;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); }
button, input, select, textarea {
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #111722;
  color: inherit;
  font: inherit;
}
button { cursor: pointer; padding: 8px 10px; background: #1f6b4a; border-color: #309363; }
input, select, textarea { min-width: 0; padding: 8px 9px; }
textarea { min-height: 96px; resize: vertical; }
.shell { display: grid; grid-template-columns: minmax(0, 1fr) 500px; height: 100vh; }
.terminal-pane, .debug-pane { min-width: 0; min-height: 0; display: grid; }
.terminal-pane { grid-template-rows: auto minmax(0, 1fr); background: #05070a; }
.pane-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  min-height: 44px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--line);
  background: #0f131b;
}
.brand, .head-title { font-weight: 700; letter-spacing: 0; }
.muted { color: var(--muted); font-size: 12px; }
#terminal { min-width: 0; height: 100%; }
.debug-pane {
  grid-template-rows: auto auto minmax(0, 1fr) minmax(160px, 26vh) auto;
  border-left: 1px solid var(--line);
  background: var(--panel);
}
.control-panel, .prompt-panel { display: grid; gap: 8px; padding: 12px; border-bottom: 1px solid var(--line); }
.prompt-panel { border-top: 1px solid var(--line); border-bottom: 0; }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.toolbar {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
}
.filter {
  flex: 0 0 auto;
  padding: 6px 9px;
  background: #151b26;
  border-color: #2b3442;
  color: var(--muted);
  font-size: 12px;
}
.filter.active { color: var(--text); border-color: var(--blue); background: #1b2a42; }
.event-list { min-height: 0; overflow: auto; padding: 10px; display: grid; gap: 8px; align-content: start; }
.event-row {
  width: 100%;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 9px;
  padding: 9px;
  text-align: left;
  background: var(--panel-2);
  border-color: #2c3544;
}
.event-row.selected { outline: 1px solid var(--blue); background: #1a2433; }
.badge {
  min-width: 42px;
  height: 24px;
  display: inline-grid;
  place-items: center;
  border-radius: 5px;
  font: 700 11px ui-monospace, SFMono-Regular, Menlo, monospace;
  background: #243045;
  color: var(--blue);
}
.kind-hook .badge { color: #c59cff; }
.kind-activity .badge { color: var(--green); }
.kind-warning .badge, .level-warn .badge { color: var(--amber); }
.kind-hookError .badge, .level-error .badge { color: var(--red); }
.event-main { min-width: 0; display: grid; gap: 4px; }
.event-title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 650; }
.event-summary { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--muted); }
.event-meta { display: flex; gap: 5px; flex-wrap: wrap; }
.tag { border: 1px solid #334052; border-radius: 999px; padding: 1px 6px; color: #b9c3d4; font-size: 11px; }
.event-time { color: var(--muted); font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
.inspector {
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  border-top: 1px solid var(--line);
  background: #0f131b;
}
.inspector-head { display: flex; justify-content: space-between; gap: 8px; padding: 9px 12px; }
#copy-json { padding: 5px 8px; background: #172033; border-color: #334663; font-size: 12px; }
#detail-json {
  margin: 0;
  min-height: 0;
  overflow: auto;
  padding: 0 12px 12px;
  color: #d9e2f2;
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.danger { background: #6c2727; border-color: #934141; }
@media (max-width: 1100px) {
  .shell { grid-template-columns: 1fr; grid-template-rows: minmax(360px, 56vh) minmax(0, 44vh); }
  .debug-pane { border-left: 0; border-top: 1px solid var(--line); }
}`;
}
