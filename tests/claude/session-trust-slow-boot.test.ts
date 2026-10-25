/**
 * Replays a real Claude 2.1.310 fresh-folder launch whose composer painted 8.9 s after
 * the trust dialog: autotrust answered within a second, the dialog was erased, and the
 * screen stayed blank, then showed only the banner, while Claude booted. That boot is not
 * a human decision, so it must not surface as `blocked` or attention (C-ATTN-03,
 * C-TRUST-01), while queued input stays held until the composer (C-API-28).
 */
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

type Chunk = { readonly atMs: number; readonly data: string };
const capture = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/claude-2.1.310/trust-slow-boot/folder-trust-to-composer.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as readonly Chunk[];
const dialogChunk = capture.findIndex((chunk) => chunk.data.includes("trust"));
const composerChunk = capture.findIndex((chunk) => chunk.data.includes("❯\u00a0"));

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

test("C-ATTN-03 a real 2.1.310 boot that outlasts the trust budget after the answer never blocks", async () => {
  installFakes();
  const session = await startClaude({ cwd: tempDir(), autotrust: true });
  const statuses: string[] = [];
  const attention: string[] = [];
  session.on("status", (event) => statuses.push(event.status));
  session.on("activity", (event) => {
    if (event.kind === "attention") attention.push(event.label);
  });
  const queued = session.sendMessage("hello");
  vi.useFakeTimers();
  const pty = ptys[0]!;
  let elapsed = 0;
  for (const [index, chunk] of capture.entries()) {
    await vi.advanceTimersByTimeAsync(chunk.atMs - elapsed);
    elapsed = chunk.atMs;
    if (index === composerChunk) {
      // Seven seconds after the dialog: answered, still held, never reported blocked.
      expect(elapsed - capture[dialogChunk]!.atMs).toBeGreaterThan(5_000);
      expect(pty.writes.some((input) => input.includes("\r"))).toBe(true);
      expect(pty.writes.join("")).not.toContain("hello");
      expect(statuses).not.toContain("blocked");
    }
    pty.emitData(chunk.data);
  }
  await vi.advanceTimersByTimeAsync(2_000);
  await queued;
  expect(pty.writes).toContain("\u001b[200~hello\u001b[201~");
  expect(statuses).not.toContain("blocked");
  expect(attention).toEqual([]);
  vi.useRealTimers();
  await session.teardown();
});
