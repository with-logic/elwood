/** Bound the live-only Codex startup screen activity (PRD §5.4, C-ATTN-06). */
import type { InitialReadyBackstopWarning } from "../warnings/lifecycle.ts";

const maxStartupScreenCodeUnits = 8_192;

export type UnrecognizedStartupActivity = {
  readonly elwoodSessionId: string;
  readonly agent: "codex";
  readonly source: "terminal";
  readonly kind: "unrecognized_startup";
  readonly label: InitialReadyBackstopWarning["code"];
  readonly text: string;
};

/** Trim trailing whitespace and retain up to 8,192 UTF-16 units without splitting a surrogate pair (C-ATTN-06). */
export function unrecognizedStartupActivity(
  elwoodSessionId: string,
  screen: string,
): UnrecognizedStartupActivity {
  const text = screen
    .trimEnd()
    .slice(-maxStartupScreenCodeUnits)
    // Drop the low surrogate if the cut fell inside a character.
    .replace(/^[\udc00-\udfff]/u, "");
  return {
    elwoodSessionId,
    agent: "codex",
    source: "terminal",
    kind: "unrecognized_startup",
    label: "initial_ready_backstop",
    text,
  };
}
