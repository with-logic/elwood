/**
 * Shared test harness and fake session for web-dispatch conformance tests.
 * Supports PRD §11 (C-APP-01..09) coverage in the web-dispatch*.test.ts files.
 */

import type { AgentLaunchOptions, SharedSession } from "../../dev/agent-runtime.ts";
import { dispatchClientMessage } from "../../dev/web/dispatch.ts";
import type { ServerMessage } from "../../dev/web/messages.ts";
import { WebSessionSlot } from "../../dev/web/session-slot.ts";
import { fakeSharedSession } from "../helpers/fake-shared-session.ts";

export type { FakeSharedSession as FakeSession } from "../helpers/fake-shared-session.ts";
export { fakeSharedSession as fakeSession } from "../helpers/fake-shared-session.ts";

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
    return (start ?? (() => Promise.resolve(fakeSharedSession("s1"))))(options);
  };
  return {
    deps: { slot, broadcast: (m) => broadcasts.push(m), startOrResumeSession },
    broadcasts,
    reports,
    launches,
    report: (m) => reports.push(m),
  };
}
