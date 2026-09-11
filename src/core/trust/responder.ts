/**
 * Detects and answers the allowlisted family of adapter startup trust prompts.
 * Implements PRD §5.1 and §9.1 (C-CLAUDE-10, C-CODEX-11, C-CLAUDE-14, C-CODEX-15).
 *
 * Policy (PRD §5.1): an agent must NEVER be left waiting on a trust gate.
 * Under the caller's full-trust posture, when an allowlisted trust prompt is
 * visible in the current frame, Elwood selects its affirmative option and sends
 * it — always say yes. Elwood only auto-answers ALLOWLISTED prompts (an
 * off-allowlist confirmation is left to the human), and never re-answers the same
 * prompt; those are the only limits.
 */

import type { ElwoodAgentKind } from "../activity/index.ts";
import { delay } from "../delay.ts";
import {
  nonOptionText,
  optionInput,
  optionKeystrokes,
  selectableOptions,
} from "../terminal-options.ts";
import {
  type TrustPromptIdFor,
  trustHeaderMatches,
  trustPromptAllowlist,
  trustPromptHeaderVisible,
} from "./prompts.ts";

/** The concrete allowlist entry type (preserves the derived literal `id`). */
type TrustPromptEntry = (typeof trustPromptAllowlist)[number];

const cursorRetryMs = 250;
const cursorNavigationTimeoutMs = 5_000;

/** An answered trust prompt; `prompt` is narrowed to the responder's agent. */
export type TrustPromptAutomation<A extends ElwoodAgentKind = ElwoodAgentKind> = {
  readonly prompt: TrustPromptIdFor<A>;
  readonly input: string;
};

/**
 * The completion of an answered trust write: a `void | Promise<void>` write is
 * normalized to a promise that resolves on success and rejects once the prompt
 * has been un-settled (kept retryable) on a rejected write.
 */
export type TrustWriteResult = void | Promise<void>;

/**
 * The outcome of handling a frame: an answered prompt, a recognized prompt whose
 * affirmative option has not rendered yet (a TRANSIENT render delay — under the
 * say-yes policy a later frame carrying the option is still answered, so this is
 * never a terminal wedge), or nothing.
 */
export type TrustPromptResult<A extends ElwoodAgentKind = ElwoodAgentKind> =
  | {
      readonly kind: "answered";
      readonly automation: TrustPromptAutomation<A>;
      // Resolves when the affirmative write fulfills; rejects (after the prompt is
      // un-settled, so a later frame re-attempts it) if the write is rejected.
      readonly settled: Promise<void>;
    }
  | { readonly kind: "option_pending"; readonly prompt: TrustPromptIdFor<A> }
  | undefined;

export class TrustPromptResponder<A extends ElwoodAgentKind> {
  // Whether the caller launched under full trust (`autotrust`). `answerPolicy:
  // "always"` prompts (hook trust) are answered even when this is false.
  private readonly autotrust: boolean;
  private readonly specs: readonly TrustPromptEntry[];
  private readonly settled = new Set<TrustPromptIdFor<A>>();
  // A prompt whose "option not rendered yet" state was reported once, kept
  // SEPARATE from `settled` so a later frame with the real option can still be
  // answered — the pending state is transient, not terminal.
  private readonly reportedPending = new Set<TrustPromptIdFor<A>>();

  constructor(agent: A, autotrust = false) {
    this.autotrust = autotrust;
    this.specs = trustPromptAllowlist.filter((spec) => spec.agent === agent);
  }

