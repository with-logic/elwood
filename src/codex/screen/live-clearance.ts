/** Trust clearance shares Codex's screen/title working facts (PRD §5.3/§5.4, C-TRUST-01). */
import { readScreenFacts } from "../../core/screen-facts.ts";
import type { TrustClearance } from "../../core/trust/clearance.ts";
import { codexScreenFactTable } from "../screen-table.ts";
import { codexComposerClearance } from "./clearance.ts";

/** Read the live title on every frame classification and trust-attempt revalidation. */
export function liveCodexClearance(readTitle: () => string): TrustClearance {
  return (text) =>
    !readScreenFacts(codexScreenFactTable, { text, title: readTitle() }).facts.working_visible &&
    codexComposerClearance(text);
}
