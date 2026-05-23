/**
 * node-pty-backed real PTY implementation.
 * Implements PRD §4.1.
 */

import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { spawn } from "node-pty";
import type { TerminalSize } from "../core/types.ts";
import type { PtyFactory, PtyProcess, PtySpawnOptions } from "./types.ts";

const require = createRequire(import.meta.url);

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
      const disposable = pty.onExit((event) => handler(event));
      return () => disposable.dispose();
    },
    write(data) {
      pty.write(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    },
    resize(size: TerminalSize) {
      pty.resize(size.cols, size.rows);
    },
    kill(signal = "SIGTERM") {
      pty.kill(signal);
    },
  };
};

export function nodePtySpawnHelperPath(): string {
  return join(
    dirname(require.resolve("node-pty/package.json")),
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  );
}

export function ensureNodePtySpawnHelperExecutable(path = nodePtySpawnHelperPath()): void {
  if (!existsSync(path)) return;
  const mode = statSync(path).mode;
  chmodSync(path, mode | 0o755);
}
