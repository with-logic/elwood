/** Selects the safe Codex update option in native menu order (PRD §5.5, C-CODEX-12). */
import { type NumberedOption, numberedOptions } from "../../core/terminal-options.ts";

export const codexUpdateOptionPattern = /continue\s*without\s*updat|skip|not\s*now|later/i;
const updateActionPattern = /update\s+now/i;

/** Initial dispatch and retries must never select a skip-shaped row before the action. */
export function safeUpdateOption(frameText: string): NumberedOption | undefined {
  const options = numberedOptions(frameText);
  const actionIndex = options.findIndex((option) => updateActionPattern.test(option.label));
  const candidates = actionIndex < 0 ? options : options.slice(actionIndex + 1);
  return candidates.find(
    (option) =>
      codexUpdateOptionPattern.test(option.label) && !updateActionPattern.test(option.label),
  );
}
