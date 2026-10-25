/**
 * Unit coverage for the Codex config restore's atomic-write failure path (PRD §5.3,
 * C-CODEX-14): when the final rename fails, the sibling temp file is removed and the
 * original error surfaces, so a failed restore never leaves litter beside config.toml.
 * The rename is failed through a `node:fs` mock (deterministic for every uid; a
 * read-only directory would not stop root).
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { restoreCodexHome, tempCodexHome } from "./helpers.ts";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  renameSync: () => {
    throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
  },
}));

const { restoreCodexConfig, snapshotCodexConfig } = await import(
  "../../src/codex/config/restore.ts"
);

afterEach(restoreCodexHome);

describe("codex config restore write failure", () => {
  test("C-CODEX-14 a failed rename removes the temp file and rethrows the original error", () => {
    const path = tempCodexHome('model = "gpt-5.5"\n');
    const home = dirname(path);
    const snapshot = snapshotCodexConfig(path);
    writeFileSync(path, 'model = "gpt-5.4"\n');
    expect(() => restoreCodexConfig({ path, snapshot })).toThrow(/cross-device link/);
    expect(readdirSync(home)).toEqual(["config.toml"]); // no temp litter
    expect(readFileSync(path, "utf8")).toBe('model = "gpt-5.4"\n'); // never truncated
  });
});
