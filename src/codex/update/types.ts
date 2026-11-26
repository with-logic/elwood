/**
 * What one bounded skip of a Codex update appearance needs and offers (PRD §5.5;
 * C-CODEX-12, C-CODEX-27).
 */
import type { AutomationWriteResult } from "../../core/startup/barrier.ts";
import type { StartupWriteCompletion } from "../../core/startup/write.ts";
import type { TrustClearance } from "../../core/trust/clearance.ts";
import type { TrustWriteResult } from "../../core/trust/responder.ts";
import type { CodexUpdatePromptTracker } from "./tracker.ts";

export type UpdateSkipRequest = {
  readonly option: string;
  readonly generation: number;
  readonly screenText: string;
  readonly tracker: CodexUpdatePromptTracker;
  readonly writeAutomation: (
    input: string,
    perWrite?: (frameText: string) => boolean,
  ) => TrustWriteResult | Promise<AutomationWriteResult>;
  readonly readFrame: (() => string) | undefined;
  readonly signal: AbortSignal;
  readonly clearance: TrustClearance;
  /** The session's input hold, which includes this attempt's own repaint hold. */
  readonly inputHeld: () => boolean;
  readonly releaseLatch: () => void;
  /** A grace or answered bound expired with no frame to follow; the session reads its frame again. */
  readonly repaintExpired: () => void;
};

export type UpdateSkipAttempt = {
  readonly settled: Promise<StartupWriteCompletion>;
  readonly observeClearance: (frame: string) => void;
  /** Each frame the session renders, before its input hold is classified. */
  readonly observeFrame: (frame: string) => void;
  /** Codex is repainting after this attempt's key: input stays held, and no dialog is reported. */
  readonly ownsRepaint: () => boolean;
  /** Raw caller input owns this appearance: no retry or pending write follows it. */
  readonly cancel: () => void;
};
