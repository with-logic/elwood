/** Retained identity bytes, paths and UUID windows are bounded (PRD §5.4 / C-CLAUDE-15). */
import { expect, test } from "vitest";
import { ClaudeTranscriptTurns } from "../../src/claude/transcript/turn-identity.ts";

test("C-CLAUDE-15 UTF-8 identifier and path limits accept their inclusive boundaries", () => {
  const turns = new ClaudeTranscriptTurns();
  const path = "é".repeat(2_048);
  const uuid = "é".repeat(512);
  const promptId = "é".repeat(512);
  expect(turns.observe(path, { uuid, promptId })).toBe(promptId);
  expect(turns.observe(path, { parentUuid: uuid })).toBe(promptId);
});

test.each([
  "promptId",
  "uuid",
  "parentUuid",
])("C-CLAUDE-15 oversized UTF-8 %s disables and clears correlation for the watcher lifetime", (field) => {
  const turns = new ClaudeTranscriptTurns();
  expect(turns.observe("p", { uuid: "root", promptId: "native" })).toBe("native");
  expect(
    turns.observe("p", { uuid: "reply", promptId: "native", [field]: "é".repeat(513) }),
  ).toBeUndefined();
  expect(turns.observe("p", { parentUuid: "root" })).toBeUndefined();
  turns.forget("p");
  expect(turns.observe("new", { promptId: "new-native" })).toBeUndefined();
});

test("C-CLAUDE-15 an oversized UTF-8 path disables correlation without retaining path failures", () => {
  const turns = new ClaudeTranscriptTurns();
  expect(turns.observe("é".repeat(2_049), { promptId: "native" })).toBeUndefined();
  expect(turns.observe("small", { promptId: "native" })).toBeUndefined();
});

test("C-CLAUDE-15 the 129th identity path clears evidence and cannot restart after retirement", () => {
  const turns = new ClaudeTranscriptTurns();
  for (let index = 0; index < 128; index += 1)
    expect(turns.observe(`path-${index}`, { uuid: "root", promptId: "native" })).toBe("native");
  expect(turns.observe("overflow", { promptId: "native" })).toBeUndefined();
  expect(turns.observe("path-0", { parentUuid: "root" })).toBeUndefined();
  turns.forget("path-0");
  turns.seed("new", "native", () => ({ uuid: "new", promptId: "native" }));
  expect(turns.observe("new", { parentUuid: "new" })).toBeUndefined();
});

/** Fill exactly 1 MiB: one path byte, 511 pairs of 2048 bytes, and one 2047-byte pair. */
function fullByteBudget(promptId = "t".repeat(1_024)): {
  readonly turns: ClaudeTranscriptTurns;
  readonly promptId: string;
  readonly first: string;
} {
  const turns = new ClaudeTranscriptTurns();
  for (let index = 0; index < 511; index += 1)
    turns.observe("p", { uuid: String(index).padEnd(1_024, "x"), promptId });
  turns.observe("p", { uuid: "last".padEnd(1_023, "x"), promptId });
  return { turns, promptId, first: "0".padEnd(1_024, "x") };
}

test("C-CLAUDE-15 aggregate bytes accept equality and replacing a UUID before overflowing safely", () => {
  const { turns, promptId, first } = fullByteBudget();
  expect(turns.observe("p", { uuid: first, promptId })).toBe(promptId);
  expect(turns.observe("p", { parentUuid: first })).toBe(promptId);
  expect(turns.observe("p", { uuid: "extra", promptId: "native" })).toBeUndefined();
  expect(turns.observe("p", { parentUuid: first })).toBeUndefined();
});

test("C-CLAUDE-15 aggregate admission includes retained path bytes", () => {
  const { turns } = fullByteBudget();
  expect(turns.observe("q", { promptId: "native" })).toBeUndefined();
});

test("C-CLAUDE-15 forgetting a path releases its retained aggregate bytes", () => {
  const { turns } = fullByteBudget();
  turns.forget("p");
  turns.forget("absent");
  expect(turns.observe("q", { uuid: "root", promptId: "new-native" })).toBe("new-native");
  expect(turns.observe("q", { parentUuid: "root" })).toBe("new-native");
});

test("C-CLAUDE-15 count eviction precedes aggregate byte admission", () => {
  const turns = new ClaudeTranscriptTurns();
  const promptId = "t".repeat(128);
  for (let index = 0; index < 4_095; index += 1)
    expect(turns.observe("p", { uuid: String(index).padEnd(128, "x"), promptId })).toBe(promptId);
  expect(turns.observe("p", { uuid: "last".padEnd(127, "x"), promptId })).toBe(promptId);
  expect(turns.observe("p", { uuid: "next".padEnd(128, "x"), promptId })).toBe(promptId);
  expect(turns.observe("p", { parentUuid: "0".padEnd(128, "x") })).toBeUndefined();
  expect(turns.observe("p", { parentUuid: "1".padEnd(128, "x") })).toBe(promptId);
});

test("C-CLAUDE-15 aggregate accounting charges UTF-8 bytes for every retained turn ID", () => {
  const { turns, promptId, first } = fullByteBudget("é".repeat(512));
  expect(turns.observe("p", { parentUuid: first })).toBe(promptId);
  expect(turns.observe("p", { uuid: "extra", promptId: "native" })).toBeUndefined();
});

test("C-CLAUDE-15 aggregate accounting charges UTF-8 bytes for every retained UUID", () => {
  const turns = new ClaudeTranscriptTurns();
  const promptId = "t".repeat(1_024);
  for (let index = 0; index < 511; index += 1)
    expect(
      turns.observe("p", { uuid: String(index).padStart(4, "0") + "é".repeat(510), promptId }),
    ).toBe(promptId);
  const last = `end${"é".repeat(510)}`;
  expect(turns.observe("p", { uuid: last, promptId })).toBe(promptId);
  expect(turns.observe("p", { parentUuid: last })).toBe(promptId);
  expect(turns.observe("p", { uuid: "extra", promptId: "native" })).toBeUndefined();
});
