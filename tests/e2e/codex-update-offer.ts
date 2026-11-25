/**
 * Forces Codex's own in-TUI update offer in a private `CODEX_HOME`, and lets only the
 * offer's `Skip` digit reach it (PRD §5.3, §5.5, §12, C-API-28, C-CODEX-27, C-E2E-26,
 * C-E2E-27). The offer's default choice is "Update now", which runs a global installer on
 * the host, so a test that opens a session on the offer must be able to prove what reached
 * the CLI, and must never let an Enter through. docs/cli-behavior.md, "Codex 0.171.0
 * update offer".
 */

import { constants, cpSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { compareVersions, parseVersion } from "../../src/core/versions.ts";
import { nodePtyFactory } from "../../src/pty/node.ts";
import { runProbe } from "../../src/runtime/probe/index.ts";
import {
  currentCommandRunner,
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPtyFactoryForTests,
} from "../../src/runtime/seams.ts";
import { probeShellCommand, shellQuote, userShell } from "../../src/runtime/shell.ts";
import { userCodexAuthPath } from "./codex-home.ts";
import { writeCodexUpdateCheck } from "./codex-update-check.ts";
import { prefixShellArgument } from "./prefix-shell-argument.ts";
import { isTerminalProtocolReply } from "./terminal-protocol-reply.ts";

/** A release no installed Codex has reached, so the offer does not depend on what is current. */
const offeredCodexVersion = "99.0.0";

/**
 * The first release seen drawing the offer layout these proofs cover. Earlier ones draw
 * Codex 0.155's layout, which C-CODEX-12 covers with captures.
 */
const offerLayoutCodexVersion = "0.171.0";

/** One application write that was kept from the CLI, with the screen it was aimed at. */
export type RefusedInput = { readonly data: string; readonly screen: string };

export type CodexUpdateOffer = {
  /** Application writes refused since `arm`, in order. Terminal protocol replies are not input. */
  readonly refused: readonly RefusedInput[];
  /** Each `Skip` digit written while the offer was on screen, in order. */
  readonly skips: readonly string[];
  /**
   * Why the Codex that sessions in `cwd` run cannot take part, or undefined. It runs
   * through the same pin as the sessions, since the install can differ per directory.
   */
  unsupported(cwd: string): Promise<string | undefined>;
  /**
   * Makes the next Codex started from the home open on its update offer. From now on,
   * while the offer is on screen only its `Skip` digit is written, and before that digit
   * no application input is. Anything else is recorded and dropped.
   */
  arm(): void;
  /** Names the screen each write meets. Until it is set, that screen is "". */
  watch(screen: () => string): void;
  /** Restores the real PTY factory and command runner. */
  dispose(): void;
};

/** The digit of the offer's plain `Skip` row, or undefined while no `N. Update now` row shows. */
export function offerSkipDigit(screen: string): string | undefined {
  if (!/^\s*›?\s*\d+\. Update now\b/m.test(screen)) return undefined;
  return /^\s*›?\s*(\d+)\. Skip\s*$/m.exec(screen)?.[1];
}

/** Each refused write with the marked rows of the screen it met, to show on failure. */
export function refusedAtMarkedRows(refused: readonly RefusedInput[]) {
  return refused.map(({ data, screen }) => ({
    data,
    marked: screen.split("\n").filter((row) => /^\s*›/.test(row)),
  }));
}

/**
 * A standalone Codex offers an update only from its home's own managed release, and the
 * login shell may resolve a different install per directory. When the user has a
 * standalone install, `home` gets a copy-on-write clone of its current release. Returns
 * the shell prefix that runs that clone, or undefined without a standalone install; the
 * shell's own Codex then runs, and an npm install offers its update unaided.
 */
function cloneManagedRelease(home: string): string | undefined {
  const current = join(dirname(userCodexAuthPath), "packages", "standalone", "current");
  if (!existsSync(join(current, "bin", "codex"))) return undefined;
  const release = realpathSync(current);
  const clone = join(home, "packages", "standalone", "releases", basename(release));
  mkdirSync(dirname(clone), { recursive: true, mode: 0o700 });
  cpSync(release, clone, {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  });
  return `export PATH=${shellQuote(join(clone, "bin"))}:"$PATH"`;
}

/**
 * Wraps every PTY and probe started from now on so that Codex can offer an update from
 * `home`. Input is forwarded until `arm`; after it, the input guard in `arm` applies.
 */
export function codexUpdateOffer(home: string): CodexUpdateOffer {
  const pin = cloneManagedRelease(home);
  const pinned = (args: readonly string[]) => (pin ? prefixShellArgument(args, pin) : [...args]);
  const refused: RefusedInput[] = [];
  const skips: string[] = [];
  let screen = () => "";
  let armed = false;
  /** The input guard: forward, or record and drop, one application write. */
  const admit = (input: string): boolean => {
    const current = screen();
    const skip = offerSkipDigit(current);
    if (skip === undefined ? skips.length > 0 : input === skip) {
      if (skip !== undefined) skips.push(input);
      return true;
    }
    refused.push({ data: input, screen: current });
    return false;
  };
  setCommandRunnerForTests((command, args, options) => runProbe(command, pinned(args), options));
  setPtyFactoryForTests((options) => {
    const pty = nodePtyFactory({ ...options, args: pinned(options.args) });
    return {
      ...pty,
      write(data) {
        const input = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
        if (!armed || isTerminalProtocolReply(input) || admit(input)) pty.write(data);
      },
    };
  });
  return {
    refused,
    skips,
    async unsupported(cwd) {
      const probe = probeShellCommand("codex --version", "codex");
      const result = await currentCommandRunner()(userShell(), probe, { cwd });
      const version = result.status === 0 ? parseVersion(result.stdout) : null;
      if (version === null) throw new Error("Codex did not report its version");
      return compareVersions(version, offerLayoutCodexVersion) < 0
        ? `The update offer proof needs Codex ${offerLayoutCodexVersion} or newer; ${version} runs`
        : undefined;
    },
    arm() {
      writeCodexUpdateCheck(home, offeredCodexVersion);
      armed = true;
    },
    watch(read) {
      screen = read;
    },
    dispose: resetRuntimeSeamsForTests,
  };
}
