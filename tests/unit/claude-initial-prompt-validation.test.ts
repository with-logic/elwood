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
afterEach(() => vi.mocked(fs.readSync).mockReset());

const pending = {};
const row = (id: string, text: string) => `${JSON.stringify(nativeUser(id, text))}\n`;
function stored(text = row("first", "native prompt")) {
  const path = tmpFile();
  fs.writeFileSync(path, text);
  return { path, initial: new InitialClaudePrompt(fs.statSync(path)) };
}

test("C-API-63 only the same authenticated prompt can retry a short read", () => {
  const { initial, path } = stored();
  vi.mocked(fs.readSync).mockReturnValueOnce(0);
  expect(() => initial.take(path, pending)).toThrow("was incomplete");
  expect(initial.take(path, {})).toBeUndefined();
  expect(initial.take(path, pending)?.prompt?.text).toBe("native prompt");
  expect(initial.take(path, pending)).toBeUndefined();
});

test("C-API-63 a second read failure closes the initial lookup", () => {
  const { initial, path } = stored();
  vi.mocked(fs.readSync).mockReturnValueOnce(0).mockReturnValueOnce(0);
  expect(() => initial.take(path, pending)).toThrow("was incomplete");
  expect(() => initial.take(path, pending)).toThrow("was incomplete");
  expect(initial.take(path, pending)).toBeUndefined();
});

test("C-API-63 a completed read cannot authorize evidence from a concurrently rewritten file", async () => {
  const { initial, path } = stored();
  const real = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(fs.readSync).mockImplementationOnce((fd, buffer) => {
    const count = real.readSync(fd, buffer, { position: 0 });
    fs.writeFileSync(path, row("first", "edited prompt"));
    fs.utimesSync(path, new Date(0), new Date(0));
    return count;
  });
  expect(initial.take(path, pending)).toBeUndefined();
});

test("C-API-63 lookup ignores non-user records and caps the scan at 4096 rows", () => {
  const { initial, path } = stored(row("first", "native prompt") + '"user"\n'.repeat(4096));
  expect(initial.take(path, pending)).toEqual({ malformed: false });
  const inBudget = stored(
    row("first", "native prompt").replace('"type":"user"', '"type":"\\u0075ser"') +
      row("", "no native ID") +
      row("ignored", "  ") +
      '{"type":"assistant","copy":"not a candidate"}\n' +
      '{"type":"assistant","copy":"user"}\n'.repeat(4092),
  );
  expect(inBudget.initial.take(inBudget.path, pending)?.prompt?.text).toBe("native prompt");
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
  expect(new InitialClaudePrompt(undefined).take(path, pending)).toBeUndefined();
  expect(new InitialClaudePrompt(fs.statSync(dirname(path))).take(path, pending)).toBeUndefined();
});

test("C-API-63 an appended record cannot authorize an initial lookup", () => {
  const { path, initial } = stored();
  fs.appendFileSync(path, row("next", "later prompt"));
  expect(initial.take(path, pending)).toBeUndefined();
});

test("C-API-63 small recent evidence needs only one bounded read", () => {
  const { path, initial } = stored(`${"x".repeat(1024 * 1024)}\n${row("first", "native prompt")}`);
  expect(initial.take(path, pending)?.prompt?.text).toBe("native prompt");
  expect(vi.mocked(fs.readSync)).toHaveBeenCalledOnce();
});

test("C-API-63 recent rows consume the budget before older prompt candidates", () => {
  const { path, initial } = stored(
    `${"x".repeat(128 * 1024)}\n${row("first", "older prompt")}${"{}\n".repeat(4096)}`,
  );
  expect(initial.take(path, pending)).toEqual({ malformed: false });
  expect(vi.mocked(fs.readSync)).toHaveBeenCalledOnce();
});

test("C-API-63 an all-pending recent window still finds a complete older row", () => {
  const { path, initial } = stored(row("first", "initial prompt") + "x".repeat(128 * 1024));
  expect(initial.take(path, pending)?.prompt?.text).toBe("initial prompt");
  expect(vi.mocked(fs.readSync)).toHaveBeenCalledTimes(2);
});

test("C-API-63 seed-read failure reserves one retry for the existing pending entry", () => {
  const { path } = stored();
  const events: unknown[] = [];
  const watcher = new ClaudeTranscriptWatcher("s", (event) => events.push(event));
  const hook = (turnId: string) => {
    watcher.observeUserPromptHook({ path, turnId, hasText: false });
    watcher.observe(path, false, turnId);
  };
  try {
    watcher.observe(path);
    vi.mocked(fs.readSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("fixture read failure"), { code: "EIO" });
    });
    hook("first");
    hook("different");
    expect(events).toEqual([]);
    hook("first");
    expect(events).toMatchObject([{ turnId: "first", summary: { text: "native prompt" } }]);
  } finally {
    watcher.finish();
  }
});

test("C-API-63 an evicted pending entry cannot reclaim its reserved retry", () => {
  const { path } = stored();
  const events: unknown[] = [];
  const watcher = new ClaudeTranscriptWatcher("s", (event) => events.push(event));
  try {
    watcher.observe(path);
    watcher.observeUserPromptHook({ path, turnId: "first", hasText: false });
    vi.mocked(fs.readSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("fixture read failure"), { code: "EIO" });
    });
    watcher.observe(path, false, "first");
    for (let index = 0; index < 64; index++)
      watcher.observeUserPromptHook({ path, turnId: `different-${index}`, hasText: false });
    watcher.observeUserPromptHook({ path, turnId: "first", hasText: false });
    watcher.observe(path, false, "first");
    expect(events).toEqual([]);
  } finally {
    watcher.finish();
  }
});

test.each([
  "removed",
  "retargeted",
])("C-API-63 the initial path is %s during reading", async (change) => {
  const { path } = stored();
  const link = `${path}.link`;
  fs.symlinkSync(path, link);
  const initial = new InitialClaudePrompt(fs.statSync(link));
  const real = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(fs.readSync).mockImplementationOnce((fd, buffer) => {
    const count = real.readSync(fd, buffer, { position: 0 });
    fs.rmSync(link);
    if (change === "retargeted") {
      const replacement = stored();
      fs.symlinkSync(replacement.path, link);
    }
    return count;
  });
  expect(initial.take(link, pending)).toBeUndefined();
  expect(initial.take(link, pending)).toBeUndefined();
});
