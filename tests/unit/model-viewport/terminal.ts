/** Stateful native picker windows for model navigation tests (C-API-23/24). */
import { codexReasoningScreen } from "../../helpers/model-pickers.ts";
import { scripted } from "../scripted-terminal.ts";

export function viewportTerminal(
  agent: "claude" | "codex",
  options: {
    readonly cursor?: number;
    readonly expanded?: boolean;
    readonly primary?: number;
  } = {},
) {
  const count = agent === "claude" ? 7 : 10;
  const primary = options.primary ?? 2;
  const state = {
    cursor: options.cursor ?? (agent === "claude" ? 1 : 0),
    expanded: options.expanded ?? false,
    selected: 2,
    expansions: 0,
    reasoning: false,
  };
  const items = () => {
    const models = Array.from(
      { length: state.expanded || agent === "codex" ? count : primary },
      (_, index) => index + 1,
    );
    if (agent === "claude") models.splice(primary, 0, 0);
    return models;
  };
  const render = () => {
    const all = items();
    const size = agent === "claude" ? 3 : 8;
    const start = Math.max(
      0,
      Math.min(state.cursor - (agent === "claude" ? 1 : 7), all.length - size),
    );
    const visible = all.slice(start, start + size);
    const chosen = all[state.cursor];
    const marker = agent === "claude" ? "❯" : "›";
    const header = agent === "claude" ? "Select model" : "Select Model and Effort";
    const above = start > 0 ? (agent === "claude" ? `↑ ${start} more` : "↑") : "";
    const hidden = all.length - start - visible.length;
    const below = hidden > 0 ? (agent === "claude" ? `↓ ${hidden} more` : "↓") : "";
    const rows = visible.map((number, index) => {
      const cursor = start + index === state.cursor ? marker : " ";
      if (number === 0) return `${cursor} ${state.expanded ? "▾" : "▸"}   More models`;
      const current = number === state.selected ? (agent === "claude" ? " ✔" : " (current)") : "";
      const recommended = agent === "claude" && number === 1 ? " (recommended)" : "";
      return `${cursor} ${number}. Model${number}${current}${recommended}  Model description ${number}`;
    });
    const controls = agent === "claude" && chosen !== 0 ? "◐ Medium effort (default)" : "";
    const footer =
      agent === "codex"
        ? "enter select · esc back"
        : chosen === 0
          ? `Enter to ${state.expanded ? "collapse" : "expand"} · Esc to cancel`
          : "←/→ to adjust · s to use this session only · Enter to save · Esc to cancel";
    return [header, "", above, ...rows, below, "", controls, "", footer].join("\n");
  };
  const terminal = scripted(render());
  terminal.onInput = (input) => {
    if (input === "\u001b") {
      terminal.text = agent === "claude" ? "❯ " : "› ";
      return;
    }
    if (input === "\u001b[A" || input === "\u001b[B") {
      state.cursor += input === "\u001b[B" ? 1 : -1;
      if (state.cursor < 0 || state.cursor >= items().length) throw new Error("Picker wrapped");
    }
    if (input === "\r") {
      if (agent === "claude") {
        if (items()[state.cursor] !== 0) throw new Error("Persisted a Claude model");
        state.expanded = !state.expanded;
        state.expansions += 1;
      } else {
        terminal.text = state.reasoning
          ? "• Model changed to Model10 medium\n› "
          : codexReasoningScreen;
        state.reasoning = true;
        return;
      }
    }
    if (input === "s") {
      state.selected = items()[state.cursor] as number;
      terminal.text = "❯ ";
      return;
    }
    terminal.text = render();
  };
  return { terminal, state, render };
}
