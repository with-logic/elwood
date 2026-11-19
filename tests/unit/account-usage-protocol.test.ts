/** Exercise C-STATS-03 at both real process boundaries with isolated native CLI stand-ins. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  vi.stubEnv("ZDOTDIR", root);
  vi.spyOn(shell, "userShell").mockReturnValue("/bin/zsh");
  writeFileSync(
    join(root, ".zshrc"),
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
    let initialized = false;
    lines.on("line", line => {
      const msg = JSON.parse(line);
      if (msg.method === "initialize") console.log(JSON.stringify({id:msg.id,result:{}}));
      else if (msg.method === "initialized") initialized = true;
      else if (initialized && msg.method === "account/rateLimits/read") {
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
  f.cli("claude", 'process.stdout.write("a".repeat(1_100_000));process.stdin.resume();');
  f.cli("codex", "console.log(JSON.stringify({id:1,error:{code:42}}));process.stdin.resume();");
  expect((await readAccountUsage()).map((a) => a.status)).toEqual(["unavailable", "unavailable"]);
});
