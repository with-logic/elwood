/**
 * Shared helpers for runnable Elwood examples.
 * Implements PRD §11 example behavior.
 */

import type {
  ElwoodActivityEvent,
  ElwoodSessionStatus,
  ElwoodWarningEvent,
  HookErrorEvent,
  Unsubscribe,
} from "../src/index.ts";

export type Agent = "claude" | "codex";
export type ExampleSession = {
  readonly elwoodSessionId: string;
  readonly status: ElwoodSessionStatus;
  on(event: "activity", handler: (event: ElwoodActivityEvent) => void): Unsubscribe;
  on(event: "warning", handler: (event: ElwoodWarningEvent) => void): Unsubscribe;
  on(event: "hookError", handler: (event: HookErrorEvent) => void): Unsubscribe;
  on(
    event: "status",
    handler: (event: { readonly status: ElwoodSessionStatus }) => void,
  ): Unsubscribe;
  on(event: "terminal:exit", handler: (event: { readonly exitCode: number }) => void): Unsubscribe;
  sendMessage(message: string): Promise<void>;
  stop(): Promise<void>;
  kill(): Promise<void>;
};

export function waitForSettled(session: ExampleSession, timeoutMs: number): Promise<boolean> {
  if (session.status === "ready" || isTerminalStatus(session.status)) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    const done = (result: boolean) => {
      clearTimeout(timer);
      for (const unsubscribe of unsubs) unsubscribe();
      resolveWait(result);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    const unsubs: Unsubscribe[] = [
      session.on("status", (event) => {
        if (event.status === "ready" || isTerminalStatus(event.status)) done(true);
      }),
      session.on("terminal:exit", () => done(true)),
    ];
  });
}

export async function cleanupSession(session: ExampleSession): Promise<void> {
  try {
    await session.stop();
  } catch (error) {
    process.stderr.write(`stop failed, killing session: ${errorMessage(error)}\n`);
    await session.kill();
  }
}

export function isTerminalStatus(status: ElwoodSessionStatus): boolean {
  return (
    status === "stopped" || status === "exited" || status === "killed" || status === "torn_down"
  );
}

export function textSuffix(text: string | undefined): string {
  if (!text) return "";
  return ` ${text.replace(/\s+/g, " ").slice(0, 120)}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
