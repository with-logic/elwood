import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempDirForUnit(): string {
  return mkdtempSync(join(tmpdir(), "elwood-unit-"));
}

export async function sendBridge(socketPath: string, payload: string): Promise<string> {
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
