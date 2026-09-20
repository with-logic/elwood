/** Preserve an attention episode until verified idle evidence (PRD §5.3, C-ATTN-02). */
import type { ScreenFactReading } from "../../core/screen-facts.ts";
import type { TrustClearance } from "../../core/trust/clearance.ts";

export function createAttentionClearance(isIdleComposer: TrustClearance) {
  let held = false;
  return (
    reading: ScreenFactReading,
    text: string,
    trustInputBlocking: boolean,
  ): ScreenFactReading => {
    const { facts } = reading;
    if (facts.blocking_prompt_visible || trustInputBlocking) held = true;
    if (!(held && facts.composer_visible)) return reading;
    if (!(facts.blocking_prompt_visible || facts.working_visible) && isIdleComposer(text)) {
      if (!trustInputBlocking) held = false;
      return reading;
    }
    return {
      facts: { ...facts, composer_visible: false },
      matched: reading.matched.filter((rule) => rule.fact !== "composer_visible"),
    };
  };
}
