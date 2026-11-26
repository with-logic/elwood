/** Redact and bound the live-only startup screen activity (PRD §5.4, C-ATTN-06, C-ATTN-11). */
import type { InitialReadyBackstopWarning } from "../warnings/lifecycle.ts";
import type { ElwoodAgentKind } from "./index.ts";

const maxStartupScreenCodeUnits = 8_192;
/**
 * A whole `sk-` key-shaped token has at least this many characters after `sk-`, so a short
 * token such as `sk-short` passes, while a key the agent masked with dots
 * (`sk-ant-...Tail`) is still caught.
 */
const minKeyChars = 8;
/**
 * An `sk-` API-key-shaped token a CLI showed, such as a key it prefilled from its
 * environment. This is a shape heuristic, not credential validation: other credentials
 * and tokens of other shapes pass through unchanged. `\b` keeps `task-…` intact.
 */
const skKeyShape = new RegExp(`\\bsk-[A-Za-z0-9._-]{${minKeyChars},}`, "g");
/**
 * A character a wrapped key carries across rows. It is narrower than a whole token's:
 * a dot ends a masked key, so masked text never continues onto the next row.
 */
const wrappedKeyChar = "[A-Za-z0-9_-]";
/** Spaces and an optional `│` box border, within one row. */
const border = "[^\\S\\n]*(?:│[^\\S\\n]*)?";
const rowBreak = `${border}\\n${border}`;
/**
 * A key wrapped across rows, captured. A row ends in `sk-` and any key characters, or in
 * only the `s` or `sk` of the prefix, and the next row's leading run of key characters
 * completes `sk-` and a key character. Each following row's leading run continues the key
 * while the run before it was all its row held, apart from spaces and a border.
 *
 * An `sk-` run that does not wrap is matched uncaptured, so the scan resumes after it.
 * Every later `sk-` in that run would fail for the same reason, and retrying each would
 * make a wide row of them quadratic.
 */
const wrapStart =
  `sk-${wrappedKeyChar}*${rowBreak}${wrappedKeyChar}|` +
  `sk${rowBreak}-${wrappedKeyChar}|s${rowBreak}k-${wrappedKeyChar}`;
const wrapRest = `${wrappedKeyChar}*(?:${rowBreak}${wrappedKeyChar}+)*`;
const wrappedKey = new RegExp(`\\b(?:((?:${wrapStart})${wrapRest})|sk-${wrappedKeyChar}*)`, "g");
const wrappedKeyStart = new RegExp(`^(?:sk-${wrappedKeyChar}*|sk?)`);
const wrappedKeyRun = new RegExp(`(\\n${border})${wrappedKeyChar}+`, "g");

/**
 * Redact each `sk-` key-shaped token. The first part of a wrapped key becomes
 * `sk-[REDACTED]` and each continuing run `[REDACTED]`, even when that run is a word.
 */
function redactSkKeys(screen: string): string {
  return screen
    .replace(wrappedKey, (run: string, key?: string) =>
      key === undefined
        ? run
        : key.replace(wrappedKeyStart, "sk-[REDACTED]").replace(wrappedKeyRun, "$1[REDACTED]"),
    )
    .replace(skKeyShape, "sk-[REDACTED]");
}

/** Reported from the readiness deadline (C-ATTN-11) or at the backstop (C-ATTN-06). */
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
   * Only `sk-` API-key-shaped tokens are redacted, including a key wrapped across rows,
   * whose continuing runs are redacted even when they are words. Account details and
   * other credentials the agent showed can remain.
   */
  readonly text: string;
};

/**
 * Redact `sk-` API-key-shaped tokens, then trim trailing whitespace and retain up to
 * 8,192 UTF-16 units without splitting a surrogate pair (C-ATTN-06). Redacting first
 * keeps the cut from leaving a key's tail without its `sk-`.
 */
export function unrecognizedStartupActivity(
  agent: ElwoodAgentKind,
  elwoodSessionId: string,
  screen: string,
  label: UnrecognizedStartupLabel = "initial_ready_backstop",
): UnrecognizedStartupActivity {
  const text = redactSkKeys(screen)
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
