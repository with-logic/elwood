/** Electron-hosted hook command compatibility (PRD §6.1/§7A.1). */

import { describe, expect, test } from "vitest";
import { hookCommand } from "../../src/runtime/hook-command.ts";

describe("hookCommand", () => {
  test("uses the runtime executable directly under Node", () => {
    expect(hookCommand("/tmp/hook bridge.mjs", "/usr/bin/node", false)).toBe(
      "'/usr/bin/node' '/tmp/hook bridge.mjs'",
    );
  });

  test("runs Electron's executable in Node mode for embedded parents", () => {
    expect(hookCommand("/tmp/it's-a-hook.mjs", "/Applications/Coal Harbor/Electron", true)).toBe(
      "ELECTRON_RUN_AS_NODE=1 '/Applications/Coal Harbor/Electron' '/tmp/it'\\''s-a-hook.mjs'",
    );
  });
});
