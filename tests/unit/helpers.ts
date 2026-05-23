import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempDirForUnit(): string {
  return mkdtempSync(join(tmpdir(), "elwood-unit-"));
}

export async function sendBridge(socketPath: string, payload: string): Promise<string> {
  const net = await import("node:net");
  return await new Promise<string>((resolve) => {
    const client = net.createConnection({ path: socketPath });
    let data = "";
    client.on("data", (chunk) => {
      data += chunk.toString("utf8");
    });
    client.on("end", () => resolve(data));
    client.on("connect", () => client.write(payload));
  });
}
