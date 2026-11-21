/** Current Claude account credential selection across the login shell and CLI (C-STATS-03). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { readAccountUsage } from "../../src/index.ts";
import { usageProtocolFixture } from "../helpers/account-usage-protocol.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const direct = { signedIn: true, key: false, used: 20, baseUrl: "", padding: 0, effective: {} };
const canonicalOrigin = "https://api.anthropic.com";
const gateway = "https://gateway.example.invalid";
const shellApiKey = "fixture-shell-key";
const keepKey = [
  ["settings gateway", { env: { ANTHROPIC_BASE_URL: gateway } }],
  ["managed gateway", { forceLoginGatewayUrl: gateway }],
  ["settings-owned key", { env: { ANTHROPIC_API_KEY: "fixture" } }],
  ["settings bearer token", { env: { ANTHROPIC_AUTH_TOKEN: "fixture-token" } }],
  ["credential helper", { apiKeyHelper: "configured-helper" }],
  ["invalid settings", []],
  ["invalid environment", { env: null }],
  ["invalid endpoint", { env: { ANTHROPIC_BASE_URL: false } }],
  ["malformed settings bearer token", { env: { ANTHROPIC_AUTH_TOKEN: null } }],
  ["older CLI", null],
] as const;

test.each([
  { ...direct, name: "subscription" },
  { ...direct, name: "key only", signedIn: false, used: undefined },
  {
    ...direct,
    name: "pinned direct endpoint",
    baseUrl: canonicalOrigin,
    effective: { env: { ANTHROPIC_BASE_URL: `${canonicalOrigin}/` } },
  },
  {
    ...direct,
    name: "empty settings bearer token",
    effective: { env: { ANTHROPIC_AUTH_TOKEN: "" } },
  },
  ...keepKey.map(([name, effective]) => ({
    ...direct,
    name,
    effective,
    key: true,
    used: undefined,
  })),
  { ...direct, name: "combined output limit", padding: 600_000, used: undefined },
])("C-STATS-03 chooses Claude credentials after shell startup for $name", async (scenario) => {
  const { baseUrl, effective, key, padding, signedIn, used } = scenario;
  for (const name of Object.keys(process.env)) {
    if (/^(?:CLAUDE_|ANTHROPIC_|CLAUDECODE$)/.test(name)) vi.stubEnv(name, undefined);
  }
  const fixture = usageProtocolFixture(
    `export ANTHROPIC_API_KEY=${shellApiKey} ANTHROPIC_BASE_URL="${baseUrl}"`,
  );
  const keyMarker = join(fixture.root, "usage-key-present");
  fixture.cli(
    "claude",
    `
    if ("CLAUDE_CONFIG_DIR" in process.env) process.exit(2);
    const fs = require("node:fs");
    const keyPresent = "ANTHROPIC_API_KEY" in process.env;
    require("node:readline").createInterface({input:process.stdin}).on("line", line => {
      const msg = JSON.parse(line);
      let reply;
      if (msg.request.subtype === "get_settings") {
        if (!keyPresent) process.exit(2);
        const effective = ${JSON.stringify(effective)};
        reply = effective === null
          ? {subtype:"error", error:"Unsupported control request subtype"}
          : {subtype:"success", response:{effective}};
      } else if (msg.request.subtype === "get_usage") {
        if (keyPresent && process.env.ANTHROPIC_API_KEY !== ${JSON.stringify(shellApiKey)}) process.exit(2);
        fs.writeFileSync(${JSON.stringify(keyMarker)}, String(keyPresent));
        const subscribed = ${signedIn} && !keyPresent;
        reply = {subtype:"success", response:{
          rate_limits_available:subscribed,
          rate_limits:subscribed ? {limits:[{kind:"weekly_all",group:"weekly",percent:20}]} : null
        }};
      } else process.exit(2);
      if (${padding}) console.log("x".repeat(${padding}));
      console.log(JSON.stringify({type:"control_response",response:{request_id:msg.request_id,...reply}}));
    });`,
  );
  const [account] = await readAccountUsage([{ agent: "claude", label: "Claude" }]);
  expect(account?.status).toBe(used === undefined ? "unavailable" : "available");
  expect(account?.windows[0]?.usedPercent).toBe(used);
  expect(readFileSync(keyMarker, "utf8")).toBe(String(key));
});
