/**
 * Forces Codex's own in-TUI update offer in a private `CODEX_HOME`, and keeps application
 * input away from it (PRD §5.3, §12, C-API-28, C-E2E-25). The offer's default choice is
 * "Update now", which runs a global installer on the host, so a test that opens a session
 * on the offer must be able to prove that nothing reached the CLI, and must never let an
 * Enter through. docs/cli-behavior.md, "Codex 0.171.0 update offer".
 */

import { constants, cpSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { nodePtyFactory } from "../../src/pty/node.ts";
import { runProbe } from "../../src/runtime/probe/index.ts";
import {
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPtyFactoryForTests,
} from "../../src/runtime/seams.ts";
import { shellQuote } from "../../src/runtime/shell.ts";
import { userCodexAuthPath } from "./codex-home.ts";
import { prefixShellArgument } from "./prefix-shell-argument.ts";

/** A release no installed Codex has reached, so the offer does not depend on what is current. */
export const offeredCodexVersion = "99.0.0";

/** One application write that was kept from the CLI, with the screen it was aimed at. */
export type RefusedInput = { readonly data: string; readonly screen: string };

export type CodexUpdateOffer = {
  /** Application writes refused since `arm`, in order. Terminal protocol replies are not input. */
  readonly refused: readonly RefusedInput[];
  /**
   * Makes the next Codex started from the home open on its update offer, and from now on
   * records and drops application input instead of writing it.
   */
  arm(): void;
  /** Names the screen a refused write met. Until it is set, that screen is "". */
  watch(screen: () => string): void;
  /** Lets exactly `key` through once; everything after that write is forwarded. */
  release(key: string): void;
  /** Restores the real PTY factory and command runner. */
  dispose(): void;
};

/** Cursor-position, device-attribute and mode-report replies to Codex's terminal queries. */
const protocolReply = /^\[(?:\d+;\d+R|\?[\d;]+c|\?[\d;]+\$y|[\d;]*n)$/;
const isProtocolReply = (input: string) =>
  input.startsWith("\u001b") && protocolReply.test(input.slice(1));

/**
 * A standalone Codex offers an update only from its home's own managed release, and the
 * login shell may resolve a different install per directory. When the user has a
 * standalone install, `home` gets a copy-on-write clone of its current release and the
 * returned shell prefix runs that clone. Otherwise the shell's own Codex runs, and an npm
 * or Homebrew install offers its update unaided.
 */
function managedReleasePath(home: string): string | undefined {
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
 * `home`. Input is forwarded until `arm`; after it, application input is refused until
 * `release` names the one key the test sends itself.
 */
export function codexUpdateOffer(home: string): CodexUpdateOffer {
  const pin = managedReleasePath(home);
  const pinned = (args: readonly string[]) => (pin ? prefixShellArgument(args, pin) : [...args]);
  const refused: RefusedInput[] = [];
  let screen = () => "";
  let releaseKey: string | undefined;
  let open = true;
  setCommandRunnerForTests((command, args, options) => runProbe(command, pinned(args), options));
  setPtyFactoryForTests((options) => {
    const pty = nodePtyFactory({ ...options, args: pinned(options.args) });
    return {
      ...pty,
      write(data) {
        const input = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
        if (open || isProtocolReply(input)) return pty.write(data);
        if (input !== releaseKey) {
          refused.push({ data: input, screen: screen() });
          return;
        }
        open = true;
        pty.write(data);
      },
    };
  });
  return {
    refused,
    arm() {
      // Codex offers the `latest_version` its cached check names when that is newer than
      // itself and was read within the last 20 hours.
      writeFileSync(
        join(home, "version.json"),
        JSON.stringify({
          latest_version: offeredCodexVersion,
          last_checked_at: new Date().toISOString(),
          dismissed_version: null,
        }),
      );
      open = false;
    },
    watch(read) {
      screen = read;
    },
    release(key) {
      releaseKey = key;
    },
    dispose: resetRuntimeSeamsForTests,
  };
}
