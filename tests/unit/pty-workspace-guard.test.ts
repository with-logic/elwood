/** Real PTY start/resume guards reject observed workspace replacements (PRD §4.2, C-API-61). */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetCodexPreflightCacheForTests } from "../../src/codex/preflight.ts";
import { resumeClaude, resumeCodex, startClaude, startCodex } from "../../src/index.ts";
import { nodePtyFactory } from "../../src/pty/node.ts";
import type { PtySpawnOptions } from "../../src/pty/types.ts";
import {
  setCommandRunnerForTests,
  setPlatformForTests,
  setPtyFactoryForTests,
} from "../../src/runtime/seams.ts";
import * as shell from "../../src/runtime/shell.ts";
import {
  resetStartupWaitMsForTests,
  setStartupWaitMsForTests,
} from "../../src/runtime/startup/index.ts";
import { resetPreflightCacheForTests } from "../../src/runtime/update/once.ts";
import {
  createSessionRecord,
  prepareStateDir,
  updateSessionResumeId,
  writeSessionRecord,
} from "../../src/state/store.ts";
import { tempDir } from "../helpers/tmp.ts";

// Only the health wait is gated; native PTY/socket timers remain real under host load.
const observed = vi.hoisted(() => ({
  windowMs: 123_456,
  exit: Promise.resolve(),
  release: () => {},
}));
vi.mock("../../src/core/delay.ts", async (original) => {
  const actual = await original<typeof import("../../src/core/delay.ts")>();
  return { delay: (ms: number) => (ms === observed.windowMs ? observed.exit : actual.delay(ms)) };
});
function observedPty(options: PtySpawnOptions) {
  const pty = nodePtyFactory(options);
  pty.onExit(observed.release);
  return pty;
}

const agents = [
  ["claude", startClaude, resumeClaude],
  ["codex", startCodex, resumeCodex],
] as const;
let home: string;
beforeEach(() => {
  const exit = Promise.withResolvers<void>();
  observed.exit = exit.promise;
  observed.release = exit.resolve;
  setStartupWaitMsForTests(observed.windowMs);
  setPlatformForTests("darwin");
  setCommandRunnerForTests(() => ({
    status: 0,
    stdout: "2.1.144 (Claude Code) codex-cli 0.150.0",
    stderr: "",
  }));
  home = tempDir("elwood-pty-guard-home-");
  const login = join(home, "login-shell");
  writeFileSync(login, '#!/bin/sh\n. "$HOME/.profile"\nshift 3\neval "$1"\n', { mode: 0o700 });
  vi.spyOn(shell, "userShell").mockReturnValue(login);
  vi.stubEnv("HOME", home);
});
afterEach(() => {
  resetStartupWaitMsForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetPreflightCacheForTests();
  resetCodexPreflightCacheForTests();
});

// Moved-state assertions require actual macOS VolFS lookup (PRD §8.1).
for (const kind of ["start", "resume"] as const) {
  for (const phase of ["before", "profile"] as const) {
    test.for(agents)(`C-API-61 real PTY ${kind} of %s refuses a ${phase} replacement`, async ([
      agent,
      start,
    ], { skip }) => {
      if (process.platform !== "darwin") skip();
      const cwd = realpathSync(tempDir("elwood-pty-guard-cwd-"));
      const original = join(tempDir("elwood-pty-guard-original-"), "kept");
      const replacement = tempDir("elwood-pty-guard-replacement-");
      const marker = join(home, "cli-ran");
      const profileMarker = join(home, "profile-ran");
      mkdirSync(join(replacement, "bin"));
      const agentScript = `#!/bin/sh\ntouch '${marker}'\nexit 1\n`;
      writeFileSync(join(replacement, "bin", agent), agentScript, { mode: 0o700 });
      const stateDir = join(cwd, ".elwood");
      const id = "guard-resume";
      const recordPath = (root: string, sessionId: string) =>
        join(root, ".elwood", "sessions", sessionId, "session.json");
      if (kind === "resume") {
        prepareStateDir(stateDir, { cwd, elwoodSessionId: id });
        writeSessionRecord(
          updateSessionResumeId(
            createSessionRecord({ cwd, id, adapter: agent }),
            agent,
            `${agent}-old`,
          ),
          join(stateDir, "sessions", id),
        );
      }
      const before = kind === "resume" ? readFileSync(recordPath(cwd, id), "utf8") : undefined;
      let launchedId = "";
      setPtyFactoryForTests((options) => {
        expect(options.directoryIdentity).toBeDefined();
        launchedId = options.env["ELWOOD_SESSION_ID"] ?? "";
        expect(launchedId).not.toBe("");
        const published = readFileSync(recordPath(cwd, launchedId), "utf8");
        if (kind === "resume") expect(published).not.toBe(before);
        const swap = `mv '${cwd}' '${original}'; mv '${replacement}' '${cwd}'`;
        writeFileSync(
          join(home, ".profile"),
          `touch '${profileMarker}'\n${phase === "profile" ? swap : ":"}\nexport PATH='${cwd}/bin:/usr/bin:/bin'\n`,
        );
        if (phase === "before") {
          renameSync(cwd, original);
          renameSync(replacement, cwd);
        }
        return observedPty(options);
      });
      try {
        const launch =
          kind === "start"
            ? start({ cwd })
            : agent === "claude"
              ? resumeClaude({ stateDir, elwoodSessionId: id, permissionMode: "plan" })
              : resumeCodex({ stateDir, elwoodSessionId: id, sandbox: "read-only" });
        await expect(launch).rejects.toMatchObject({
          code: `${agent}_start_failed`,
          details: { cwd },
        });
        expect(existsSync(original)).toBe(true);
        expect(existsSync(profileMarker)).toBe(phase === "profile");
        expect(existsSync(marker), "the replacement CLI never runs").toBe(false);
        if (kind === "resume") expect(readFileSync(recordPath(original, id), "utf8")).toBe(before);
        else expect(existsSync(recordPath(original, launchedId))).toBe(false);
        expect(readdirSync(cwd)).toEqual(["bin"]);
        expect(readFileSync(join(cwd, "bin", agent), "utf8")).toBe(agentScript);
      } finally {
        if (existsSync(original)) {
          renameSync(cwd, replacement);
          renameSync(original, cwd);
        }
      }
    });
  }
}

test.each(
  agents,
)("C-API-61 an unchanged %s PTY reaches its requested command", async (agent, start) => {
  const cwd = realpathSync(tempDir("elwood-pty-guard-control-"));
  const marker = join(home, "cli-ran");
  mkdirSync(join(cwd, "bin"));
  writeFileSync(join(cwd, "bin", agent), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o700 });
  writeFileSync(join(home, ".profile"), `export PATH='${cwd}/bin:/usr/bin:/bin'\n`);
  setPtyFactoryForTests(observedPty);
  const session = await start({ cwd }).catch(() => undefined);
  try {
    await expect.poll(() => existsSync(marker), { timeout: 5_000 }).toBe(true);
  } finally {
    await session?.teardown();
  }
});
