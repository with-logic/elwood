/**
 * Codex's initial-readiness gate: its deadline needs the configured composer (the native
 * status footer, whose effort label, for a session that requested an effort Codex labels, is
 * no longer `default` once Codex applied it, or when the backstop falls), and missing
 * evidence at the backstop is reported as a content-free warning (PRD §5.3, §5.7, C-API-28).
 * Its header drawn alone, its boot composer, its resume placeholder and its footer before it
 * shows the requested effort are startup screens Codex draws before that composer, not
 * unrecognized ones (§5.4, C-ATTN-11).
 */
import { runContained } from "../../core/contained.ts";
import type { CodexReasoningEffort } from "../../core/reasoning-effort.ts";
import type { InitialReadinessWarning } from "../../core/warnings/lifecycle.ts";
import type { TypedEmitter } from "../../events/emitter.ts";
import { createNativeBootFrameMatcher } from "../../runtime/readiness/boot-frame.ts";
import { initialBackstopMs } from "../../runtime/readiness/initial-ready.ts";
import { createStartupReadinessGate } from "../../runtime/session/startup-readiness.ts";
import { codexReadinessEvidence } from "../screen/clearance.ts";
import { codexFooterShowsEffort } from "../screen/footer.ts";
import { codexUnconfiguredComposerVisible } from "../update/repaint.ts";
import type { CodexEventMap } from "./types.ts";

/** Codex's header drawn alone while it loads (C-ATTN-11). */
export const isCodexBootFrame = createNativeBootFrameMatcher(/>_ OpenAI Codex \(v\d+\.\d+\.\d+/);

/** The launch facts the gate reads: a resume, the session id and the requested effort. */
export type CodexReadinessLaunch = {
  readonly resumed: boolean;
  readonly record: { readonly elwoodSessionId: string };
  readonly options: { readonly reasoningEffort?: CodexReasoningEffort | undefined };
};

/**
 * The configured-composer check for a session that requested `effort`. Once a footer shows
 * it, Codex has applied its configuration: a later label, such as a pre-ready `setModel` to an
 * effort labelled `default`, cannot revoke that. The wait for the label ends when the
 * initial-readiness backstop falls, so a footer that never shows it degrades to the footer
 * alone (`onLapse`) and never holds readiness for good.
 */
export function codexConfiguredCheck(
  effort: CodexReasoningEffort | undefined,
  onLapse: () => void,
) {
  let lapse: ReturnType<typeof setTimeout> | undefined;
  let lapsed = false;
  let stopped = false;
  let waitOver = false;
  return {
    /**
     * Start the wait's bound with the shared deadline, on the first rendered frame. Armed
     * just before the backstop and with its delay, the lapse falls first, so the backstop
     * judges the footer alone.
     */
    arm: () => {
      if (stopped) return;
      lapse ??= setTimeout(() => {
        lapsed = true;
      }, initialBackstopMs);
    },
    stop: () => {
      stopped = true;
      clearTimeout(lapse);
    },
    configured: (frame: string, cols?: number): boolean => {
      const painted = codexReadinessEvidence(frame, cols);
      if (waitOver || !painted) return painted;
      if (codexReadinessEvidence(frame, cols, effort)) {
        waitOver = codexFooterShowsEffort(effort);
        return true;
      }
      if (!lapsed) return false;
      waitOver = true;
      runContained(onLapse);
      return true;
    },
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
  const check = codexConfiguredCheck(options.reasoningEffort, onLapse);
  const gate = createStartupReadinessGate(
    () => {
      onReady();
      check.stop();
    },
    resumed,
    {
      session: { agent: "codex", elwoodSessionId },
      configured: check.configured,
      // A footer still waiting for the requested effort is Codex's own, not unrecognized.
      nativeStartupScreen: (frame, cols) =>
        isCodexBootFrame(frame) ||
        codexUnconfiguredComposerVisible(frame) ||
        codexReadinessEvidence(frame, cols),
      warnings,
      events,
    },
  );
  const { ready } = gate;
  return {
    ...gate,
    ready: {
      ...ready,
      armDeadline: () => {
        check.arm();
        ready.armDeadline();
      },
      cancel: () => {
        check.stop();
        ready.cancel();
      },
    },
  };
}
