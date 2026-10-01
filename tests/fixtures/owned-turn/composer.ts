/** Exact composer encoding without implicit paint acknowledgment (C-API-31/48/56). */
import { claudeComposer, claudeTty, codexSmallComposer, codexTty, tty } from "../trust-composer.ts";
import type { Agent } from "./session.ts";

export const codexIdle =
  "\u001b[2J\u001b[H› Ask Codex to do anything\r\n  gpt-5.3-codex high\u001b[1;3H";

export function emptyComposer(agent: Agent): string {
  return `\u001b[2J\u001b[H${agent === "claude" ? claudeTty(claudeComposer) : codexTty(codexSmallComposer)}`;
}

export function imageComposer(agent: Agent, chips: string, effort: boolean, title: string): string {
  const caret = agent === "claude" ? "❯" : "›";
  const idle =
    (agent === "claude" ? claudeComposer : codexSmallComposer) +
    (agent === "claude" && effort ? "\n◐ medium · /effort" : "");
  const frame = chips ? idle.replace(new RegExp(`^${caret}.*$`, "m"), `${caret} ${chips}`) : idle;
  const row = frame.split("\n").findLastIndex((line) => line.startsWith(caret));
  return `\u001b[2J\u001b[H${tty(frame)}\u001b[${row + 1};${chips ? chips.length + 3 : 3}H\u001b[?25h${title}`;
}

export function cursorFrame(
  text: string,
  x: number,
  y: number,
  visible: boolean,
  title: string,
): string {
  return `\u001b[2J\u001b[H${text.replaceAll("\n", "\r\n")}\u001b[${y + 1};${x + 1}H\u001b[?25${visible ? "h" : "l"}\u001b]0;${title}\u0007`;
}
