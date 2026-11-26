/**
 * Claude `UserPromptSubmit` hooks that the caller's handler has not answered yet, and the newest
 * one it allowed (PRD §6.5, C-HOOK-24). Claude Code 2.1.332 can fire a queued message's `Stop` while
 * the handler still screens it, and runs the message only once the handler allows it, so a `Stop`
 * cannot conclude that Claude will run nothing more while a handler is screening.
 */
import type { QueuedPromptsAccess } from "../transcript/queued-prompts.ts";

export class SubmitScreening {
  private submits = 0;
  private newestAllowed = 0;
  private readonly unanswered = new Set<number>();

  /** Whether the caller's handler is still screening a submitted message. */
  get active(): boolean {
    return this.unanswered.size > 0;
  }

  /** The submits so far, for `allowedSince`. */
  mark(): number {
    return this.submits;
  }

  /** Whether the handler allowed a submit made after `mark`, which may have started a turn. */
  allowedSince(mark: number): boolean {
    return this.newestAllowed > mark;
  }

  /**
   * Starts screening a submit whose message, if Claude queued it, took `position` in `queued`.
   * Returns its settlement, called once with the handler's answer.
   */
  begin(
    queued: Pick<QueuedPromptsAccess, "block"> | undefined,
    position: number | undefined,
    prompt: string,
  ): (blocked: boolean) => void {
    const submit = ++this.submits;
    this.unanswered.add(submit);
    return (blocked) => {
      this.unanswered.delete(submit);
      // Claude never runs a queued message the caller blocked, so it holds no `Stop`.
      if (blocked) queued?.block(position, prompt);
      else this.newestAllowed = Math.max(this.newestAllowed, submit);
    };
  }
}
