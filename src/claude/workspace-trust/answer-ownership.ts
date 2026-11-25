/** Keep caller takeover scoped to the observed Claude workspace trust appearance (C-ATTN-07). */
import { disclosedWorkspacePath, type WorkspacePreludeEvidence } from "./menu.ts";

type Appearance = { readonly gateIdentity: string };
type Observed = Appearance | { readonly prelude: WorkspacePreludeEvidence };

export function claudeAnswerOwnership() {
  let observed: Observed | undefined;
  let relinquished: string | undefined;
  let rawPrelude: WorkspacePreludeEvidence | undefined;
  return {
    canWrite(gateIdentity: string) {
      return relinquished !== gateIdentity;
    },
    relinquish(gateIdentity: string) {
      relinquished = gateIdentity;
    },
    observeGate(gate: Appearance, promptHeaderKey: string) {
      observed = gate;
      // Carry a partial takeover into its completed menu. A full takeover follows
      // the appearance identity so a later incarnation of the same menu is answerable.
      const matchesPrelude =
        rawPrelude === disclosedWorkspacePath || rawPrelude === promptHeaderKey;
      const alreadyRelinquished = relinquished === gate.gateIdentity;
      relinquished = matchesPrelude || alreadyRelinquished ? gate.gateIdentity : undefined;
      rawPrelude = undefined;
    },
    observePrelude(prelude: WorkspacePreludeEvidence | undefined) {
      observed = prelude === undefined ? undefined : { prelude };
      if (prelude === undefined) rawPrelude = undefined;
    },
    callerInput() {
      if (!observed) return;
      if ("gateIdentity" in observed) {
        relinquished = observed.gateIdentity;
        rawPrelude = undefined;
      } else rawPrelude = observed.prelude;
    },
  };
}
