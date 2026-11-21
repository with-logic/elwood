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
  { name: "named profile", error: unsupportedUsage, rc: "", used: 18 },
  { name: "legacy refusal", error: "Unsupported control request subtype", rc: "", used: 18 },
  { name: "authentication refusal", error: "Not authenticated", rc: "", used: undefined },
  {
    name: "federated profile",
    error: unsupportedUsage,
    rc: "export ANTHROPIC_PROFILE=fixture",
    used: undefined,
  },
  { name: "non-neutral directory", error: unsupportedUsage, rc: "cd /tmp", used: undefined },
].map((row) => ({ ...row, currentSignIn: false, expectedStorageDir: undefined }));

test.each([
  ...explicitProfile,
  {
    name: "nested Claude",
    error: unsupportedUsage,
    rc: "export CLAUDECODE=1",
    used: undefined,
    currentSignIn: true,
    expectedStorageDir: undefined,
  },
  {
    name: "shell API key",
    error: unsupportedUsage,
    rc: "export ANTHROPIC_API_KEY=fixture",
    used: 18,
    currentSignIn: true,
    expectedStorageDir: undefined,
  },
  {
    name: "gateway in effective settings",
    error: unsupportedUsage,
    rc: "export ANTHROPIC_API_KEY=fixture",
    settingsEnv: { ANTHROPIC_BASE_URL: "https://gateway.example.invalid" },
    used: undefined,
    currentSignIn: true,
    expectedStorageDir: undefined,
  },
  {
    name: "bearer token in effective settings",
    error: unsupportedUsage,
    rc: "export ANTHROPIC_API_KEY=fixture",
    settingsEnv: { ANTHROPIC_AUTH_TOKEN: "fixture" },
    used: undefined,
    currentSignIn: true,
    expectedStorageDir: undefined,
  },
  {
    name: "secure storage selector",
    error: unsupportedUsage,
    rc: `export CLAUDE_SECURESTORAGE_CONFIG_DIR=${secureStorageDir}`,
    used: 18,
    currentSignIn: true,
    expectedStorageDir: secureStorageDir,
  },
])("C-STATS-05 reads Claude /usage only after an eligible request refusal ($name)", async (scenario) => {
  const { currentSignIn, error, expectedStorageDir, rc, used } = scenario;
  const effective = "settingsEnv" in scenario ? { env: scenario.settingsEnv } : {};
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
          !JSON.parse(flag("--settings")).disableAllHooks || flag("--tools") !== "" ||
          "ANTHROPIC_API_KEY" in process.env) process.exit(2);
      console.log(JSON.stringify({type:"assistant", usage_report:{rate_limits:{limits:[{kind:"session", percent:18}]}}}));
    } else {
      require("node:readline").createInterface({input:process.stdin}).on("line", line => {
        const msg = JSON.parse(line);
        const reply = msg.request?.subtype === "get_settings"
          ? {subtype:"success",response:{effective:${JSON.stringify(effective)}}}
          : {subtype:"error",error:${JSON.stringify(error)}};
        console.log(JSON.stringify({type:"control_response",response:{request_id:msg.request_id,...reply}}));
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
