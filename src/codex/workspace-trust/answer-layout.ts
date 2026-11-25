/** Codex native key selection and completion evidence for workspace consent (C-ATTN-07). */
import { arrowDown, arrowUp } from "../../core/input/constants.ts";
import type { SelectableOption } from "../../core/terminal-options.ts";
import type { TrustClearance } from "../../core/trust/clearance.ts";
import { codexHookReviewLabels, codexHooksFooter } from "../../core/trust/options.ts";
import { type TrustView, trustView } from "../../core/trust/view.ts";
import type { TerminalSnapshot } from "../../terminal/headless.ts";
import { isCodexAgentCommandCenter } from "./command-center-frame.ts";

export type NumberedTrustOption = Extract<SelectableOption, { style: "numbered" }>;

export function codexWorkspaceTrustStep(option: NumberedTrustOption) {
  return option.selected
    ? { keys: "\r", confirm: true }
    : { keys: option.number === "1" ? arrowUp : arrowDown, confirm: false };
}

function isCompleteCodexHookReview(view: TrustView, text: string): boolean {
  if (view.kind !== "candidate" || !view.valid || view.spec.id !== "hook_trust") return false;
  const { options, gateFooter } = view.dialog;
  const hasAcceptedFooter =
    gateFooter === codexHooksFooter ||
    text.trimEnd().split("\n").at(-1)?.trim() === "Press enter to confirm or esc to go back";
  const hasExpectedOptions =
    options.length === codexHookReviewLabels.length &&
    options.every(
      (option, index) =>
        option.style === "numbered" &&
        option.number === String(index + 1) &&
        option.label === codexHookReviewLabels[index],
    );
  const hasSingleSelectedOption =
    options.filter((option) => option.style === "numbered" && option.selected).length === 1;
  return hasAcceptedFooter && hasExpectedOptions && hasSingleSelectedOption;
}

export function workspaceTrustCompletion(frame: TerminalSnapshot, clearance: TrustClearance) {
  if (isCodexAgentCommandCenter(frame)) return "back";
  if (clearance(frame.text)) return "affirmative";
  if (
    isCompleteCodexHookReview(
      trustView(frame.text, "codex", () => false),
      frame.text,
    )
  )
    return "affirmative";
  return undefined;
}
