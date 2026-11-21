/** Read a cold lazy session without creating native resources (PRD §5.12, C-STATS-04). */
import { expect, test } from "vitest";
import { ClaudeSession, CodexSession } from "../../src/index.ts";
import { installFakes, resetFakes, tempDir } from "../claude/helpers.ts";
import { ready } from "../claude/login-helpers.ts";

test.each([
  ClaudeSession,
  CodexSession,
])("C-STATS-04 $name reads cold session stats", async (Session) => {
  const lazy = new Session({ cwd: "/" });
  expect(await lazy.getStats()).toEqual({
    status: "starting",
    activeSubagentCount: 0,
    quota: { state: "unavailable" },
  });
  expect(lazy.session).toBeUndefined();
});

test("C-STATS-04 a started facade reads its live session status", async () => {
  installFakes();
  const cwd = tempDir();
  const facade = new ClaudeSession({ cwd });
  try {
    await ready(cwd, await facade.start());
    expect((await facade.getStats()).status).toBe("ready");
  } finally {
    try {
      await facade.stop();
    } finally {
      resetFakes();
    }
  }
});
