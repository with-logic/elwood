/** Startup auth detection consumes received bytes independently of rendering (PRD §9.1). */
import xtermHeadless from "@xterm/headless";
import { afterEach, expect, test, vi } from "vitest";
import { startClaude, startCodex } from "../../src/index.ts";
import { setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
  claude.resetFakes();
  codex.resetFakes();
});

for (const [agent, start, harness] of [
  ["claude", startClaude, claude],
  ["codex", startCodex, codex],
] as const) {
  test(`C-LIFE-10 ${agent} rejects received auth errors even when rendering never completes`, async () => {
    harness.installFakes();
    vi.spyOn(xtermHeadless.Terminal.prototype, "write").mockImplementation(() => undefined);
    setPtyFactoryForTests((options) => {
      const pty = new harness.FakePty(options);
      harness.ptys.push(pty);
      emitAfterSubscription(pty, ["not auth", "enticated"]);
      return pty;
    });
    let unexpected: Awaited<ReturnType<typeof start>> | undefined;
    try {
      await expect(
        start({ cwd: harness.tempDir() }).then((session) => {
          unexpected = session;
        }),
      ).rejects.toMatchObject({ code: `${agent}_not_authenticated` });
      expect(harness.ptys[0]!.killSignals).toContain("SIGTERM");
    } finally {
      await unexpected?.teardown();
    }
  });

  test(`C-LIFE-10 ${agent} startup stays bounded with non-auth output and a stalled renderer`, async () => {
    harness.installFakes();
    vi.spyOn(xtermHeadless.Terminal.prototype, "write").mockImplementation(() => undefined);
    setPtyFactoryForTests((options) => {
      const pty = new harness.FakePty(options);
      harness.ptys.push(pty);
      emitAfterSubscription(pty, ["Starting agent"]);
      return pty;
    });
    const session = await start({ cwd: harness.tempDir() });
    await session.teardown();
    expect(harness.ptys[0]!.killSignals).toContain("SIGKILL");
  });
}

function emitAfterSubscription(pty: claude.FakePty, chunks: readonly string[]): void {
  const subscribe = pty.onData.bind(pty);
  vi.spyOn(pty, "onData").mockImplementationOnce((handler) => {
    const unsubscribe = subscribe(handler);
    queueMicrotask(() => {
      for (const chunk of chunks) pty.emitData(chunk);
    });
    return unsubscribe;
  });
}
