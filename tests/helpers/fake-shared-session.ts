/**
 * The one fake `SharedSession` for the dev-app suites (PRD §11, C-APP-*): a minimal
 * session whose calls are recorded (prompts, keys, sizes, stop/kill/teardown counts)
 * and whose `emit` drives the handlers a consumer registered through `on`. Behavior
 * overrides (a rejecting teardown, a rejecting kill) are opt-in per test.
 */

import type {
  CommonEventHandler,
  CommonEventName,
  SharedSession,
} from "../../dev/agent-runtime.ts";

type Size = { readonly cols: number; readonly rows: number };
type Handler = CommonEventHandler<CommonEventName>;

export type FakeSharedSession = SharedSession & {
  readonly prompts: string[];
  readonly keys: string[];
  readonly sizes: Size[];
  stopped: number;
  killed: number;
  teardownCount: number;
  emit<E extends CommonEventName>(event: E, payload: Parameters<CommonEventHandler<E>>[0]): void;
};

export type FakeSharedSessionOptions = {
  readonly cwd?: string;
  /** Replace the resolving teardown (the call is still counted). */
  readonly teardown?: () => Promise<void>;
  /** Replace the resolving kill (the call is still counted). */
  readonly kill?: () => Promise<void>;
};

export function fakeSharedSession(
  id = "s1",
  options: FakeSharedSessionOptions = {},
): FakeSharedSession {
  const handlers = new Map<CommonEventName, Handler[]>();
  const resolved = () => Promise.resolve();
  const session: FakeSharedSession = {
    elwoodSessionId: id,
    cwd: options.cwd ?? "/w",
    status: "running",
    // The dev app never reaches the terminal through SharedSession (it renders raw
    // `terminal:data` events), so no headless terminal is constructed for the fake.
    terminal: {} as SharedSession["terminal"],
    prompts: [],
    keys: [],
    sizes: [],
    stopped: 0,
    killed: 0,
    teardownCount: 0,
    statusDecisions: () => [],
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler as Handler);
      handlers.set(event, list);
      return () => {
        handlers.set(
          event,
          (handlers.get(event) ?? []).filter((entry) => entry !== handler),
        );
      };
    },
    emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) handler(payload as never);
    },
    sendPrompt: (value: string) => {
      session.prompts.push(value);
      return resolved();
    },
    sendMessage: resolved,
    sendGuidance: resolved,
    sendKeys: (value: string | Uint8Array) => {
      session.keys.push(String(value));
      return resolved();
    },
    resize: (size: Size) => {
      session.sizes.push(size);
      return resolved();
    },
    stop: () => {
      session.stopped += 1;
      return resolved();
    },
    kill: () => {
      session.killed += 1;
      return (options.kill ?? resolved)();
    },
    teardown: () => {
      session.teardownCount += 1;
      return (options.teardown ?? resolved)();
    },
  };
  return session;
}
