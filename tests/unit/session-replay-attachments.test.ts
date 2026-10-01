/** Real adapter attachment ownership through awaited replay acceptance (C-API-44/56). */
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as realDelay } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { QueuedImageBudget, shareImageBudget } from "../../src/core/images/queued-budget.ts";
import { cancellableSubmission } from "../../src/core/input/submission-cancel.ts";
import { startClaude, startCodex } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";
import { claudeComposer, codexSmallComposer, tty } from "../fixtures/trust-composer.ts";

const clipboard = vi.hoisted(() => ({ paths: [] as string[], restored: [] as string[] }));
vi.mock("../../src/codex/images/clipboard.ts", async (original) => ({
  ...(await original<typeof import("../../src/codex/images/clipboard.ts")>()),
  clipboardImageSupported: () => true,
  snapshotClipboardText: () => Promise.resolve("previous clipboard"),
  setClipboardImage: (path: string) => {
    clipboard.paths.push(path);
    return Promise.resolve();
  },
  restoreClipboardText: (text: string) => {
    clipboard.restored.push(text);
    return Promise.resolve(true);
  },
}));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  claude.resetFakes();
  codex.resetFakes();
  clipboard.paths = [];
  clipboard.restored = [];
});
async function realDeadline<T>(work: Promise<T>): Promise<T> {
  const cancel = new AbortController();
  try {
    return await Promise.race([
      work,
      realDelay(5_000, undefined, { signal: cancel.signal }).then(() => {
        throw new Error("Attachment or physical submission did not settle");
      }),
    ]);
  } finally {
    cancel.abort();
  }
}
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

for (const agent of ["claude", "codex"] as const) {
  test.each([
    "",
    "  \t ",
  ])(`C-API-56 ${agent} owns attached bytes with payload %j until fresh acceptance`, async (text) => {
    const helper = agent === "claude" ? claude : codex;
    helper.installFakes();
    const cwd = helper.tempDir();
    const session = await (agent === "claude" ? startClaude : startCodex)({
      cwd,
      initialSize: { cols: 200, rows: 35 },
    });
    const pty = helper.ptys[0]!;
    const abort = new AbortController();
    shareImageBudget(session, new QueuedImageBudget(png.length * 2));
    const caret = agent === "claude" ? "❯" : "›";
    const idle =
      (agent === "claude" ? claudeComposer : codexSmallComposer) +
      (agent === "claude" ? "\n◐ medium · /effort" : "");
    const attached: { path: string; bytes: Buffer }[] = [];
    const paint = (chip: boolean) => {
      const frame = chip
        ? idle.replace(new RegExp(`^${caret}.*$`, "m"), `${caret} [Image #1]`)
        : idle;
      const row = frame.split("\n").findLastIndex((line) => line.startsWith(caret));
      pty.emitData(
        `\u001b[2J\u001b[H${tty(frame)}\u001b[${row + 1};${chip ? 13 : 3}H\u001b[?25h\u001b]0;Ready\u0007`,
      );
      return session.terminal.settled();
    };
    const paintCompleted = async (chip: boolean) => {
      const rendered = paint(chip);
      await vi.advanceTimersByTimeAsync(1);
      await realDeadline(rendered);
    };
    const write = pty.write.bind(pty);
    vi.spyOn(pty, "write").mockImplementation((value) => {
      write(value);
      const path =
        value === "\u0016"
          ? clipboard.paths.at(-1)
          : String(value)
              .slice(6, -6)
              .match(/^(.+elwood-image-.+\.png)$/)?.[1];
      if (path) {
        attached.push({ path, bytes: readFileSync(path) });
        void paint(true); // acknowledge only an actual adapter attachment
      }
    });
    try {
      if (agent === "claude")
        await pty.dispatchHook(session.elwoodSessionId, {
          hook_event_name: "InstructionsLoaded",
          session_id: "claude-1",
          cwd,
          file_path: "/tmp/CLAUDE.md",
          memory_type: "Project",
          load_reason: "session_start",
        });
      else await codex.becomeReady(session.elwoodSessionId, cwd);
      await expect.poll(() => session.status).toBe("ready");
      const firstSubmitted = Promise.withResolvers<void>();
      const bytes = png.slice();
      let accepted = false;
      const replay = session
        .sendMessage(
          text,
          cancellableSubmission(
            {
              images: [{ data: bytes, format: "png" }],
            },
            abort.signal,
            () => {
              // Filesystem attachment uses real time; only recovery observations use the fake clock.
              vi.useFakeTimers();
              firstSubmitted.resolve();
            },
          ),
        )
        .then(() => {
          accepted = true;
        });
      void replay.catch(() => undefined);
      bytes.fill(0); // mutation after the call cannot alter the attached clone
      await realDeadline(firstSubmitted.promise);
      expect(pty.writes.filter((v) => v === "\r")).toHaveLength(1);
      expect(attached).toHaveLength(1);
      expect(attached[0]?.bytes).toEqual(Buffer.from(png));
      expect(existsSync(attached[0]!.path)).toBe(false); // materialized file is already consumed
      expect(accepted).toBe(false);
      const successor = session.sendPrompt("next", { images: [{ data: png, format: "png" }] });
      void successor.catch(() => undefined);
      await expect(
        session.sendPrompt("overflow", { images: [{ data: png, format: "png" }] }),
      ).rejects.toMatchObject({ code: "invalid_image" });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(attached).toHaveLength(1);
      expect(pty.writes.some((v) => v.includes("next"))).toBe(false);
      expect(accepted).toBe(false);
      await paintCompleted(true); // fresh image-only output still cannot release ownership
      await vi.advanceTimersByTimeAsync(1_000);
      expect(accepted).toBe(false);
      expect(attached).toHaveLength(1);
      await paintCompleted(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(accepted).toBe(true);
      await replay;
      // Yield to real filesystem work while advancing the successor's attachment/Enter timers.
      const finished = realDeadline(successor);
      let done = false;
      void finished
        .finally(() => {
          done = true;
        })
        .catch(() => undefined);
      while (!done) {
        await realDelay(0);
        await vi.advanceTimersByTimeAsync(10);
      }
      await finished;
      expect(attached).toHaveLength(2);
      expect(attached[1]?.bytes).toEqual(Buffer.from(png));
      expect(pty.writes).toContain(`\u001b[200~${text}\u001b[201~`);
      if (agent === "codex")
        expect(clipboard.restored).toEqual(["previous clipboard", "previous clipboard"]);
    } finally {
      abort.abort();
      vi.useRealTimers();
      await session.teardown();
    }
  });
}
