/**
 * Classifies the frames of a startup screen Elwood does not recognize, from the readiness
 * deadline until the first readiness, and reports each run of them once.
 * Implements PRD §5.4 "Unrecognized agent startup screen" (C-ATTN-09).
 */
import type { ComposerReadyFacts } from "./initial-ready.ts";

/** The adapter evidence that recognizes a startup frame, and where a run is reported. */
export type UnrecognizedStartupEvidence = {
  /** The adapter's configured composer (C-API-28). */
  readonly configured: (frame: string, cols?: number) => boolean;
  /** The adapter's own screens before that composer: Codex's boot composer and resume placeholder. */
  readonly startupScreen?: ((frame: string) => boolean) | undefined;
  /** Whether the latest frame is completed; a synchronized repaint can span PTY writes. */
  readonly completed?: (() => boolean) | undefined;
  readonly report?: ((text: string) => void) | undefined;
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
  /** Whether the last frame classified was one. */
  readonly current: () => boolean;
  /** Report the current run once, with the text of a frame in it. */
  readonly report: (text: string) => void;
};

export function createUnrecognizedStartupWatch(
  evidence: UnrecognizedStartupEvidence,
): UnrecognizedStartupWatch {
  let deadline = false;
  let ended = false;
  let current = false;
  let reported = false;
  const recognized = (
    facts: ComposerReadyFacts,
    automationInputBlocking: boolean,
    { text, cols }: { readonly text: string; readonly cols?: number | undefined },
  ) =>
    ended ||
    !deadline ||
    facts.blocking_prompt_visible ||
    automationInputBlocking ||
    facts.working_visible === true ||
    evidence.configured(text, cols) ||
    evidence.startupScreen?.(text) === true;
  return {
    deadlinePassed: () => {
      deadline = true;
    },
    end: () => {
      ended = true;
      current = false;
    },
    classify: (facts, automationInputBlocking, frame) => {
      const pending = frame.text.trim() === "" || evidence.completed?.() === false;
      current = !(pending || recognized(facts, automationInputBlocking, frame));
      if (!(current || pending)) reported = false;
      return current;
    },
    current: () => current,
    report: (text) => {
      if (!current || reported) return;
      reported = true;
      evidence.report?.(text);
    },
  };
}
