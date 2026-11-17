/** Provider-correlated transcript speed evidence, implementing PRD §5.11. */
import type { AgentSpeedObservation } from "../speed/types.ts";

/** Only the matching adapter's transcript can supply record-scoped speed evidence. */
export type SpeedActivityFields =
  | { readonly speed?: never }
  | {
      readonly source: "transcript";
      readonly agent: "codex";
      readonly speed?: Extract<AgentSpeedObservation, { readonly agent: "codex" }>;
    }
  | {
      readonly source: "transcript";
      readonly agent: "claude";
      readonly speed?: Extract<AgentSpeedObservation, { readonly agent: "claude" }>;
    };
