/**
 * The CLI-side hook timeout carries a fixed margin over Elwood's fail-open deadline.
 * Covers PRD §6.3 (C-HOOK-04).
 */

import { describe, expect, test } from "vitest";
import { cliHookTimeoutSeconds } from "../../src/claude/session/runtime.ts";

describe("Claude hook timeout margin", () => {
  test("C-HOOK-04 the CLI-side hook timeout carries a margin over Elwood's fail-open deadline", () => {
    // The CLI's clock starts at hook-process spawn, before Elwood's race begins; with
    // equal values the CLI would kill the hook before the fail-open reply arrived.
    expect(cliHookTimeoutSeconds(25_000)).toBe(30);
    expect(cliHookTimeoutSeconds(1)).toBe(6);
  });
});
