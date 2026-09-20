/** Adapter-boundary matrix: off-allowlist native gates hold input, hold-only (C-TRUST-01). */
import { expect, test, vi } from "vitest";
import type { ElwoodActivityEvent, ElwoodSessionStatus } from "../../src/index.ts";
import type { FakePty } from "./fake-pty.ts";
import { paintWhileStarting } from "./startup-frame.ts";

type Session = {
  readonly elwoodSessionId: string;
  readonly cwd: string;
  readonly status: ElwoodSessionStatus;
  statusDecisions(): readonly { readonly from: string; readonly to?: string | undefined }[];
  readonly terminal: { snapshot(): { readonly text: string } };
  sendMessage(input: string): Promise<void>;
  sendKeys(input: string): Promise<void>;
  teardown(): Promise<void>;
  on(event: "activity", callback: (event: ElwoodActivityEvent) => unknown): unknown;
};

type Harness = {
  readonly agent: "claude" | "codex";
  readonly start: (autotrust: boolean) => Promise<{ session: Session; pty: FakePty }>;
  /** Fires the adapter's pre-input readiness hook, as the real CLI does behind a gate. */
  readonly ready: (session: Session, pty: FakePty) => Promise<unknown>;
  readonly clear: string;
  /** A complete allowlisted gate, human-owned while `autotrust` is off. */
  readonly known: string;
};

/** A reworded trust question no allowlist entry names, in the native option/footer shape. */
export const rewordedGate =
  "Do you trust this workspace?\n\n> 1. Yes, continue\n  2. No, quit\n\nPress enter to continue";
const paste = (text: string) => `\u001b[200~${text}\u001b[201~`;
/** Repaint, then wait for the render: readiness racing an unpainted gate is not under test. */
const cleared = (frame: string) => `\u001b[2J\u001b[H${frame.replaceAll("\n", "\r\n")}`;
async function repaint(session: Session, pty: FakePty, frame: string): Promise<void> {
  pty.emitData(cleared(frame));
  const lastRow = frame.split("\n").at(-1)!.trim();
  await vi.waitFor(() => {
    if (!session.terminal.snapshot().text.includes(lastRow)) throw new Error("frame not rendered");
  });
}

async function run(
  harness: Harness,
  autotrust: boolean,
  body: (session: Session, pty: FakePty, attention: string[]) => Promise<void>,
): Promise<void> {
  const { session, pty } = await harness.start(autotrust);
  const attention: string[] = [];
  session.on("activity", (event) => {
    if (event.kind === "attention") attention.push(event.label);
  });
  try {
    await body(session, pty, attention);
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
}

export function unknownGateTests(harness: Harness): void {
  test.each([
    true,
    false,
  ])("C-TRUST-01 an off-allowlist native gate holds queued input, unanswered (autotrust %s)", async (autotrust) => {
    await run(harness, autotrust, async (session, pty, attention) => {
      const queued = session.sendMessage("hello");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); // the first frame arms the deadline
      await repaint(session, pty, rewordedGate);
      await harness.ready(session, pty);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(11_000); // the hook AND the 10 s readiness deadline
      expect(pty.writes).toEqual([]);
      expect(session.status).toBe("blocked");
      expect(attention).toEqual([`${harness.agent}-unknown_gate-prompt`]);
      await session.sendKeys("2");
      vi.useRealTimers();
      await repaint(session, pty, harness.clear);
      await queued;
      expect(pty.writes).toEqual(["2", paste("hello"), "\r"]);
      expect(session.status).not.toBe("blocked");
      expect(attention).toHaveLength(1);
    });
  });

  test.each([
    ["allowlisted", harness.known, false, `${harness.agent}-workspace_trust-prompt`],
    ["off-allowlist", rewordedGate, true, `${harness.agent}-unknown_gate-prompt`],
  ] as const)("C-ATTN-03 an %s gate painted while starting still announces its label once live", async (_name, gate, autotrust, label) => {
    paintWhileStarting(gate);
    try {
      await run(harness, autotrust, async (session, pty, attention) => {
        await vi.waitFor(() => expect(session.status).toBe("blocked"));
        expect(session.statusDecisions()[0]).toMatchObject({ from: "starting", to: undefined });
        expect(attention).toEqual([label]);
        expect(pty.writes).toEqual([]);
      });
    } finally {
      vi.restoreAllMocks();
    }
  });

  test("C-API-56 an off-allowlist gate received but not yet rendered still holds the queued paste", async () => {
    await run(harness, true, async (session, pty, attention) => {
      await repaint(session, pty, harness.clear);
      await harness.ready(session, pty);
      await vi.waitFor(() => expect(session.status).toBe("ready"));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      // Same tick: the gate's bytes are RECEIVED, but no frame has been observed yet.
      pty.emitData(cleared(rewordedGate));
      const queued = session.sendMessage("held");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(pty.writes).toEqual([]);
      expect(attention).toEqual([`${harness.agent}-unknown_gate-prompt`]);
      pty.emitData(cleared(harness.clear));
      await vi.advanceTimersByTimeAsync(500);
      await queued;
      expect(pty.writes).toEqual([paste("held"), "\r"]);
    });
  });

  test("C-TRUST-01 the same gate quoted below a conversation row never holds input", async () => {
    await run(harness, true, async (session, pty, attention) => {
      await repaint(session, pty, `● The CLI once asked:\n${rewordedGate}`);
      await harness.ready(session, pty);
      await session.sendMessage("hello");
      expect(pty.writes).toEqual([paste("hello"), "\r"]);
      expect(attention).toEqual([]);
    });
  });
}
