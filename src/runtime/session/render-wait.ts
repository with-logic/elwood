/**
 * Initial readiness waits for received PTY output to render (PRD §5.3, C-API-28). A
 * judgment deferred while that output is undrawn runs on the frame it draws. A render that
 * fails draws no frame, so the last frame is judged in its place; after a failure nothing
 * waits for rendering, and writes stay withheld (C-API-56).
 */
import { runContained } from "../../core/contained.ts";
import { ptyOutputPending } from "../../terminal/cursor.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { onRenderFailed } from "../../terminal/render-failure.ts";

export type RenderWait = {
  /** The session's terminal, bound before its PTY output can arrive. */
  readonly bind: (terminal: ElwoodTerminal) => void;
  /** Received PTY output is undrawn: its render, or its render failure, follows shortly. */
  readonly undrawn: () => boolean;
  /** Output is undrawn, or a synchronized update is open, which the agent might never end. */
  readonly rendering: () => boolean;
};

/** `afterFailedRender` judges, on the last frame, what waited for a render that failed. */
export function createRenderWait(afterFailedRender: () => void): RenderWait {
  let terminal: ElwoodTerminal | undefined;
  const terminalIfRenderHealthy = () => (terminal?.renderFailed === false ? terminal : undefined);
  const undrawn = () => {
    const current = terminalIfRenderHealthy();
    return current !== undefined && ptyOutputPending(current);
  };
  return {
    bind: (bound) => {
      terminal = bound;
      onRenderFailed(bound.xterm, afterFailedRender);
    },
    undrawn,
    rendering: () =>
      undrawn() || terminalIfRenderHealthy()?.xterm.modes.synchronizedOutputMode === true,
  };
}

export type DeferredBackstop = {
  /** The backstop fell: judge now, or on the frame undrawn output draws. */
  readonly fall: () => void;
  /** A frame was drawn, or a render failed: judge a deferred backstop unless output is undrawn. */
  readonly settle: () => void;
  readonly cancel: () => void;
};

/**
 * A backstop that falls while PTY output is undrawn judges the frame that output draws, or
 * the last frame if its render fails. One that falls during an open synchronized update
 * judges at once. As at the backstop itself, an observer failure must not release input.
 */
export function createDeferredBackstop(render: RenderWait, judge: () => void): DeferredBackstop {
  let deferred = false;
  const settle = () => {
    if (!deferred || render.undrawn()) return;
    deferred = false;
    runContained(judge);
  };
  return {
    fall: () => {
      deferred = true;
      settle();
    },
    settle,
    cancel: () => {
      deferred = false;
    },
  };
}
