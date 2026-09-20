/** Render startup fixtures before startup completes (PRD §5.3, C-ATTN-03). */
import { vi } from "vitest";
import * as startup from "../../src/runtime/startup/index.ts";
import * as terminal from "../../src/terminal/headless.ts";
import { FakePty } from "./fake-pty.ts";

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
