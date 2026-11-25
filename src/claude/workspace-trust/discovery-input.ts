/** Describe the Claude native trust and observer inputs (C-ATTN-07, C-ATTN-08). */
import type { ElwoodDialogEvent, ElwoodDialogRequest } from "../../core/dialogs/types.ts";
import type { TrustClearance } from "../../core/trust/clearance.ts";
import type { TrustPromptIdFor } from "../../core/trust/prompts.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import type { ClaudeLaunchTrustEvidence } from "./target.ts";

export type DialogRequest = ElwoodDialogRequest<"claude">;

export type WorkspaceTrustDiscoveryInput = {
  readonly elwoodSessionId: string;
  readonly evidence: ClaudeLaunchTrustEvidence | undefined;
  readonly terminal: () => ElwoodTerminal;
  readonly humanOwnedPrompt: () => TrustPromptIdFor<"claude"> | undefined;
  readonly clearance: TrustClearance;
  readonly manualTrust: boolean;
};

export type Retirement = Extract<ElwoodDialogEvent<"claude">, { phase: "closed" }>["reason"];
export type DiscoveryObserver = {
  readonly revision: () => number;
  readonly onRetire: (request: DialogRequest, reason: Retirement) => void;
  readonly onListDiscovery: (request: DialogRequest) => void;
};
