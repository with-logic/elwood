/**
 * A probe never runs the user's not-found handler: a CLI missing from a real login shell's PATH
 * exits 127, so preflight reports it as not found, and nothing the handler prints reaches the
 * probe's captured output, where `*_start_failed` details and `agent_update_failed.raw` would
 * carry it (PRD §9.2, C-PERF-05). zsh's handler is `command_not_found_handler`,
 * bash's (4.0 and later) `command_not_found_handle`. Private startup files hold each handler,
 * so the developer's own are never read.
 */

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runProbe } from "../../src/runtime/probe/index.ts";
import { probeShellCommand } from "../../src/runtime/shell.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Whether `/bin/bash` has `command_not_found_handle`, which bash 4.0 added. */
function bashHasHandler(): boolean {
  if (!existsSync("/bin/bash")) return false;
  return !/version [0-3]\./.test(execFileSync("/bin/bash", ["--version"], { encoding: "utf8" }));
}

const shells = [
  {
    shell: "/bin/zsh",
    available: existsSync("/bin/zsh"),
    // `.zshrc`: an interactive zsh reads it from ZDOTDIR.
    profile: (dir: string, handler: string) => {
      writeFileSync(join(dir, ".zshrc"), `command_not_found_handler() { ${handler} }\n`);
      vi.stubEnv("ZDOTDIR", dir);
      vi.stubEnv("TERM_PROGRAM", ""); // no /etc/zshrc_Apple_Terminal session hooks
    },
  },
  {
    shell: "/bin/bash",
    available: bashHasHandler(),
    // `.bash_profile`: a login bash reads it from HOME.
    profile: (dir: string, handler: string) => {
      writeFileSync(join(dir, ".bash_profile"), `command_not_found_handle() { ${handler}; }\n`);
      vi.stubEnv("HOME", dir);
    },
  },
] as const;

describe.each(shells)("a real $shell login shell", ({ shell, available, profile }) => {
  describe.skipIf(!available)("whose startup files define a not-found handler", () => {
    test.each([
      127, 1,
    ])("C-PERF-05 returning %i, it neither runs for a missing CLI nor reaches the probe", async (status) => {
      profile(
        tempDir("elwood-not-found-handler-"),
        `echo FAKE-SECRET-out; echo FAKE-SECRET-err >&2; return ${status}`,
      );
      const result = await runProbe(shell, probeShellCommand("elwood-no-such-cli --version"));
      expect(result).toMatchObject({ status: 127, stdout: "" });
      expect(JSON.stringify(result)).not.toContain("FAKE-SECRET");
    }, 60_000);
  });
});
