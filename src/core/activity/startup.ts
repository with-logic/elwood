/** Bound the live-only startup screen activity (PRD §5.4, C-ATTN-06, C-ATTN-09). */
import type { InitialReadyBackstopWarning } from "../warnings/lifecycle.ts";
import type { ElwoodAgentKind } from "./index.ts";

const maxStartupScreenCodeUnits = 8_192;
/** An API key a CLI showed, such as one it prefilled from its environment. */
const apiKeyShape = /\bsk-[A-Za-z0-9._-]{8,}/g;

/** Reported from the readiness deadline (C-ATTN-09) or at the backstop (C-ATTN-06). */
export type UnrecognizedStartupLabel =
  | "initial_ready_deadline"
  | InitialReadyBackstopWarning["code"];

export type UnrecognizedStartupActivity = {
  readonly elwoodSessionId: string;
  readonly agent: ElwoodAgentKind;
  readonly source: "terminal";
  readonly kind: "unrecognized_startup";
  readonly label: UnrecognizedStartupLabel;
  readonly text: string;
};

/**
 * Redact API-key-shaped tokens, trim trailing whitespace, and retain up to 8,192 UTF-16
 * units without splitting a surrogate pair (C-ATTN-06).
 */
export function unrecognizedStartupActivity(
  agent: ElwoodAgentKind,
  elwoodSessionId: string,
  screen: string,
  label: UnrecognizedStartupLabel = "initial_ready_backstop",
): UnrecognizedStartupActivity {
  const text = screen
    .replace(apiKeyShape, "sk-[redacted]")
    .trimEnd()
    .slice(-maxStartupScreenCodeUnits)
    // Drop the low surrogate if the cut fell inside a character.
    .replace(/^[\udc00-\udfff]/u, "");
  return {
    elwoodSessionId,
    agent,
    source: "terminal",
    kind: "unrecognized_startup",
    label,
    text,
  };
}
