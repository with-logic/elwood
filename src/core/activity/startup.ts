/** Bound the live-only startup screen activity (PRD §5.4, C-ATTN-06, C-ATTN-09). */
import type { InitialReadyBackstopWarning } from "../warnings/lifecycle.ts";
import type { ElwoodAgentKind } from "./index.ts";

const maxStartupScreenCodeUnits = 8_192;
/** A whole API key has at least this many characters after `sk-`. */
const minKeyChars = 8;
/** An API key a CLI showed, such as one it prefilled from its environment. */
const apiKeyShape = new RegExp(`\\bsk-[A-Za-z0-9._-]{${minKeyChars},}`, "g");
/**
 * `sk-` and any key characters ending a row, inside an optional box border: however short,
 * this part of a key can continue on the next row. A key masked with dots is complete.
 */
const keyAtRowEnd = /\bsk-[A-Za-z0-9_-]*(?=\s*│?\s*$)/;
/** The key characters that start the next row, inside an optional box border. */
const keyContinuation = /^(\s*│?\s*)[A-Za-z0-9_-]+/;
const onlyBorder = /^\s*│?\s*$/;

/**
 * Redact each API-key-shaped token. A key part that ends its row continues into the key
 * characters starting the next row, which are redacted too, even when they are a word.
 */
function redactApiKeys(screen: string): string {
  let wrapping = false;
  return screen
    .split("\n")
    .map((row, index, rows) => {
      const continuation = wrapping ? keyContinuation.exec(row) : null;
      const rest = continuation ? row.slice(continuation[0].length) : row;
      const endsInKey = keyAtRowEnd.test(rest);
      // A continuation that fills its row can continue again.
      const fillsRow = continuation !== null && onlyBorder.test(rest);
      wrapping = (endsInKey || fillsRow) && keyContinuation.test(rows[index + 1] ?? "");
      const whole = rest.replace(apiKeyShape, "sk-[redacted]");
      const redacted = wrapping && endsInKey ? whole.replace(keyAtRowEnd, "sk-[redacted]") : whole;
      return continuation ? `${continuation[1]}[redacted]${redacted}` : redacted;
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
  /**
   * The screen, trailing whitespace removed and limited to its last 8,192 UTF-16 units.
   * Only `sk-` API-key-shaped tokens are redacted, including a key wrapped across rows:
   * account details and other credentials the agent showed can remain.
   */
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
