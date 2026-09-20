/**
 * Local hook IPC server that dispatches bridge calls to session handlers.
 * Implements PRD §6.2 and §6.3.
 */

import { existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { inertRecord } from "../core/inert-record.ts";
import type { HookErrorEvent } from "../core/types.ts";
import { MAX_HOOK_REQUEST_BYTES } from "./limits.ts";
import { hookEventNameFrom, noDecision, parseBridgeMessage, parseHookInput } from "./parse.ts";
import type { BridgeProcessResult } from "./types.ts";

export type HookDispatcher = (input: unknown) => Promise<BridgeProcessResult>;
export type HookErrorSink = (event: Omit<HookErrorEvent, "elwoodSessionId">) => void;
export type HookInputValidator = (input: unknown) => boolean;

export class HookBridgeServer {
  private readonly socketPath: string;
  private readonly token: string;
  private readonly elwoodSessionId: string | undefined;
  private readonly dispatch: HookDispatcher;
  private readonly onError: HookErrorSink;
  private readonly isHookInput: HookInputValidator;
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(
    socketPath: string,
    token: string,
    dispatch: HookDispatcher,
    onError: HookErrorSink,
    isHookInput: HookInputValidator,
    elwoodSessionId?: string,
  ) {
    this.socketPath = socketPath;
    this.token = token;
    this.dispatch = dispatch;
    this.onError = onError;
    this.isHookInput = isHookInput;
    this.elwoodSessionId = elwoodSessionId;
  }

  async start(): Promise<void> {
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    const server = createServer((socket) => {
      this.sockets.add(socket);
      // Accumulate RAW bytes, not per-chunk strings: decoding each chunk on its own
      // would insert replacement chars whenever a multibyte code point straddles two
      // chunks. We decode the whole buffer ONCE, at the frame boundary (PRD §6.2).
      const chunks: Buffer[] = [];
      let bytes = 0;
      let responded = false;
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("error", this.sockets.delete.bind(this.sockets, socket));
      // `respond` can never reject: `handleSafely` always resolves to a decision
      // (even when the error sink throws), so the `void respond()` call sites
      // below never leave an unhandled rejection and always fail the socket open.
      const respond = async (result: BridgeProcessResult | null) => {
        if (responded) return;
        responded = true;
        // Release the socket the moment we commit to a response: a half-open client
        // must not keep the socket (and its FD / input budget) alive after it has its
        // answer. `end()` writes the response then FINs, and `destroy()` on flush
        // stops reading and releases the FD instead of lingering half-open — a
        // post-response client write can no longer reach a second dispatch.
        const data = Buffer.concat(chunks).toString("utf8"); // decode once, whole
        const { exitCode, stdout, stderr } = result ?? (await this.handleSafely(data));
        const envelope = inertRecord({ exitCode, stdout, stderr });
        socket.end(JSON.stringify(envelope), () => socket.destroy());
      };
      socket.on("data", (chunk: Buffer) => {
        // Count raw bytes and fail open the instant the request envelope crosses
        // the cap — before auth or parse — so an unauthenticated sender cannot
        // force unbounded buffering (PRD §6.3). Scan only the fresh chunk for the
        // frame terminator instead of rescanning the whole growing buffer.
        bytes += chunk.length;
        if (bytes > MAX_HOOK_REQUEST_BYTES) return void respond(noDecision());
        const framed = chunk.includes(0x0a);
        chunks.push(chunk);
        if (framed) void respond(null);
      });
      socket.on("end", () => void respond(null));
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.listen({ path: this.socketPath }, onListening);
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.sockets.clear();
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
  }

  private async handleSafely(data: string): Promise<BridgeProcessResult> {
    try {
      return await this.handle(data);
    } catch (error) {
      this.reportError({
        hookEventName: "Unknown",
        category: "bridge_error",
        message: error instanceof Error ? error.message : "Hook bridge failed",
      });
      return noDecision();
    }
  }

  // Isolate error-sink delivery: the live sink emits `hookError`/`activity`, and
  // a parent-registered observer that throws must never propagate back out to
  // prevent the fail-open socket write (PRD §6.3). Swallowing a throwing sink
  // keeps `handleSafely` — and therefore `respond` — always resolving.
  private reportError(event: Omit<HookErrorEvent, "elwoodSessionId">): void {
    try {
      this.onError(event);
    } catch {
      // Swallow: a throwing observer must never block the fail-open write.
    }
  }

  private async handle(data: string): Promise<BridgeProcessResult> {
    const parsed = parseBridgeMessage(data);
    if (parsed.kind === "malformed") {
      this.reportError({
        hookEventName: "Unknown",
        category: "invalid_input",
        message: "Malformed hook bridge request",
      });
      return noDecision();
    }
    if (parsed.kind === "unauthenticated") return noDecision();
    if (parsed.token !== this.token) return noDecision();
    if (this.elwoodSessionId && parsed.elwoodSessionId !== this.elwoodSessionId) {
      return noDecision();
    }
    const hookInput = parseHookInput(parsed.input);
    if (!this.isHookInput(hookInput)) {
      this.reportError({
        hookEventName: hookEventNameFrom(hookInput),
        category: "invalid_input",
        message: "Invalid hook input",
      });
      return noDecision();
    }
    return await this.dispatch(hookInput);
  }
}
