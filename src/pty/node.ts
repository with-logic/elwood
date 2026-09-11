/**
 * node-pty-backed real PTY implementation.
 * Implements PRD §4.1.
 */

import { chmodSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node-pty";
import { moduleRequire } from "../core/module-require.ts";
import type { TerminalSize } from "../core/types.ts";
import type { PtyFactory, PtyProcess, PtySpawnOptions } from "./types.ts";

const require = moduleRequire(import.meta.url);

export const nodePtyFactory: PtyFactory = (options: PtySpawnOptions): PtyProcess => {
  ensureNodePtySpawnHelperExecutable();
  const pty = spawn(options.command, [...options.args], {
    name: "xterm-256color",
    cols: options.size.cols,
    rows: options.size.rows,
    cwd: options.cwd,
    env: { ...options.env },
  });
  return {
    pid: pty.pid,
    onData(handler) {
      const disposable = pty.onData(handler);
      return () => disposable.dispose();
    },
    onExit(handler) {
      const disposable = pty.onExit(handler);
      return () => disposable.dispose();
    },
    write(data) {
      pty.write(typeof data === "string" ? data : Buffer.from(data));
    },
    resize(size: TerminalSize) {
      try {
        pty.resize(size.cols, size.rows);
        return "resized";
      } catch (error) {
        if (isClosedPtyError(error)) return "closed";
        throw error;
      }
    },
    kill(signal = "SIGTERM") {
      pty.kill(signal);
    },
  };
};

function isClosedPtyError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("EBADF");
}

export function nodePtySpawnHelperPath(): string {
  return join(
    dirname(require.resolve("node-pty/package.json")),
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  );
}

/**
 * Some package managers strip the execute bit from node-pty's prebuilt
 * `spawn-helper`, which makes every PTY spawn fail with EACCES. Restore it only
 * when it is actually missing: an already-executable helper is left untouched
 * (never write into node_modules on every spawn), and a chmod that fails — a
 * root-installed global, a read-only layer, a pnpm content store — is tolerated
 * because node-pty itself reports the real spawn failure if the helper is unusable.
 */
export function ensureNodePtySpawnHelperExecutable(path = nodePtySpawnHelperPath()): void {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    return; // absent helper (not every platform ships one): nothing to repair
  }
  if ((mode & 0o111) !== 0) return;
  try {
    chmodSync(path, mode | 0o755);
  } catch {
    // Best effort: a read-only install cannot be repaired from here.
  }
}
