/** Observe the final native output for a confirmed Codex Quit (C-ATTN-07). */
import { deadlineClock } from "../../core/timers.ts";
import { terminalDrainTimeoutMs } from "../../runtime/shutdown/terminal.ts";
import type { ElwoodTerminal, TerminalSnapshot, XtermTerminal } from "../../terminal/headless.ts";
import { matchWorkspaceMenu } from "./target.ts";

export function restoredQuitBuffer(
  claimedBuffer: XtermTerminal["buffer"]["active"]["type"] | undefined,
  terminal: ElwoodTerminal,
  frame: TerminalSnapshot,
): boolean {
  // Older Codex Quit restores the shell buffer after leaving its fullscreen menu.
  return (
    claimedBuffer === "alternate" &&
    terminal.xterm.buffer.active.type === "normal" &&
    !matchWorkspaceMenu(frame.lines)
  );
}

export function settleQuitRender(
  terminal: Pick<ElwoodTerminal, "settled">,
  complete: (settled: boolean) => void,
): void {
  const deadlineAtMs = deadlineClock.now() + terminalDrainTimeoutMs;
  let finished = false;
  const finish = (settled: boolean) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    complete(settled);
  };
  const timer = setTimeout(() => finish(false), terminalDrainTimeoutMs);
  timer.unref();
  // Read and commit evidence here before disposal or another settlement reaction.
  void terminal.settled().then(() => finish(deadlineClock.now() < deadlineAtMs));
}
