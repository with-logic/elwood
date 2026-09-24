/**
 * Bounded first-party option evidence for Codex updates (PRD §5.5, C-CODEX-12).
 * Banner-less frames may reuse known bindings but cannot introduce
 * choices: disjoint numbering is absence of contradiction, not provenance.
 */

import { numberedOptions } from "../../core/terminal-options.ts";
import { updateScreenBanner } from "./recognition.ts";

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
): CodexUpdateAppearanceEvidence {
  const boundOptions = new Map(evidence.boundOptions);
  let overflowed = evidence.overflowed;
  for (const option of updateFrameOptions(frameText)) {
    if (!isFirstPartyFrame || boundOptions.has(option.number)) continue;
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
): boolean {
  if (evidence.overflowed) return false;
  return updateFrameOptions(frameText).every((option) => {
    const known = evidence.boundOptions.get(option.number);
    return known === undefined || known === option.label;
  });
}

/** Provenance only: callers must also check continuation shape and banner contradiction. */
export function continuationOptionsAreBound(
  evidence: CodexUpdateAppearanceEvidence,
  frameText: string,
): boolean {
  return (
    evidence.hasFirstPartyEvidence &&
    !evidence.overflowed &&
    updateFrameOptions(frameText).every(
      (option) => evidence.boundOptions.get(option.number) === option.label,
    )
  );
}

/** Version fragments in the recognized banner are not selectable option rows. */
function updateFrameOptions(frameText: string) {
  return numberedOptions(frameText.replace(everyUpdateBanner, ""));
}
