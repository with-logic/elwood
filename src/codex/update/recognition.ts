/**
 * The single-frame recognition vocabulary for Codex in-TUI update screens: the banner,
 * the safe-option pattern, and the two partial-frame shape tests built on them.
 * Implements PRD §5.5, C-CODEX-12 and C-CODEX-22.
 *
 * This module is the shared BOTTOM of the update stack and imports nothing from its
 * siblings, so recognition (here), cross-frame lifecycle (`tracker.ts`) and the write
 * path (`index.ts`) form a line rather than a cycle.
 *
 * Every predicate here judges ONE frame's shape and nothing else. None of them is
 * sufficient on its own to authorize a write: a frame's shape cannot say which
 * APPEARANCE it belongs to, which is exactly the gap issue #50 recorded. Pair them with
 * the appearance's accumulated evidence (`evidence.ts`) before acting.
 */

import {
  type NumberedOption,
  nonOptionText,
  numberedOptions,
} from "../../core/terminal-options.ts";

export const codexUpdateOptionPattern = /continue\s*without\s*updat|skip|not\s*now|later/i;
/** The option that PERFORMS the update; never a safe choice, whatever else its label says. */
export const codexUpdateActionPattern = /update\s+now/i;
/** The first-party banner; its version pair distinguishes one appearance from the next. */
export const updateScreenBanner =
  /^[^\S\r\n]*(?:Update available!\s+\d+\.\d+\.\d+\s*(?:->|→)\s*\d+\.\d+\.\d+|A new version of Codex is available[.!]?)[^\S\r\n]*$/im;

/**
 * Whether THIS FRAME carries first-party update-screen markings: the versioned banner,
 * or an `Update now` option alongside a safe one. A captured banner alone counts so a
 * partial layout fails safe before its options paint; generic "update available" prose
 * does not count.
 *
 * NOT proof that the frame belongs to any particular appearance — a replacement dialog
 * that relabels a captured option is first-party SHAPED too. Callers deciding whether to
 * write must also check the appearance's bindings (`appearanceBindingsHold`).
 */
export function codexUpdatePromptVisible(frameText: string): boolean {
  if (updateScreenBanner.test(frameText)) return true;
  const options = numberedOptions(frameText);
  return (
    options.some((option) => codexUpdateActionPattern.test(option.label)) &&
    options.some((option) => codexUpdateOptionPattern.test(option.label))
  );
}

/**
 * The safe numbered option to press on THIS FRAME, or `undefined` when it offers none.
 *
 * Picking the first label matching `codexUpdateOptionPattern` is NOT enough. Every real
 * Codex update screen we have captured — 0.132 through 0.155, banner-split or whole —
 * lists `Update now` FIRST and its safe choices after it (`1. Update now` / `2. Skip` /
 * `3. Skip until next version`). The safe pattern does not match `Update now`, so on a
 * genuine screen the first match happens to be the real skip: an ordering the selection
 * silently relied on.
 *
 * A dialog that puts a skip-shaped label BEFORE the update action (`1. Skip backup` /
 * `2. Update now`) violates that layout, and the old selection would press `1` on it. So
 * a safe option is only taken from AFTER the update action when the frame shows one, and
 * the update action itself is never selectable however its label reads (round 1 of #59).
 * A frame with no update action (the banner-less continuation) is unconstrained, which is
 * what keeps `2. Skip` / `3. Skip until next version` working.
 */
export function safeUpdateOption(frameText: string): NumberedOption | undefined {
  const options = numberedOptions(frameText);
  const actionIndex = options.findIndex((option) => codexUpdateActionPattern.test(option.label));
  const candidates = actionIndex < 0 ? options : options.slice(actionIndex + 1);
  return candidates.find(
    (option) =>
      codexUpdateOptionPattern.test(option.label) && !codexUpdateActionPattern.test(option.label),
  );
}

/**
 * Whether THIS FRAME has the shape of a banner-less continuation: options only, at least
 * one of them safe. Necessary for a continuation but NOT sufficient — issue #50 showed an
 * unrelated option-only prompt whose every option is skip-shaped has exactly this shape.
 * The appearance's own evidence is what separates the two.
 */
export function hasContinuationShape(frameText: string): boolean {
  if (nonOptionText(frameText).trim() !== "") return false;
  return numberedOptions(frameText).some((option) =>
    /continue\s*without\s*updat|skip/i.test(option.label),
  );
}
