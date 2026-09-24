/** Recognizes native update appearances and continuation rows (PRD §5.5, C-CODEX-12). */
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

export function codexUpdatePromptVisible(frameText: string): boolean {
  return classifyCodexUpdateFrame(frameText).visible;
}

export function isSafeUpdateContinuation(frameText: string): boolean {
  return classifyCodexUpdateFrame(frameText).continuation;
}
