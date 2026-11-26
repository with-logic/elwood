/**
 * A readiness backstop that falls while received PTY output is undrawn judges the next
 * rendered frame, or the last one if that render fails, as a mark deferred by that output
 * does. One that falls during an open synchronized update reports at once (PRD §5.3,
 * C-API-28).
 */
import { afterEach, expect, test, vi } from "vitest";
import { initialBackstopMs } from "../../src/runtime/readiness/initial-ready.ts";
import { createReadinessGate } from "../../src/runtime/session/readiness.ts";
import { ptyOutputPending } from "../../src/terminal/cursor.ts";
import type { ElwoodTerminal } from "../../src/terminal/headless.ts";
import { setupTerminalPty } from "../helpers/terminal-pty.ts";

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
const dialog = { composer_visible: false, blocking_prompt_visible: true };
const dialogFrame: Frame = { facts: dialog, text: "dialog" };

/**
 * A gate on a PTY terminal that reports each rendered frame to it, as a session does,
 * `leadMs` before a readiness timer falls: by default the backstop, on a startup screen
 * with no configured composer. PTY output emitted one millisecond before the timer is
 * still staged when it falls.
 */
const failNextRender = (terminal: ElwoodTerminal) =>
  vi.spyOn(terminal.xterm, "write").mockImplementationOnce(() => {
    throw new Error("render failed");
  });

function beforeTimer({
  onBackstop = vi.fn(),
  leadMs = 1,
  first = loadingFrame,
  timerMs = initialBackstopMs,
  ready = vi.fn(),
} = {}) {
  vi.useFakeTimers();
  const gate = createReadinessGate(ready, false, {
    configured: (frame) => frame === composerFrame.text,
    onBackstop,
  });
  let drawn = first;
  let beforeObserving: (() => void) | undefined;
  const { terminal, emit: emitData } = setupTerminalPty(() => {
    const observed = drawn;
    beforeObserving?.();
    beforeObserving = undefined;
    gate.observeReadinessFrame(observed.facts, false, observed.text);
  });
  terminals.push(terminal);
  gate.bindTerminal(terminal);
  gate.observeReadinessFrame(first.facts, false, first.text);
  gate.ready.armDeadline();
  vi.advanceTimersByTime(timerMs - leadMs);
  const emit = (data: string, frame: Frame) => {
    drawn = frame;
    emitData(data);
  };
  const beforeNextObserve = (run: () => void) => {
    beforeObserving = run;
  };
  return { gate, terminal, ready, onBackstop, emit, beforeNextObserve };
}

test("C-API-28 a backstop while PTY output is undrawn lets the frame it draws mark readiness", async () => {
  const { terminal, ready, onBackstop, emit } = beforeTimer();
  emit("composer", composerFrame);
  vi.advanceTimersByTime(1);
  expect(ptyOutputPending(terminal)).toBe(true);
  expect(onBackstop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(20);
  expect(ready).toHaveBeenCalledOnce();
  expect(onBackstop).not.toHaveBeenCalled();
});

test("C-API-28 a backstop while PTY output is undrawn reports once that frame shows no composer", async () => {
  const { gate, ready, onBackstop, emit } = beforeTimer();
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
  const { ready, onBackstop, emit, beforeNextObserve } = beforeTimer();
  emit("still loading", loadingFrame);
  vi.advanceTimersByTime(1);
  // By the time that frame is drawn, the composer has arrived.
  beforeNextObserve(() => emit("composer", composerFrame));
  await vi.advanceTimersByTimeAsync(20);
  expect(onBackstop).not.toHaveBeenCalled();
  expect(ready).toHaveBeenCalledOnce();
});

test("C-API-28 a backstop whose undrawn PTY output fails to render judges the last frame", async () => {
  const { terminal, ready, onBackstop, emit } = beforeTimer();
  failNextRender(terminal);
  emit("composer", composerFrame);
  vi.advanceTimersByTime(1);
  expect(onBackstop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(20);
  expect(terminal.renderFailed).toBe(true);
  // The failed render drew no frame, and the last one showed no composer.
  expect(onBackstop).toHaveBeenCalledExactlyOnceWith(false);
  expect(ready).not.toHaveBeenCalled();
});

test("C-API-28 a deferred backstop over a dialog that PTY output draws reports it held", async () => {
  const { gate, ready, onBackstop, emit } = beforeTimer();
  emit("dialog", dialogFrame);
  vi.advanceTimersByTime(1);
  expect(onBackstop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(20);
  // The dialog holds readiness, so the backstop reports it rather than a missing composer.
  expect(onBackstop).toHaveBeenCalledExactlyOnceWith(true);
  expect(gate.holdsReadiness()).toBe(true);
  expect(ready).not.toHaveBeenCalled();
});

test("C-API-28 a deadline whose undrawn PTY output fails to render marks on the last frame", async () => {
  const { terminal, ready, onBackstop, emit } = beforeTimer({
    first: composerFrame,
    timerMs: 10_000,
  });
  failNextRender(terminal);
  emit("repaint", loadingFrame);
  vi.advanceTimersByTime(1);
  // The deadline fell on undrawn output, so it waits for the frame that output draws.
  expect(ready).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(20);
  expect(terminal.renderFailed).toBe(true);
  // That render drew nothing, so the configured composer last drawn stands.
  expect(ready).toHaveBeenCalledOnce();
  expect(onBackstop).not.toHaveBeenCalled();
});

test("C-API-28 a backstop during an open synchronized update reports at once, and a later composer marks", async () => {
  const { terminal, ready, onBackstop, emit } = beforeTimer({ leadMs: 20 });
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
  const { gate, onBackstop, emit } = beforeTimer();
  emit("still loading", loadingFrame);
  vi.advanceTimersByTime(1);
  gate.ready.cancel();
  await vi.advanceTimersByTimeAsync(20);
  expect(onBackstop).not.toHaveBeenCalled();
});

// An uncontained failure would escape the notice's microtask as an uncaught exception.
test("C-API-28 a deferred backstop contains its observer's failure after a failed render", async () => {
  const onBackstop = vi.fn(() => {
    throw new Error("observer failure");
  });
  const { gate, terminal, ready, emit } = beforeTimer({ onBackstop });
  failNextRender(terminal);
  emit("still loading", loadingFrame);
  await vi.advanceTimersByTimeAsync(20);
  expect(onBackstop).toHaveBeenCalledOnce();
  expect(gate.holdsReadiness()).toBe(true);
  expect(ready).not.toHaveBeenCalled();
});

test("C-API-28 a mark retried after a failed render contains its listener's failure", async () => {
  const ready = vi.fn(() => {
    throw new Error("listener failure");
  });
  const { terminal, emit } = beforeTimer({ first: composerFrame, timerMs: 10_000, ready });
  failNextRender(terminal);
  emit("repaint", loadingFrame);
  await vi.advanceTimersByTimeAsync(20);
  expect(ready).toHaveBeenCalledOnce();
});
