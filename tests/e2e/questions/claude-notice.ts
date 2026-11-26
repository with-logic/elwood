/** Post the transient notice Claude draws above its composer (PRD §12, C-E2E-18). */
import { waitFor } from "../wait-for.ts";
import type { ClaudeRoundKind } from "./claude-round-kinds.ts";

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
/** A shorter grouped question's footer drawn on the notice row keeps the blank cells too. */
const footerOnNoticeRow = /^Enter to select · .+ · Esc to cancel {20,}$/m;
/** A footer that starts on one row and ends one or two rows below it. */
const wrappedFooter = /^Enter to select · (?!.*Esc to cancel *$).*\n(?:.*\n)?.*Esc to cancel *$/m;

/**
 * A proof session's pane. At 140 columns a notice is posted before each question, and `blankCells`
 * says whether its questionnaires keep the notice's blank cells. At 60 columns Claude wraps the
 * footer once the cursor reaches Other, `Next` or `Submit`. A 60-cell row cannot hold the notice's
 * 42 characters after the 20-cell indent `noticeRow` requires, so none is posted.
 */
export type ClaudeProofPane =
  | { readonly cols: 140; readonly blankCells: boolean }
  | { readonly cols: 60 };

/** The paint evidence `pane` must record for `kinds`: only long text draws a footer on the notice. */
export function expectedPaintEvidence(pane: ClaudeProofPane, kinds: readonly ClaudeRoundKind[]) {
  const posted = pane.cols === 140;
  return {
    drawnAtQuestion: kinds.map(() => posted),
    residueWhenRaised: kinds.map(() => pane.cols === 140 && pane.blankCells),
    footerKeptCells: posted && kinds.includes("long-text"),
    footerWrapped: !posted,
  };
}

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
  /** Whether any painted questionnaire footer sat on the notice row, keeping its blank cells. */
  readonly footerKeptCells: boolean;
  /** The first painted questionnaire footer that wrapped over rows, if any. */
  readonly wrappedFooter: string | undefined;
  /** This proof's evidence, in the shape `expectedPaintEvidence` returns. */
  evidence(): ReturnType<typeof expectedPaintEvidence>;
  /** On each terminal paint. */
  painted(): void;
  /** At the idle composer, before each prompt. */
  post(): Promise<void>;
  /** From the `AskUserQuestion` `PreToolUse` hook; the questionnaire paints once it returns. */
  atQuestion(): void;
  raised(screen: string): void;
  stop(): void;
};

/**
 * Records each question's notice and footer-paint evidence. The 140-column cases call `post()`
 * before each prompt; the 60-column case posts no notice and checks the wrapped footer it records.
 * Cancellation closes the session, so `signal` stops reposting before any Alt+T can reach a PTY
 * that is shutting down.
 */
export function claudeNoticeProof(
  press: (input: string) => void,
  screen: () => string | undefined,
  signal: AbortSignal,
): ClaudeNoticeProof {
  let notice: PostedClaudeNotice | undefined;
  const drawnAtQuestion: boolean[] = [];
  const residueWhenRaised: boolean[] = [];
  let footerKeptCells = false;
  let wrapped: string | undefined;
  const stop = () => notice?.stop();
  signal.addEventListener("abort", stop, { once: true });
  return {
    drawnAtQuestion,
    residueWhenRaised,
    get footerKeptCells() {
      return footerKeptCells;
    },
    get wrappedFooter() {
      return wrapped;
    },
    evidence: () => ({
      drawnAtQuestion,
      residueWhenRaised,
      footerKeptCells,
      footerWrapped: wrapped !== undefined,
    }),
    painted() {
      const text = screen() ?? "";
      footerKeptCells ||= footerOnNoticeRow.test(text);
      wrapped ??= wrappedFooter.exec(text)?.[0];
    },
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
