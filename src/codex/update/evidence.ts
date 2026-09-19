/**
 * The first-party evidence one Codex update-screen APPEARANCE accumulates across its
 * frames, and the test a banner-less continuation frame must pass to belong to it.
 * Implements PRD §5.5 / C-CODEX-12 and C-CODEX-22 (issue #50).
 *
 * Why this exists. Codex genuinely splits the update banner and its safe option across
 * consecutive frames (docs/cli-behavior.md): the banner frame carries only
 * `1. Update now`, and `2. Skip` arrives later. So no single-frame predicate can demand
 * both, and a banner-less option-only frame is accepted as a continuation of whatever
 * appearance is already active. That is the hole issue #50 records: an UNRELATED
 * option-only prompt whose every option is skip-shaped (`1. Skip backup` / `2. Skip`)
 * is, on its own frame, indistinguishable from a legitimate update continuation.
 *
 * The fix is different EVIDENCE, not a tighter predicate. Every attempt to tighten the
 * predicate fixed a synthetic case and broke a real one (#50 records three). Instead the
 * appearance remembers what it has actually seen, and a continuation must be CONSISTENT
 * with it. The consistency rule is the one thing a repaint of the same dialog cannot
 * violate: Codex may drop rows that scrolled off and may reveal rows that had not
 * painted, but it never reassigns a number this appearance already showed under a
 * different label. `1. Update now` cannot become `1. Skip backup` without being a
 * DIFFERENT dialog.
 *
 * That rule admits the real cases and rejects the synthetic one:
 *   banner frame `1. Update now`          -> `2. Skip` / `3. Skip until next version`  OK
 *     (numbers 2 and 3 are new; number 1 is simply absent, which is not a contradiction)
 *   banner frame `1. Update now`          -> `1. Skip backup` / `2. Skip`              NO
 *     (number 1 was `Update now`; a repaint cannot relabel it)
 */

import { numberedOptions } from "../../core/terminal-options.ts";
import { updateScreenBanner } from "./recognition.ts";

/** What one appearance of the update screen has shown so far. */
export type CodexUpdateAppearanceEvidence = {
  /** Every option number this appearance has rendered, mapped to its label. */
  readonly options: ReadonlyMap<string, string>;
  /** True once a frame carried the first-party banner or the `Update now` option. */
  readonly firstParty: boolean;
  /**
   * The banner line this appearance was first identified by, or `""` when it has only ever
   * been seen through its options. The `Update available! X -> Y` form carries a version
   * pair, so a CHANGED version proves a new appearance where identical option sets would
   * otherwise look like one. The generic `A new version of Codex is available` form carries
   * no version and is identical across appearances, so it can never prove a change — this
   * field fences same-text replacements only when the banner is the versioned form.
   */
  readonly banner: string;
};

/** A fresh appearance, before any frame has been folded into it. */
export function emptyUpdateEvidence(): CodexUpdateAppearanceEvidence {
  return { options: new Map(), firstParty: false, banner: "" };
}

/**
 * Whether a frame's banner contradicts the one this appearance was identified by. A
 * DIFFERENT version pair is a different appearance even when the options are identical,
 * so a pending retry cannot act across the swap. A frame with no banner is not a
 * contradiction: the banner routinely scrolls off during a split appearance.
 */
export function bannerContradictsAppearance(
  evidence: CodexUpdateAppearanceEvidence,
  frameText: string,
): boolean {
  const banner = updateScreenBanner.exec(frameText)?.[0]?.trim() ?? "";
  return evidence.banner !== "" && banner !== "" && banner !== evidence.banner;
}

/**
 * Folds one frame of this appearance into its evidence. Later labels for a number the
 * appearance already knows are IGNORED rather than overwritten — the first label an
 * appearance showed for a number is the one a continuation is checked against, so a
 * frame that already contradicts the appearance cannot rewrite history to justify itself.
 */
export function withUpdateFrameEvidence(
  evidence: CodexUpdateAppearanceEvidence,
  frameText: string,
  firstParty: boolean,
): CodexUpdateAppearanceEvidence {
  const options = new Map(evidence.options);
  for (const option of numberedOptions(frameText)) {
    if (!options.has(option.number)) options.set(option.number, option.label);
  }
  // The FIRST banner an appearance shows identifies it, for the same reason as the option
  // labels: a later frame must not be able to rewrite the identity it is checked against.
  const banner = evidence.banner || (updateScreenBanner.exec(frameText)?.[0]?.trim() ?? "");
  return { options, firstParty: evidence.firstParty || firstParty, banner };
}

/**
 * Returns `true` when EVERY option number on `frameText` still carries the label this
 * appearance bound it to — that is, the frame reassigns nothing. Returns `false` as soon
 * as one number appears under a different label.
 *
 * Note the polarity: `true` means AGREEMENT (safe to treat as the same dialog), which is
 * how the tracker consumes it. This is only the consistency half of the continuation
 * question — it says nothing about whether the appearance was ever first-party, and a
 * frame with no options at all trivially returns `true`. Callers asking "is this a
 * continuation" want `evidenceAllowsContinuation`; callers asking "is this still the same
 * dialog" — which includes complete-looking first-party frames — want this one.
 */
export function appearanceBindingsHold(
  evidence: CodexUpdateAppearanceEvidence,
  frameText: string,
): boolean {
  return numberedOptions(frameText).every((option) => {
    const known = evidence.options.get(option.number);
    return known === undefined || known === option.label;
  });
}

/**
 * Whether a banner-less option-only frame can be a continuation of THIS appearance.
 *
 * Two requirements, and neither can be satisfied by the frame alone — which is the
 * point. The appearance must have been recognized from first-party evidence at some
 * point (a banner or an `Update now` option), and this frame must not CONTRADICT any
 * option number that appearance already showed. An unrelated prompt that merely happens
 * to offer skip-shaped rows fails the second test as soon as it re-uses a number, and
 * fails the first outright when no update screen was ever recognized.
 */
export function evidenceAllowsContinuation(
  evidence: CodexUpdateAppearanceEvidence,
  frameText: string,
): boolean {
  return evidence.firstParty && appearanceBindingsHold(evidence, frameText);
}
