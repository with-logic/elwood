/**
 * Conformance test for the CLI-side hook timeout margin written into generated
 * Claude settings. Covers PRD §6.3 (C-HOOK-04).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { installFakes, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("ClaudeSessionApi hook timeout", () => {
  test("C-HOOK-04 the generated settings give the CLI a timeout margin over hookTimeoutMs", async () => {
    // The CLI's hook clock starts at process spawn, before Elwood's own race; an
    // equal value would let the CLI kill the hook before the fail-open reply landed.
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd, hookTimeoutMs: 2_500 });
    const settingsPath = join(
      cwd,
      ".elwood",
      "sessions",
      session.elwoodSessionId,
      "claude-settings.json",
    );
    const hooks = JSON.parse(readFileSync(settingsPath, "utf8")).hooks;
    expect(hooks.Stop[0].hooks[0].timeout).toBe(8); // ceil(2.5 s) + 5 s margin
    expect(hooks.PreToolUse[0].matcher).toBe("*");
  });
});
