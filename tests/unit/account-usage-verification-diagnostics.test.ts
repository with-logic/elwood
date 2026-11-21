/** Fixed diagnostics for unverified Claude quota settings (C-STATS-03). */
import * as fs from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { readAccountUsage } from "../../src/index.ts";
import { resetRuntimeSeamsForTests, setCommandRunnerForTests } from "../../src/runtime/seams.ts";

vi.mock(import("node:fs"), async (importOriginal) => ({
  ...(await importOriginal()),
  writeSync: vi.fn<(fd: number, data: string | NodeJS.ArrayBufferView) => number>(),
}));

afterEach(() => {
  resetRuntimeSeamsForTests();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

test.each([
  "",
  "elwood",
])("C-STATS-03 settings diagnostics stay fixed and opt-in (%s)", async (debug) => {
  vi.stubEnv("NODE_DEBUG", debug);
  const write = vi.mocked(fs.writeSync).mockReturnValue(0);
  setCommandRunnerForTests(() => ({
    status: 0,
    stdout: JSON.stringify({ rate_limits_available: false }),
    stderr: "unrelated native diagnostic\nELWOOD_QUOTA_SETTINGS_UNVERIFIED\n",
  }));
  const [result] = await readAccountUsage([{ agent: "claude", label: "Claude" }]);
  expect(result?.status).toBe("unavailable");
  expect(write.mock.calls).toEqual(
    debug
      ? [[2, "ELWOOD: Could not verify Claude quota settings. Kept the configured credential.\n"]]
      : [],
  );
});
