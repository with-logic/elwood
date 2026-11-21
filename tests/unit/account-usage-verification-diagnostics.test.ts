/** Fixed diagnostics for unverified Claude quota settings (C-STATS-03). */
import * as fs from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { readAccountUsage } from "../../src/index.ts";
import { usageProtocolFixture } from "../helpers/account-usage-protocol.ts";

vi.mock(import("node:fs"), async (importOriginal) => ({
  ...(await importOriginal()),
  writeSync: vi.fn<(fd: number, data: string | NodeJS.ArrayBufferView) => number>(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

test.each([
  "",
  "elwood",
])("C-STATS-03 settings diagnostics stay fixed and opt-in (%s)", async (debug) => {
  vi.stubEnv("NODE_DEBUG", debug);
  for (const name of Object.keys(process.env)) {
    if (/^(?:CLAUDE_|ANTHROPIC_|CLAUDECODE$)/.test(name)) vi.stubEnv(name, undefined);
  }
  const fixture = usageProtocolFixture("export ANTHROPIC_API_KEY=synthetic-usage-key");
  fixture.cli(
    "claude",
    `
    if (process.env.ANTHROPIC_API_KEY !== "synthetic-usage-key") process.exit(2);
    let settingsRead = false;
    require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
      const { request_id, request } = JSON.parse(line);
      let reply;
      if (request.subtype === "get_settings" && !settingsRead) {
        settingsRead = true;
        reply = { subtype: "error", error: "private native diagnostic" };
      } else if (request.subtype === "get_usage" && settingsRead) {
        reply = { subtype: "success", response: {
          rate_limits_available: true, rate_limits: { five_hour: { utilization: 20 } }
        }};
      } else process.exit(2);
      console.log(JSON.stringify({ type: "control_response", response: { request_id, ...reply } }));
    });`,
  );
  const write = vi.mocked(fs.writeSync).mockReturnValue(0);
  const [result] = await readAccountUsage([{ agent: "claude", label: "Claude" }]);
  expect(result?.windows[0]?.usedPercent).toBe(20);
  expect(write.mock.calls).toEqual(
    debug
      ? [[2, "ELWOOD: Could not verify Claude quota settings. Kept the configured credential.\n"]]
      : [],
  );
});
