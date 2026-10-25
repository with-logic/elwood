/**
 * Waits for a resumed Codex screen to stop repainting, for the real-CLI resume e2e
 * (PRD §5.3, C-API-28, C-TURN-03).
 *
 * The resumed transcript replay repaints in bursts (docs/cli-behavior.md, "Resume
 * lifecycle"), so "replay finished" means the rendered screen and window title stayed
 * unchanged with no working marker for a SUSTAINED streak of frames — not one quiet
 * frame, and not a fixed sleep. Codex 0.164 first paints a "Resuming session…"
 * placeholder for up to 1.6 s and only then loads the conversation under a title
 * spinner, so neither counts as quiet. Best-effort: at its deadline it returns rather
 * than fails, so a never-settling screen still reaches the caller's assertion.
 */

import type { CodexSessionApi } from "../../src/index.ts";

const QUIET_STREAK_MS = 2_000;
const QUIET_DEADLINE_MS = 15_000;
const FRAME_MS = 250;

export async function waitForQuietScreen(session: CodexSessionApi): Promise<void> {
  const started = Date.now();
  let last = "";
  let quietSince = Date.now();
  while (Date.now() - started < QUIET_DEADLINE_MS) {
    const title = session.terminal.title;
    const text = `${title}\n${session.terminal.snapshot().text}`;
    const unsettled = /esc to interrupt|Resuming session…/i.test(text) || /^[⠀-⣿]/.test(title);
    const quiet = text === last && !unsettled;
    if (!quiet) quietSince = Date.now();
    if (Date.now() - quietSince >= QUIET_STREAK_MS) return;
    last = text;
    await new Promise((resolve) => setTimeout(resolve, FRAME_MS));
  }
}
