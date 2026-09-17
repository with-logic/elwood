/**
 * Detects and answers the allowlisted family of adapter startup trust prompts.
 * Implements PRD §5.1 and §9.1 (C-CLAUDE-10, C-CODEX-11, C-CLAUDE-14, C-CODEX-15).
 *
 * Policy (PRD §5.1): an agent must NEVER be left waiting on a trust gate.
 * Under the caller's full-trust posture, when an allowlisted trust prompt is
 * visible in the current frame, Elwood selects its affirmative option and sends
 * it. Recognition binds the header and answer to one active dialog and every
 * write revalidates it; unrelated confirmations remain with the human.
 */

import type { ElwoodAgentKind } from "../activity/index.ts";
import type { StartupWriteCompletion } from "../startup/write.ts";
import { optionInput } from "../terminal-options.ts";
import { parseTrustDialog } from "./dialog.ts";
import {
  activeTrustDialogVisible,
  type TrustPromptIdFor,
  trustPromptAllowlist,
} from "./prompts.ts";
import { writeTrustOption } from "./write.ts";

/** The concrete allowlist entry type (preserves the derived literal `id`). */
type TrustPromptEntry = (typeof trustPromptAllowlist)[number];

/** An attempted trust response; `prompt` is narrowed to the responder's agent. */
export type TrustPromptAutomation<A extends ElwoodAgentKind = ElwoodAgentKind> = {
  readonly prompt: TrustPromptIdFor<A>;
  readonly input: string;
};

/** Raw PTY writer result; the navigation owner separately settles answered or cancelled. */
export type TrustWriteResult = void | Promise<void>;

/**
 * The outcome of handling a frame: a cancellable write attempt, a recognized prompt whose
 * affirmative option has not rendered yet (a TRANSIENT render delay — under the
 * say-yes policy a later frame carrying the option is still answered, so this is
 * never a terminal wedge), or nothing.
 */
export type TrustPromptResult<A extends ElwoodAgentKind = ElwoodAgentKind> =
  | {
      readonly kind: "attempted";
      readonly automation: TrustPromptAutomation<A>;
      // Cancellation is a safe skip; both cancellation and write failure allow retry.
      readonly settled: Promise<StartupWriteCompletion>;
    }
  | { readonly kind: "option_pending"; readonly prompt: TrustPromptIdFor<A> }
  | undefined;

export class TrustPromptResponder<A extends ElwoodAgentKind> {
  // Whether the caller launched under full trust (`autotrust`). `answerPolicy:
  // "always"` prompts (hook trust) are answered even when this is false.
  private readonly autotrust: boolean;
  private visible = false;
  private dialogKey: string | undefined;
  private generation = 0;

  /** Automation owns input until the current native trust dialog clears. */
  get inputBlocking(): boolean {
    return this.visible;
  }
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
    const dialog = parseTrustDialog(frame);
    const key =
      dialog === undefined
        ? undefined
        : JSON.stringify([
            dialog.header,
            dialog.options.map((option) => [
              option.style,
              option.label,
              option.style === "numbered" ? option.number : "",
            ]),
          ]);
    // Clearing preserves the epoch for successful settlement; a reappearing or
    // replaced dialog starts a new epoch before any old attempt can retry.
    if (key !== undefined && key !== this.dialogKey) this.generation += 1;
    this.dialogKey = key;
    this.visible = this.specs.some(
      (spec) =>
        (this.autotrust || spec.answerPolicy === "always") &&
        activeTrustDialogVisible(dialog, spec),
    );
    if (dialog === undefined) return undefined;
    for (const spec of this.specs) {
      const id = spec.id as TrustPromptIdFor<A>;
      // Codex hook trust covers all configured hooks regardless of autotrust.
      if (!(this.autotrust || spec.answerPolicy === "always") || this.settled.has(id)) continue;
      if (!activeTrustDialogVisible(dialog, spec)) continue;
      const options = dialog.options;
      const option = options.find((candidate) => spec.accept.test(candidate.label));
      if (option === undefined) {
        // Affirmative not rendered yet (partial frame). Report once, but DON'T
        // settle — a later frame with the option can still be answered.
        if (this.reportedPending.has(id)) continue;
        this.reportedPending.add(id);
        return { kind: "option_pending", prompt: id };
      }
      // Reserve this class while navigation runs. Cancellation or a failed write
      // releases it for retry; only a rejected write becomes a warning upstream.
      this.settled.add(id);
      const input = optionInput(option);
      const generation = this.generation;
      const operation = writeTrustOption(
        spec,
        option,
        write,
        dialog,
        () => this.generation === generation,
        readFrame,
      );
      const settled = operation.then(
        (completion) => {
          if (completion === "cancelled") this.settled.delete(id);
          return completion;
        },
        (error: unknown) => {
          this.settled.delete(id);
          throw error;
        },
      );
      return { kind: "attempted", automation: { prompt: id, input }, settled };
    }
    return undefined;
  }
}

/** Whether the active dialog matches any allowlisted trust prompt for `agent`. */
export function trustPromptVisible(text: string, agent: ElwoodAgentKind): boolean {
  const dialog = parseTrustDialog(text);
  return trustPromptAllowlist.some(
    (spec) => spec.agent === agent && activeTrustDialogVisible(dialog, spec),
  );
}
