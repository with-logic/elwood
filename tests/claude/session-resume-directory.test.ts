/**
 * A resumed Claude session launches in the `cwd` it is given, where that differs from the
 * directory its record says the session started in, and in the recorded directory when it is
 * given none (PRD §5.2, C-API-03).
 */

import { afterEach, expect, test } from "vitest";
import { resumeClaude } from "../../src/index.ts";
import { resumableStateDir } from "../helpers/session-state.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-API-03 claude resume launches in the cwd it is given, not the recorded one", async () => {
  installFakes();
  const recorded = tempDir();
  const given = tempDir();
  const stateDir = resumableStateDir("claude", recorded, "claude-elsewhere");
  const session = await resumeClaude({ elwoodSessionId: "claude-elsewhere", stateDir, cwd: given });
  try {
    expect(session.status).toBe("running");
    expect(ptys.at(-1)!.options.cwd).toBe(given);
  } finally {
    await session.teardown();
  }
});

test("C-API-03 claude resume without a cwd launches in the recorded one, not the process's", async () => {
  installFakes();
  const recorded = tempDir();
  expect(recorded).not.toBe(process.cwd());
  const stateDir = resumableStateDir("claude", recorded, "claude-recorded");
  const session = await resumeClaude({ elwoodSessionId: "claude-recorded", stateDir });
  try {
    expect(ptys.at(-1)!.options.cwd).toBe(recorded);
  } finally {
    await session.teardown();
  }
});
