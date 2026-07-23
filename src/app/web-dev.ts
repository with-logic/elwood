/**
 * Browser-based local Elwood dev app factory and entrypoint. Implements PRD §11.
 *
 * `createWebDevApp` builds the HTTP + WebSocket wiring with no import-time side
 * effects so it is fully testable; `bootstrapIfMain` is the thin entrypoint that
 * `scripts/dev-web.ts` runs, starting the server only when this module is the
 * process entry.
 */

import { createServer, type Server } from "node:http";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import type { WebSocket, WebSocketServer } from "ws";
import { startAgentSession } from "./agent-runtime.ts";
import { closeWebDevResources } from "./web-cleanup.ts";
import { type DispatchDeps, dispatchClientMessage } from "./web-dispatch.ts";
import * as events from "./web-events.ts";
import { createHttpHandler } from "./web-http.ts";
import type { ServerMessage } from "./web-messages.ts";
import { createBrowserToken, createGuardedWebSocketServer } from "./web-security.ts";
import { WebSessionSlot } from "./web-session-slot.ts";
import { installHardShutdown, setChildLookupReporter } from "./web-shutdown.ts";

export type WebDevApp = {
  readonly server: Server;
  readonly wss: WebSocketServer;
  readonly slot: WebSessionSlot;
  readonly listen: () => Promise<number>;
  readonly shutdown: () => Promise<void>;
};

export type WebDevAppOptions = {
  readonly cwd?: string;
  readonly port?: number;
  readonly token?: string;
  /** Injectable session launcher; defaults to the real adapter runtime. */
  readonly startOrResumeSession?: typeof startAgentSession;
};

/** Build the dev app's server, WebSocket layer, and session slot without listening. */
export function createWebDevApp(options: WebDevAppOptions = {}): WebDevApp {
  const cwd = options.cwd ?? process.cwd();
  const port = options.port ?? Number(process.env["ELWOOD_DEV_PORT"] ?? 4317);
  const token = options.token ?? createBrowserToken();
  const sockets = new Set<WebSocket>();
  const broadcast = (message: ServerMessage) => broadcastTo(sockets, message);
  // A discarded session's teardown failure is broadcast as a runtime error rather
  // than silently dropped, so a stuck PTY/process tree stays visible in the dev app.
  const slot = new WebSessionSlot((id, error) =>
    broadcast({
      type: "event",
      entry: events.runtimeErrorEvent(`Session teardown failed (${id}).`, {
        id,
        error: String(error),
      }),
    }),
  );
  const server = createServer(createHttpHandler({ cwd, token }));
  // Resolve the port lazily: with port 0 the OS assigns one at listen time.
  const wss = createGuardedWebSocketServer(server, token, () => boundPort(server, port));
  const deps: DispatchDeps = {
    slot,
    broadcast,
    startOrResumeSession: options.startOrResumeSession ?? startAgentSession,
  };
  setChildLookupReporter((d) =>
    broadcast({
      type: "event",
      entry: events.runtimeErrorEvent(`Child-process lookup failed (${d.reason}).`, d),
    }),
  );
  wss.on("connection", (socket) => acceptConnection(socket, sockets, deps));
  return { server, wss, slot, listen: () => listen(server, wss, port), shutdown };

  async function shutdown(): Promise<void> {
    // closeAndTake refuses new slot work and waits for any in-flight start to settle,
    // so a session can't be installed after we tear down (no resurrected PTY).
    const session = await slot.closeAndTake();
    await closeWebDevResources({ server, wss, sockets, session });
  }
}

function acceptConnection(socket: WebSocket, sockets: Set<WebSocket>, deps: DispatchDeps): void {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("message", (data) => {
    // A parse/dispatch failure is reported only to the originating socket.
    void dispatchClientMessage(deps, data.toString("utf8"), (message) =>
      sendSocket(socket, message),
    );
  });
}

export type StartWebDevAppOptions = WebDevAppOptions & {
  /** Install shutdown handling; injectable so tests need not touch real signals. */
  readonly installShutdown?: (cleanup: () => Promise<void>) => void;
  /** Write the ready banner; injectable so tests can capture it. */
  readonly log?: (line: string) => void;
};

/** Start the dev app when this module is the process entry; returns the app or null. */
export function bootstrapIfMain(meta: { readonly url: string }): WebDevApp | null {
  if (!isMainModule(meta.url)) return null;
  return startWebDevApp();
}

/** Create the app, install hard-shutdown signal handling, and begin listening. */
export function startWebDevApp(options: StartWebDevAppOptions = {}): WebDevApp {
  const app = createWebDevApp(options);
  const install =
    options.installShutdown ?? ((cleanup: () => Promise<void>) => installHardShutdown({ cleanup }));
  const log = options.log ?? ((line: string) => process.stdout.write(line));
  install(() => app.shutdown());
  void app.listen().then(
    (port) => log(`Elwood dev app: http://localhost:${port}\n`),
    // A bind failure surfaces here rather than as an unhandled rejection: log it so
    // the operator sees why the dev app never came up (e.g. the port is in use).
    (error: unknown) => log(`Elwood dev app failed to start: ${String(error)}\n`),
  );
  return app;
}

function isMainModule(url: string): boolean {
  return argv[1] !== undefined && fileURLToPath(url) === argv[1];
}

function listen(server: Server, wss: WebSocketServer, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    // A bind failure (e.g. EADDRINUSE) emits `error`, NOT the listen callback — so
    // without this the promise would hang. When `ws` is attached with `{ server }`
    // it forwards the http server's error to the WebSocketServer instance, so we
    // must listen THERE (an unhandled wss `error` throws and crashes the dev app).
    const onError = (error: Error) => reject(error);
    wss.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      wss.removeListener("error", onError);
      resolve(boundPort(server, port));
    });
  });
}

/** The TCP port a server is bound to, or `fallback` for a not-yet-bound/pipe address. */
export function boundPort(server: Pick<Server, "address">, fallback: number): number {
  const address = server.address();
  return address && typeof address === "object" ? address.port : fallback;
}

function broadcastTo(sockets: ReadonlySet<WebSocket>, message: ServerMessage): void {
  for (const socket of sockets) sendSocket(socket, message);
}

/** Send a message to a socket only when it is OPEN; a closing/closed socket is skipped. */
export function sendSocket(
  socket: Pick<WebSocket, "readyState" | "OPEN" | "send">,
  message: ServerMessage,
): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

void bootstrapIfMain(import.meta);