  /** `frame` MUST be the CURRENT rendered screen, not an accumulated buffer. */
  handle(
    frame: string,
    write: (input: string) => TrustWriteResult,
    readFrame?: () => string,
  ): TrustPromptResult<A> {
    const header = nonOptionText(frame);
    for (const spec of this.specs) {
      const id = spec.id as TrustPromptIdFor<A>;
      // `answerPolicy: "always"` prompts (Elwood's own hook bridge) answer
      // regardless of autotrust; every other trust prompt requires the caller's
      // full-trust posture.
      if (!(this.autotrust || spec.answerPolicy === "always")) continue;
      // Recognized when the prompt's HEADER wording appears on a NON-OPTION line
      // (via the shared `trustHeaderMatches`), so a phrase living only inside an
      // option label can't spoof a prompt. That is the ONLY guard — recognition
      // means "say yes".
      if (this.settled.has(id) || !trustHeaderMatches(header, spec)) continue;
      const options = selectableOptions(frame);
      const option = options.find((candidate) => spec.accept.test(candidate.label));
      if (option === undefined) {
        // Affirmative not rendered yet (partial frame). Report once, but DON'T
        // settle — a later frame with the option can still be answered.
        if (this.reportedPending.has(id)) continue;
        this.reportedPending.add(id);
        return { kind: "option_pending", prompt: id };
      }
      // Settle OPTIMISTICALLY so a second frame in the same tick does not re-answer,
      // but keep the settle contingent on the write: if the write is rejected we
      // un-settle here so a later frame re-attempts it, and the returned `settled`
      // promise rejects so the caller emits a warning instead of a false "answered".
      this.settled.add(id);
      const input = optionInput(option);
      const operation =
        option.style === "cursor"
          ? readFrame === undefined
            ? Promise.reject(new Error("Cursor trust navigation requires live screen reads."))
            : navigateCursorOption(spec, input, write, readFrame)
          : writeOptionKeys(optionKeystrokes(option), write);
      const settled = operation.catch((error: unknown) => {
        this.settled.delete(id);
        throw error;
      });
      return { kind: "answered", automation: { prompt: id, input }, settled };
    }
    return undefined;
  }
}

/** Writes one option's keys in order (numbered prompts and parser-only tests). */
async function writeOptionKeys(
  keys: readonly string[],
  write: (input: string) => TrustWriteResult,
): Promise<void> {
  for (const key of keys) await write(key);
}

/** Navigates a cursor prompt one observed frame at a time, retrying swallowed startup input. */
async function navigateCursorOption(
  spec: TrustPromptEntry,
  originalInput: string,
  write: (input: string) => TrustWriteResult,
  readFrame: () => string,
): Promise<void> {
  const deadline = Date.now() + cursorNavigationTimeoutMs;
  while (Date.now() < deadline) {
    const before = readFrame();
    if (!trustPromptHeaderVisible(before, spec)) {
      throw new Error("Cursor trust prompt disappeared before confirmation.");
    }
    const target = selectableOptions(before).find((option) => spec.accept.test(option.label));
    if (target?.style !== "cursor") {
      await delay(cursorRetryMs);
      continue;
    }
    const key = target.offset === 0 ? "\r" : target.offset < 0 ? "\u001b[A" : "\u001b[B";
    await write(key);
    const progress = await waitForCursorProgress(spec, target.offset, readFrame);
    if (progress === "cleared") return;
  }
  throw new Error(`Cursor trust navigation timed out (${originalInput}).`);
}

async function waitForCursorProgress(
  spec: TrustPromptEntry,
  priorOffset: number,
  readFrame: () => string,
): Promise<"cleared" | "retry"> {
  const deadline = Date.now() + cursorRetryMs;
  while (Date.now() < deadline) {
    await delay(20);
    const frame = readFrame();
    if (!trustPromptHeaderVisible(frame, spec)) {
      if (priorOffset === 0) return "cleared";
      throw new Error("Cursor trust prompt disappeared before confirmation.");
    }
    const target = selectableOptions(frame).find((option) => spec.accept.test(option.label));
    if (target?.style === "cursor" && target.offset !== priorOffset) return "retry";
  }
  return "retry";
}

/** Whether any allowlisted trust prompt for `agent` is showing its header in `text`. */
export function trustPromptVisible(text: string, agent: ElwoodAgentKind): boolean {
  return trustPromptAllowlist.some(
    (spec) => spec.agent === agent && trustPromptHeaderVisible(text, spec),
  );
}
