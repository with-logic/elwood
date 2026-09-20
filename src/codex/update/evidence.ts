/**
 * First-party option bindings owned by one Codex update appearance (PRD §5.5,
 * C-CODEX-12/22). Banner-less frames may reuse known bindings but cannot introduce
 * choices: disjoint numbering is absence of contradiction, not provenance.
 */

import { numberedOptions } from "../../core/terminal-options.ts";
import { updateScreenBanner } from "./recognition.ts";

export type CodexUpdateAppearanceEvidence = {
  readonly options: ReadonlyMap<string, string>;
  readonly firstParty: boolean;
  readonly banner: string;
  readonly overflowed: boolean;
};

const maxRetainedOptions = 32;
const maxRetainedLabelLength = 200;

export function emptyUpdateEvidence(): CodexUpdateAppearanceEvidence {
  return { options: new Map(), firstParty: false, banner: "", overflowed: false };
}

export function bannerContradictsAppearance(
  evidence: CodexUpdateAppearanceEvidence,
  frameText: string,
): boolean {
  const banner = updateScreenBanner.exec(frameText)?.[0]?.trim() ?? "";
  return evidence.banner !== "" && banner !== "" && banner !== evidence.banner;
}

export function withUpdateFrameEvidence(
  evidence: CodexUpdateAppearanceEvidence,
  frameText: string,
  firstParty: boolean,
): CodexUpdateAppearanceEvidence {
  const options = new Map(evidence.options);
  let overflowed = evidence.overflowed;
  for (const option of numberedOptions(frameText)) {
    if (!firstParty || options.has(option.number)) continue;
    if (options.size >= maxRetainedOptions || option.label.length > maxRetainedLabelLength) {
      overflowed = true;
      continue;
    }
    options.set(option.number, option.label);
  }
  const banner = evidence.banner || (updateScreenBanner.exec(frameText)?.[0]?.trim() ?? "");
  return { options, firstParty: evidence.firstParty || firstParty, banner, overflowed };
}

export function appearanceBindingsHold(
  evidence: CodexUpdateAppearanceEvidence,
  frameText: string,
): boolean {
  if (evidence.overflowed) return false;
  return numberedOptions(frameText).every((option) => {
    const known = evidence.options.get(option.number);
    return known === undefined || known === option.label;
  });
}

export function evidenceAllowsContinuation(
  evidence: CodexUpdateAppearanceEvidence,
  frameText: string,
): boolean {
  return (
    evidence.firstParty &&
    !evidence.overflowed &&
    numberedOptions(frameText).every(
      (option) => evidence.options.get(option.number) === option.label,
    )
  );
}
