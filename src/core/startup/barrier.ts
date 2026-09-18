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
 * Scope is deliberate: this guards the NON-TRUST writer, never the trust writer.
 * Answering a trust gate is `TrustPromptResponder`'s own job, so vetoing it here would
 * block the one writer that is supposed to act on such a frame.
 *
 * Withholding is REPORTED, not silent. The settled frame is the first trustworthy view
 * of the screen, so a caller that decided from the pre-settle frame must be able to
 * learn its key never went out — otherwise it latches the prompt as handled and emits
 * success telemetry for a key nobody sent.
 */

import type { ElwoodAgentKind } from "../activity/index.ts";
import { type InputTerminal, writeUnsafe } from "../input/abort.ts";
import { trustView } from "../trust/view.ts";

/** What a non-trust automation write returns; void writers settle immediately. */
export type NonTrustAutomationWriter = (input: string) => void | Promise<void>;

/** `withheld`: nothing reached the PTY, and the prompt stays answerable on a later frame. */
export type AutomationWriteResult = "written" | "withheld";

/**
 * Wrap the NON-TRUST automation writer: observe all received output, then withhold the
 * key if the settled frame shows a trust gate or the caller's own `stillValid` check no
 * longer holds. `stillValid` runs AFTER settlement, so a caller whose key encodes screen
 * state (an option number, a latched prompt) can revalidate it against the frame that is
 * actually on screen rather than the one it decided from.
 */
export function guardedNonTrustAutomationWrite(
  terminal: InputTerminal,
  write: NonTrustAutomationWriter,
  readFrame: () => string,
  agent: ElwoodAgentKind,
  stillValid: (frameText: string, input: string) => boolean = () => true,
): (input: string, perWrite?: (frameText: string) => boolean) => Promise<AutomationWriteResult> {
  return async (input, perWrite) => {
    // `writeUnsafe` awaits `terminal.settled()`, so the frame read next reflects every
    // byte received before this write was requested. It fails closed when observation
    // exceeds its budget or a render has failed (C-API-56).
    if (await writeUnsafe(terminal)) return "withheld";
    const frame = readFrame();
    if (trustView(frame, agent).kind === "candidate") return "withheld";
    if (!stillValid(frame, input)) return "withheld";
    // A caller may also pass a predicate CAPTURED for this single write, so a later
    // attempt mutating shared state cannot validate an older key (#42 round 3).
    if (perWrite !== undefined && !perWrite(frame)) return "withheld";
    await write(input);
    return "written";
  };
}
