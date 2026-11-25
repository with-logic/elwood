/** Render startup fixtures before startup completes (PRD §5.3, C-ATTN-03, C-ATTN-08). */
import { vi } from "vitest";
import { TypedEmitter } from "../../src/events/emitter.ts";
import * as startup from "../../src/runtime/startup/index.ts";
import * as terminal from "../../src/terminal/headless.ts";
import { FakePty } from "./fake-pty.ts";

/** A `start()` held at startup's usability check until the test releases it. */
export interface HeldStartup<T> {
  /** The in-flight `start()`. */
  readonly starting: Promise<T>;
  /** Terminal renders emitted since the hold began. */
  readonly renders: () => number;
  /** Let startup run its usability check and finish. */
  readonly release: () => void;
  /** Release startup and wait for it to settle, so teardown finds the session it started. */
  readonly settle: () => Promise<void>;
}

/**
 * Calls `start` and holds startup at its usability check, so a test can paint native frames
 * while startup is open and see them render before `start()` returns, however long rendering
 * takes. Resolves once startup reaches the check; rejects with startup's own failure when it
 * ends first. A lazy facade's teardown has nothing to stop until its start settles, so
 * cleanup calls `settle()` before tearing down.
 */
export async function holdStartup<T>(start: () => Promise<T>): Promise<HeldStartup<T>> {
  const check = startup.assertStartupUsable;
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  vi.spyOn(startup, "assertStartupUsable").mockImplementation(async (input) => {
    entered.resolve();
    await released.promise;
    await check(input);
  });
  startup.setStartupWaitMsForTests(0);
  const emitted = vi.spyOn(TypedEmitter.prototype, "emit");
  const starting = start();
  await Promise.race([
    entered.promise,
    starting.then(() => {
      throw new Error("startup finished without reaching its usability check");
    }),
  ]);
  return {
    starting,
    renders: () => emitted.mock.calls.filter(([name]) => name === "terminal:data").length,
    release: () => released.resolve(),
    settle: async () => {
      released.resolve();
      await starting.catch(() => undefined);
    },
  };
}

/** Paint `frame` on the first PTY subscription: before the session is live. */
export function paintWhileStarting(frame: string): void {
  const attach = terminal.attachPtyTerminal;
  const assertUsable = startup.assertStartupUsable;
  let settleInitialFrame = () => Promise.resolve();
  vi.spyOn(terminal, "attachPtyTerminal").mockImplementation((...args) => {
    const attached = attach(...args);
    settleInitialFrame = () => attached.settled();
    return attached;
  });
  // The fixture requires its first frame to be observed while starting. A 25ms
  // startup delay cannot ensure that under load because xterm renders asynchronously.
  vi.spyOn(startup, "assertStartupUsable").mockImplementation(async (input) => {
    await assertUsable(input);
    await settleInitialFrame();
  });
  const subscribe = FakePty.prototype.onData;
  let frameScheduled = false;
  vi.spyOn(FakePty.prototype, "onData").mockImplementation(function (this: FakePty, handler) {
    const off = subscribe.call(this, handler);
    if (!frameScheduled)
      queueMicrotask(() => this.emitData(`\u001b[2J\u001b[H${frame.replaceAll("\n", "\r\n")}`));
    frameScheduled = true;
    return off;
  });
}
