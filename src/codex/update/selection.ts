/** Selects the safe Codex update option in native menu order (PRD §5.5, C-CODEX-12). */
import type { NumberedOption } from "../../core/terminal-options.ts";
import { updateDialogOptions } from "./layout.ts";

export const codexUpdateOptionPattern = /continue\s*without\s*updat|skip|not\s*now|later/i;
export const codexUpdateActionPattern = /update\s+now/i;

/** Initial dispatch and retries must never select a skip-shaped row before the action. */
export function safeUpdateOption(
  frameText: string,
  options: readonly NumberedOption[] = updateDialogOptions(frameText) ?? [],
): NumberedOption | undefined {
  const actionIndex = options.findIndex((option) => codexUpdateActionPattern.test(option.label));
  const candidates = actionIndex < 0 ? options : options.slice(actionIndex + 1);
  return candidates.find(
    (option) =>
      codexUpdateOptionPattern.test(option.label) && !codexUpdateActionPattern.test(option.label),
  );
}
