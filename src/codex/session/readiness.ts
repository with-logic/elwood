/**
 * Codex's initial-readiness gate: its deadline needs the configured composer (the native
 * status footer, showing a requested effort once Codex has applied it), and missing evidence
 * at the backstop is reported as a content-free `initial_ready_backstop` warning (PRD §5.3,
 * §5.7, C-API-28).
 */
import type { CodexReasoningEffort } from "../../core/reasoning-effort.ts";
import type { InitialReadyBackstopWarning } from "../../core/warnings/lifecycle.ts";
import type { TypedEmitter } from "../../events/emitter.ts";
import { createStartupReadinessGate } from "../../runtime/session/startup-readiness.ts";
import { codexComposerConfigured } from "../screen/clearance.ts";
import type { CodexEventMap } from "./types.ts";

/** The launch facts the gate reads: a resume, the session id and the requested effort. */
export type CodexReadinessLaunch = {
  readonly resumed: boolean;
  readonly record: { readonly elwoodSessionId: string };
  readonly options: { readonly reasoningEffort?: CodexReasoningEffort | undefined };
};

/**
 * Whether Codex's footer shows `effort` once it has applied it. Codex labels `none`, like
 * no effort, `default`, the label every footer shows before that (C-API-28).
 */
export function codexFooterShowsEffort(effort: CodexReasoningEffort | undefined): boolean {
  return effort !== undefined && effort !== "none";
}

export function createCodexReadinessGate(
  onReady: () => void,
  { resumed, record, options }: CodexReadinessLaunch,
  warnings: { emitWarnings(warnings: readonly InitialReadyBackstopWarning[]): void },
  events: Pick<TypedEmitter<CodexEventMap>, "emit">,
) {
  const effortShown = codexFooterShowsEffort(options.reasoningEffort);
  return createStartupReadinessGate(onReady, resumed, {
    session: { agent: "codex", elwoodSessionId: record.elwoodSessionId },
    configured: (frame, cols) => codexComposerConfigured(frame, cols, effortShown),
    warnings,
    events,
  });
}
