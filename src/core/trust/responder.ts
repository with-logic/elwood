/** Owns trust episodes, bounded attempts, and recoverable blocking (PRD §5.4/C-TRUST-01). */
import type { ElwoodAgentKind } from "../activity/index.ts";
import { optionInput } from "../terminal-options.ts";
import type { TrustClearance } from "./clearance.ts";
import type { TrustPromptId, TrustPromptIdFor } from "./prompts.ts";
import {
  type Episode,
  newEpisode,
  type TrustPromptResult,
  type TrustWriteResult,
} from "./types.ts";
import { choiceIdentity, readTrustView, type TrustView, trustView } from "./view.ts";
import { TrustAttempt } from "./write.ts";

export type { TrustPromptAutomation, TrustPromptResult, TrustWriteResult } from "./types.ts";
export { trustPromptVisible } from "./view.ts";

const episodeTimeoutMs = 5_000;
export class TrustPromptResponder<A extends ElwoodAgentKind> {
  private episode: Episode | undefined;
  private humanPrompt: TrustPromptId | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly attempts = new Set<TrustAttempt>();
  private disposed = false;
  private readonly agent: A;
  private readonly autotrust: boolean;
  private readonly onStateChange: (() => void) | undefined;
  /** The ADAPTER's clearance grammar; the coordinator never encodes a CLI's layout. */
  private readonly clearance: TrustClearance;
  constructor(agent: A, clearance: TrustClearance, autotrust = false, onStateChange?: () => void) {
    this.agent = agent;
    this.clearance = clearance;
    this.autotrust = autotrust;
    this.onStateChange = onStateChange;
  }
  get inputBlocking(): boolean {
    return this.humanPrompt !== undefined || this.episode !== undefined;
  }
  get blockedPrompt(): TrustPromptIdFor<A> | undefined {
    const id = this.episode?.blocked ? this.episode.candidate.spec.id : undefined;
    return (this.humanPrompt ?? id) as TrustPromptIdFor<A> | undefined;
  }
  handle(
    frame: string,
    write: (input: string) => TrustWriteResult,
    readFrame?: () => string | undefined,
  ): TrustPromptResult<A> {
    if (this.disposed) return undefined;
    const priorIdentity = this.episode?.lastIdentity;
    const view = trustView(frame, this.agent, this.clearance);
    this.observe(view);
    const episode = this.episode;
    if (view.kind !== "candidate" || episode === undefined || view.key !== episode.candidate.key)
      return undefined;
    const identity = choiceIdentity(view);
    episode.lastIdentity = identity;
    if (
      episode.expired &&
      identity !== undefined &&
      (identity !== episode.expiredIdentity || priorIdentity === undefined)
    ) {
      episode.attemptedIdentity = undefined;
      this.arm(episode);
    }
    if (readFrame === undefined && episode.attempt) return undefined;
    if (episode.attempt && episode.attempt.identity !== identity) {
      episode.attempt.cancel();
      episode.attempt = undefined;
      episode.attemptedIdentity = undefined;
    }
    if (identity === undefined) {
      if (!view.valid || episode.reportedPending) return undefined;
      episode.reportedPending = true;
      return { kind: "option_pending", prompt: view.spec.id as TrustPromptIdFor<A> };
    }
    if (
      episode.expired ||
      episode.attempt ||
      episode.legacyAnswered ||
      episode.attemptedIdentity === identity
    )
      return undefined;
    const read =
      readFrame === undefined
        ? undefined
        : () => readTrustView(readFrame, this.agent, this.clearance);
    const attempt = new TrustAttempt(view, identity);
    episode.attempt = attempt;
    episode.attemptedIdentity = identity;
    this.attempts.add(attempt);
    const settled = attempt.start(write, read, episode.deadlineAtMs).then(
      (completion) => {
        this.attempts.delete(attempt);
        if (this.disposed || attempt.invalidated) return "cancelled" as const;
        if (this.episode !== episode || episode.attempt !== attempt) return completion;
        episode.attempt = undefined;
        if (attempt.lostChoice) episode.attemptedIdentity = undefined;
        if (read === undefined && completion === "answered") {
          episode.legacyAnswered = true;
          clearTimeout(this.timer);
        }
        if (read === undefined) return completion;
        const latest = read();
        if (latest === undefined) {
          episode.attemptedIdentity = undefined;
          return "cancelled" as const;
        }
        if (attempt.cleared) this.release(true);
        this.observe(latest);
        this.notify();
        if (attempt.cleared && latest.kind === "candidate" && latest.spec.id === view.spec.id)
          return "cancelled" as const;
        return completion;
      },
      (error: unknown) => {
        this.attempts.delete(attempt);
        if (this.episode !== episode || episode.attempt !== attempt) return "cancelled" as const;
        episode.attempt = undefined;
        episode.attemptedIdentity = undefined;
        throw error;
      },
    );
    return {
      kind: "attempted",
      automation: {
        prompt: view.spec.id as TrustPromptIdFor<A>,
        input: optionInput(view.option!),
      },
      settled,
    };
  }
  /** Session closing owns all cancellation, including writes whose promises settle late. */
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    for (const attempt of this.attempts) attempt.cancel();
    this.episode = undefined;
    this.humanPrompt = undefined;
  }
  private observe(view: TrustView): void {
    if (view.kind === "clear") {
      this.release(true);
      return;
    }
    if (view.kind === "unknown") {
      if (this.episode) {
        this.episode.attempt?.cancel();
        this.episode.attempt = undefined;
        this.episode.attemptedIdentity = undefined;
        this.episode.lastIdentity = undefined;
      }
      return;
    }
    if (!(this.autotrust || view.spec.answerPolicy === "always")) {
      this.release(view.valid);
      this.humanPrompt = view.spec.id;
      return;
    }
    if (this.episode?.candidate.key === view.key) {
      this.episode.lastIdentity = choiceIdentity(view);
      return;
    }
    const blocked = this.blockedPrompt !== undefined;
    this.release(view.valid);
    // A cleared-and-reappeared class cannot inherit an old pending success.
    for (const attempt of this.attempts) {
      if (attempt.candidate.spec.id === view.spec.id) attempt.cancel();
    }
    const episode = newEpisode(view, blocked);
    this.episode = episode;
    this.arm(episode);
  }
  private arm(episode: Episode): void {
    clearTimeout(this.timer);
    episode.expired = false;
    episode.deadlineAtMs = Date.now() + episodeTimeoutMs;
    this.timer = setTimeout(() => {
      episode.expired = true;
      episode.expiredIdentity = episode.lastIdentity;
      episode.blocked = true;
      episode.attempt?.cancel();
      episode.attempt = undefined;
      this.notify();
    }, episodeTimeoutMs);
    this.timer.unref();
  }
  private release(cleared: boolean): void {
    clearTimeout(this.timer);
    this.episode?.attempt?.cancel(cleared);
    this.episode = undefined;
    this.humanPrompt = undefined;
  }
  private notify(): void {
    try {
      this.onStateChange?.();
    } catch {
      /* An observer cannot retain owned timers or writes. */
    }
  }
}
