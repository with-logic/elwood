/** Inputs for read-only Codex workspace trust discovery (C-ATTN-07). */
import type { TrustClearance } from "../../core/trust/clearance.ts";
import type { TrustPromptIdFor } from "../../core/trust/prompts.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import type { CodexLaunchTrustEvidence } from "./launch-evidence.ts";

export type WorkspaceTrustDiscoveryInput = {
  readonly elwoodSessionId: string;
  readonly evidence: CodexLaunchTrustEvidence | undefined;
  readonly terminal: () => ElwoodTerminal;
  readonly humanOwnedPrompt: () => TrustPromptIdFor<"codex"> | undefined;
  readonly clearance: TrustClearance;
};
