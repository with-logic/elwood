/**
 * Native idle evidence reads a frame once the session has classified it. A render notifies
 * its listeners before the PTY render observer classifies the frame, so a read on the
 * notification itself would see the previous frame's blocking state (PRD §5.8, C-API-48).
 */
import { expect, test, vi } from "vitest";
import { captureNativeIdle, registerNativeIdle } from "../../src/core/simple/native-idle.ts";
import { nativeIdleSource } from "../../src/runtime/session/native-submission.ts";
import { setupTerminalPty } from "../helpers/terminal-pty.ts";

test("C-API-48 native idle reads a frame after the session classifies it", async () => {
  let inputBlocking = false;
  // The session's frame observer: a dialog on screen blocks input.
  const { terminal, emit } = setupTerminalPty((data) => {
    inputBlocking = data.includes("dialog");
  });
  const session = {
    terminal,
    closing: new AbortController(),
    status: "ready" as const,
    get inputBlocking() {
      return inputBlocking;
    },
    automationInputBlocking: false,
  };
  try {
    registerNativeIdle(
      session,
      nativeIdleSource(session, () => ({})),
    );
    const idle = vi.fn();
    captureNativeIdle(session)?.onIdle(idle);
    emit("dialog over an empty composer");
    await terminal.settled();
    await Promise.resolve();
    expect(idle).not.toHaveBeenCalled();
    emit("\r\nidle");
    await terminal.settled();
    await vi.waitFor(() => expect(idle).toHaveBeenCalledOnce());
  } finally {
    terminal.dispose();
  }
});

test("C-API-48 an idle wait cancelled by the frame's own observer is never notified", async () => {
  let stop: (() => void) | undefined;
  // The session's frame observer, which runs after the render's listeners, ends the wait.
  const { terminal, emit } = setupTerminalPty(() => stop?.());
  const session = {
    terminal,
    closing: new AbortController(),
    status: "ready" as const,
    inputBlocking: false,
    automationInputBlocking: false,
  };
  try {
    registerNativeIdle(
      session,
      nativeIdleSource(session, () => ({})),
    );
    const idle = vi.fn();
    stop = captureNativeIdle(session)?.onIdle(idle);
    emit("idle");
    await terminal.settled();
    await Promise.resolve();
    expect(idle).not.toHaveBeenCalled();
  } finally {
    terminal.dispose();
  }
});

test("C-API-48 host output over the old empty composer is not the CLI's progress", async () => {
  const { terminal, emit } = setupTerminalPty();
  const session = {
    terminal,
    closing: new AbortController(),
    status: "ready" as const,
    inputBlocking: false,
    automationInputBlocking: false,
  };
  try {
    registerNativeIdle(
      session,
      nativeIdleSource(session, () => ({})),
    );
    const evidence = captureNativeIdle(session);
    const idle = vi.fn();
    evidence?.onIdle(idle);
    await terminal.writeOutput("host note");
    await new Promise((resolve) => setImmediate(resolve));
    expect(evidence?.isIdle()).toBe(false);
    expect(idle).not.toHaveBeenCalled();
    emit("idle");
    await terminal.settled();
    await vi.waitFor(() => expect(idle).toHaveBeenCalledOnce());
  } finally {
    terminal.dispose();
  }
});
