/**
 * Local hook IPC server that dispatches bridge calls to session handlers.
 * Implements PRD §6.2 and §6.3.
 */

import { existsSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import type { HookErrorEvent } from "../core/types.ts";
import type { BridgeProcessResult } from "./types.ts";
import { isClaudeHookEvent } from "./validate.ts";

export type HookDispatcher = (input: unknown) => Promise<BridgeProcessResult>;
export type HookErrorSink = (event: Omit<HookErrorEvent, "elwoodSessionId">) => void;
export type HookInputValidator = (input: unknown) => boolean;

export class HookBridgeServer {
  private readonly socketPath: string;
  private readonly token: string;
  private readonly dispatch: HookDispatcher;
  private readonly onError: HookErrorSink;
  private readonly isHookInput: HookInputValidator;
  private server: Server | null = null;

  constructor(
    socketPath: string,
    token: string,
    dispatch: HookDispatcher,
    onError: HookErrorSink,
    isHookInput: HookInputValidator = isClaudeHookEvent,
  ) {
    this.socketPath = socketPath;
    this.token = token;
    this.dispatch = dispatch;
    this.onError = onError;
    this.isHookInput = isHookInput;
  }

  async start(): Promise<void> {
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    this.server = createServer((socket) => {
      let data = "";
      let responded = false;
      const respond = async () => {
        if (responded) return;
        responded = true;
        const result = await this.handle(data);
        socket.write(JSON.stringify(result));
        socket.end();
      };
      socket.on("data", async (chunk) => {
        data += chunk.toString("utf8");
        await respond();
      });
      socket.on("end", respond);
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (!server) {
        resolve();
        return;
      }
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
  }

  private async handle(data: string): Promise<BridgeProcessResult> {
    const parsed = parseBridgeMessage(data);
    if (!parsed || parsed.token !== this.token) return noDecision();
    const hookInput = parseHookInput(parsed.input);
    if (!this.isHookInput(hookInput)) {
      this.onError({
        hookEventName: "Unknown",
        category: "invalid_input",
        message: "Invalid hook input",
      });
      return noDecision();
    }
    return await this.dispatch(hookInput);
  }
}

function parseBridgeMessage(
  data: string,
): { readonly token: string; readonly input: string } | null {
  try {
    const parsed = JSON.parse(data) as { readonly token?: unknown; readonly input?: unknown };
    if (typeof parsed.token === "string" && typeof parsed.input === "string") {
      return { token: parsed.token, input: parsed.input };
    }
    return null;
  } catch {
    return null;
  }
}

function parseHookInput(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function noDecision(): BridgeProcessResult {
  return { exitCode: 0, stdout: "", stderr: "" };
}
