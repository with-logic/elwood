/**
 * Owned resource cleanup for the browser dev app.
 * Implements PRD §11.
 */

import type { Server } from "node:http";
import type { WebSocket, WebSocketServer } from "ws";
import type { SharedSession } from "./agent-runtime.ts";

export async function closeWebDevResources(input: {
  readonly server: Server;
  readonly wss: WebSocketServer;
  readonly sockets: ReadonlySet<WebSocket>;
  readonly session: SharedSession | null;
}): Promise<void> {
  for (const socket of input.sockets) socket.terminate();
  await Promise.all([
    closeWebSockets(input.wss),
    closeServer(input.server),
    input.session?.kill().catch(() => undefined),
  ]);
}

function closeWebSockets(wss: WebSocketServer): Promise<void> {
  return new Promise((resolve) => wss.close(() => resolve()));
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}
