/** Capture setup errors are startup failures, never missing CLIs (C-PERF-05, C-ERR-08). */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import { preflightCodex } from "../../src/codex/preflight.ts";
import { setMkfifoForTests } from "../../src/runtime/probe/named-pipes.ts";
import { outputUnavailable } from "../../src/runtime/probe/results.ts";
import { resetRuntimeSeamsForTests, setPlatformForTests } from "../../src/runtime/seams.ts";
import * as shell from "../../src/runtime/shell.ts";
import { resetPreflightCacheForTests } from "../../src/runtime/update/once.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetRuntimeSeamsForTests();
  resetPreflightCacheForTests();
  setMkfifoForTests();
});
for (const [agent, preflight] of [
  ["claude", preflightClaude],
  ["codex", preflightCodex],
] as const) {
  for (const missing of ["directory", "mkfifo"] as const) {
    test(`C-ERR-08 installed ${agent} reports ${missing} ENOENT as start_failed with its cause`, async () => {
      const root = tempDir("elwood-probe-setup-agent-");
      writeFileSync(join(root, agent), "#!/bin/sh\necho 2.1.144\n", { mode: 0o700 });
      vi.stubEnv("PATH", `${root}:/usr/bin:/bin`);
      vi.spyOn(shell, "userShell").mockReturnValue("/bin/sh");
      setPlatformForTests("darwin");
      if (missing === "directory") vi.stubEnv("TMPDIR", join(root, "missing"));
      else setMkfifoForTests(join(root, "missing-mkfifo"));
      await expect(preflight(false)).rejects.toMatchObject({
        code: `${agent}_start_failed`,
        details: {
          errno: "ENOENT",
          cause: expect.stringContaining("could not create the probe's private output pipes:"),
          stderr: "",
        },
      });
    });
  }
}

for (const code of ["ENOENT", 1, null, undefined] as const) {
  test(`C-PERF-05 setup error code ${code} is narrowed from execFile's actual shape`, () => {
    const error = Object.assign(new Error("setup"), { code });
    expect(outputUnavailable(error)).toEqual({
      status: null,
      stdout: "",
      stderr: "",
      error: {
        message: "could not create the probe's private output pipes: setup",
        origin: "probe_setup",
        ...(typeof code === "string" ? { code } : {}),
      },
    });
  });
}
test("C-PERF-05 an unknown setup rejection remains diagnosable", () => {
  expect(outputUnavailable("setup").error?.message).toContain("setup");
});
