/** A probe's group owner stays alive until captured heirs drain or abort (PRD §9.2, C-PERF-03). */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { ProbeChild } from "./capture.ts";

/** Private supervisor descriptor, never inherited by the user's login shell or command. */
const statusFd = 4;
const statusPrefix = "elwood-probe-command-exit:";
const supervisor =
  'if "$@" 4>&- </dev/null; then elwood_status=0; else elwood_status=$?; fi; ' +
  `printf '${statusPrefix}%s\\n' "$elwood_status" >&${statusFd}; ` +
  'IFS= read -r elwood_ack; exit "$elwood_status"';

export class ProbeProcess {
  readonly child;
  readonly output: ProbeChild;
  private readonly exits = new EventEmitter();
  private exited = false;

  constructor(command: string, args: readonly string[], supervised: boolean) {
    this.child = spawn(
      supervised ? "/bin/sh" : command,
      supervised
        ? ["-p", "-c", supervisor, "elwood-probe-supervisor", command, ...args]
        : [...args],
      {
        detached: true,
        stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
      },
    );
    const { child } = this;
    // Native kill fallback can emit after the runner detaches; retain no result closure.
    child.on("error", discardLateChildError);
    this.output = {
      stdout: child.stdout,
      stderr: child.stderr,
      once: (event, listener) => this.exits.once(event, listener),
    };
    if (supervised) {
      const status = createInterface({ input: child.stdio[statusFd] as Readable });
      status.once("line", (line) => this.exit(Number(line.slice(statusPrefix.length)), null));
    }
    child.once(supervised ? "exit" : "close", (code, signal) => this.exit(code, signal));
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exits.once("exit", listener);
  }

  /** Drop runner/capture callbacks and private channels before a retained reaper takes over. */
  detach(): void {
    this.exits.removeAllListeners();
    (this.child.stdio[3] as Readable).destroy();
    (this.child.stdio[4] as Readable).destroy();
  }

  /** A normal completion lets the owner exit; abort instead kills its still-owned group. */
  release(): void {
    this.child.stdin.end("done\n");
  }

  private exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exits.emit("exit", code, signal);
  }
}

/** The active runner observes errors too; after delivery only liveness cleanup remains. */
function discardLateChildError(): void {
  // Keep a native kill error contained even after its result listeners were detached.
}
