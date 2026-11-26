/**
 * Who answers each appearance of Codex's update offer: Elwood's one bounded skip, or raw
 * caller input (PRD §5.5; C-CODEX-12, C-CODEX-17, C-CODEX-27).
 */
import type { StartupWriteCompletion } from "../../core/startup/write.ts";
import { trustGateVisible } from "../../core/trust/blocking.ts";
import type { TrustClearance } from "../../core/trust/clearance.ts";
import { safeUpdateOption } from "./selection.ts";
import { startCodexUpdateSkip } from "./skip-attempt.ts";
import { CodexUpdatePromptTracker } from "./tracker.ts";
import type { UpdateSkipAttempt, UpdateSkipRequest } from "./types.ts";

type CodexUpdateSkipsOptions = {
  readonly clearance: TrustClearance;
  /**
   * The live session's input hold. Supplying it also defers clearance: the tracker waits
   * for `observeClearance`, which the session calls once a frame's retained input is
   * classified. Without it, as for a static caller, the tracker checks clearance itself
   * on each frame without the offer.
   */
  readonly inputHeld: (() => boolean) | undefined;
  /** The responder's lifetime: closing ends every skip. */
  readonly signal: AbortSignal;
  readonly onStateChange: (() => void) | undefined;
};

/** Elwood's skip of an update appearance, as the startup outcome it reports. */
type UpdateSkipOutcome = {
  readonly outcome: {
    readonly kind: "attempted";
    readonly prompt: "update";
    readonly input: string;
  };
  readonly settled: Promise<StartupWriteCompletion>;
};

/** What one frame meant for the update offer. */
type CodexUpdateObservation = {
  readonly generation: number;
  /** The frame shows an appearance that needs the host's attention again. */
  readonly renewAttention: boolean;
  /** Elwood's skip, when this frame started one. */
  readonly outcome: UpdateSkipOutcome | undefined;
};

/**
 * Tracks the session's update offer appearances and starts at most one bounded skip of
 * each, unless raw caller input owns it.
 */
export class CodexUpdateSkips {
  private readonly tracker: CodexUpdatePromptTracker;
  private readonly clearance: TrustClearance;
  private readonly inputHeld: () => boolean;
  private readonly signal: AbortSignal;
  private readonly onStateChange: (() => void) | undefined;
  // The update-screen generation that owns the skip latch (0 = none). Only that
  // generation's own completion may release it; a stale completion is a no-op.
  private skipGeneration = 0;
  private attempt: UpdateSkipAttempt | undefined;
  // Raw caller input owns an unresolved update until a native composer clears it.
  private callerOwned = false;

  constructor({ clearance, inputHeld, signal, onStateChange }: CodexUpdateSkipsOptions) {
    this.clearance = clearance;
    this.inputHeld = inputHeld ?? (() => false);
    this.signal = signal;
    this.onStateChange = onStateChange;
    this.tracker = new CodexUpdatePromptTracker(clearance, inputHeld !== undefined);
  }

  observeClearance(frame: string): void {
    if (this.tracker.needsClearance)
      this.tracker.observeClearance(!this.inputHeld() && this.clearance(frame));
    this.attempt?.observeClearance(frame);
  }

  /** Raw caller input owns the offer on screen and ends any skip of it. */
  callerInput(): void {
    this.attempt?.cancel();
    this.callerOwned ||= this.tracker.unresolved;
  }

  /** Codex is repainting after a skip's key, so input stays held (C-CODEX-27). */
  ownsRepaint(): boolean {
    return this.attempt?.ownsRepaint() === true;
  }

  /**
   * Each frame, after trust. One bounded skip belongs to one appearance. Unknown
   * replacements disable reauthorization immediately; a fresh banner with a valid current
   * safe-option block or authoritative native clearance can rearm it. The live observer
   * confirms clearance after this frame's retained hold is classified, before queued input
   * can repaint it.
   */
  observe(
    screenText: string,
    writeAutomation: UpdateSkipRequest["writeAutomation"],
    readFrame: UpdateSkipRequest["readFrame"],
  ): CodexUpdateObservation {
    this.callerOwned &&= this.tracker.unresolved; // a later appearance is new
    const renewAttention = this.tracker.renewsAttention(screenText);
    const onUpdateScreen = this.tracker.observe(screenText);
    this.attempt?.observeFrame(screenText);
    const generation = this.tracker.currentGeneration;
    const automatable = onUpdateScreen && !this.callerOwned;
    const outcome = automatable
      ? this.startSkip(generation, screenText, writeAutomation, readFrame)
      : undefined;
    return { generation, renewAttention, outcome };
  }

  /** Elwood's skip of an appearance it has not answered yet, as a startup outcome. */
  private startSkip(
    generation: number,
    screenText: string,
    writeAutomation: UpdateSkipRequest["writeAutomation"],
    readFrame: UpdateSkipRequest["readFrame"],
  ): UpdateSkipOutcome | undefined {
    // A trust gate (held allowlisted candidate or off-allowlist) is never ELIGIBLE for
    // update-skip automation, even when its rows resemble the update options. This gates
    // the WRITE only: the tracker still counts such a frame as an update appearance, so
    // generation latching and re-arming are unaffected.
    if (this.skipGeneration === generation || trustGateVisible(screenText, "codex")) return;
    const parsed = this.tracker.classify(screenText);
    const option = safeUpdateOption(screenText, parsed.options ?? [])?.number ?? null;
    if (!(option && this.tracker.currentFramePredicate()(screenText))) return;
    // Latch this appearance before writing; rejection can release the latch for a later
    // frame, while success requires observed clearance (C-CODEX-17).
    this.skipGeneration = generation;
    this.attempt = startCodexUpdateSkip({
      option,
      generation,
      screenText,
      tracker: this.tracker,
      writeAutomation,
      readFrame,
      signal: this.signal,
      clearance: this.clearance,
      inputHeld: this.inputHeld,
      releaseLatch: () => {
        this.skipGeneration = 0;
      },
      repaintExpired: () => this.onStateChange?.(),
    });
    return {
      outcome: { kind: "attempted", prompt: "update", input: option },
      settled: this.attempt.settled,
    };
  }
}
