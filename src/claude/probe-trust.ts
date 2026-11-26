/**
 * The model probe's workspace trust policy: which verified prompts its implied automatic trust
 * must leave to a human, and why. Implements PRD §5.3 and C-CLAUDE-26.
 */

import { claudeWorkspaceDisclosesHooks } from "../core/trust/copy.ts";
import type { TrustView } from "../core/trust/view.ts";

/**
 * Why the model probe refused a workspace prompt (§5.3): the prompt disclosed hooks, or the
 * installed Claude cannot disclose them, so no prompt it shows is evidence that none run.
 */
export type ProbeTrustRefusal = "hooks_disclosed" | "hooks_undisclosable";

/**
 * The model probe's workspace trust policy (§5.3). Its automatic trust never approves a
 * workspace prompt for a folder whose hooks could run: one that discloses hooks or, from a
 * Claude that cannot disclose them, any workspace prompt at all.
 */
export type ProbeWorkspaceTrust = {
  /** Whether the installed Claude can disclose hooks, never whether a prompt disclosed them. */
  readonly canDiscloseHooks: boolean;
  readonly onRefused: (reason: ProbeTrustRefusal) => void;
};

/**
 * Leaves a verified workspace prompt the probe must not trust to a human, so automatic trust
 * never runs the folder's hooks, and reports each frame that shows it (§5.3).
 */
export function refuseProbeTrust({
  canDiscloseHooks,
  onRefused,
}: ProbeWorkspaceTrust): (view: TrustView) => boolean {
  return (view) => {
    if (view.kind !== "candidate" || !view.valid || view.spec.id !== "workspace_trust")
      return false;
    const reason = probeTrustRefusal(canDiscloseHooks, view.dialog.header);
    if (reason !== undefined) onRefused(reason);
    return reason !== undefined;
  };
}

function probeTrustRefusal(canDiscloseHooks: boolean, copy: string): ProbeTrustRefusal | undefined {
  if (!canDiscloseHooks) return "hooks_undisclosable";
  return claudeWorkspaceDisclosesHooks(copy) ? "hooks_disclosed" : undefined;
}
