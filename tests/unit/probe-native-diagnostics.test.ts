/** Native shell spawn failures retain C-ERR-08 diagnostics through both adapter preflights. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { tempDir } from "../helpers/tmp.ts";

const os = vi.hoisted(() => ({ shell: "" }));
vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, userInfo: () => ({ ...actual.userInfo(), shell: os.shell }) };
});

test.each([
  ["claude", "EACCES"],
  ["codex", "EACCES"],
  ["claude", "ENOENT"],
  ["codex", "ENOENT"],
] as const)("C-ERR-08 %s preflight keeps native shell %s syscall and path", async (adapter, errno) => {
  const shell = join(tempDir("elwood-probe-spawn-"), "shell");
  if (errno === "EACCES") writeFileSync(shell, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
  os.shell = shell;
  // The preload imports shell helpers before this file's OS mock; refresh every caller.
  vi.resetModules();
  const seams = await import("../../src/runtime/seams.ts");
  seams.setPlatformForTests("darwin");
  try {
    const { userShell } = await import("../../src/runtime/shell.ts");
    expect(userShell()).toBe(shell);
    const preflight =
      adapter === "claude"
        ? (await import("../../src/claude/preflight.ts")).preflightClaude
        : (await import("../../src/codex/preflight.ts")).preflightCodex;
    const failure = preflight(false);
    await expect(failure).rejects.toMatchObject({
      code: `${adapter}_${errno === "ENOENT" ? "not_found" : "start_failed"}`,
      details: { errno, syscall: `spawn ${shell}`, path: shell },
    });
    await expect(failure).rejects.toHaveProperty(
      "details",
      errno === "ENOENT"
        ? expect.not.objectContaining({ stderr: expect.anything() })
        : expect.objectContaining({ stderr: "" }),
    );
  } finally {
    seams.resetRuntimeSeamsForTests();
  }
});
