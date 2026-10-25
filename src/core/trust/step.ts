/**
 * The keys one trust answer writes, and what a retry of it may write (PRD §5.4,
 * C-TRUST-01). Kept apart from the attempt's lifecycle in `write.ts`.
 */
import { cursorSelection, type SelectableOption } from "../terminal-options.ts";

export const retryMs = 250;
export const observationMs = 20;

export type TrustStep = {
  /** The raw PTY keystrokes, not the printable answer summary activity reports. */
  readonly keys: string;
  /** The write confirms the answer (it carries Enter). */
  readonly confirm: boolean;
  readonly pollMs: number;
};

/**
 * A cursor answer never sends a relative arrow or a bare Enter (docs/cli-behavior.md).
 * Claude 2.1.310 remounts its dialog with the cursor back on "No, exit" once its input
 * guard settles, and a retried arrow can land after the first already moved; a bare
 * Enter decided from the earlier frame then confirms the decline. The absolute selection
 * lands on the same row however often it repeats, and Enter travels only in the same
 * write as it, once the rendered cursor sits on the affirmative.
 */
export function trustStep(option: SelectableOption): TrustStep {
  if (option.style === "numbered")
    return { keys: `${option.number}\r`, confirm: true, pollMs: retryMs };
  const select = cursorSelection(option);
  const confirm = option.offset === 0;
  return { keys: confirm ? `${select}\r` : select, confirm, pollMs: observationMs };
}

type NumberedOption = Extract<SelectableOption, { style: "numbered" }>;

/**
 * What a numbered answer's retry writes after its first write typed the number
 * (`trustStep`); `undefined` waits for the next rendered frame. A frame still showing
 * the gate does not prove the CLI ignored the answer: under load Codex 0.164 takes `1\r`
 * but paints its composer after the retry interval, and the same keys typed again submit
 * "1" as a user turn. Each adapter chooses its retry beside its clearance grammar
 * (C-TRUST-01).
 */
export type NumberedRetry = (
  option: NumberedOption,
  renderedSinceWrite: boolean,
) => TrustStep | undefined;

/**
 * The default: the number again, but only once a frame rendered from output received
 * after the last write still shows the gate. Claude needs this: its list remounts with
 * the caret on the decline, so a bare Enter could exit.
 */
export const retypeAfterRender: NumberedRetry = (option, renderedSinceWrite) =>
  renderedSinceWrite ? trustStep(option) : undefined;

/**
 * For a CLI whose gate confirms its highlighted option on Enter and whose empty composer
 * ignores a bare Enter: Enter alone while the rendered caret is on the affirmative, which
 * confirms the gate or does nothing; otherwise `retypeAfterRender`.
 */
export const enterWhileSelected: NumberedRetry = (option, renderedSinceWrite) =>
  option.selected === true
    ? { keys: "\r", confirm: true, pollMs: retryMs }
    : retypeAfterRender(option, renderedSinceWrite);
