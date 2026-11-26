/**
 * Codex's initial-readiness gate: its deadline needs the configured composer (the native
 * status footer, whose effort label, for a session that requested an effort Codex labels, is
 * no longer `default` once Codex applied it, or by the backstop at the latest), and missing
 * evidence at the backstop is reported as a content-free warning (PRD §5.3, §5.7, C-API-28).
 */
import { runContained } from "../../core/contained.ts";
import type { CodexReasoningEffort } from "../../core/reasoning-effort.ts";
import type { InitialReadinessWarning } from "../../core/warnings/lifecycle.ts";
import type { TypedEmitter } from "../../events/emitter.ts";
import { initialBackstopMs } from "../../runtime/readiness/initial-ready.ts";
import { createStartupReadinessGate } from "../../runtime/session/startup-readiness.ts";
import { codexComposerConfigured } from "../screen/clearance.ts";
import { codexFooterShowsEffort } from "../screen/footer.ts";
import type { CodexEventMap } from "./types.ts";

/** The launch facts the gate reads: a resume, the session id and the requested effort. */
export type CodexReadinessLaunch = {
  readonly resumed: boolean;
  readonly record: { readonly elwoodSessionId: string };
  readonly options: { readonly reasoningEffort?: CodexReasoningEffort | undefined };
};

/**
 * The configured-composer check for a session that requested `effort`. Once a footer shows
 * it, Codex has applied its configuration: a later label, such as a pre-ready `setModel` to an
 * effort labelled `default`, cannot revoke that. The wait for the label ends by the backstop,
 * which falls `initialBackstopMs` after the first frame, so a footer that never shows it
 * degrades to the footer alone (`onLapse`) and never holds readiness for good.
 */
export function codexConfiguredCheck(
  effort: CodexReasoningEffort | undefined,
  onLapse: () => void,
): (frame: string, cols?: number) => boolean {
  const lapsesAt = Date.now() + initialBackstopMs;
  let waitOver = false;
  return (frame, cols) => {
    const painted = codexComposerConfigured(frame, cols);
    if (waitOver || !painted) return painted;
    if (codexComposerConfigured(frame, cols, effort)) {
      waitOver = codexFooterShowsEffort(effort);
      return true;
    }
    if (Date.now() < lapsesAt) return false;
    waitOver = true;
    runContained(onLapse);
    return true;
  };
}

export function createCodexReadinessGate(
  onReady: () => void,
  { resumed, record, options }: CodexReadinessLaunch,
  warnings: { emitWarnings(warnings: readonly InitialReadinessWarning[]): void },
  events: Pick<TypedEmitter<CodexEventMap>, "emit">,
) {
  const { elwoodSessionId } = record;
  const onLapse = () =>
    warnings.emitWarnings([
      {
        elwoodSessionId,
        agent: "codex",
        source: "lifecycle",
        code: "codex_effort_unconfirmed",
        severity: "warning",
        message: `Codex did not show the requested reasoning effort within ${initialBackstopMs / 1_000} seconds; readiness was released on its status footer, and a mode or model picked before Codex applies its configuration can be discarded.`,
        raw: "codex_effort_unconfirmed",
      },
    ]);
  return createStartupReadinessGate(onReady, resumed, {
    session: { agent: "codex", elwoodSessionId },
    configured: codexConfiguredCheck(options.reasoningEffort, onLapse),
    warnings,
    events,
  });
}
