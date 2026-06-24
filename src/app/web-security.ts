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

export function createGuardedWebSocketServer(
  server: Server,
  token: string,
  port: number,
): WebSocketServer {
  return new WebSocketServer({
    server,
    verifyClient: guardUpgrade(token, port),
  });
}

export function guardUpgrade(token: string, port: number) {
  return (info: { readonly req: IncomingMessage }) => isAllowedUpgrade(info.req, token, port);
}

export function isAllowedUpgrade(request: IncomingMessage, token: string, port: number): boolean {
  const host = request.headers.host ?? "";
  const origin = request.headers.origin;
  if (!isLocalHost(host, port)) return false;
  if (origin !== undefined && !isLocalOrigin(origin, port)) return false;
  const url = new URL(request.url ?? "/", `http://${host}`);
  return url.searchParams.get("token") === token;
}

function isLocalOrigin(origin: string, port: number): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && isLocalHost(parsed.host, port);
  } catch {
    return false;
  }
}

function isLocalHost(host: string, port: number): boolean {
  return host === `localhost:${port}` || host === `127.0.0.1:${port}`;
}
