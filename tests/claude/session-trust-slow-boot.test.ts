/**
 * Replays a real Claude 2.1.310 fresh-folder launch whose composer painted 8.9 s after
 * the trust dialog: autotrust answered within a second, the dialog was erased, and the
 * screen stayed blank, then showed only the banner, while Claude booted. That boot is not
 * a human decision, so it must not surface as `blocked` or attention (C-ATTN-03,
 * C-TRUST-01), while queued input stays held until the composer (C-API-28).
 */
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { type ClaudeSessionApi, type ElwoodSessionStatus, startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

type Chunk = { readonly atMs: number; readonly data: string };

function isChunk(value: unknown): value is Chunk {
  return (
    typeof value === "object" &&
    value !== null &&
    "atMs" in value &&
    typeof value.atMs === "number" &&
    "data" in value &&
    typeof value.data === "string"
  );
}

function loadCapture(): readonly Chunk[] {
  const fixture = new URL(
    "../fixtures/claude-2.1.310/trust-slow-boot/folder-trust-to-composer.json",
    import.meta.url,
  );
  const parsed: unknown = JSON.parse(readFileSync(fixture, "utf8"));
  if (!(Array.isArray(parsed) && parsed.every(isChunk)))
    throw new Error("the capture fixture must be an array of { atMs, data } chunks");
  return parsed;
}

const capture = loadCapture();

function chunkIndexOf(marker: string): number {
  const index = capture.findIndex((chunk) => chunk.data.includes(marker));
  if (index < 0) throw new Error(`the capture fixture has no chunk with ${JSON.stringify(marker)}`);
  return index;
}

const dialogChunkIndex = chunkIndexOf("trust");
const composerChunkIndex = chunkIndexOf("❯\u00a0");
let session: ClaudeSessionApi | undefined;

afterEach(async () => {
  vi.useRealTimers();
  // A failed assertion must not leak the session or its bridge into later tests.
  await session?.teardown();
  session = undefined;
  resetFakes();
});

test("C-ATTN-03 a real 2.1.310 boot that outlasts the trust budget after the answer never blocks", async () => {
  installFakes();
  const live = await startClaude({ cwd: tempDir(), autotrust: true });
  session = live;
  const statuses: ElwoodSessionStatus[] = [];
  const attention: string[] = [];
  live.on("status", (event) => statuses.push(event.status));
  live.on("activity", (event) => {
    if (event.kind === "attention") attention.push(event.label);
  });
  const queued = live.sendMessage("hello");
  vi.useFakeTimers();
  const pty = ptys[0]!;
  let elapsed = 0;
  for (const [index, chunk] of capture.entries()) {
    await vi.advanceTimersByTimeAsync(chunk.atMs - elapsed);
    elapsed = chunk.atMs;
    if (index === composerChunkIndex) {
      // Nearly nine seconds after the dialog first painted: answered, still held, never
      // reported blocked.
      expect(elapsed - capture[dialogChunkIndex]!.atMs).toBeGreaterThan(5_000);
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
});
