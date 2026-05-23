/**
 * Browser-based local Elwood dev app.
 * Runs under Node because node-pty's native addon is not reliable under Bun.
 */

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { type WebSocket, WebSocketServer } from "ws";
import {
  type ClaudeHookEvent,
  type ClaudeHookHandlers,
  type ClaudeHookResult,
  type ClaudeSession,
  claudeHookEventNames,
  resumeClaude,
  startClaude,
} from "../index.ts";
import { clientScript, renderHtml } from "./web-assets.ts";
import { summarizeHookEvent } from "./web-log.ts";
import {
  type ClientMessage,
  parseClientMessage,
  type ServerMessage,
  sizeFrom,
} from "./web-messages.ts";

const require = createRequire(import.meta.url);
const appPort = Number(process.env["ELWOOD_DEV_PORT"] ?? 4317);

let session: ClaudeSession | null = null;
const server = createServer(handleHttp);
const sockets = new Set<WebSocket>();
const wss = new WebSocketServer({ server });

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
    } else if (message.type === "kill") {
      await currentSession().kill();
    } else {
      await currentSession().teardown();
      session = null;
    }
  } catch (error) {
    sendSocket(socket, {
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function startOrResume(
  message: Extract<ClientMessage, { readonly type: "start" }>,
): Promise<void> {
  const size = sizeFrom(message);
  session =
    message.resumeSessionId === undefined
      ? await startClaude({
          cwd: message.cwd,
          initialSize: size,
          hooks: loggingHooks(),
          ...(message.stateDir === undefined ? {} : { stateDir: message.stateDir }),
        })
      : await resumeClaude({
          elwoodSessionId: message.resumeSessionId,
          cwd: message.cwd,
          initialSize: size,
          hooks: loggingHooks(),
          ...(message.stateDir === undefined ? {} : { stateDir: message.stateDir }),
        });
  wireSession(session);
  broadcast({
    type: "session",
    id: session.elwoodSessionId,
    cwd: session.cwd,
    status: session.status,
  });
}

function wireSession(active: ClaudeSession): void {
  active.on("terminal:data", (event) => broadcast({ type: "terminal", data: event.data }));
  active.on("terminal:exit", (event) =>
    broadcast({ type: "log", level: "info", text: `terminal exit ${event.exitCode}` }),
  );
  active.on("status", (event) => broadcast({ type: "status", status: event.status }));
  active.on("hookError", (event) =>
    broadcast({
      type: "log",
      level: "error",
      text: `hookError ${event.hookEventName}: ${event.category} ${event.message}`,
    }),
  );
}

function loggingHooks(): ClaudeHookHandlers {
  const handlers: Partial<
    Record<(typeof claudeHookEventNames)[number], (event: ClaudeHookEvent) => ClaudeHookResult>
  > = {};
  for (const name of claudeHookEventNames) {
    handlers[name] = (event) => {
      broadcast({ type: "log", level: "info", text: summarizeHookEvent(event) });
      return undefined;
    };
  }
  return handlers as ClaudeHookHandlers;
}

function currentSession(): ClaudeSession {
  if (!session) throw new Error("No Claude session is running.");
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
