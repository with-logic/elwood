/** Bound the live-only Codex startup screen activity (PRD §5.4, C-ATTN-06). */
import type { InitialReadyBackstopWarning } from "../warnings/lifecycle.ts";

export type UnrecognizedStartupActivity = {
  readonly elwoodSessionId: string;
  readonly agent: "codex";
  readonly source: "terminal";
  readonly kind: "unrecognized_startup";
  readonly label: InitialReadyBackstopWarning["code"];
  readonly text: string;
};

export function unrecognizedStartupActivity(
  elwoodSessionId: string,
  screen: string,
): UnrecognizedStartupActivity {
  const text = screen
    .trimEnd()
    .slice(-8192)
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
