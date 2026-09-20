/** Real adapter-boundary recovery and shutdown matrix for C-TRUST-01. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type {
  ElwoodActivityEvent,
  ElwoodSessionStatus,
  ElwoodWarningEvent,
} from "../../src/index.ts";
import type { FakePty } from "./fake-pty.ts";
import { tempDir } from "./tmp.ts";

type Session = {
  readonly status: ElwoodSessionStatus;
  sendMessage(input: string, options?: { images: readonly { path: string }[] }): Promise<void>;
  sendKeys(input: string): Promise<void>;
  stop(): Promise<void>;
  kill(): Promise<void>;
  teardown(): Promise<void>;
  on(event: "activity", callback: (event: ElwoodActivityEvent) => unknown): unknown;
  on(event: "warning", callback: (event: ElwoodWarningEvent) => unknown): unknown;
};

type Harness = {
  readonly agent: "claude" | "codex";
  readonly start: () => Promise<{ readonly session: Session; readonly pty: FakePty }>;
  readonly native: string;
  readonly cursor: string;
  readonly clear: string;
  readonly renderClear?: (frame: string) => string;
  /** The guard the adapter handed its mocked image driver, once an attach ran. */
  readonly attachGuard: () => (() => boolean) | undefined;
};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const repaint = (
  pty: FakePty,
  frame: string,
  render = (text: string) => text.replaceAll("\n", "\r\n"),
) => pty.emitData(`\u001b[2J\u001b[H${render(frame)}`);

/** Teardown cannot depend on assertions passing; a leaked session contaminates later tests. */
async function withSession(
  harness: Harness,
  body: (live: Awaited<ReturnType<Harness["start"]>>) => Promise<void>,
): Promise<void> {
  const live = await harness.start();
  try {
    await body(live);
  } finally {
    vi.useRealTimers();
    await live.session.teardown();
  }
}

export function trustRecoveryTests(harness: Harness): void {
  test("C-TRUST-01 an automation-owned trust gate holds image attachment", async () => {
    await withSession(harness, async ({ session, pty }) => {
      const image = join(tempDir("elwood-trust-"), "shot.png");
      writeFileSync(image, PNG);
      repaint(pty, harness.clear, harness.renderClear);
      await session.sendMessage("look", { images: [{ path: image }] });
      const guard = harness.attachGuard();
      expect(guard?.()).toBe(false);
      repaint(pty, harness.native);
      await vi.waitFor(() => expect(guard?.()).toBe(true));
      expect(session.status).not.toBe("blocked");
    });
  });

  test.each([
    "automatic",
    "raw keys",
  ])("C-TRUST-01 unsupported static layout blocks then recovers via %s", async (recovery) => {
    await withSession(harness, async ({ session, pty }) => {
      const attention: string[] = [];
      const answered: string[] = [];
      const warnings: string[] = [];
      session.on("activity", (event) => {
        if (event.kind === "attention") attention.push(event.label);
        if (event.kind === "startup_prompt") answered.push(event.label);
      });
      session.on("warning", (event) => warnings.push(event.code));
      const queued = session.sendMessage("held until native clearance");
      vi.useFakeTimers();
      const nativeRows = harness.native.split("\n");
      nativeRows.splice(1, 0, "Unknown native copy");
      const unsupported = nativeRows.join("\n");
      repaint(pty, unsupported);
      await vi.advanceTimersByTimeAsync(4_900);
      expect(pty.writes).toEqual([]);
      expect(session.status).not.toBe("blocked");
      await vi.advanceTimersByTimeAsync(200);
      expect(session.status).toBe("blocked");
      expect(attention).toContain(`${harness.agent}-workspace_trust-prompt`);
      repaint(pty, unsupported);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(pty.writes).toEqual([]);
      expect(session.status).toBe("blocked");
      if (recovery === "automatic") {
        const write = pty.write.bind(pty);
        vi.spyOn(pty, "write").mockImplementation((input) => {
          write(input);
          if (input === "1\r") repaint(pty, harness.clear, harness.renderClear);
        });
        repaint(pty, harness.native);
      } else {
        await session.sendKeys("manual recovery");
        expect(pty.writes).toEqual(["manual recovery"]);
        repaint(pty, harness.clear, harness.renderClear);
      }
      await vi.advanceTimersByTimeAsync(600);
      expect(session.status).not.toBe("blocked");
      expect(pty.writes).toContain("\u001b[200~held until native clearance\u001b[201~");
      await queued;
      expect(answered).toEqual(recovery === "automatic" ? ["workspace_trust"] : []);
      expect(warnings).toEqual([]);
    });
  });

  test.each([
    "stop",
    "kill",
    "teardown",
    "exit",
  ] as const)("C-TRUST-01 %s cancels both navigation styles before further input", async (action) => {
    for (const frame of [harness.native, harness.cursor]) {
      await withSession(harness, async ({ session, pty }) => {
        const late: string[] = [];
        session.on("activity", (event) => {
          if (event.kind === "startup_prompt" || event.kind === "attention") late.push(event.kind);
        });
        session.on("warning", (event) => late.push(event.code));
        vi.useFakeTimers();
        repaint(pty, frame);
        await vi.advanceTimersByTimeAsync(100);
        expect(pty.writes.length).toBeGreaterThan(0);
        const count = pty.writes.length;
        let closed: Promise<void>;
        if (action === "exit") {
          pty.emitExit({ exitCode: 0 });
          closed = Promise.resolve();
        } else closed = session[action]();
        await vi.advanceTimersByTimeAsync(10_000);
        await closed;
        expect(pty.writes).toHaveLength(count);
        expect(late).toEqual([]);
      });
    }
  });
}
