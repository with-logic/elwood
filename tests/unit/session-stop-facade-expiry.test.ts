/** Facade image capture obeys the expired Stop boundary before cloning input (C-HOOK-04). */
import { afterEach, expect, test } from "vitest";
import type { SendOptions } from "../../src/core/images/types.ts";
import { withStopInput } from "../../src/core/stop-input.ts";
import { ClaudeSession, CodexSession } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";

afterEach(() => {
  claude.resetFakes();
  codex.resetFakes();
});

for (const agent of ["claude", "codex"] as const) {
  test.each([
    "sendMessage",
    "send",
  ] as const)(`C-HOOK-04 ${agent} expired Stop rejects facade %s before image capture`, async (method) => {
    const helper = agent === "claude" ? claude : codex;
    helper.installFakes();
    const cwd = helper.tempDir();
    const facade = agent === "claude" ? new ClaudeSession({ cwd }) : new CodexSession({ cwd });
    const session = await facade.start();
    const pty = helper.ptys[0]!;
    const release = Promise.withResolvers<void>();
    let late: Promise<unknown> | undefined;
    try {
      await withStopInput({ hookName: "Stop", session }, () => {
        late = release.promise.then(() =>
          facade[method]("expired", {
            images: "malformed" as unknown as NonNullable<SendOptions["images"]>,
          }).then(
            () => "sent",
            (error: unknown) => error,
          ),
        );
        return Promise.resolve();
      });
      release.resolve();
      expect(await late).toMatchObject({ code: "wait_timeout" });
      expect(pty.writes.some((value) => value.includes("expired"))).toBe(false);
    } finally {
      release.resolve();
      await facade.close();
    }
  });
}
