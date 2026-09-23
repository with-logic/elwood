/** Persona cancellation precedes fallible process shutdown (PRD §5.8/§9.4, C-API-21/51). */
import { afterEach, expect, test, vi } from "vitest";
import { CodexSession } from "../../src/index.ts";
import { setGroupKillerForTests } from "../../src/runtime/shutdown/reap-tree.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
  resetFakes();
});

test("C-API-51 failed stop and kill still cancel the caller waiting on its persona", async () => {
  installFakes();
  let failShutdown = true;
  setGroupKillerForTests({
    killGroup: () => {
      if (failShutdown) throw new Error("reap failed");
    },
  });
  const cwd = tempDir();
  const facade = new CodexSession({ cwd, persona: "persona" });
  let outcome: unknown;
  const result = facade.send("caller").then(
    (value) => {
      outcome = value;
    },
    (error: unknown) => {
      outcome = error;
    },
  );
  try {
    const live = await facade.start();
    await becomeReady(live.elwoodSessionId, cwd);
    await expect.poll(() => ptys[0]!.writes).toContain("\r");
    vi.spyOn(ptys[0]!, "kill").mockImplementation(() => {
      throw new Error("kill failed");
    });
    const kill = vi.spyOn(live, "kill");
    await expect(facade.close()).rejects.toMatchObject({
      code: "termination_failed",
      details: {
        cause: "kill failed",
        killCause: "Could not reap the PTY process group.",
      },
    });
    expect(kill).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(outcome).toMatchObject({ code: "session_not_running" });
    expect(ptys[0]!.writes.some((write) => write.includes("caller"))).toBe(false);
  } finally {
    failShutdown = false;
    vi.restoreAllMocks();
    ptys[0]?.emitExit({ exitCode: 0 });
    await facade.close();
    await result;
  }
});
