/** Acknowledge Claude's native login-success modal safely (PRD §5.3, C-API-43). */
import { elwoodError } from "../../core/errors.ts";
import type { ObservedTerminal } from "../../core/input/abort.ts";
import { guardedNonTrustAutomationWrite } from "../../core/startup/barrier.ts";
import { abortError, pollDelay } from "./abort.ts";
import { isClaudeLoginSuccessDialog } from "./screens.ts";

export { isClaudeLoginSuccessDialog } from "./screens.ts";

/**
 * Observe all received output before acknowledging, retrying withheld writes.
 * Revalidate the complete modal immediately before Enter; replacement or abort
 * prevents the write.
 */
export async function acknowledgeLoginSuccess(
  io: { readonly terminal: ObservedTerminal },
  signal: AbortSignal,
): Promise<void> {
  const read = () => io.terminal.snapshot().text;
  const write = guardedNonTrustAutomationWrite(
    io.terminal,
    async (input) => {
      try {
        await io.terminal.sendInput(input);
      } catch (error) {
        if (signal.aborted) throw abortError(signal);
        throw elwoodError("login_failed", "Claude /login acknowledgement failed.", {
          cause: (error instanceof Error ? error.message : String(error)).slice(0, 200),
        });
      }
    },
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
