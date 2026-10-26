/**
 * Codex's numbered trust retry (PRD §5.4, C-TRUST-01). Under load Codex 0.164 takes the
 * directory-trust answer `1\r` but can paint its composer after the retry interval, so
 * typing the number again would submit "1" as a user turn. Enter on its gate confirms
 * the highlighted option, and Enter on its empty composer submits nothing
 * (docs/cli-behavior.md), so Codex retries with Enter alone while the caret is on the
 * affirmative. Its hook gate opens with the caret on `Review hooks`, so that gate falls
 * back to retyping after a rendered frame.
 */
import { enterWhileSelected, type NumberedRetry } from "../core/trust/step.ts";

export const codexNumberedRetry: NumberedRetry = enterWhileSelected;
