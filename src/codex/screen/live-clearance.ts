/** Trust clearance shares Codex's screen/title working facts (PRD §5.3/§5.4, C-TRUST-01). */
import type { TrustClearance } from "../../core/trust/clearance.ts";
import { codexComposerClearance } from "./clearance.ts";
import { codexWorkingTitle } from "./working.ts";

/** Read the live title on every frame classification and trust-attempt revalidation. */
export function liveCodexClearance(readTitle: () => string): TrustClearance {
  return (text) => !codexWorkingTitle.test(readTitle()) && codexComposerClearance(text);
}
