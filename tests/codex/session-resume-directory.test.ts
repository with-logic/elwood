/**
 * A resumed Codex session launches in the directory its record says it started in, where the
 * `cwd` it is given differs: that `cwd` only locates the state (PRD §5.6, C-API-10).
 */

import { afterEach, expect, test } from "vitest";
import { resumeCodex } from "../../src/index.ts";
import { resumableStateDir } from "../helpers/session-state.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-API-10 codex resume launches in its recorded directory, not the cwd it is given", async () => {
  installFakes();
  const recorded = tempDir();
  const given = tempDir();
  const stateDir = resumableStateDir("codex", recorded, "codex-elsewhere");
  const session = await resumeCodex({ elwoodSessionId: "codex-elsewhere", stateDir, cwd: given });
  try {
    expect(session.status).toBe("running");
    const pty = ptys.at(-1)!;
    expect(pty.options.cwd).toBe(recorded);
    const command = pty.options.args.join(" ");
    expect(command).toContain(`--cd '${recorded}'`);
    expect(command).not.toContain(given);
  } finally {
    await session.teardown();
  }
});
