/** Verify bounded, complete native row evidence even around malformed bytes (C-API-63). */
import { statSync, utimesSync, writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import { InitialClaudePrompt } from "../../src/claude/transcript/initial-prompt.ts";
import { nativeUser, tmpFile } from "./claude-transcript-helpers.ts";

const pending = {};
const user = (turnId: string, text: string) => `${JSON.stringify(nativeUser(turnId, text))}\n`;

test("C-API-63 invalid bytes at an arbitrary boundary do not turn into prompt text", () => {
  const path = tmpFile();
  const bad = user("first", "left|right");
  const split = bad.indexOf("|");
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from(user("first", "valid native prompt")),
      Buffer.from(bad.slice(0, split)),
      Buffer.alloc(128 * 1024 + 17, 0x80),
      Buffer.from(bad.slice(split + 1)),
    ]),
  );
  const initial = new InitialClaudePrompt(statSync(path));
  expect(initial.take(path, pending)).toEqual({
    malformed: true,
    prompt: { turnId: "first", text: "valid native prompt" },
  });
  expect(initial.take(path, pending)).toBeUndefined();
});

test("C-API-63 an unchanged file must already contain a complete committed row", () => {
  const path = tmpFile();
  writeFileSync(path, user("first", "committed prompt") + user("pending", "incomplete").trimEnd());
  expect(new InitialClaudePrompt(statSync(path)).take(path, pending)).toEqual({
    malformed: false,
    prompt: { turnId: "first", text: "committed prompt" },
  });
  writeFileSync(path, user("pending", "incomplete").trimEnd());
  expect(new InitialClaudePrompt(statSync(path)).take(path, pending)).toEqual({
    malformed: false,
  });
});

test("C-API-63 a rewrite of the same inode cannot introduce baseline evidence", () => {
  const path = tmpFile();
  writeFileSync(path, user("first", "old prompt"));
  const before = statSync(path);
  const initial = new InitialClaudePrompt(before);
  writeFileSync(path, user("first", "new prompt"));
  utimesSync(path, new Date(0), new Date(0));
  expect(statSync(path)).toMatchObject({ ino: before.ino, size: before.size });
  expect(initial.take(path, pending)).toBeUndefined();
});

test("C-API-63 a clipped row is never decoded from its suffix", () => {
  const path = tmpFile();
  const text = user("first", "native prompt");
  writeFileSync(path, "x".repeat(1024 * 1024) + text);
  const before = statSync(path);
  expect(new InitialClaudePrompt(before).take(path, pending)).toEqual({ malformed: false });
  writeFileSync(path, `${"x".repeat(1024 * 1024)}\n${text}`);
  expect(new InitialClaudePrompt(statSync(path)).take(path, pending)).toEqual({
    malformed: false,
    prompt: { turnId: "first", text: "native prompt" },
  });
});

test("C-API-63 a valid prompt immediately outside the 1 MiB tail is excluded", () => {
  const path = tmpFile();
  const maxBytes = 1024 * 1024;
  const rowPrefix = '{"type":"assistant","message":"';
  const rowSuffix = '"}\n';
  const filler = "x".repeat(maxBytes - rowPrefix.length - rowSuffix.length + 1);
  writeFileSync(path, user("first", "outside the tail") + rowPrefix + filler + rowSuffix);
  expect(new InitialClaudePrompt(statSync(path)).take(path, pending)).toEqual({ malformed: false });
});
