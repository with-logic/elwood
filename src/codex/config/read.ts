/**
 * Reads a Codex config.toml without letting the file stall or flood Elwood. The file can sit
 * in a project-local `CODEX_HOME` that the agent itself may rewrite, so it can become a FIFO
 * (a blocking read waits for a writer and freezes every session in the process) or grow
 * without bound. Implements PRD §5.3 and C-CODEX-25.
 */

import { closeSync, constants, fstatSync, openSync, readSync, type Stats, statSync } from "node:fs";
import { errnoCode } from "../../core/errors.ts";

/** The largest config.toml Elwood reads (C-CODEX-25). */
export const maxCodexConfigBytes = 1024 * 1024;

type ConfigFileCode = "EISDIR" | "EFTYPE" | "EFBIG";

/**
 * The text of the config.toml at `path`, or `undefined` when there is none. Anything else
 * that is not a regular file of at most `maxCodexConfigBytes` throws an errno-coded error:
 * `EISDIR` for a directory, `EFTYPE` for any other kind of file (a FIFO, socket, or device),
 * `EFBIG` past the limit, and an open or read failure's own code.
 */
export function readCodexConfigFile(path: string): string | undefined {
  let fd: number;
  try {
    // O_NONBLOCK: opening a FIFO read-only would otherwise wait for a writer.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    // macOS will not open a Unix socket at all, failing with an errno Node cannot name
    // (EOPNOTSUPP, "Unknown system error -102"). A target that cannot be opened is
    // classified as it would be once open; any other failure keeps its own code.
    throw notRegularFile(statOrUndefined(path), path) ?? error;
  }
  try {
    const rejected = notRegularFile(fstatSync(fd), path);
    if (rejected !== undefined) throw rejected;
    return readSizeChecked(fd, path);
  } finally {
    closeSync(fd);
  }
}

function statOrUndefined(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function notRegularFile(stat: Stats | undefined, path: string): Error | undefined {
  if (stat === undefined || stat.isFile()) return undefined;
  return fileError(stat.isDirectory() ? "EISDIR" : "EFTYPE", path);
}

/**
 * Reads the descriptor to end of file, failing with `EFBIG` once it holds more than the
 * limit. It reads at most one byte past the limit: that byte is how a file over the limit
 * is told apart from one exactly at it.
 */
function readSizeChecked(fd: number, path: string): string {
  const buffer = Buffer.alloc(maxCodexConfigBytes + 1);
  let length = 0;
  for (;;) {
    const read = readSync(fd, buffer, length, buffer.length - length, null);
    if (read === 0) return buffer.toString("utf8", 0, length);
    length += read;
    if (length > maxCodexConfigBytes) throw fileError("EFBIG", path);
  }
}

function fileError(code: ConfigFileCode, path: string): NodeJS.ErrnoException {
  const reason =
    code === "EFBIG" ? `is larger than ${maxCodexConfigBytes} bytes` : "is not a regular file";
  return Object.assign(new Error(`${code}: Codex config ${reason}: ${path}`), { code, path });
}
