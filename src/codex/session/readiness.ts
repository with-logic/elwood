/**
 * Codex's initial-readiness gate: its deadline needs the configured composer (the native
 * status footer), and missing evidence at the backstop is reported as a content-free
 * `initial_ready_backstop` warning (PRD §5.3, §5.7, C-API-28). Its header drawn alone, its
 * boot composer and its resume placeholder are startup screens Codex draws before that
 * footer, not unrecognized ones (§5.4, C-ATTN-11).
 */
import type { InitialReadyBackstopWarning } from "../../core/warnings/lifecycle.ts";
import type { TypedEmitter } from "../../events/emitter.ts";
import { createNativeBootFrameMatcher } from "../../runtime/readiness/boot-frame.ts";
import { createStartupReadinessGate } from "../../runtime/session/startup-readiness.ts";
import { codexComposerConfigured } from "../screen/clearance.ts";
import { codexUnconfiguredComposerVisible } from "../update/repaint.ts";
import type { CodexEventMap } from "./types.ts";

/** Codex's header drawn alone while it loads (C-ATTN-11). */
export const isCodexBootFrame = createNativeBootFrameMatcher(/>_ OpenAI Codex \(v\d+\.\d+\.\d+/);

export function createCodexReadinessGate(
  onReady: () => void,
  resumed: boolean,
  elwoodSessionId: string,
  warnings: { emitWarnings(warnings: readonly InitialReadyBackstopWarning[]): void },
  events: Pick<TypedEmitter<CodexEventMap>, "emit">,
) {
  return createStartupReadinessGate(onReady, resumed, {
    session: { agent: "codex", elwoodSessionId },
    configured: codexComposerConfigured,
    nativeStartupScreen: (frame) =>
      isCodexBootFrame(frame) || codexUnconfiguredComposerVisible(frame),
    warnings,
    events,
  });
}
