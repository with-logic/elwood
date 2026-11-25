/** Read settled native workspace trust without moving the viewport or flushing output (C-ATTN-07). */
import { afterEach, expect, test, vi } from "vitest";
import { viewTerminalHistory } from "../helpers/live-buffer-fixture.ts";
import { resetFakes } from "./helpers.ts";
import { menu, setup } from "./workspace-trust-discovery-fixture.ts";

afterEach(resetFakes);

test("C-ATTN-07 does not wait for pending xterm writes to finish", async () => {
  const { cwd, session, pty, render } = await setup();
  try {
    await render(menu(cwd));
    const [request] = await session.listDialogs();
    expect(request).toBeDefined();

    const { xterm } = session.terminal;
    const nativeWrite = xterm.write.bind(xterm);
    const drew = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const spy = vi.spyOn(xterm, "write").mockImplementation((data, callback) => {
      nativeWrite(data, () => {
        drew.resolve();
        void release.promise.then(callback);
      });
    });
    try {
      pty.emitData("\x1b[?2026h");
      await drew.promise;
      await expect(
        Promise.race([
          session.listDialogs(),
          new Promise((resolve) => setImmediate(() => resolve("waiting"))),
        ]),
      ).resolves.toEqual([]);
    } finally {
      release.resolve();
      spy.mockRestore();
      await session.terminal.settled();
    }
    pty.emitData("\x1b[?2026l");
    await session.terminal.settled();
    expect((await session.listDialogs())[0]).toBe(request);
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-07 reads the same live request while the viewport selects scrollback", async () => {
  const { cwd, session, pty } = await setup();
  try {
    const { isScrolled, paint } = await viewTerminalHistory(session.terminal, pty);
    session.terminal.xterm.scrollToBottom();
    await paint(menu(cwd));
    const [request] = await session.listDialogs();
    expect(request).toBeDefined();

    session.terminal.xterm.scrollToTop();
    expect(isScrolled()).toBe(true);
    expect(session.terminal.xterm.buffer.active.getLine(0)?.translateToString(true)).toBe(
      "Historical output",
    );
    expect((await session.listDialogs())[0]).toBe(request);
  } finally {
    await session.teardown();
  }
});
