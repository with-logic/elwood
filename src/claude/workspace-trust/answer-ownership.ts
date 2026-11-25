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
      if (
        rawPrelude === disclosedWorkspacePath ||
        rawPrelude === promptHeaderKey ||
        relinquished === gate.gateIdentity
      )
        relinquished = gate.gateIdentity;
      else relinquished = undefined;
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
