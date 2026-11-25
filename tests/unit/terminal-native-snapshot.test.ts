/** Verify that native snapshots depend on settled, unchanged PTY output. */
import { expect, test, vi } from "vitest";
import {
  onNativeRenderEvidenceInvalidated,
  settledNativeSnapshot,
} from "../../src/terminal/cursor.ts";
import { hasUnwrappedRowEndPadding } from "../../src/terminal/snapshot.ts";
import { setupTerminalPty } from "../helpers/terminal-pty.ts";

test("proves native snapshots only after all output has rendered", async () => {
  const { terminal, emit } = setupTerminalPty();
  try {
    expect(settledNativeSnapshot(terminal)).toBeUndefined();
    emit("native");
    expect(settledNativeSnapshot(terminal)).toBeUndefined();
    await terminal.settled();
    expect(settledNativeSnapshot(terminal)?.text).toContain("native");
    emit("\x1b[?2026h still rendering");
    await terminal.settled();
    expect(settledNativeSnapshot(terminal)).toBeUndefined();
    emit("\x1b[?2026l");
    await terminal.settled();
    expect(settledNativeSnapshot(terminal)?.text).toContain("still rendering");
  } finally {
    terminal.dispose();
  }
});

test.each([
  "writeOutput",
  "clear",
  "reset",
] as const)("revokes native proof only once after host %s", async (operation) => {
  const { terminal, emit } = setupTerminalPty();
  const lost = vi.fn();
  const off = onNativeRenderEvidenceInvalidated(terminal, lost);
  try {
    emit("native");
    await terminal.settled();
    if (operation === "writeOutput") await terminal.writeOutput("host");
    else terminal.xterm[operation]();
    expect(settledNativeSnapshot(terminal)).toBeUndefined();
    emit("fresh native");
    await terminal.settled();
    expect(settledNativeSnapshot(terminal)).toBeUndefined();
    expect(lost).toHaveBeenCalledTimes(1);
  } finally {
    off();
    terminal.dispose();
  }
});

test("C-TRUST-01 revocation preserves host write order when a listener writes again", async () => {
  const { terminal, emit } = setupTerminalPty();
  try {
    emit("native ");
    await terminal.settled();
    const listener = vi.fn(() => terminal.writeOutput("nested"));
    onNativeRenderEvidenceInvalidated(terminal, listener);

    const first = terminal.writeOutput("first ");
    expect(settledNativeSnapshot(terminal)).toBeUndefined();
    const callsDuringDispatch = listener.mock.calls.length;
    await first;
    await terminal.settled();
    expect(terminal.snapshot().text).toContain("native first nested");
    expect(callsDuringDispatch).toBe(0);
    expect(listener).toHaveBeenCalledOnce();
  } finally {
    terminal.dispose();
  }
});

test("C-TRUST-01 one invalidation listener cannot interfere with the write or other listeners", async () => {
  const { terminal, emit } = setupTerminalPty();
  try {
    emit("native ");
    await terminal.settled();
    const failure = new Error("listener failed");
    const rejecting = vi.fn(() => Promise.reject(failure));
    const delivered = vi.fn();
    onNativeRenderEvidenceInvalidated(terminal, () => {
      throw failure;
    });
    onNativeRenderEvidenceInvalidated(terminal, rejecting);
    onNativeRenderEvidenceInvalidated(terminal, delivered);

    await expect(terminal.writeOutput("host")).resolves.toBeUndefined();
    expect(terminal.snapshot().text).toContain("native host");
    expect(rejecting).toHaveBeenCalledOnce();
    expect(delivered).toHaveBeenCalledOnce();
  } finally {
    terminal.dispose();
  }
});

test("C-TRUST-01 unsubscribe before notification cancels a pending callback", async () => {
  const { terminal } = setupTerminalPty();
  try {
    const listener = vi.fn();
    const off = onNativeRenderEvidenceInvalidated(terminal, listener);
    terminal.xterm.clear();
    off();
    const late = vi.fn();
    onNativeRenderEvidenceInvalidated(terminal, late)();
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();
  } finally {
    terminal.dispose();
  }
});

test("C-TRUST-01 terminal disposal finishes before delivering native evidence invalidation", async () => {
  const { terminal } = setupTerminalPty();
  const disposed = vi.fn();
  terminal.xterm.loadAddon({ activate: () => {}, dispose: disposed });
  const disposedBeforeNotification = vi.fn();
  const observed = vi.fn(() => {
    disposedBeforeNotification(disposed.mock.calls.length);
  });
  onNativeRenderEvidenceInvalidated(terminal, observed);
  terminal.dispose();
  expect(settledNativeSnapshot(terminal)).toBeUndefined();
  expect(observed).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(observed).toHaveBeenCalledOnce();
  expect(disposedBeforeNotification).toHaveBeenCalledExactlyOnceWith(1);
});

test("C-TRUST-01 a resize cannot make a clipped native row usable as evidence", async () => {
  const { terminal, emit } = setupTerminalPty();
  const listener = vi.fn();
  onNativeRenderEvidenceInvalidated(terminal, listener);
  try {
    terminal.resize({ cols: 8, rows: 5 });
    emit("/tmp/abc");
    await terminal.settled();
    terminal.resize({ cols: 8, rows: 5 });
    expect(settledNativeSnapshot(terminal)?.text).toContain("/tmp/abc");
    expect(hasUnwrappedRowEndPadding(terminal.xterm, 0, 0)).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    terminal.resize({ cols: 10, rows: 5 });
    expect(hasUnwrappedRowEndPadding(terminal.xterm, 0, 0)).toBe(true);
    expect(terminal.snapshot().text).toContain("/tmp/abc");
    expect(settledNativeSnapshot(terminal)).toBeUndefined();
    emit("\x1b]0;new title\x07");
    await terminal.settled();
    expect(terminal.title).toBe("new title");
    expect(settledNativeSnapshot(terminal)).toBeUndefined();
    expect(listener).toHaveBeenCalledOnce();
  } finally {
    terminal.dispose();
  }
});

test.each([
  false,
  true,
])("C-TRUST-01 resizes revoke proof while the first PTY output is in flight (submitted: %s)", async (submitted) => {
  const { terminal, emit } = setupTerminalPty();
  try {
    emit("first paint");
    const pending = submitted ? terminal.settled() : undefined;
    terminal.xterm.resize(41, 5);
    await (pending ?? terminal.settled());
    expect(terminal.snapshot().text).toContain("first paint");
    expect(settledNativeSnapshot(terminal)).toBeUndefined();
  } finally {
    terminal.dispose();
  }
});
