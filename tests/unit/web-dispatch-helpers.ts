/**
 * Shared test harness and fake session for web-dispatch conformance tests.
 * Supports PRD §11 (C-APP-01..09) coverage in the web-dispatch*.test.ts files.
 */

import type {
  AgentLaunchOptions,
  CommonEventHandler,
  CommonEventName,
  SharedSession,
} from "../../src/app/agent-runtime.ts";
import { dispatchClientMessage } from "../../src/app/web-dispatch.ts";
import type { ServerMessage } from "../../src/app/web-messages.ts";
import { WebSessionSlot } from "../../src/app/web-session-slot.ts";

export function frame(message: unknown): string {
  return JSON.stringify(message);
}

export async function start(harness: Harness): Promise<void> {
  await dispatchClientMessage(
    harness.deps,
    frame({ type: "start", cwd: "/w", cols: 80, rows: 24 }),
    harness.report,
  );
}

export type Harness = {
  readonly deps: {
    readonly slot: WebSessionSlot;
    readonly broadcast: (m: ServerMessage) => void;
    readonly startOrResumeSession: (o: AgentLaunchOptions) => Promise<SharedSession>;
  };
  readonly broadcasts: ServerMessage[];
  readonly reports: ServerMessage[];
  readonly launches: AgentLaunchOptions[];
  readonly report: (m: ServerMessage) => void;
};

export function harnessWith(
  start?: (options: AgentLaunchOptions) => Promise<SharedSession>,
  slot: WebSessionSlot = new WebSessionSlot(),
): Harness {
  const broadcasts: ServerMessage[] = [];
  const reports: ServerMessage[] = [];
  const launches: AgentLaunchOptions[] = [];
  const startOrResumeSession = (options: AgentLaunchOptions) => {
    launches.push(options);
    return (start ?? (() => Promise.resolve(fakeSession("s1"))))(options);
  };
  return {
    deps: { slot, broadcast: (m) => broadcasts.push(m), startOrResumeSession },
    broadcasts,
    reports,
    launches,
    report: (m) => reports.push(m),
  };
}

export type FakeSession = SharedSession & {
  teardownCount: number;
  stopped: number;
  killed: number;
  readonly prompts: string[];
  readonly keys: string[];
  readonly sizes: { readonly cols: number; readonly rows: number }[];
  emit<E extends CommonEventName>(event: E, payload: Parameters<CommonEventHandler<E>>[0]): void;
};

export function fakeSession(id: string): FakeSession {
  const handlers = new Map<CommonEventName, CommonEventHandler<CommonEventName>[]>();
  const session = {
    elwoodSessionId: id,
    cwd: "/w",
    status: "running",
    terminal: {} as never,
    teardownCount: 0,
    stopped: 0,
    killed: 0,
    prompts: [] as string[],
    keys: [] as string[],
    sizes: [] as { readonly cols: number; readonly rows: number }[],
    statusDecisions: () => [],
    on<E extends CommonEventName>(event: E, handler: CommonEventHandler<E>) {
      const list = handlers.get(event) ?? [];
      list.push(handler as CommonEventHandler<CommonEventName>);
      handlers.set(event, list);
      return () => undefined;
    },
    emit<E extends CommonEventName>(event: E, payload: Parameters<CommonEventHandler<E>>[0]) {
      for (const handler of handlers.get(event) ?? []) handler(payload as never);
    },
    sendPrompt: (value: string) => {
      session.prompts.push(value);
      return Promise.resolve();
    },
    sendMessage: () => Promise.resolve(),
    sendGuidance: () => Promise.resolve(),
    sendKeys: (value: string) => {
      session.keys.push(value);
      return Promise.resolve();
    },
    resize: (size: { readonly cols: number; readonly rows: number }) => {
      session.sizes.push(size);
      return Promise.resolve();
    },
    stop: () => {
      session.stopped += 1;
      return Promise.resolve();
    },
    kill: () => {
      session.killed += 1;
      return Promise.resolve();
    },
    teardown: () => {
      session.teardownCount += 1;
      return Promise.resolve();
    },
  } satisfies FakeSession;
  return session;
}
