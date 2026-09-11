/**
 * Focused coverage for web dev app owned-resource cleanup.
 * Covers PRD §11.
 */

import { describe, expect, test } from "vitest";
import { closeWebDevResources } from "../../src/app/web-cleanup.ts";
import { fakeSharedSession } from "../helpers/fake-shared-session.ts";

describe("web dev cleanup", () => {
  test("C-APP-08 closes sockets, server, websocket server, and active session", async () => {
    const socket = new FakeSocket();
    const server = new FakeServer(true);
    const wss = new FakeWebSocketServer();
    const session = fakeSharedSession();
    await closeWebDevResources({
      server: server as never,
      wss: wss as never,
      sockets: new Set([socket as never]),
      session,
    });
    expect(socket.terminated).toBe(true);
    expect(server.closed).toBe(true);
    expect(wss.closed).toBe(true);
    expect(session.killed).toBe(1);
  });

  test("C-APP-08 ignores inactive server and kill failures during cleanup", async () => {
    const server = new FakeServer(false);
    const session = fakeSharedSession("s1", { kill: () => Promise.reject(new Error("gone")) });
    await closeWebDevResources({
      server: server as never,
      wss: new FakeWebSocketServer() as never,
      sockets: new Set(),
      session,
    });
    expect(server.closed).toBe(false);
    expect(session.killed).toBe(1);
  });
});

class FakeSocket {
  terminated = false;

  terminate(): void {
    this.terminated = true;
  }
}

class FakeServer {
  closed = false;
  readonly listening: boolean;

  constructor(listening: boolean) {
    this.listening = listening;
  }

  close(callback: () => void): void {
    this.closed = true;
    callback();
  }
}

class FakeWebSocketServer {
  closed = false;

  close(callback: () => void): void {
    this.closed = true;
    callback();
  }
}
