/** Recognizes native update appearances and continuation rows (PRD §5.5, C-CODEX-12). */
import { updateDialogOptions, updateScreenBanner } from "./layout.ts";
import { codexUpdateActionPattern, codexUpdateOptionPattern } from "./selection.ts";

export { updateScreenBanner } from "./layout.ts";

/**
 * A captured first-party banner alone counts so a partial layout fails safe
 * before its options paint. Generic "update available" prose does not count;
 * an option-only frame must carry both the update and safe choices.
 */
export function codexUpdatePromptVisible(frameText: string): boolean {
  if (updateScreenBanner.test(frameText)) return true;
  const options = updateDialogOptions(frameText);
  if (options === undefined) return false;
  return (
    options.some((option) => codexUpdateActionPattern.test(option.label)) &&
    options.some((option) => codexUpdateOptionPattern.test(option.label))
  );
}

export function isSafeUpdateContinuation(frameText: string): boolean {
  if (updateScreenBanner.test(frameText)) return false;
  return (updateDialogOptions(frameText) ?? []).some((option) =>
    /continue\s*without\s*updat|skip/i.test(option.label),
  );
}
