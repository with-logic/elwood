/**
 * The writers and readers that each rendered Claude frame answers its first-party prompts
 * with: plain automated input for trust, the guarded writer that withholds other automated
 * keys once their prompt has cleared, and the terminal's settled frame.
 * Implements PRD §5.1, C-CLAUDE-16, C-CLAUDE-26 and C-CLAUDE-27.
 */
import type { InputTerminal } from "../../core/input/abort.ts";
import {
  type AutomationWriteResult,
  guardedNonTrustAutomationWrite,
  type NonTrustAutomationWriter,
} from "../../core/startup/barrier.ts";
import type { SettledStartupOutcome } from "../../core/startup/write.ts";
import { withAutomatedInput } from "../../runtime/session/session-input.ts";
import { settledLiveSnapshot } from "../../terminal/cursor.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { isClaudeAutoModeOfferMenu } from "../auto-mode/offer.ts";
import {
  browserToolsPromptVisible,
  type ClaudeStartupPromptResponder,
} from "../startup-prompts.ts";

/**
 * The Claude non-trust automation barrier. A decline is only correct while its own
 * prompt is still on screen: if the prompt cleared during settlement, an Escape would
 * land in whatever replaced it (a composer, clearing staged text), so it is withheld.
 * A writer may narrow that to one prompt for a single write.
 */
export function guardedClaudeAutomationWrite(
  terminal: InputTerminal,
  write: NonTrustAutomationWriter,
  readFrame: () => string,
  cancelled: () => boolean = () => false,
  signal?: AbortSignal,
): (input: string, stillValid?: (frameText: string) => boolean) => Promise<AutomationWriteResult> {
  return guardedNonTrustAutomationWrite(
    terminal,
    write,
    readFrame,
    "claude",
    (frameText) => browserToolsPromptVisible(frameText) || isClaudeAutoModeOfferMenu(frameText),
    cancelled,
    signal,
  );
}

/** Answers the prompts on one live frame; `read` returns the latest rendered frame's text. */
export function answerClaudeFramePrompts(
  responder: ClaudeStartupPromptResponder,
  terminal: ElwoodTerminal,
  frameText: string,
  read: () => string,
): readonly SettledStartupOutcome<"claude">[] {
  const send = (input: string) => withAutomatedInput(terminal, () => terminal.sendInput(input));
  const guarded = guardedClaudeAutomationWrite(
    terminal,
    send,
    read,
    () => responder.closing,
    responder.closingSignal,
  );
  const readSettled = () => settledLiveSnapshot(terminal)?.text;
  return responder.handle(frameText, send, read, guarded, readSettled);
}
