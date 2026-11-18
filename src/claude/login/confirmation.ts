/** Acknowledge Claude's native login-success modal safely (PRD §5.3, C-API-43). */
import type { ObservedTerminal } from "../../core/input/abort.ts";
import { guardedNonTrustAutomationWrite } from "../../core/startup/barrier.ts";
import { pollDelay } from "./abort.ts";
import { isClaudeLoginSuccessDialog } from "./screens.ts";

export { isClaudeLoginSuccessDialog } from "./screens.ts";

export async function acknowledgeLoginSuccess(
  io: { readonly terminal: ObservedTerminal },
  signal: AbortSignal,
): Promise<void> {
  const read = () => io.terminal.snapshot().text;
  const write = guardedNonTrustAutomationWrite(
    io.terminal,
    (input) => io.terminal.sendInput(input),
    read,
    "claude",
    isClaudeLoginSuccessDialog,
    () => signal.aborted,
    signal,
  );
  while (isClaudeLoginSuccessDialog(read())) {
    if ((await write("\r")) === "written") return;
    await pollDelay(signal);
  }
}
