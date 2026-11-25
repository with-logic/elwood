/** Native Claude quota warnings from an isolated loopback gateway (PRD §5.4, C-API-68). */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { type ElwoodActivityEvent, type ElwoodWarningEvent, startClaude } from "../../src/index.ts";
import { nodePtyFactory } from "../../src/pty/node.ts";
import type { PtyProcess } from "../../src/pty/types.ts";
import {
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPtyFactoryForTests,
} from "../../src/runtime/seams.ts";
import { shellQuote } from "../../src/runtime/shell.ts";
import {
  resetSocketHomeRootForTests,
  setSocketHomeRootForTests,
} from "../../src/state/socket-home.ts";
import { fixtureGateway, localGatewayMarker } from "./claude-quota-loopback.ts";
import { registerPrivateHome } from "./home-guard.ts";
import { prefixShellArgument } from "./prefix-shell-argument.ts";
import { waitFor } from "./wait-for.ts";

const enabled = process.env["ELWOOD_NATIVE_CLAUDE_QUOTA_PROOF"] === "1";
const release = "2.1.332";
const binaryOverride = process.env["ELWOOD_NATIVE_CLAUDE_QUOTA_BINARY"];
const binary = binaryOverride
  ? resolve(binaryOverride)
  : join(homedir(), ".local/share/claude/versions", release);
const seatbelt = "/usr/bin/sandbox-exec";
const nativeLimitType = "seven_day_overage_included";
const prompt = "Synthetic quota test prompt";

type QuotaWarning = Extract<ElwoodWarningEvent, { code: "usage_limit_reached"; agent: "claude" }>;

// Run alone with ELWOOD_NATIVE_CLAUDE_QUOTA_PROOF=1 and node --test on this file.
// The standard e2e credential preloads are unnecessary for this loopback-only test.
test("C-API-68 a real Claude usage-cap rejection emits a structured warning and activity", {
  skip: enabled ? false : "set ELWOOD_NATIVE_CLAUDE_QUOTA_PROOF=1 for the pinned local Claude",
  timeout: 55_000,
}, async () => {
  assert.equal(process.platform, "darwin");
  assert.ok(existsSync(binary), `Claude ${release} is required`);
  assert.ok(existsSync(seatbelt), "macOS sandbox-exec is required for loopback isolation");
  const root = realpathSync(mkdtempSync("/tmp/ew-quota-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const stateDir = join(root, "state");
  const bin = join(root, "bin");
  const requests: string[] = [];
  const resetsAt = Math.floor(Date.now() / 1_000) + 14_400;
  const gateway = fixtureGateway(resetsAt, requests, nativeLimitType);
  let releaseHome: (() => void) | undefined;
  let session: Awaited<ReturnType<typeof startClaude>> | undefined;
  let pty: PtyProcess | undefined;
  let ptyClosed = false;
  try {
    for (const dir of [home, cwd, stateDir, bin]) mkdirSync(dir, { mode: 0o700 });
    releaseHome = registerPrivateHome(home);
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        theme: "dark",
        hasCompletedOnboarding: true,
        lastOnboardingVersion: release,
        projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
      }),
      { mode: 0o600 },
    );
    gateway.listen(0, "127.0.0.1");
    await once(gateway, "listening");
    const address = gateway.address();
    assert.ok(address && typeof address === "object");
    const jail = `(version 1) (allow default) (deny network*) (allow network-outbound (remote ip "localhost:${address.port}") (remote unix-socket (subpath ${JSON.stringify(root)})))`;
    writeFileSync(
      join(bin, "claude"),
      `#!/bin/sh
exec ${shellQuote(seatbelt)} -p ${shellQuote(jail)} ${shellQuote(binary)} "$@"
`,
      { mode: 0o700 },
    );
    const path = `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`;
    const env = {
      HOME: home,
      CLAUDE_CONFIG_DIR: home,
      CLAUDE_CODE_TMPDIR: home,
      ZDOTDIR: home,
      PATH: path,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      ANTHROPIC_AUTH_TOKEN: localGatewayMarker(),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_MAX_RETRIES: "0",
      DISABLE_AUTOUPDATER: "1",
    };
    setSocketHomeRootForTests(root);
    setCommandRunnerForTests(() => {
      const version = spawnSync(seatbelt, ["-p", jail, binary, "--version"], {
        cwd,
        env,
        encoding: "utf8",
        timeout: 10_000,
        killSignal: "SIGKILL",
      });
      assert.equal(version.status, 0, version.stderr);
      const banner = version.stdout.trim();
      if (binaryOverride) assert.match(banner, /\(Claude Code\)$/u);
      else assert.equal(banner, `${release} (Claude Code)`);
      return { status: version.status, stdout: version.stdout, stderr: version.stderr };
    });
    setPtyFactoryForTests((options) => {
      pty = nodePtyFactory({
        ...options,
        command: "/bin/zsh",
        args: prefixShellArgument(options.args, `export PATH=${shellQuote(path)}`),
        env: { ...env, ELWOOD_SESSION_ID: options.env["ELWOOD_SESSION_ID"] ?? "" },
      });
      pty.onExit(() => {
        ptyClosed = true;
      });
      return pty;
    });
    session = await startClaude({ cwd, stateDir, model: "claude-sonnet-4-6", autoupdate: false });
    const warnings: QuotaWarning[] = [];
    const activities: ElwoodActivityEvent[] = [];
    let turnId: string | undefined;
    session.on("hook", (event) => {
      if (event.hook_event_name !== "UserPromptSubmit" || event.prompt !== prompt) return;
      const id = event["prompt_id"];
      if (typeof id === "string") turnId = id;
    });
    session.on("warning", (event) => {
      if (event.agent === "claude" && event.code === "usage_limit_reached") warnings.push(event);
    });
    session.on("activity", (event) => {
      if (event.kind === "warning" && event.label === "usage_limit_reached") activities.push(event);
    });
    await waitFor(
      () => session?.status === "ready" || undefined,
      "isolated Claude readiness",
      15_000,
    );
    await session.sendMessage(prompt);
    const warning = await waitFor(() => warnings[0], "the native Claude quota warning", 20_000);
    assert.ok(turnId);
    assert.equal(warning.elwoodSessionId, session.elwoodSessionId);
    assert.equal(warning.turnId, turnId);
    assert.equal(warning.nativeLimitType, nativeLimitType);
    assert.equal(warning.limitName, "Fable");
    assert.equal(warning.resetsAtUnixSeconds, resetsAt);
    assert.match(warning.message, /You've hit your Fable limit/u);
    assert.equal(warning.source, "transcript");
    assert.ok(warning.transcriptPath.startsWith(`${home}/projects/`));
    assert.equal(warnings.length, 1);
    assert.equal(activities.length, 1);
    assert.deepEqual(activities[0]?.raw, warning);
    assert.equal(requests.length, 1);
  } finally {
    try {
      await session?.teardown().catch(() => session?.kill());
      if (pty && !ptyClosed) {
        pty.kill("SIGKILL");
        await waitFor(() => ptyClosed || undefined, "the isolated Claude process to exit", 5_000);
      }
    } finally {
      gateway.closeAllConnections();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
      resetRuntimeSeamsForTests();
      resetSocketHomeRootForTests();
      releaseHome?.();
      rmSync(root, { recursive: true, force: true });
    }
  }
});
