/** Checks the non-null Codex selector contract at the public boundary (PRD §5.7, C-API-23). */
import { elwoodError } from "../../core/errors.ts";
import type { AgentModelOption, CodexModelOption } from "../../core/models/rows.ts";

export function codexModelOptions(
  options: readonly AgentModelOption[],
): readonly CodexModelOption[] {
  return options.map((option) => {
    const { id } = option;
    if (id === null)
      throw elwoodError(
        "model_automation_failed",
        "Codex returned a model without a native selector.",
      );
    return { ...option, id };
  });
}
