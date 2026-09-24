/**
 * Bounds CLI ownership of Codex's automatically skipped update prompt.
 * Implements PRD §5.5 and C-CODEX-12/C-CLI-05.
 */

import type { ElwoodSessionStatus } from "../core/types.ts";
import type { CliLifecycleClock } from "./lifecycle/index.ts";

export const codexUpdateAttentionGraceMs = 5_500;

type UpdateAttentionSession = { readonly status: ElwoodSessionStatus };
type UpdateAttentionLifecycle = { readonly block: (label: string) => void };
type UpdateAttentionClock = Pick<CliLifecycleClock, "setTimer" | "clearTimer">;

const realClock: UpdateAttentionClock = {
  setTimer: (handler, delayMs) => {
    const timer = setTimeout(handler, delayMs);
    timer.unref();
    return timer;
  },
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** Gives safe update automation a short grace period without allowing a permanent CLI stall. */
export class CodexUpdateAttentionGuard {
  private readonly session: UpdateAttentionSession;
  private readonly lifecycle: UpdateAttentionLifecycle;
  private readonly clock: UpdateAttentionClock;
  private timer: unknown;
  private disposed = false;
  private generation = 0;

  constructor(
    session: UpdateAttentionSession,
    lifecycle: UpdateAttentionLifecycle,
    clock: UpdateAttentionClock = realClock,
  ) {
    this.session = session;
    this.lifecycle = lifecycle;
    this.clock = clock;
  }

  attention(generation?: number): void {
    if (this.disposed || this.session.status !== "blocked") return;
    if (generation !== undefined) {
      if (generation <= this.generation) return;
      this.generation = generation;
      this.cancel();
    }
    if (this.timer !== undefined) return;
    this.timer = this.clock.setTimer(() => this.expire(), codexUpdateAttentionGraceMs);
  }

  status(status: ElwoodSessionStatus): void {
    if (status !== "blocked") this.cancel();
  }

  succeeded(): void {
    this.cancel();
  }

  writeFailed(): void {
    if (this.disposed) return;
    this.cancel();
    this.lifecycle.block("codex-update-prompt");
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private expire(): void {
    this.timer = undefined;
    if (!this.disposed && this.session.status === "blocked") {
      this.lifecycle.block("codex-update-prompt");
    }
  }

  private cancel(): void {
    if (this.timer !== undefined) this.clock.clearTimer(this.timer);
    this.timer = undefined;
  }
}
