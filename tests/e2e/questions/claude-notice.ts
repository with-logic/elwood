/** Post the transient notice Claude draws above its composer (PRD §12, C-E2E-18). */
import { waitFor } from "../wait-for.ts";

/** Alt+T. Haiku cannot turn thinking off, so Claude changes nothing and posts a three-second notice. */
const thinkingToggle = "\x1bt";
const noticeDrawTimeoutMs = 3_000;
/** Shorter than the notice's three-second lifetime, so it never lapses before the question hook. */
const repostMs = 1_000;
const noticeRow = /^ {20,}Thinking can't be turned off/m;

/**
 * The questionnaire's last row with a replaced notice's blank cells: the single-choice Other row or
 * the checkbox Next or Submit row, not highlighted. Other is option 3 because each single-choice
 * question in the proof has two options. Twenty cells is far above Claude's one-cell cursor pad;
 * captures show 66 to 85.
 */
export const claudeNoticeResidue = /^(?: {2}3\. Type something\.| {5}(?:Next|Submit)) {20,}$/m;

type PostedClaudeNotice = {
  /** Stops reposting the notice. */
  stop(): void;
  /** Whether the notice is drawn on the current screen. */
  drawn(): boolean;
};

/**
 * Posts the notice at the idle composer and reposts it until stopped. A notice posted at idle adds
 * a row above the composer, so Claude writes the notice's indent as real spaces where the composer's
 * top rule was. An unnamed session's questionnaire painted over that row keeps them. `press` writes
 * straight to the native PTY, as a person at that terminal would.
 */
async function postClaudeNotice(
  press: (input: string) => void,
  screen: () => string | undefined,
): Promise<PostedClaudeNotice> {
  const drawn = () => noticeRow.test(screen() ?? "");
  press(thinkingToggle);
  await waitFor(() => (drawn() ? true : undefined), "Claude's posted notice", noticeDrawTimeoutMs);
  const repost = setInterval(() => press(thinkingToggle), repostMs);
  repost.unref();
  return { stop: () => clearInterval(repost), drawn };
}

/** Per-question notice evidence for C-E2E-18. */
export type ClaudeNoticeProof = {
  /** Whether the notice was still drawn at each `AskUserQuestion` hook. */
  readonly drawnAtQuestion: readonly boolean[];
  /** Whether each question was raised on a screen that kept the blank cells. */
  readonly residueWhenRaised: readonly boolean[];
  /** At the idle composer, before each prompt. */
  post(): Promise<void>;
  /** From the `AskUserQuestion` `PreToolUse` hook; the questionnaire paints once it returns. */
  atQuestion(): void;
  raised(screen: string): void;
  stop(): void;
};

/**
 * Posts the notice before each question and records the evidence for each one. Cancellation closes
 * the session, so `signal` stops reposting before any Alt+T can reach a PTY that is shutting down.
 */
export function claudeNoticeProof(
  press: (input: string) => void,
  screen: () => string | undefined,
  signal: AbortSignal,
): ClaudeNoticeProof {
  let notice: PostedClaudeNotice | undefined;
  const drawnAtQuestion: boolean[] = [];
  const residueWhenRaised: boolean[] = [];
  const stop = () => notice?.stop();
  signal.addEventListener("abort", stop, { once: true });
  return {
    drawnAtQuestion,
    residueWhenRaised,
    async post() {
      signal.throwIfAborted();
      notice = await postClaudeNotice(press, screen);
      if (signal.aborted) stop();
    },
    atQuestion() {
      notice?.stop();
      drawnAtQuestion.push(notice?.drawn() ?? false);
    },
    raised(text) {
      residueWhenRaised.push(claudeNoticeResidue.test(text));
    },
    stop() {
      stop();
      signal.removeEventListener("abort", stop);
    },
  };
}
