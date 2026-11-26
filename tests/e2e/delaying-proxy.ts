/**
 * A local HTTPS `CONNECT` proxy that holds every tunnel for a fixed time before opening it,
 * standing in for a slow network in front of a real CLI. Supports C-E2E-34.
 */
import { createServer } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";

export type DelayingProxy = {
  /** Proxy variables for a launch; `NO_PROXY` is cleared so every host goes through. */
  readonly env: Readonly<Record<string, string>>;
  /** Tunnels opened to their hosts so far: proof that the CLI went through the proxy. */
  readonly openedTunnelCount: () => number;
  /** Why tunnels failed to reach their hosts, for a failure message: empty when none did. */
  readonly failures: () => readonly string[];
  /** Stops listening and drops every held and open tunnel. */
  close(): Promise<void>;
};

export async function startDelayingProxy(holdMs: number): Promise<DelayingProxy> {
  const sockets = new Set<Duplex>();
  const holds = new Set<ReturnType<typeof setTimeout>>();
  const failures: string[] = [];
  let opened = 0;
  const track = <T extends Duplex>(socket: T): T => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    return socket;
  };
  const server = createServer((_request, response) => {
    response.writeHead(405).end();
  });
  server.on("connect", (request, client, head) => {
    track(client);
    const target = String(request.url);
    const [host = "", port = "443"] = target.split(":");
    const hold = setTimeout(() => {
      holds.delete(hold);
      if (client.destroyed) return;
      const upstream = track(
        connect(Number(port), host, () => {
          opened += 1;
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
        }),
      );
      upstream.once("error", (error) => failures.push(`${target}: ${error.message}`));
      upstream.once("close", () => client.destroy());
      client.once("close", () => upstream.destroy());
    }, holdMs);
    holds.add(hold);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Proxy has no TCP port");
  const url = `http://127.0.0.1:${address.port}`;
  return {
    env: {
      HTTPS_PROXY: url,
      https_proxy: url,
      HTTP_PROXY: url,
      http_proxy: url,
      NO_PROXY: "",
      no_proxy: "",
    },
    openedTunnelCount: () => opened,
    failures: () => [...failures],
    async close() {
      for (const hold of holds) clearTimeout(hold);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
