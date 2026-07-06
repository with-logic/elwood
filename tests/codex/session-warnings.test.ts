/**
 * Conformance tests for Codex startup environment warnings.
 * Covers PRD §5.7 and C-CODEX-14.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { installFakes, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("CodexSession environment warnings", () => {
  test("C-CODEX-14 warns when CODEX_HOME is set because TUI hooks will not fire", async () => {
    const cwd = tempDir();
    installFakes();
    process.env["CODEX_HOME"] = "/tmp/relocated-codex-home";
    try {
      const session = await startCodex({ cwd });
      expect(session.warnings).toMatchObject([
        { code: "codex_home_hooks_disabled", agent: "codex", raw: "/tmp/relocated-codex-home" },
      ]);
      const record = JSON.parse(
        readFileSync(
          join(cwd, ".elwood", "sessions", session.elwoodSessionId, "session.json"),
          "utf8",
        ),
      );
      expect(record.warnings).toMatchObject([{ code: "codex_home_hooks_disabled" }]);
    } finally {
      delete process.env["CODEX_HOME"];
    }
  });
});
