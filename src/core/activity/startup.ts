/** Bound the live-only startup screen activity (PRD §5.4, C-ATTN-06, C-ATTN-09). */
import type { InitialReadyBackstopWarning } from "../warnings/lifecycle.ts";
import type { ElwoodAgentKind } from "./index.ts";

const maxStartupScreenCodeUnits = 8_192;
/** An API key a CLI showed, such as one it prefilled from its environment. */
const apiKeyShape = /\bsk-[A-Za-z0-9._-]{8,}/g;
/** A row whose last text is such a key, inside an optional box border. */
const keyAtRowEnd = /\bsk-[A-Za-z0-9._-]{8,}\s*│?\s*$/;
/** The part of a key the terminal wrapped onto the next row. */
const keyContinuation = /^(\s*│?\s*)([A-Za-z0-9._-]{8,})/;
/** Key text holds digits; a following row's leading word or variable name does not. */
const keyLike = /\d/;

/** Redact each API-key-shaped token, and the rows a wrapped key continues onto. */
function redactApiKeys(screen: string): string {
  let wrapping = false;
  return screen
    .split("\n")
    .map((row) => {
      const [run = "", border = "", key = ""] = (wrapping && keyContinuation.exec(row)) || [];
      const continued = keyLike.test(key);
      const rest = row.slice(continued ? run.length : 0);
      // A continuation that fills its row can continue again.
      wrapping = keyAtRowEnd.test(row) || (continued && /^\s*│?\s*$/.test(rest));
      const redacted = rest.replace(apiKeyShape, "sk-[redacted]");
      return continued ? `${border}[redacted]${redacted}` : redacted;
    })
    .join("\n");
}

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
  const text = redactApiKeys(screen)
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
