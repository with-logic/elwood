/**
 * Agent auto-detection through a real login-shell command probe (PRD §12A.1, C-CLI-21).
 * Each case spawns a real shell against a real temp directory placed on PATH.
 */

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  agentDetectionOrder,
  detectAvailableAgent,
  loginShellResolves,
  noAgentFoundMessage,
} from "../../src/cli/request/agent-detect.ts";
import type { CliAgent } from "../../src/cli/types.ts";
import { resetRuntimeSeamsForTests, setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import { userShell } from "../../src/runtime/shell.ts";

/**
 * A hermetic stand-in for the user's login shell. It enforces the same
 * `-l -i -c <command>` contract the agent PTY uses, then runs the command with
 * PATH limited to `bin`, so rc files on the developer machine cannot leak the
 * real `claude`/`codex` installs into the "neither present" case.
 */
function stubShell(bin: string): {
  readonly shell: string;
  readonly install: (agent: CliAgent) => void;
} {
  const root = mkdtempSync(join(tmpdir(), "elwood-agent-detect-"));
  const shell = join(root, "login-shell");
  writeFileSync(
    shell,
    `#!/bin/sh\n[ "$1 $2 $3" = "-l -i -c" ] || exit 99\nPATH='${bin}' exec /bin/sh -c "$4"\n`,
  );
  chmodSync(shell, 0o755);
  return {
    shell,
    install: (agent) => {
      writeFileSync(join(bin, agent), "#!/bin/sh\nexit 0\n");
      chmodSync(join(bin, agent), 0o755);
    },
  };
}

function emptyBin(): string {
  const bin = join(mkdtempSync(join(tmpdir(), "elwood-agent-bin-")), "bin");
  mkdirSync(bin);
  return bin;
}

describe("agent auto-detection", () => {
  afterEach(() => {
    resetRuntimeSeamsForTests();
  });

  test("C-CLI-21 detection order is claude then codex", () => {
    expect(agentDetectionOrder).toEqual(["claude", "codex"]);
  });

  test("C-CLI-21 resolves only executables placed on the probe shell's PATH", async () => {
    const bin = emptyBin();
    const stub = stubShell(bin);
    stub.install("claude");
    await expect(loginShellResolves("claude", stub.shell)).resolves.toBe(true);
    await expect(loginShellResolves("codex", stub.shell)).resolves.toBe(false);
  });

  test("C-CLI-21 picks claude before codex when both resolve", async () => {
    const bin = emptyBin();
    const stub = stubShell(bin);
    stub.install("claude");
    stub.install("codex");
    await expect(
      detectAvailableAgent((agent) => loginShellResolves(agent, stub.shell)),
    ).resolves.toBe("claude");
  });

  test("C-CLI-21 falls through to codex when only codex resolves", async () => {
    const bin = emptyBin();
    const stub = stubShell(bin);
    stub.install("codex");
    await expect(
      detectAvailableAgent((agent) => loginShellResolves(agent, stub.shell)),
    ).resolves.toBe("codex");
  });

  test("C-CLI-21 fails with an actionable no_agent_found when neither resolves", async () => {
    const stub = stubShell(emptyBin());
    const failure = detectAvailableAgent((agent) => loginShellResolves(agent, stub.shell));
    await expect(failure).rejects.toMatchObject({
      name: "CliValidationError",
      code: "no_agent_found",
      message: noAgentFoundMessage,
    });
    for (const needle of ["`claude`", "`codex`", "--agent", "ELWOOD_AGENT", "config set agent"])
      expect(noAgentFoundMessage).toContain(needle);
  });

  test("C-CLI-21 the default probe asks the user's login shell with command -v only", async () => {
    const calls: { readonly command: string; readonly args: readonly string[] }[] = [];
    setCommandRunnerForTests((command, args) => {
      calls.push({ command, args });
      return { status: args.at(-1) === "command -v 'codex'" ? 0 : 1, stdout: "", stderr: "" };
    });
    await expect(detectAvailableAgent()).resolves.toBe("codex");
    expect(calls).toEqual([
      { command: userShell(), args: ["-l", "-i", "-c", "command -v 'claude'"] },
      { command: userShell(), args: ["-l", "-i", "-c", "command -v 'codex'"] },
    ]);
  });

  test("C-CLI-21 both agents are probed concurrently, then chosen in detection order", async () => {
    let inFlight = 0;
    let peak = 0;
    const probe = (agent: CliAgent) =>
      new Promise<boolean>((resolve) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        setTimeout(
          () => {
            inFlight -= 1;
            resolve(true);
          },
          agent === "claude" ? 20 : 1,
        );
      });
    await expect(detectAvailableAgent(probe)).resolves.toBe("claude");
    expect(peak).toBe(2);
  });

  test("C-CLI-21 a probe that cannot run names the shell and errno instead of no agent", async () => {
    const stub = stubShell(emptyBin());
    const missingShell = `${stub.shell}-missing`;
    const error = await detectAvailableAgent((agent) =>
      loginShellResolves(agent, missingShell),
    ).then(
      () => undefined,
      (failure: unknown) => failure as Error & { readonly code: string },
    );
    expect(error).toMatchObject({ name: "CliValidationError", code: "no_agent_found" });
    for (const needle of [
      "probe itself failed",
      JSON.stringify(missingShell),
      "failed with ENOENT",
    ])
      expect(error?.message).toContain(needle);
    expect(error?.message).toContain("--agent");
    expect(error?.message).not.toContain("neither");
  });

  test("C-CLI-21 a code-less probe failure still names the default login shell", async () => {
    setCommandRunnerForTests(() => ({
      status: null,
      stdout: "",
      stderr: "",
      error: { message: "probe timed out" },
    }));
    await expect(detectAvailableAgent()).rejects.toMatchObject({
      code: "no_agent_found",
      message: expect.stringContaining(`login shell ${JSON.stringify(userShell())} did not run`),
    });
  });
});
