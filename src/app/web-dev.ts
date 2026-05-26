/** Browser-based local Elwood dev app. Implements PRD §11. */

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { type WebSocket, WebSocketServer } from "ws";
import {
  type AgentKind,
  createLiveHookHandlers,
  parseAgentKind,
  type SharedSession,
  startAgentSession,
} from "./agent-runtime.ts";
import { clientScript, renderHtml } from "./web-assets.ts";
import {
  activityEvent,
  hookErrorEvent,
  hookEvent,
  runtimeErrorEvent,
  sessionEvent,
  statusEvent,
  terminalExitEvent,
  warningEvent,
} from "./web-events.ts";
import {
  type ClientMessage,
  parseClientMessage,
  type ServerMessage,
  sizeFrom,
} from "./web-messages.ts";
import { installHardShutdown } from "./web-shutdown.ts";

const require = createRequire(import.meta.url);
const appPort = Number(process.env["ELWOOD_DEV_PORT"] ?? 4317);

let session: SharedSession | null = null;
const server = createServer(handleHttp);
const sockets = new Set<WebSocket>();
const wss = new WebSocketServer({ server });
installHardShutdown();
wss.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("message", (data) => {
    void handleClientMessage(socket, data.toString("utf8"));
  });
});

server.listen(appPort, () => {
  process.stdout.write(`Elwood dev app: http://localhost:${appPort}\n`);
});

function handleHttp(request: IncomingMessage, response: ServerResponse): void {
  const path = request.url?.split("?")[0] ?? "/";
  if (path === "/") {
    send(response, "text/html; charset=utf-8", renderHtml(process.cwd()));
  } else if (path === "/client.js") {
    send(response, "text/javascript; charset=utf-8", clientScript());
  } else if (path === "/vendor/xterm.mjs") {
    sendFile(
      response,
      "text/javascript; charset=utf-8",
      packageFile("@xterm/xterm", "lib/xterm.mjs"),
    );
  } else if (path === "/vendor/addon-fit.mjs") {
    sendFile(
      response,
      "text/javascript; charset=utf-8",
      packageFile("@xterm/addon-fit", "lib/addon-fit.mjs"),
    );
  } else if (path === "/vendor/xterm.css") {
    sendFile(response, "text/css; charset=utf-8", packageFile("@xterm/xterm", "css/xterm.css"));
  } else {
    response.writeHead(404);
    response.end("not found");
  }
}

async function handleClientMessage(socket: WebSocket, raw: string): Promise<void> {
  try {
    const message = parseClientMessage(raw);
    if (message.type === "start") {
      await startOrResume(message);
    } else if (message.type === "prompt") {
      await currentSession().sendPrompt(message.value);
    } else if (message.type === "keys") {
      await currentSession().sendKeys(message.value);
    } else if (message.type === "resize") {
      await currentSession().resize(sizeFrom(message));
    } else if (message.type === "stop" || message.type === "kill") {
      await closeActive(message.type);
    } else {
      await currentSession().teardown();
      session = null;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendSocket(socket, { type: "event", entry: runtimeErrorEvent(message, errorPayload(error)) });
  }
}

async function closeActive(action: "stop" | "kill"): Promise<void> {
  const active = currentSession();
  await active[action]();
  if (session === active) session = null;
}

async function startOrResume(
  message: Extract<ClientMessage, { readonly type: "start" }>,
): Promise<void> {
  const size = sizeFrom(message);
  const agent = parseAgentKind(message.agent);
  session = await startAgentSession({
    agent,
    cwd: message.cwd,
    size,
    hooks: loggingHooks(agent),
    ...(message.stateDir === undefined ? {} : { stateDir: message.stateDir }),
    ...(message.resumeSessionId === undefined ? {} : { resumeSessionId: message.resumeSessionId }),
  });
  wireSession(session);
  broadcast({
    type: "session",
    id: session.elwoodSessionId,
    cwd: session.cwd,
    status: session.status,
  });
  broadcast({
    type: "event",
    entry: sessionEvent({
      id: session.elwoodSessionId,
      cwd: session.cwd,
      status: session.status,
    }),
  });
}

function wireSession(active: SharedSession): void {
  active.on("terminal:data", (event) => broadcast({ type: "terminal", data: event.data }));
  active.on("terminal:exit", (event) =>
    broadcast({ type: "event", entry: terminalExitEvent(event) }),
  );
  active.on("status", (event) => {
    broadcast({ type: "status", status: event.status });
    broadcast({ type: "event", entry: statusEvent(event) });
  });
  active.on("activity", (event) => broadcast({ type: "event", entry: activityEvent(event) }));
  active.on("warning", (event) => broadcast({ type: "event", entry: warningEvent(event) }));
  active.on("hook", (event) => broadcast({ type: "event", entry: hookEvent(event) }));
  active.on("hookError", (event) =>
    broadcast({
      type: "event",
      entry: hookErrorEvent(event),
    }),
  );
}

function loggingHooks(agent: AgentKind) {
  return createLiveHookHandlers(agent, {
    write: () => undefined,
  });
}

function currentSession(): SharedSession {
  if (!session) throw new Error("No Elwood session is running.");
  return session;
}

function broadcast(message: ServerMessage): void {
  for (const socket of sockets) {
    sendSocket(socket, message);
  }
}

function sendSocket(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function errorPayload(error: unknown): Readonly<Record<string, unknown>> {
  if (!(error instanceof Error)) return { value: String(error) };
  return { name: error.name, message: error.message, stack: error.stack };
}

function sendFile(response: ServerResponse, contentType: string, path: string): void {
  send(response, contentType, readFileSync(path, "utf8"));
}

function send(response: ServerResponse, contentType: string, body: string): void {
  response.writeHead(200, { "content-type": contentType });
  response.end(body);
}

function packageFile(packageName: string, relativePath: string): string {
  return join(dirname(require.resolve(`${packageName}/package.json`)), relativePath);
}
