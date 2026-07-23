/**
 * Shared HTTP/WebSocket helpers for the browser dev app e2e tests.
 * Supports PRD §11 (C-APP-08) coverage across web-dev-app*.test.ts files.
 */

import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import type { AgentLaunchOptions, SharedSession } from "../../src/app/agent-runtime.ts";
import { createWebDevApp, type WebDevApp } from "../../src/app/web-dev.ts";

export type LaunchOptions = { readonly token?: string; readonly port?: number };
export type StartFn = (options: AgentLaunchOptions) => Promise<SharedSession>;

export async function launch(
  running: WebDevApp[],
  options: LaunchOptions = {},
  startOrResumeSession?: StartFn,
): Promise<WebDevApp> {
  const app = createWebDevApp({
    port: 0,
    cwd: "/w",
    ...options,
    ...(startOrResumeSession === undefined ? {} : { startOrResumeSession }),
  });
  running.push(app);
  await app.listen();
  return app;
}

export function port(app: WebDevApp): number {
  return (app.server.address() as AddressInfo).port;
}

export function fetchRaw(app: WebDevApp, path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port(app)}${path}`);
}

export async function fetchText(app: WebDevApp, path: string): Promise<string> {
  return (await fetchRaw(app, path)).text();
}

export function connect(app: WebDevApp, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port(app)}/?token=${encodeURIComponent(token)}`);
    socket.on("open", () => resolve(socket));
    socket.on("error", reject);
  });
}

export type Incoming = { type: string; entry?: { kind: string }; [key: string]: unknown };

export function collect(socket: WebSocket): Incoming[] {
  const messages: Incoming[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString("utf8")) as Incoming));
  return messages;
}

export async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function fakeSession(
  id: string,
  overrides: { readonly teardown?: () => Promise<void> } = {},
): SharedSession {
  return {
    elwoodSessionId: id,
    cwd: "/w",
    status: "running",
    warnings: [],
    terminal: {} as never,
    statusDecisions: () => [],
    on: () => () => {},
    sendPrompt: () => Promise.resolve(),
    sendMessage: () => Promise.resolve(),
    sendGuidance: () => Promise.resolve(),
    sendKeys: () => Promise.resolve(),
    resize: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    kill: () => Promise.resolve(),
    teardown: overrides.teardown ?? (() => Promise.resolve()),
  };
}
