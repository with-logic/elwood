/**
 * Focused coverage for web dev app owned-resource cleanup.
 * Covers PRD §11.
 */

import { describe, expect, test } from "bun:test";
import { closeWebDevResources } from "../../src/app/web-cleanup.ts";

describe("web dev cleanup", () => {
  test("C-APP-08 closes sockets, server, websocket server, and active session", async () => {
    const socket = new FakeSocket();
    const server = new FakeServer(true);
    const wss = new FakeWebSocketServer();
    const session = new FakeSession();
    await closeWebDevResources({
      server: server as never,
      wss: wss as never,
      sockets: new Set([socket as never]),
      session: session as never,
    });
    expect(socket.terminated).toBe(true);
    expect(server.closed).toBe(true);
    expect(wss.closed).toBe(true);
    expect(session.killed).toBe(true);
  });

  test("C-APP-08 ignores inactive server and kill failures during cleanup", async () => {
    const server = new FakeServer(false);
    const session = new FakeSession(true);
    await closeWebDevResources({
      server: server as never,
      wss: new FakeWebSocketServer() as never,
      sockets: new Set(),
      session: session as never,
    });
    expect(server.closed).toBe(false);
    expect(session.killed).toBe(true);
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

class FakeSession {
  killed = false;
  private readonly reject: boolean;

  constructor(reject = false) {
    this.reject = reject;
  }

  kill(): Promise<void> {
    this.killed = true;
    return this.reject ? Promise.reject(new Error("already gone")) : Promise.resolve();
  }
}
