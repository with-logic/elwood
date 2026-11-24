/** Preserve initial-file provenance and retry policy at the real read boundary (C-API-63). */
import * as fs from "node:fs";
import { dirname } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ClaudeTranscriptWatcher } from "../../src/claude/transcript/index.ts";
import { InitialClaudePrompt } from "../../src/claude/transcript/initial-prompt.ts";
import { nativeUser, tmpFile } from "./claude-transcript-helpers.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});
afterEach(() => vi.restoreAllMocks());

const row = (id: string, text: string) => `${JSON.stringify(nativeUser(id, text))}\n`;
function stored(text = row("first", "native prompt")) {
  const path = tmpFile();
  fs.writeFileSync(path, text);
  return { path, initial: new InitialClaudePrompt(fs.statSync(path)) };
}

test("C-API-63 only the same authenticated prompt can retry a short read", () => {
  const { initial, path } = stored();
  vi.mocked(fs.readSync).mockReturnValueOnce(0);
  expect(() => initial.take(path, "first")).toThrow("was incomplete");
  expect(initial.take(path, "another")).toBeUndefined();
  expect(initial.take(path, "first")?.prompt?.text).toBe("native prompt");
  expect(initial.take(path, "first")).toBeUndefined();
});

test("C-API-63 a second read failure closes the initial lookup", () => {
  const { initial, path } = stored();
  vi.mocked(fs.readSync).mockReturnValueOnce(0).mockReturnValueOnce(0);
  expect(() => initial.take(path, "first")).toThrow("was incomplete");
  expect(() => initial.take(path, "first")).toThrow("was incomplete");
  expect(initial.take(path, "first")).toBeUndefined();
});

test("C-API-63 a completed read cannot authorize evidence from a concurrently rewritten file", async () => {
  const { initial, path } = stored();
  const real = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(fs.readSync).mockImplementationOnce((...args: unknown[]) => {
    const count = Reflect.apply(real.readSync, undefined, args) as number;
    fs.writeFileSync(path, row("first", "edited prompt"));
    fs.utimesSync(path, new Date(0), new Date(0));
    return count;
  });
  expect(initial.take(path, "first")).toBeUndefined();
});

test("C-API-63 lookup ignores non-user records and caps the scan at 4096 rows", () => {
  const { initial, path } = stored(row("first", "native prompt") + '"user"\n'.repeat(4096));
  expect(initial.take(path, "first")).toEqual({ malformed: false });
  const inBudget = stored(
    row("first", "native prompt") +
      row("", "no native ID") +
      row("ignored", "  ") +
      '{"type":"assistant","copy":"user"}\n'.repeat(4093),
  );
  expect(inBudget.initial.take(inBudget.path, "first")?.prompt?.text).toBe("native prompt");
});

test.each([
  true,
  false,
])("C-API-63 a malformed candidate is skipped whether drop observer is %s", (reportDrops) => {
  const { path } = stored(row("first", "native prompt") + '{"type":"user",} \n'.repeat(2));
  const events: unknown[] = [];
  const drops: unknown[] = [];
  const watcher = new ClaudeTranscriptWatcher("session", (event) => events.push(event), {
    ...(reportDrops ? { onDrop: (notice: unknown) => drops.push(notice) } : {}),
  });
  try {
    watcher.observe(path);
    watcher.observeUserPromptHook({ path, turnId: "first", hasText: false });
    watcher.observe(path, false, "first");
    expect(events).toMatchObject([{ turnId: "first", summary: { kind: "user_message" } }]);
    expect(drops).toEqual(
      reportDrops ? [{ elwoodSessionId: "session", path, cause: "unparseable" }] : [],
    );
  } finally {
    watcher.finish();
  }
});

test("C-API-63 initial evidence only exists for a registered regular file", () => {
  const { path } = stored();
  expect(new InitialClaudePrompt(undefined).take(path, "first")).toBeUndefined();
  expect(new InitialClaudePrompt(fs.statSync(dirname(path))).take(path, "first")).toBeUndefined();
});

test("C-API-63 an appended record cannot authorize an initial lookup", () => {
  const { path, initial } = stored();
  fs.appendFileSync(path, row("next", "later prompt"));
  expect(initial.take(path, "first")).toBeUndefined();
});
