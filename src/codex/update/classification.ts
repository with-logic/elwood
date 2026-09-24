/** Classifies one native update block for eligibility consumers (PRD §5.5, C-CODEX-12). */
import type { NumberedOption } from "../../core/terminal-options.ts";
import { updateDialogOptions, updateScreenBanner } from "./layout.ts";
import { codexUpdateActionPattern, codexUpdateOptionPattern } from "./selection.ts";

export { updateScreenBanner } from "./layout.ts";

export type CodexUpdateFrame = {
  readonly options: readonly NumberedOption[] | undefined;
  readonly hasBanner: boolean;
  readonly visible: boolean;
  readonly continuation: boolean;
};

/** A banner blocks even before its choices paint; unknown surrounding rows cannot authorize input. */
export function classifyCodexUpdateFrame(frameText: string): CodexUpdateFrame {
  const hasBanner = updateScreenBanner.test(frameText);
  const options = updateDialogOptions(frameText);
  const choices = options ?? [];
  return {
    options,
    hasBanner,
    visible:
      hasBanner ||
      (choices.some((option) => codexUpdateActionPattern.test(option.label)) &&
        choices.some((option) => codexUpdateOptionPattern.test(option.label))),
    continuation:
      !hasBanner && choices.some((option) => /continue\s*without\s*updat|skip/i.test(option.label)),
  };
}

/** Keeps at most the last exact viewport; instances never share terminal content. */
export class CodexUpdateFrameClassifier {
  private parsed: { readonly text: string; readonly frame: CodexUpdateFrame } | undefined;

  read(text: string): CodexUpdateFrame {
    if (this.parsed?.text !== text) {
      this.parsed = { text, frame: classifyCodexUpdateFrame(text) };
    }
    return this.parsed.frame;
  }
}
