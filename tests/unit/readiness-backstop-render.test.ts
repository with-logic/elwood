/**
 * A readiness backstop that falls while received PTY output is undrawn judges the next
 * rendered frame, or the last one if that render fails. One that falls during an open
 * synchronized update reports at once (PRD §5.3, C-API-28).
 */
import { afterEach, expect, test, vi } from "vitest";
import type { PtyProcess } from "../../src/pty/types.ts";
import { createReadinessGate } from "../../src/runtime/session/readiness.ts";
import { ptyOutputPending } from "../../src/terminal/cursor.ts";
import { attachPtyTerminal, type ElwoodTerminal } from "../../src/terminal/headless.ts";

const terminals: ElwoodTerminal[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const terminal of terminals.splice(0)) terminal.dispose();
});

const idle = { composer_visible: true, blocking_prompt_visible: false };
const loading = { composer_visible: false, blocking_prompt_visible: false };
type Frame = { readonly facts: typeof idle; readonly text: string };
const composerFrame: Frame = { facts: idle, text: "configured composer" };
const loadingFrame: Frame = { facts: loading, text: "loading" };

/**
 * A gate on a PTY terminal that reports each rendered frame to it, as a session does,
 * `leadMs` before its backstop, on a startup screen with no configured composer. PTY
 * output emitted one millisecond before the backstop is still staged when it falls.
 */
function beforeBackstop({ onBackstop = vi.fn(), leadMs = 1 } = {}) {
  vi.useFakeTimers();
  const handlers = new Set<(data: string) => void>();
  const pty: PtyProcess = {
    pid: 1,
    onData: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    onExit: () => () => undefined,
    write: () => undefined,
    resize: () => "resized",
    kill: () => undefined,
  };
  const ready = vi.fn();
  const gate = createReadinessGate(ready, false, {
    configured: (frame) => frame === composerFrame.text,
    onBackstop,
  });
  let drawn = loadingFrame;
  let beforeObserving: (() => void) | undefined;
  const terminal = attachPtyTerminal({ cols: 40, rows: 5 }, pty, () => {
    const observed = drawn;
    beforeObserving?.();
    beforeObserving = undefined;
    gate.observeReadinessFrame(observed.facts, false, observed.text);
  });
  terminals.push(terminal);
  gate.bindTerminal(terminal);
  gate.observeReadinessFrame(loading, false, loadingFrame.text);
  gate.ready.armDeadline();
  vi.advanceTimersByTime(60_000 - leadMs);
  const emit = (data: string, frame: Frame) => {
    drawn = frame;
    for (const handler of handlers) handler(data);
  };
  const beforeNextObserve = (run: () => void) => {
    beforeObserving = run;
  };
  return { gate, terminal, ready, onBackstop, emit, beforeNextObserve };
}

test("C-API-28 a backstop while PTY output is undrawn lets the frame it draws mark readiness", async () => {
  const { terminal, ready, onBackstop, emit } = beforeBackstop();
  emit("composer", composerFrame);
  vi.advanceTimersByTime(1);
  expect(ptyOutputPending(terminal)).toBe(true);
  expect(onBackstop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(20);
  expect(ready).toHaveBeenCalledOnce();
  expect(onBackstop).not.toHaveBeenCalled();
});

test("C-API-28 a backstop while PTY output is undrawn reports once that frame shows no composer", async () => {
  const { gate, ready, onBackstop, emit } = beforeBackstop();
  emit("still loading", loadingFrame);
  vi.advanceTimersByTime(1);
  expect(onBackstop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(20);
  expect(onBackstop).toHaveBeenCalledExactlyOnceWith(false);
  expect(gate.holdsReadiness()).toBe(true);
  emit(" more", loadingFrame);
  await vi.advanceTimersByTimeAsync(20);
  expect(onBackstop).toHaveBeenCalledOnce();
  expect(ready).not.toHaveBeenCalled();
});

test("C-API-28 a deferred backstop skips a frame that PTY output received meanwhile replaces", async () => {
  const { ready, onBackstop, emit, beforeNextObserve } = beforeBackstop();
  emit("still loading", loadingFrame);
  vi.advanceTimersByTime(1);
  // By the time that frame is drawn, the composer has arrived.
  beforeNextObserve(() => emit("composer", composerFrame));
  await vi.advanceTimersByTimeAsync(20);
  expect(onBackstop).not.toHaveBeenCalled();
  expect(ready).toHaveBeenCalledOnce();
});

test("C-API-28 a backstop whose undrawn PTY output fails to render judges the last frame", async () => {
  const { terminal, ready, onBackstop, emit } = beforeBackstop();
  vi.spyOn(terminal.xterm, "write").mockImplementationOnce(() => {
    throw new Error("render failed");
  });
  emit("composer", composerFrame);
  vi.advanceTimersByTime(1);
  expect(onBackstop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(20);
  expect(terminal.renderFailed).toBe(true);
  // The failed render drew no frame, and the last one showed no composer.
  expect(onBackstop).toHaveBeenCalledExactlyOnceWith(false);
  expect(ready).not.toHaveBeenCalled();
});

test("C-API-28 a backstop during an open synchronized update reports at once, and a later composer marks", async () => {
  const { terminal, ready, onBackstop, emit } = beforeBackstop({ leadMs: 20 });
  emit("\u001b[?2026h", loadingFrame);
  await vi.advanceTimersByTimeAsync(19);
  expect(ptyOutputPending(terminal)).toBe(false);
  expect(terminal.xterm.modes.synchronizedOutputMode).toBe(true);
  vi.advanceTimersByTime(1);
  // An update the agent never ends would otherwise hide the backstop for good.
  expect(onBackstop).toHaveBeenCalledExactlyOnceWith(false);
  emit("\u001b[?2026lcomposer", composerFrame);
  await vi.advanceTimersByTimeAsync(20);
  expect(ready).toHaveBeenCalledOnce();
});

test("C-API-28 a deferred backstop is dropped when readiness is cancelled", async () => {
  const { gate, onBackstop, emit } = beforeBackstop();
  emit("still loading", loadingFrame);
  vi.advanceTimersByTime(1);
  gate.ready.cancel();
  await vi.advanceTimersByTimeAsync(20);
  expect(onBackstop).not.toHaveBeenCalled();
});

test("C-API-28 a deferred backstop contains its observer's failure after a failed render", async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    const onBackstop = vi.fn(() => {
      throw new Error("observer failure");
    });
    const { gate, terminal, ready, emit } = beforeBackstop({ onBackstop });
    vi.spyOn(terminal.xterm, "write").mockImplementationOnce(() => {
      throw new Error("render failed");
    });
    emit("still loading", loadingFrame);
    vi.advanceTimersByTime(1);
    await vi.advanceTimersByTimeAsync(20);
    vi.useRealTimers();
    // An uncontained failure would surface here, after the settlement that judged it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onBackstop).toHaveBeenCalledOnce();
    expect(rejections).toEqual([]);
    expect(gate.holdsReadiness()).toBe(true);
    expect(ready).not.toHaveBeenCalled();
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});
