/** Claude answer writes require completed post-write render waits (PRD §4). */
import { expect, test } from "vitest";
import { questionNavigation } from "../../../src/claude/questions/navigation.ts";
import { definitions, fixture, registry } from "./helpers.ts";
import { scriptedQuestionIo } from "./scripted-io-helpers.ts";

test("scripted IO stages renders until the wait completes before another write", async () => {
  const initial = fixture("questions");
  const successor = fixture("color-blue-highlight");
  const { io, writes } = scriptedQuestionIo(initial, [successor]);
  await io.write("\x1b[B", () => true);
  expect(io.frame()).toBe(initial);
  expect(() => io.write("\r", () => true)).toThrow("render barrier");
  const waiting = io.wait((current) => current === successor);
  expect(io.frame()).toBe(initial);
  expect(() => io.write("\r", () => true)).toThrow("render barrier");
  await waiting;
  expect(io.frame()).toBe(successor);
  await io.write("\r", () => true);
  expect(writes).toEqual(["\x1b[B", "\r"]);
});

test("Claude navigation completes its render barrier before reading the next cursor", async () => {
  const request = registry().publish("native", "blocking", definitions)!;
  const successor = fixture("color-blue-highlight");
  const { io, writes } = scriptedQuestionIo(fixture("questions"), [successor]);
  await questionNavigation(request, 0, io).move(1);
  expect(writes).toEqual(["\x1b[B"]);
  expect(io.frame()).toBe(successor);
});
