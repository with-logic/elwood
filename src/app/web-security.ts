/**
 * Local browser dev app connection guards.
 * Implements PRD §11 security constraints for manual tooling.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer } from "ws";

export function createBrowserToken(): string {
  return randomUUID();
}

/**
 * The upgrade guard validates the request host against the port the server is
 * actually bound to. Because the app may bind an ephemeral port (0 → OS-assigned),
 * the port is resolved lazily at upgrade time rather than captured at construction.
 */
export type PortSource = number | (() => number);

export function createGuardedWebSocketServer(
  server: Server,
  token: string,
  port: PortSource,
): WebSocketServer {
  return new WebSocketServer({
    server,
    verifyClient: guardUpgrade(token, port),
  });
}

export function guardUpgrade(token: string, port: PortSource) {
  return (info: { readonly req: IncomingMessage }) =>
    isAllowedUpgrade(info.req, token, resolvePort(port));
}

export function isAllowedUpgrade(request: IncomingMessage, token: string, port: number): boolean {
  const host = request.headers.host ?? "";
  const origin = request.headers.origin;
  if (!isLocalHost(host, port)) return false;
  if (origin !== undefined && !isLocalOrigin(origin, port)) return false;
  const url = new URL(request.url ?? "/", `http://${host}`);
  return url.searchParams.get("token") === token;
}

export function resolvePort(port: PortSource): number {
  return typeof port === "function" ? port() : port;
}

function isLocalOrigin(origin: string, port: number): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && isLocalHost(parsed.host, port);
  } catch {
    return false;
  }
}

/** Only a loopback `Host` for the bound port may reach the app shell (it embeds the token). */
export function isLocalHost(host: string, port: number): boolean {
  return host === `localhost:${port}` || host === `127.0.0.1:${port}`;
}
