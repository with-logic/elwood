/**
 * C-LIFE-10 codex exit-boundary invariant: the native PTY-exit callback contains the
 * transcript drain + terminal:exit/activity emission and still reaches a terminal
 * status AND reaps. Covers PRD §5.3/§9.4: a throw in the drain/emit chain must not
 * abort the unconditional reap or leak the session non-terminal.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { setGroupKillerForTests } from "../../src/runtime/shutdown/reap-tree.ts";
import { installFakes, ptys, reapedGroups, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("C-LIFE-10 codex exit-callback error boundary", () => {
  for (const event of ["terminal:exit", "activity", "status"] as const) {
    test(`a throwing '${event}' listener still reaches 'exited' and reaps`, async () => {
      const cwd = tempDir();
      installFakes();
      const session = await startCodex({ cwd });
      const pty = ptys[0]!;
      session.on(event, () => {
        throw new Error(`boom from ${event} listener`);
      });
      reapedGroups.length = 0;
      expect(() => pty.emitExit({ exitCode: 0 })).not.toThrow();
      expect(session.status).toBe("exited"); // terminal despite the listener throw
      expect(reapedGroups).toEqual([pty.pid]); // the unconditional reap still ran
    });
  }

  test("C-LIFE-10 a reap failure on codex exit surfaces a live reap_failed warning", async () => {
    // Routes through the codex warning emit path (emitCodexWarnings), so a leaked
    // group is surfaced live, content-free, with pgid + normalized code (never persisted).
    const cwd = tempDir();
    installFakes();
    setGroupKillerForTests({
      killGroup: () => {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      },
    });
    const session = await startCodex({ cwd });
    const warnings: { code: string; [key: string]: unknown }[] = [];
    session.on("warning", (event) => warnings.push(event));
    const pty = ptys[0]!;
    pty.emitExit({ exitCode: 0 });
    expect(session.status).toBe("exited");
    expect(warnings).toMatchObject([
      { code: "reap_failed", source: "lifecycle", processGroupId: pty.pid, errorCode: "EPERM" },
    ]);
  });
});
