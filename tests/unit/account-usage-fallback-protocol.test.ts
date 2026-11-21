/** Exercise Claude usage fallback selection at the process boundary (C-STATS-05). */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { readAccountUsage } from "../../src/index.ts";
import { usageProtocolFixture } from "../helpers/account-usage-protocol.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const unsupportedUsage = "Unsupported control request subtype: get_usage";
const secureStorageDir = "/fixture-secure-storage";
const explicitProfile = [
  { error: unsupportedUsage, rc: "", used: 18 },
  { error: "Unsupported control request subtype", rc: "", used: 18 },
  { error: "Not authenticated", rc: "", used: undefined },
  { error: unsupportedUsage, rc: "export ANTHROPIC_PROFILE=fixture", used: undefined },
  { error: unsupportedUsage, rc: "cd /tmp", used: undefined },
].map((row) => ({ ...row, currentSignIn: false, expectedStorageDir: undefined }));

test.each([
  ...explicitProfile,
  {
    error: unsupportedUsage,
    rc: "export CLAUDECODE=1",
    used: undefined,
    currentSignIn: true,
    expectedStorageDir: undefined,
  },
  {
    error: unsupportedUsage,
    rc: `export CLAUDE_SECURESTORAGE_CONFIG_DIR=${secureStorageDir}`,
    used: 18,
    currentSignIn: true,
    expectedStorageDir: secureStorageDir,
  },
])("C-STATS-05 reads Claude /usage only after an eligible request refusal ($error $rc)", async ({
  currentSignIn,
  error,
  expectedStorageDir,
  rc,
  used,
}) => {
  for (const name of Object.keys(process.env)) {
    if (/^(?:CLAUDE_|ANTHROPIC_|CLAUDECODE$)/.test(name)) vi.stubEnv(name, undefined);
  }
  const f = usageProtocolFixture(rc);
  const expectedConfigDir = currentSignIn ? undefined : f.root;
  const marker = join(f.root, "fallback-invoked");
  f.cli(
    "claude",
    `
    if (process.argv.includes("/usage")) {
      require("node:fs").writeFileSync(${JSON.stringify(marker)}, process.cwd());
      const flag = (name) => process.argv[process.argv.indexOf(name) + 1];
      if (!process.argv.includes("--safe-mode") || !process.argv.includes("-p") ||
          flag("--output-format") !== "stream-json" || process.cwd() !== "/" ||
          process.env.CLAUDE_CONFIG_DIR !== ${JSON.stringify(expectedConfigDir)} || flag("--setting-sources") !== "user" ||
          process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== ${JSON.stringify(expectedStorageDir)} ||
          !process.argv.includes("--no-session-persistence") || !process.argv.includes("--strict-mcp-config") ||
          !JSON.parse(flag("--settings")).disableAllHooks || flag("--tools") !== "") process.exit(2);
      console.log(JSON.stringify({type:"assistant", usage_report:{rate_limits:{limits:[{kind:"session", percent:18}]}}}));
    } else {
      require("node:readline").createInterface({input:process.stdin}).on("line", line => {
        const msg = JSON.parse(line);
        console.log(JSON.stringify({type:"control_response",response:{request_id:msg.request_id,subtype:"error",error:${JSON.stringify(error)}}}));
      });
    }
  `,
  );
  const [result] = await readAccountUsage([
    currentSignIn
      ? { agent: "claude", label: "Current" }
      : { agent: "claude", label: "Work", configDir: f.root },
  ]);
  expect(result?.windows[0]?.usedPercent).toBe(used);
  expect(existsSync(marker)).toBe(used !== undefined);
});
