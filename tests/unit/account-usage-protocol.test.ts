/** Exercise C-STATS-03 at both real process boundaries with isolated native CLI stand-ins. */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { readAccountUsage } from "../../src/index.ts";
import { usageProtocolFixture } from "../helpers/account-usage-protocol.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test("C-STATS-03 reads fresh balances for distinct profiles before a model turn", async () => {
  const f = usageProtocolFixture();
  const personal = join(f.root, "personal 'account");
  mkdirSync(personal);
  f.cli(
    "claude",
    `
    if (process.env.CLAUDE_CONFIG_DIR !== ${JSON.stringify(f.root)} || !process.argv.includes("--no-session-persistence") ||
        process.argv[process.argv.indexOf("--input-format") + 1] !== "stream-json" ||
        process.argv[process.argv.indexOf("--output-format") + 1] !== "stream-json") process.exit(2);
    require("node:readline").createInterface({input:process.stdin}).on("line", line => {
      const msg = JSON.parse(line);
      if (msg.type !== "control_request" || msg.request.subtype !== "get_usage" || !msg.request.skip_behaviors) process.exit(2);
      console.log("noise");
      console.log(JSON.stringify({type:"control_response",response:{subtype:"success",request_id:"wrong",response:{}}}));
      console.log(JSON.stringify({type:"control_response",response:{subtype:"success",request_id:msg.request_id,response:{
        rate_limits_available:true, rate_limits:{limits:[{kind:"weekly_all",group:"weekly",percent:3}]}
      }}}));
    });
  `,
  );
  f.cli(
    "codex",
    `
    const lines = require("node:readline").createInterface({input:process.stdin});
    if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["app-server","--listen","stdio://"])) process.exit(2);
    let handshake = 0;
    lines.on("line", line => {
      const msg = JSON.parse(line);
      if (handshake === 0 && msg.method === "initialize") { handshake++; console.log(JSON.stringify({id:msg.id,result:{}})); }
      else if (handshake === 1 && msg.method === "initialized") handshake++;
      else if (handshake === 2 && msg.method === "account/rateLimits/read") {
        const used = process.env.CODEX_HOME.endsWith("personal 'account") ? 4 : 57;
        console.log(JSON.stringify({id:msg.id,result:{rateLimits:{primary:{usedPercent:used,windowDurationMins:300}}}}));
      } else process.exit(2);
    });
  `,
  );
  const accounts = await readAccountUsage([
    { agent: "claude", label: "Work", configDir: f.root },
    { agent: "codex", label: "Work", configDir: f.root },
    { agent: "codex", label: "Personal", configDir: personal },
  ]);
  expect(accounts.map((a) => [a.label, a.windows[0]?.remainingPercent])).toEqual([
    ["Work", 97],
    ["Work", 43],
    ["Personal", 96],
  ]);
});

test("C-STATS-03 a profile overwritten by the login shell never displays the wrong balance", async () => {
  const f = usageProtocolFixture("export CODEX_HOME=/unexpected");
  const launched = join(f.root, "launched");
  f.cli("codex", `require("node:fs").writeFileSync(${JSON.stringify(launched)}, "wrong account");`);
  const [account] = await readAccountUsage([{ agent: "codex", label: "Work", configDir: f.root }]);
  expect(account?.status).toBe("unavailable");
  expect(existsSync(launched)).toBe(false);
});

test("C-STATS-03 a native refusal or oversized reply yields unavailable", async () => {
  const f = usageProtocolFixture();
  const pidFile = join(f.root, "helper.pid");
  f.cli(
    "claude",
    `
    const helper = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 12000)"], {stdio:"ignore"});
    require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid));
    helper.unref();
    process.stdout.write("a".repeat(1_100_000));
    process.stdin.resume();
  `,
  );
  f.cli("codex", "console.log(JSON.stringify({id:1,error:{code:42}}));process.stdin.resume();");
  expect((await readAccountUsage()).map((a) => a.status)).toEqual(["unavailable", "unavailable"]);
  const pid = Number(readFileSync(pidFile, "utf8"));
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 4000 });
});

test("C-STATS-03 an explicit Claude profile uses its own credential store after login-shell startup", async () => {
  const f = usageProtocolFixture(
    "export CLAUDE_SECURESTORAGE_CONFIG_DIR=/other CLAUDE_CODE_OAUTH_TOKEN=fake ANTHROPIC_API_KEY=fixture ANTHROPIC_BASE_URL=https://gateway.example.invalid",
  );
  f.cli(
    "claude",
    `
    const selected = process.env.CLAUDE_CONFIG_DIR;
    const inherited = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    const explicit = selected === ${JSON.stringify(f.root)};
    const hasOAuth = "CLAUDE_CODE_OAUTH_TOKEN" in process.env;
    const correct = explicit ? (!inherited || inherited === selected) && !hasOAuth : inherited === "/other" && hasOAuth;
    if (!correct || (explicit ? "ANTHROPIC_API_KEY" in process.env : process.env.ANTHROPIC_API_KEY !== "fixture")) process.exit(2);
    require("node:readline").createInterface({ input: process.stdin }).on("line", () => {
      console.log(JSON.stringify({type:"control_response",response:{request_id:"usage",subtype:"success",response:{
        rate_limits_available:true,rate_limits:{seven_day:{utilization:explicit ? 15 : 70}}
      }}}));
    });`,
  );
  const results = await readAccountUsage([
    { agent: "claude", label: "Work", configDir: f.root },
    { agent: "claude", label: "Current" },
  ]);
  expect(results.map((row) => row.windows[0]?.usedPercent)).toEqual([15, 70]);
});

test("C-STATS-03 an explicit Codex profile ignores a login-shell token while the current sign-in keeps it", async () => {
  const f = usageProtocolFixture("export CODEX_ACCESS_TOKEN=synthetic-test-token");
  f.cli(
    "codex",
    `
    const lines = require("node:readline").createInterface({input:process.stdin});
    lines.on("line", line => {
      const msg = JSON.parse(line);
      if (msg.method === "initialize") console.log(JSON.stringify({id:msg.id,result:{}}));
      if (msg.method === "account/rateLimits/read") {
        const usedPercent = process.env.CODEX_ACCESS_TOKEN ? 70 : 15;
        console.log(JSON.stringify({id:msg.id,result:{rateLimits:{primary:{usedPercent}}}}));
      }
    });`,
  );
  const results = await readAccountUsage([
    { agent: "codex", label: "Work", configDir: f.root },
    { agent: "codex", label: "Current" },
  ]);
  expect(results.map((row) => row.windows[0]?.usedPercent)).toEqual([15, 70]);
});
