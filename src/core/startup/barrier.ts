/**
 * A render-settlement barrier for NON-TRUST automated startup writes.
 * Implements PRD §5.1/§5.4 and C-API-56: rendering is asynchronous (§4.1), so a trust
 * gate can be RECEIVED while the last observed frame is still the previous screen.
 * Startup automation decides from that observed frame, so without a barrier the Codex
 * update skip or the Claude browser-tools decline can write into a gate that has
 * arrived but not been classified. `trustView(...).kind === "candidate"` is the veto:
 * any allowlisted gate, including a hold-only one whose body is unsupported. Each write
 * therefore observes everything received, fails closed when it cannot, and only then
 * re-checks the settled frame.
 *
 * Scope is deliberate: this guards `writeAutomation`, never the trust writer. Answering
 * a trust gate is `TrustPromptResponder`'s own job, so vetoing it here would block the
 * one writer that is supposed to act on such a frame.
 */

import type { ElwoodAgentKind } from "../activity/index.ts";
import { type InputTerminal, writeUnsafe } from "../input/abort.ts";
import { trustView } from "../trust/view.ts";

/** What an automation write returns: adapters await it, void writers settle immediately. */
export type AutomationWrite = (input: string) => void | Promise<void>;

/**
 * Wrap the NON-TRUST automation writer: observe all received output, then withhold the
 * key if the freshly settled frame shows a trust gate. Withholding is silent and safe —
 * the prompt stays answerable on a later frame — so it is not a write failure and emits
 * neither a `startup_prompt` activity nor a warning.
 */
export function guardedAutomationWrite(
  terminal: InputTerminal,
  write: AutomationWrite,
  readFrame: () => string,
  agent: ElwoodAgentKind,
): (input: string) => Promise<void> {
  return async (input) => {
    // `writeUnsafe` awaits `terminal.settled()`, so the frame read next reflects every
    // byte received before this write was requested. It fails closed when observation
    // exceeds its budget or a render has failed (C-API-56).
    if (await writeUnsafe(terminal)) return;
    if (trustView(readFrame(), agent).kind === "candidate") return;
    await write(input);
  };
}
