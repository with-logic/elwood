/**
 * The trust-clearance seam: the shared coordinator asks an ADAPTER whether a frame is
 * the CLI's own native composer, rather than carrying both CLIs' layout grammars itself
 * (PRD §5.4, C-TRUST-01). Each adapter owns its grammar beside its screen-fact table, so
 * a CLI layout change lands in exactly one place per adapter.
 *
 * The part that is genuinely agent-neutral stays here: a frame carrying a numbered option
 * row, or a caret row that is not the composer row, is a DIALOG and never clearance —
 * that rule is about option grammar, not about either CLI's chrome.
 */

/** True when the frame is the agent's own idle native composer and no dialog is up. */
export type TrustClearance = (frame: string) => boolean;

/**
 * Builds an adapter's clearance predicate from its composer row and the chrome that
 * proves the frame is that CLI's own idle screen. `composerRow` is used twice on
 * purpose: to recognize clearance, and to tell the composer caret apart from a dialog
 * caret, which is the collision `docs/cli-behavior.md` records.
 */
export function nativeComposerClearance(
  composerRow: RegExp,
  chrome: (frame: string) => boolean,
): TrustClearance {
  return (frame) => {
    if (
      /^\s*[❯›>]?\s*\d+[.)]\s+\S/m.test(frame) ||
      frame.split("\n").some((line) => /^\s*[❯›]/.test(line) && !composerRow.test(line))
    )
      return false;
    return chrome(frame) && composerRow.test(frame);
  };
}
