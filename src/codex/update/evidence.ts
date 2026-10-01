/**
 * Bounded first-party option evidence for Codex updates (PRD §5.5, C-CODEX-12).
 * Retain the current first-party block, never a union across repaints.
 * Binding agreement alone does not authorize automation without a current banner.
 */

import { type NumberedOption, numberedOptions } from "../../core/terminal-options.ts";
import { updateScreenBanner } from "./recognition.ts";
import { codexUpdateActionPattern, codexUpdateOptionPattern } from "./selection.ts";

export type CodexUpdateAppearanceEvidence = {
  readonly boundOptions: ReadonlyMap<string, string>;
  readonly hasFirstPartyEvidence: boolean;
  readonly observedBanner: string;
  readonly overflowed: boolean;
};

const everyUpdateBanner = new RegExp(updateScreenBanner.source, "gim");
const maxRetainedOptions = 32;
const maxRetainedLabelLength = 200;

export function emptyUpdateEvidence(): CodexUpdateAppearanceEvidence {
  return {
    boundOptions: new Map(),
    hasFirstPartyEvidence: false,
    observedBanner: "",
    overflowed: false,
  };
}

export function bannerContradictsAppearance(
  evidence: Pick<CodexUpdateAppearanceEvidence, "observedBanner">,
  frameText: string,
): boolean {
  return (
    evidence.observedBanner !== "" &&
    [...frameText.matchAll(everyUpdateBanner)].some(
      (match) => match[0].trim() !== evidence.observedBanner,
    )
  );
}

export function withUpdateFrameEvidence(
  evidence: CodexUpdateAppearanceEvidence,
  frameText: string,
  isFirstPartyFrame: boolean,
  options: readonly NumberedOption[] = updateFrameOptions(frameText),
): CodexUpdateAppearanceEvidence {
  if (!isFirstPartyFrame) return evidence;
  const boundOptions = new Map<string, string>();
  let overflowed = evidence.overflowed;
  for (const option of options) {
    if (boundOptions.size >= maxRetainedOptions || option.label.length > maxRetainedLabelLength) {
      overflowed = true;
      continue;
    }
    boundOptions.set(option.number, option.label);
  }
  const observedBanner =
    evidence.observedBanner || (updateScreenBanner.exec(frameText)?.[0]?.trim() ?? "");
  return {
    boundOptions,
    hasFirstPartyEvidence: evidence.hasFirstPartyEvidence || isFirstPartyFrame,
    observedBanner,
    overflowed,
  };
}

/** Partial check: rejects changed retained labels and overflow; unseen numbers are allowed. */
export function retainedOptionLabelsAgree(
  evidence: CodexUpdateAppearanceEvidence,
  frameText: string,
  options: readonly NumberedOption[] = updateFrameOptions(frameText),
): boolean {
  if (evidence.overflowed) return false;
  return options.every((option) => {
    const known = evidence.boundOptions.get(option.number);
    return known === undefined || known === option.label;
  });
}

/** Exact current bindings only; callers must also require a current validated banner. */
export function currentOptionBindingsMatch(
  evidence: CodexUpdateAppearanceEvidence,
  frameText: string,
  options: readonly NumberedOption[] = updateFrameOptions(frameText),
): boolean {
  return (
    evidence.hasFirstPartyEvidence &&
    !evidence.overflowed &&
    options.every((option) => evidence.boundOptions.get(option.number) === option.label)
  );
}

/** Version fragments in the recognized banner are not selectable option rows. */
function updateFrameOptions(frameText: string) {
  return numberedOptions(frameText.replace(everyUpdateBanner, ""));
}

/** A removed safe binding cannot keep an earlier retry alive through renumbering. */
export function retainedSafeOptionsPresent(
  evidence: CodexUpdateAppearanceEvidence,
  options: readonly NumberedOption[],
): boolean {
  return [...evidence.boundOptions].every(
    ([number, label]) =>
      !codexUpdateOptionPattern.test(label) ||
      codexUpdateActionPattern.test(label) ||
      options.some((option) => option.number === number && option.label === label),
  );
}
