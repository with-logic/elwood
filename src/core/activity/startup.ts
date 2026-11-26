/** Redact and bound the live-only startup screen activity (PRD §5.4, C-ATTN-06). */
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
/** A key character that can continue onto the next row; a dot ends a masked key. */
const keyChar = "[A-Za-z0-9_-]";
/** Spaces and an optional `│` box border, within one row. */
const border = "[^\\S\\n]*(?:│[^\\S\\n]*)?";
const rowBreak = `${border}\\n${border}`;
/**
 * A key wrapped across rows. A row ends in `sk-` and any key characters, or in only the
 * `s` or `sk` of the prefix, and the next row's leading run of key characters completes
 * `sk-` and a key character. Each following row's leading run continues the key while the
 * run before it was all its row held, apart from spaces and a border.
 */
const wrappedKey = new RegExp(
  `\\b(?:sk-${keyChar}*${rowBreak}${keyChar}|sk${rowBreak}-${keyChar}|s${rowBreak}k-${keyChar})` +
    `${keyChar}*(?:${rowBreak}${keyChar}+)*`,
  "g",
);
const wrappedKeyStart = new RegExp(`^(?:sk-${keyChar}*|sk?)`);
const wrappedKeyRun = new RegExp(`(\\n${border})${keyChar}+`, "g");

/**
 * Redact each `sk-` key-shaped token. The first part of a wrapped key becomes
 * `sk-[REDACTED]` and each continuing run `[REDACTED]`, even when that run is a word.
 */
function redactSkKeys(screen: string): string {
  return screen
    .replace(wrappedKey, (key) =>
      key.replace(wrappedKeyStart, "sk-[REDACTED]").replace(wrappedKeyRun, "$1[REDACTED]"),
    )
    .replace(skKeyShape, "sk-[REDACTED]");
}

export type UnrecognizedStartupActivity = {
  readonly elwoodSessionId: string;
  readonly agent: ElwoodAgentKind;
  readonly source: "terminal";
  readonly kind: "unrecognized_startup";
  readonly label: InitialReadyBackstopWarning["code"];
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
    label: "initial_ready_backstop",
    text,
  };
}
