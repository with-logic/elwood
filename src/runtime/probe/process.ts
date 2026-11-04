/** Own a probe’s group until command output drains or abort kills it (PRD §9.2, C-PERF-03/05). */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { createInterface } from "node:readline";
import { setImmediate } from "node:timers";
import type { CommandOptions } from "../seams.ts";
import type { ProbeChild } from "./capture.ts";

const statusFd = 4;
const acknowledgementFd = 5;
const statusPrefix = "elwood-probe-command-exit:";
const supervisor =
  'if "$@" 4>&- 5>&- </dev/null; then elwood_status=0; else elwood_status=$?; fi; ' +
  `printf '${statusPrefix}%s\\n' "$elwood_status" >&${statusFd}; ` +
  `IFS= read -r elwood_ack <&${acknowledgementFd}; exit "$elwood_status"`;

export class ProbeProcess {
  readonly child;
  readonly output: ProbeChild;
  private readonly exits = new EventEmitter();
  private exited = false;
  private readonly supervised: boolean;

  constructor(
    command: string,
    args: readonly string[],
    supervised: boolean,
    options: CommandOptions,
  ) {
    this.supervised = supervised;
    this.child = spawn(
      supervised ? "/bin/sh" : command,
      supervised
        ? ["-p", "-c", supervisor, "elwood-probe-supervisor", command, ...args]
        : [...args],
      {
        cwd: options.cwd,
        detached: true,
        stdio: supervised
          ? ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"]
          : ["pipe", "pipe", "pipe", "pipe"],
      },
    );
    const { child } = this;
    child.on("error", discardLateChildError);
    this.output = {
      stdout: child.stdout,
      stderr: child.stderr,
      once: (event, listener) => this.exits.once(event, listener),
    };
    if (supervised) {
      const statusPipe = child.stdio[statusFd] as Socket;
      const acknowledgement = child.stdio.at(acknowledgementFd) as Socket;
      // Abort may close the peer before release writes its acknowledgement.
      acknowledgement.on("error", discardLateChildError);
      const status = createInterface({ input: statusPipe });
      // Let already-written control data reach the start-line observer before classifying exit.
      status.once("line", (line) =>
        setImmediate(() => this.exit(Number(line.slice(statusPrefix.length)), null)),
      );
      child.once("exit", () => {
        statusPipe.destroy();
        acknowledgement.destroy();
      });
    }
    child.once(supervised ? "exit" : "close", (code, signal) => this.exit(code, signal));
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exits.once("exit", listener);
  }

  /** Stop shell draining; private protocol pipes stay open so abort cannot release the owner. */
  detach(): void {
    this.exits.removeAllListeners();
    this.child.stdout.destroy();
    this.child.stderr.destroy();

    (this.child.stdio[3] as Socket).destroy();
    if (this.supervised) {
      (this.child.stdio[statusFd] as Socket).unref();
      (this.child.stdio.at(acknowledgementFd) as Socket).unref();
    }
  }

  release(): void {
    if (this.supervised) (this.child.stdio.at(acknowledgementFd) as Socket).end("done\n");
  }

  private exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exits.emit("exit", code, signal);
  }
}

/** Native fallback errors can arrive after the result callbacks have detached. */
function discardLateChildError(): void {
  // Result callbacks have detached; bounded cleanup retains only process liveness.
}
