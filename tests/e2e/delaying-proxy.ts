/**
 * A local HTTPS `CONNECT` proxy that holds every tunnel for a fixed time before opening it,
 * standing in for a slow network in front of a real CLI. Supports C-E2E-34.
 */
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";

export type DelayingProxy = {
  /** Proxy variables for a launch; `NO_PROXY` is cleared so every host goes through. */
  readonly env: Readonly<Record<string, string>>;
  /** Tunnels requested so far: proof that the CLI used the proxy. */
  readonly tunnels: () => number;
  /** Stops listening and drops every held and open tunnel. */
  close(): Promise<void>;
};

export async function startDelayingProxy(holdMs: number): Promise<DelayingProxy> {
  const sockets = new Set<Socket>();
  const holds = new Set<ReturnType<typeof setTimeout>>();
  let tunnels = 0;
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    return socket;
  };
  const server = createServer((_request, response) => {
    response.writeHead(405).end();
  });
  server.on("connect", (request, client: Socket, head: Buffer) => {
    tunnels += 1;
    track(client);
    const [host = "", port = "443"] = String(request.url).split(":");
    const hold = setTimeout(() => {
      holds.delete(hold);
      if (client.destroyed) return;
      const upstream = track(
        connect(Number(port), host, () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
        }),
      );
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
    tunnels: () => tunnels,
    async close() {
      for (const hold of holds) clearTimeout(hold);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
