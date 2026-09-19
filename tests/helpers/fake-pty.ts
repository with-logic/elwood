/**
 * Fake PTY shared by the Claude and Codex adapter suites (PRD §13 test seams). Records
 * writes, resizes, and kill signals; replays data/exit into the session; and can
 * dispatch a hook request straight at the session's bridge socket the way the real
 * `hook-bridge.mjs` child would. Also owns the scratch-directory registry both suites
 * use for per-test cwd/stateDir roots, so an `afterEach` can remove them.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import type { TerminalSize } from "../../src/index.ts";
import type { PtyExit, PtyProcess, PtySpawnOptions } from "../../src/pty/types.ts";
import { realTmpRoot } from "./real-tmp.ts";

export type BridgeReply = { exitCode: number; stdout: string; stderr: string };

let anonymousPid = 1000;

export class FakePty implements PtyProcess {
  readonly pid: number;
  readonly writes: string[] = [];
  readonly killSignals: string[] = [];
  readonly dataHandlers: ((data: string) => void)[] = [];
  readonly exitHandlers: ((exit: PtyExit) => void)[] = [];
  readonly options: PtySpawnOptions;
  size: TerminalSize;
  resizeResult: "resized" | "closed" = "resized";
  /** When set, `resize()` throws it — models a raw node-pty failure (EIO etc.). */
  resizeError: Error | undefined;
  failOnWrite: string | undefined;

  /** Adapter helpers pass `1000 + registry.length`; ad-hoc factories get a fresh pid. */
  constructor(options: PtySpawnOptions, pid: number = anonymousPid++) {
    this.options = options;
    this.size = options.size;
    this.pid = pid;
  }

  onData(handler: (data: string) => void) {
    this.dataHandlers.push(handler);
    return () => {};
  }

  onExit(handler: (exit: PtyExit) => void) {
    this.exitHandlers.push(handler);
    return () => {};
  }

  write(data: string | Uint8Array): void {
    if (data === this.failOnWrite) throw new Error("terminal disposed");
    this.writes.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
  }

  resize(size: TerminalSize): "resized" | "closed" {
    if (this.resizeError !== undefined) throw this.resizeError;
    if (this.resizeResult === "closed") return "closed";
    this.size = size;
    return "resized";
  }

  kill(signal = "SIGTERM"): void {
    this.killSignals.push(signal);
    this.emitExit({ exitCode: 0 });
  }

  emitData(data: string): void {
    for (const handler of this.dataHandlers) handler(data);
  }

  emitExit(exit: PtyExit): void {
    for (const handler of this.exitHandlers) handler(exit);
  }

  async dispatchHook(
    elwoodSessionId: string,
    input: Record<string, unknown>,
    stateDir?: string,
  ): Promise<BridgeReply> {
    const { socketPath, token } = this.readBridge(elwoodSessionId, stateDir);
    return await dispatchRaw(
      socketPath,
      JSON.stringify({ token, elwoodSessionId, input: JSON.stringify(input) }),
    );
  }

  async dispatchMalformedHook(elwoodSessionId: string, stateDir?: string): Promise<BridgeReply> {
    const { socketPath, token } = this.readBridge(elwoodSessionId, stateDir);
    return await dispatchRaw(
      socketPath,
      JSON.stringify({ token, elwoodSessionId, input: "not-json" }),
    );
  }

  private readBridge(elwoodSessionId: string, stateDir?: string) {
    const dir = join(stateDir ?? join(this.options.cwd, ".elwood"), "sessions", elwoodSessionId);
    return readBridgeScript(join(dir, "hook-bridge.mjs"));
  }
}

/** The socket path and auth token the generated bridge script embeds. */
export function readBridgeScript(scriptPath: string): { socketPath: string; token: string } {
  const script = readFileSync(scriptPath, "utf8");
  return {
    socketPath: /const socketPath = "([^"]+)"/.exec(script)![1]!,
    token: /const token = "([^"]+)"/.exec(script)![1]!,
  };
}

/** Sends one framed bridge request and resolves with the server's JSON reply. */
export function dispatchRaw(socketPath: string, payload: string): Promise<BridgeReply> {
  return new Promise<BridgeReply>((resolve) => {
    const client = createConnection({ path: socketPath });
    let response = "";
    client.on("data", (chunk) => {
      response += chunk.toString("utf8");
    });
    client.on("end", () => resolve(JSON.parse(response)));
    client.on("connect", () => {
      client.write(`${payload}\n`);
    });
  });
}

export type ScratchRegistry = {
  /** A fresh scratch directory under `os.tmpdir()`, remembered for `removeAll()`. */
  make(): string;
  /** Removes every directory `make()` handed out so far (best effort, idempotent). */
  removeAll(): void;
};

/**
 * Scratch directories for test cwd/stateDir roots. The prefix must NOT start with the
 * `elwood-` socket-home prefix (`src/state/socket-home.ts`): socket-leak checks and
 * the long-stateDir e2e enumerate `elwood-<16hex>` homes under tmpdir, and a scratch
 * dir sharing that prefix would read as a leaked home.
 *
 * Rooted at `realTmpRoot`, never a live `os.tmpdir()`: a sibling file redirecting
 * `TMPDIR` in the shared fork would otherwise capture these dirs and delete them.
 */
export function createScratchRegistry(prefix: string): ScratchRegistry {
  if (prefix.startsWith("elwood-")) throw new Error("scratch prefix collides with socket homes");
  const made: string[] = [];
  return {
    make: () => {
      const path = mkdtempSync(join(realTmpRoot, prefix));
      made.push(path);
      return path;
    },
    removeAll: () => {
      for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
    },
  };
}
