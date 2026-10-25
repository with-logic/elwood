/**
 * The keys one trust answer writes, and what a retry of it may write (PRD §5.4,
 * C-TRUST-01). Kept apart from the attempt's lifecycle in `write.ts`.
 */
import type { ElwoodAgentKind } from "../activity/index.ts";
import { cursorSelection, type SelectableOption } from "../terminal-options.ts";

export const retryMs = 250;
export const observationMs = 20;

export type TrustStep = {
  readonly input: string;
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
    return { input: `${option.number}\r`, confirm: true, pollMs: retryMs };
  const select = cursorSelection(option);
  const confirm = option.offset === 0;
  return { input: confirm ? `${select}\r` : select, confirm, pollMs: observationMs };
}

/**
 * A numbered answer is typed once. A frame still showing its gate does not prove the CLI
 * ignored it: under load Codex 0.164 takes `1\r` but paints its composer after the retry
 * interval, and the same keys typed again submit "1" as a user turn. Codex's answer is
 * therefore repeated as Enter alone while the rendered caret is on the affirmative: on
 * the gate Enter confirms that option, and on Codex's empty composer it does nothing.
 * Claude resets its caret to the decline when its list remounts, so it never gets a bare
 * Enter. Otherwise the answer repeats only once a frame rendered after the last write
 * still shows the gate; `undefined` waits for one.
 */
export function numberedRetry(
  option: Extract<SelectableOption, { style: "numbered" }>,
  agent: ElwoodAgentKind,
  renderedSinceWrite: boolean,
): TrustStep | undefined {
  if (option.selected === true && agent === "codex")
    return { input: "\r", confirm: true, pollMs: retryMs };
  return renderedSinceWrite ? trustStep(option) : undefined;
}
