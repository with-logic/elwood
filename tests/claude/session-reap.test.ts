/**
 * Session-level coverage for reap-failure handling on PTY exit.
 * Covers PRD §5.3/§9.4 (C-LIFE-10): a reap failure never keeps the session live
 * and is surfaced as a diagnostic rather than thrown from the exit callback.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { setGroupKillerForTests } from "../../src/runtime/reap-tree.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("C-LIFE-10 session reap-failure handling", () => {
  test("a throwing reaper on exit still reaches 'exited' and surfaces a diagnostic", async () => {
    // A reap failure on an already-exited PTY must NOT keep the session live in
    // memory: terminal evidence is submitted first, and the reap failure surfaces
    // as a diagnostic instead of throwing out of the native exit callback.
    const cwd = tempDir();
    installFakes();
    setGroupKillerForTests({
      killGroup: () => {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      },
    });
    const session = await startClaude({ cwd });
    const reapWarnings: string[] = [];
    session.on("activity", (a) => {
      if (a.kind === "warning" && a.label === "reap_failed") reapWarnings.push(a.label);
    });
    ptys.at(-1)!.emitExit({ exitCode: 0 }); // unsolicited exit; reap throws
    expect(session.status).toBe("exited"); // still terminal despite the reap failure
    expect(reapWarnings).toEqual(["reap_failed"]); // the risk is surfaced, not silent
  });
});
