/**
 * Classifies the frames of a startup screen Elwood does not recognize, from the readiness
 * deadline until the first readiness, and reports each run of them once.
 * Implements PRD §5.4 "Unrecognized agent startup screen" (C-ATTN-11).
 */
import type { ComposerReadyFacts } from "./initial-ready.ts";

/** The adapter evidence that recognizes a startup frame, and where a run is reported. */
export type StartupScreenEvidence = {
  /** The adapter's configured composer (C-API-28). */
  readonly configured: (frame: string, cols?: number) => boolean;
  /**
   * The screens the adapter draws before that composer: its boot frames, and Codex's boot
   * composer and resume placeholder.
   */
  readonly nativeStartupScreen: (frame: string) => boolean;
  /** Whether the latest frame is completed; a synchronized repaint can span PTY writes. */
  readonly completed: () => boolean;
  readonly report: (text: string) => void;
};

export type UnrecognizedStartupWatch = {
  readonly deadlinePassed: () => void;
  /** The first readiness: no frame is an unrecognized startup screen after it. */
  readonly end: () => void;
  /**
   * Whether this frame is an unrecognized startup screen. A blank or incomplete frame is
   * not, nor does it end a run.
   */
  readonly classify: (
    facts: ComposerReadyFacts,
    automationInputBlocking: boolean,
    frame: { readonly text: string; readonly cols?: number | undefined },
  ) => boolean;
  /**
   * Whether a run's block still holds: from an unrecognized frame until a recognized dialog,
   * startup automation, visible work or the configured composer. Blank, incomplete and
   * native startup frames leave it as it was.
   */
  readonly blocking: () => boolean;
  /** Report the current run once, with the text of a frame in it. */
  readonly report: (text: string) => void;
};

/**
 * The watch for one session's startup: inert until the deadline, ended by the first
 * readiness, and reporting through `evidence.report`.
 */
export function createUnrecognizedStartupWatch(
  evidence: StartupScreenEvidence,
): UnrecognizedStartupWatch {
  let deadline = false;
  let ended = false;
  let current = false;
  let blocking = false;
  let reported = false;
  /** A recognized dialog or automation hold, visible work, or the configured composer. */
  const hasRecognizedStartupEvidence = (
    facts: ComposerReadyFacts,
    automationInputBlocking: boolean,
    { text, cols }: { readonly text: string; readonly cols?: number | undefined },
  ) =>
    facts.blocking_prompt_visible ||
    automationInputBlocking ||
    facts.working_visible === true ||
    evidence.configured(text, cols);
  return {
    deadlinePassed: () => {
      deadline = true;
    },
    end: () => {
      ended = true;
      current = false;
      blocking = false;
    },
    classify: (facts, automationInputBlocking, frame) => {
      // Before the deadline and after readiness `current` and `blocking` are already false.
      if (!deadline || ended) return false;
      const pending = frame.text.trim() === "" || !evidence.completed();
      const recognizedEvidence =
        !pending && hasRecognizedStartupEvidence(facts, automationInputBlocking, frame);
      current = !(pending || recognizedEvidence || evidence.nativeStartupScreen(frame.text));
      blocking = current || (blocking && !recognizedEvidence);
      // A recognized frame ends the run, so the next unrecognized one is reported again.
      const endsRun = !(pending || current);
      if (endsRun) reported = false;
      return current;
    },
    blocking: () => blocking,
    report: (text) => {
      if (!current || reported) return;
      reported = true;
      evidence.report(text);
    },
  };
}

/** Without adapter evidence no frame is an unrecognized startup screen. */
export const noUnrecognizedStartup: Pick<UnrecognizedStartupWatch, "classify" | "report"> = {
  classify: () => false,
  report: () => undefined,
};
