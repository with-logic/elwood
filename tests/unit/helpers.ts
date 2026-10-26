/**
 * Shared unit-test helpers: temp dirs, a sandboxed `CODEX_HOME` for the Codex config
 * tests (PRD §5.3, C-API-23, C-CODEX-14), and raw bridge-socket clients for the bridge
 * request-framing tests (PRD §6).
 */

import { writeFileSync } from "node:fs";
import { useCodexHome } from "../helpers/codex-home.ts";
import { tempDir } from "../helpers/tmp.ts";

export { restoreCodexHome } from "../helpers/codex-home.ts";

/** A fresh temp dir, removed (recursively) when the calling test finishes. */
export function tempDirForUnit(): string {
  return tempDir("elwood-unit-");
}

/**
 * Points `CODEX_HOME` at a fresh temp dir and returns its `config.toml` path, writing
 * `contents` there when given. Pair with `restoreCodexHome` in `afterEach`.
 */
export function tempCodexHome(contents?: string): string {
  const path = useCodexHome(tempDirForUnit());
  if (contents !== undefined) writeFileSync(path, contents);
  return path;
}

export function sendBridge(socketPath: string, payload: string): Promise<string> {
  return sendRaw(socketPath, `${payload}\n`);
}

/**
 * Send `payload` VERBATIM (no appended framing) and return the response. Tolerates
 * the server destroying the socket mid-write (EPIPE) — used for exact-cap/over-cap
 * boundary requests where the server closes the connection as it fails open.
 */
export async function sendRaw(socketPath: string, payload: string): Promise<string> {
  const net = await import("node:net");
  return await new Promise<string>((resolve) => {
    const client = net.createConnection({ path: socketPath });
    let data = "";
    client.on("data", (chunk) => {
      data += chunk.toString("utf8");
    });
    client.on("error", () => resolve(data)); // server may destroy mid-write on over-cap
    client.on("end", () => resolve(data));
    client.on("connect", () => client.write(payload));
  });
}
