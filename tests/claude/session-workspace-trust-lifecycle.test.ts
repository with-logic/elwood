/** Verify Claude workspace discovery follows current native viewport evidence (C-ATTN-08). */
import { realpathSync } from "node:fs";
import { afterEach, assert, expect, test, vi } from "vitest";
import { type ElwoodDialogEvent, startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import { trustFrame } from "./workspace-trust-discovery-fixture.ts";

afterEach(resetFakes);

async function start() {
  installFakes();
  const cwd = realpathSync(tempDir());
  const session = await startClaude({ cwd, autotrust: false });
  const pty = ptys[0]!;
  const render = async (data: string) => {
    pty.emitData(data);
    await session.terminal.settled();
  };
  return { cwd, session, pty, render };
}

test("C-ATTN-08 a Claude announcement waits for a complete native paint", async () => {
  const { cwd, session, pty, render } = await start();
  const events = vi.fn<(event: ElwoodDialogEvent<"claude">) => void>();
  session.on("dialog", events);
  try {
    await render("Starting Claude");
    expect(events).not.toHaveBeenCalled();
    const off = session.on("terminal:data", () => {
      if (session.terminal.snapshot().text.includes("Accessing workspace:")) {
        off();
        pty.emitData("\x1b[?2026h");
      }
    });
    await render(trustFrame(cwd));
    expect(events).not.toHaveBeenCalled();
    expect(await session.listDialogs()).toEqual([]);

    await render("\x1b[?2026l");
    await expect.poll(() => events.mock.calls.length).toBe(1);
    const [request] = await session.listDialogs();
    assert.isDefined(request);
    expect(events).toHaveBeenCalledExactlyOnceWith({ phase: "raised", request });
    expect(pty.writes).toEqual([]);
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-08 Claude host mutation retires discovery and leaves the native hold", async () => {
  const { cwd, session, pty, render } = await start();
  const events = vi.fn<(event: ElwoodDialogEvent<"claude">) => void>();
  session.on("dialog", events);
  try {
    await render(trustFrame(cwd));
    const [request] = await session.listDialogs();
    assert.isDefined(request);
    await expect.poll(() => events.mock.calls).toEqual([[{ phase: "raised", request }]]);
    const rejection = vi.fn().mockRejectedValue(new Error("host replay failure"));
    session.on("dialog", rejection);
    await expect.poll(() => rejection.mock.calls).toEqual([[{ phase: "raised", request }]]);

    await session.terminal.writeOutput("host output");
    expect(events.mock.calls).toEqual([
      [{ phase: "raised", request }],
      [{ phase: "closed", reason: "unavailable", request }],
    ]);
    await render(trustFrame(cwd));
    expect(events).toHaveBeenCalledTimes(2);
    expect(await session.listDialogs()).toEqual([]);
    expect(session.status).toBe("blocked");
    expect(pty.writes).toEqual([]);
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-08 Claude replays the same announced menu after a native repaint", async () => {
  const { cwd, session, render } = await start();
  const live = vi.fn<(event: ElwoodDialogEvent<"claude">) => void>();
  session.on("dialog", live);
  const late = vi.fn<(event: ElwoodDialogEvent<"claude">) => void>();
  const removed = vi.fn<(event: ElwoodDialogEvent<"claude">) => void>();
  const menu = trustFrame(cwd);
  try {
    await render(menu);
    const [request] = await session.listDialogs();
    assert.isDefined(request);
    await expect.poll(() => live.mock.calls).toEqual([[{ phase: "raised", request }]]);

    await render("\x1b[?2026h");
    session.on("dialog", late);
    const unsubscribe = session.on("dialog", removed);
    unsubscribe();
    expect(await session.listDialogs()).toEqual([]);
    expect(late).not.toHaveBeenCalled();

    await render(`${menu}\x1b[?2026l`);
    await expect.poll(() => late.mock.calls).toEqual([[{ phase: "raised", request }]]);
    expect(removed).not.toHaveBeenCalled();
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-08 retained Claude listeners ignore non-Promise thenables", async () => {
  const { cwd, session, render } = await start();
  const live = vi.fn<(event: ElwoodDialogEvent<"claude">) => void>();
  session.on("dialog", live);
  const then = vi.fn();
  const listener = vi.fn(() => ({ then }));
  try {
    await render(trustFrame(cwd));
    const [request] = await session.listDialogs();
    assert.isDefined(request);
    await expect.poll(() => live.mock.calls).toEqual([[{ phase: "raised", request }]]);
    session.on("dialog", listener);
    await expect.poll(() => listener.mock.calls).toEqual([[{ phase: "raised", request }]]);
    expect(then).not.toHaveBeenCalled();
  } finally {
    await session.teardown();
  }
});

test.each([
  false,
  true,
])("C-ATTN-08 Claude dispatches the close before announcing a replacement (%s)", async (revoke) => {
  const { cwd, session, render } = await start();
  const events = vi.fn<(event: ElwoodDialogEvent<"claude">) => void>();
  let writing: Promise<void> | undefined;
  session.on("dialog", (event) => {
    events(event);
    if (!revoke || event.phase !== "closed") return;
    writing = session.terminal.writeOutput("host output");
    return writing;
  });
  try {
    const menu = trustFrame(cwd);
    await render(menu);
    const [request] = await session.listDialogs();
    assert.isDefined(request);
    await expect.poll(() => events.mock.calls.length).toBe(1);
    await render(
      menu.replace(
        "❯ No, exit\r\n   Yes, I trust this folder",
        "❯ Yes, I trust this folder\r\n   No, exit",
      ),
    );
    const [replacement] = await session.listDialogs();
    await writing;
    expect(events.mock.calls.slice(0, 2)).toEqual([
      [{ phase: "raised", request }],
      [{ phase: "closed", reason: "replaced", request }],
    ]);
    if (revoke) {
      expect(replacement).toBeUndefined();
      expect(events).toHaveBeenCalledTimes(2);
    } else {
      expect(replacement?.id).not.toBe(request.id);
      await expect
        .poll(() => events.mock.calls.at(-1))
        .toEqual([{ phase: "raised", request: replacement }]);
    }
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-08 Claude replay skips a request revoked before its turn", async () => {
  const { cwd, session, render } = await start();
  const late = vi.fn<(event: ElwoodDialogEvent<"claude">) => void>();
  const live = vi.fn<(event: ElwoodDialogEvent<"claude">) => void>();
  session.on("dialog", live);
  try {
    await render(trustFrame(cwd));
    const [request] = await session.listDialogs();
    assert.isDefined(request);
    await expect.poll(() => live.mock.calls).toEqual([[{ phase: "raised", request }]]);
    const writing = session.terminal.writeOutput("host output");
    session.on("dialog", late);
    await writing;
    expect(late.mock.calls).toEqual([[{ phase: "closed", reason: "unavailable", request }]]);
  } finally {
    await session.teardown();
  }
});
