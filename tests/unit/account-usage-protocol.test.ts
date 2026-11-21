/** Exercise C-STATS-03 at both real process boundaries with isolated native CLI stand-ins. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { readAccountUsage } from "../../src/index.ts";
import * as shell from "../../src/runtime/shell.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function fixture(rc = "") {
  const root = tempDir("usage-protocol-");
  vi.stubEnv("HOME", root);
  vi.stubEnv("TERM_PROGRAM", "");
  vi.spyOn(shell, "userShell").mockReturnValue("/bin/bash");
  writeFileSync(
    join(root, ".bash_profile"),
    `export PATH=${shell.shellQuote(root)}:/usr/bin:/bin\n${rc}\n`,
  );
  return {
    root,
    cli(name: string, body: string) {
      writeFileSync(join(root, name), `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
    },
  };
}

test("C-STATS-03 reads fresh balances for distinct profiles before a model turn", async () => {
  const f = fixture();
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
  const f = fixture("export CODEX_HOME=/unexpected");
  const launched = join(f.root, "launched");
  f.cli("codex", `require("node:fs").writeFileSync(${JSON.stringify(launched)}, "wrong account");`);
  const [account] = await readAccountUsage([{ agent: "codex", label: "Work", configDir: f.root }]);
  expect(account?.status).toBe("unavailable");
  expect(existsSync(launched)).toBe(false);
});

test("C-STATS-03 a native refusal or oversized reply yields unavailable", async () => {
  const f = fixture();
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
  const f = fixture("export CLAUDE_SECURESTORAGE_CONFIG_DIR=/other CLAUDE_CODE_OAUTH_TOKEN=fake");
  f.cli(
    "claude",
    `
    const selected = process.env.CLAUDE_CONFIG_DIR;
    const inherited = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    const explicit = selected === ${JSON.stringify(f.root)};
    const correct = explicit ? (!inherited || inherited === selected) && !process.env.CLAUDE_CODE_OAUTH_TOKEN : inherited === "/other";
    if (!correct) process.exit(2);
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
  const f = fixture("export CODEX_ACCESS_TOKEN=synthetic-test-token");
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

test.each([
  { error: "Unsupported control request subtype: get_usage", rc: "", used: 18 },
  { error: "Unsupported control request subtype", rc: "", used: 18 },
  { error: "Not authenticated", rc: "", used: undefined },
  {
    error: "Unsupported control request subtype: get_usage",
    rc: "export ANTHROPIC_PROFILE=fixture",
    used: undefined,
  },
  { error: "Unsupported control request subtype: get_usage", rc: "cd /tmp", used: undefined },
])("C-STATS-05 reads Claude /usage only after an eligible request refusal ($error $rc)", async ({
  error,
  rc,
  used,
}) => {
  for (const name of Object.keys(process.env)) {
    if (/^(?:CLAUDE_|ANTHROPIC_|CLAUDECODE$)/.test(name)) vi.stubEnv(name, undefined);
  }
  const f = fixture(rc);
  const marker = join(f.root, "fallback-invoked");
  f.cli(
    "claude",
    `
    if (process.argv.includes("/usage")) {
      require("node:fs").writeFileSync(${JSON.stringify(marker)}, process.cwd());
      const flag = (name) => process.argv[process.argv.indexOf(name) + 1];
      if (!process.argv.includes("--safe-mode") || !process.argv.includes("-p") ||
          flag("--output-format") !== "stream-json" || process.cwd() !== "/" ||
          process.env.CLAUDE_CONFIG_DIR !== ${JSON.stringify(f.root)} || flag("--setting-sources") !== "user" ||
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
  const [result] = await readAccountUsage([{ agent: "claude", label: "Work", configDir: f.root }]);
  expect(result?.windows[0]?.usedPercent).toBe(used);
  expect(existsSync(marker)).toBe(used !== undefined);
});
