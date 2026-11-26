/**
 * Forces Codex's own in-TUI update offer in a private `CODEX_HOME`, and lets only the
 * offer's `Skip` digit reach it (PRD §5.3, §5.5, §5.13, §12, C-API-28, C-CODEX-27,
 * C-E2E-26, C-E2E-27, C-E2E-30). The offer's default choice is "Update now", which runs a global installer on
 * the host, so a test that opens a session on the offer must be able to prove what reached
 * the CLI, and must never let an Enter through. Each write is judged against the CLI's own
 * screen, drawn from its output by a terminal of the harness, never against Elwood's
 * rendering of it. docs/cli-behavior.md, "Codex 0.171.0 update offer".
 */

import { constants, cpSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { compareVersions, parseVersion } from "../../../src/core/versions.ts";
import { nodePtyFactory } from "../../../src/pty/node.ts";
import { runProbe } from "../../../src/runtime/probe/index.ts";
import {
  currentCommandRunner,
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPtyFactoryForTests,
} from "../../../src/runtime/seams.ts";
import { probeShellCommand, shellQuote, userShell } from "../../../src/runtime/shell.ts";
import { userCodexAuthPath } from "../codex-home.ts";
import { writeCodexUpdateCheck } from "../codex-update-check.ts";
import { heldOutputView } from "../output-hold.ts";
import { prefixShellArgument } from "../prefix-shell-argument.ts";
import { isTerminalProtocolReply } from "../terminal-protocol-reply.ts";
import {
  configuredComposerShown,
  offerSkipDigit,
  type RefusedInput,
  screenMirror,
} from "./screen.ts";

/** A release no installed Codex has reached, so the offer does not depend on what is current. */
const offeredCodexVersion = "99.0.0";

/**
 * The first release seen drawing the offer layout these proofs cover. Earlier ones draw
 * Codex 0.155's layout, which C-CODEX-12 covers with captures.
 */
const minimumOfferProofCodexVersion = "0.171.0";

export type CodexUpdateOffer = {
  /** Application writes refused since `arm`, in order. Terminal protocol replies are not input. */
  readonly refused: readonly RefusedInput[];
  /** Errors from admitted writes to a CLI that had not exited. */
  readonly writeErrors: readonly unknown[];
  /** Each `Skip` digit written while the offer was on screen, in order. */
  readonly skips: readonly string[];
  /** Each `Skip` digit kept from the offer by `withholdSkips`, in order. */
  readonly withheld: readonly string[];
  /**
   * Why the Codex that sessions in `cwd` run cannot take part, or undefined. It runs
   * through the same pin as the sessions, since the install can differ per directory.
   */
  unsupported(cwd: string): Promise<string | undefined>;
  /**
   * Makes the next Codex started from the home open on its update offer. From now on,
   * while the offer is on screen only its `Skip` digit is written. Before that digit no
   * application input is, and after it none is until Codex shows its configured composer;
   * a lone digit off the offer never is. Anything else is recorded and dropped.
   */
  arm(): void;
  /** Restores the real PTY factory and command runner. */
  dispose(): void;
};

export type CodexUpdateOfferOptions = {
  /** Once a `Skip` digit is written, Elwood reads the CLI's output this much later. */
  readonly lagAfterSkipMs?: number;
  /** While true, a `Skip` digit never reaches the offer, as when Codex drops a key. */
  readonly withholdSkips?: () => boolean;
};

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
 * `home`. Input is forwarded until `arm`; after it, `admit` applies the guard that
 * `CodexUpdateOffer.arm` describes.
 */
export function codexUpdateOffer(
  home: string,
  { lagAfterSkipMs = 0, withholdSkips = () => false }: CodexUpdateOfferOptions = {},
): CodexUpdateOffer {
  const pin = cloneManagedRelease(home);
  const pinned = (args: readonly string[]) => (pin ? prefixShellArgument(args, pin) : [...args]);
  const refused: RefusedInput[] = [];
  const writeErrors: unknown[] = [];
  const skips: string[] = [];
  const withheld: string[] = [];
  const mirrors: ReturnType<typeof screenMirror>[] = [];
  let armed = false;
  setCommandRunnerForTests((command, args, options) => runProbe(command, pinned(args), options));
  setPtyFactoryForTests((options) => {
    const pty = nodePtyFactory({ ...options, args: pinned(options.args) });
    const mirror = screenMirror(options.size);
    mirrors.push(mirror);
    const view = heldOutputView(pty);
    let exited = false;
    pty.onExit(() => {
      exited = true;
    });
    let configuredComposerSeen = false;
    let writeQueue = Promise.resolve();
    /** The input guard: forward, or record and drop, one application write. */
    const admit = (input: string, screen: string): boolean => {
      const skip = offerSkipDigit(screen);
      configuredComposerSeen ||=
        skips.length > 0 && skip === undefined && configuredComposerShown(screen);
      const admitted =
        skip === undefined ? configuredComposerSeen && !/^\d$/.test(input) : input === skip;
      if (admitted && skip !== undefined) skips.push(input);
      if (!admitted) refused.push({ data: input, screen });
      return admitted;
    };
    // The mirror draws each chunk before Elwood can see it, so a write is never judged
    // against a screen older than the one Elwood wrote it on.
    pty.onData((data) => {
      mirror.draw(data);
      view.receive(data);
    });
    return {
      ...view.pty,
      resize(size) {
        mirror.resize(size);
        return pty.resize(size);
      },
      write(data) {
        if (!armed) return pty.write(data);
        const input = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
        // Judged once the CLI's screen shows all it drew before this write was made.
        const pendingScreen = mirror.read();
        writeQueue = writeQueue.then(async () => {
          const firstSkip = skips.length === 0;
          const screen = await pendingScreen;
          if (withholdSkips() && input === offerSkipDigit(screen)) {
            withheld.push(input);
            return;
          }
          if (!(isTerminalProtocolReply(input) || admit(input, screen))) return;
          try {
            pty.write(data);
          } catch (error) {
            // A CLI that has exited takes no input, and Elwood sees it exit.
            if (!exited) writeErrors.push(error);
            return;
          }
          if (firstSkip && skips.length === 1 && lagAfterSkipMs > 0)
            view.output.hold(lagAfterSkipMs);
        });
      },
    };
  });
  return {
    refused,
    writeErrors,
    skips,
    withheld,
    async unsupported(cwd) {
      const probe = probeShellCommand("codex --version", "codex");
      const result = await currentCommandRunner()(userShell(), probe, { cwd });
      const version = result.status === 0 ? parseVersion(result.stdout) : null;
      if (version === null) throw new Error("Codex did not report its version");
      return compareVersions(version, minimumOfferProofCodexVersion) < 0
        ? `The update offer proof needs Codex ${minimumOfferProofCodexVersion} or newer; ${version} runs`
        : undefined;
    },
    arm() {
      writeCodexUpdateCheck(home, offeredCodexVersion);
      armed = true;
    },
    dispose() {
      for (const mirror of mirrors) mirror.dispose();
      resetRuntimeSeamsForTests();
    },
  };
}
