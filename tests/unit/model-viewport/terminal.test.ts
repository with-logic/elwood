/** The native picker fixture rejects impossible selections (C-API-24 test support). */
import { expect, test } from "vitest";
import { viewportTerminal } from "./terminal.ts";

test("the viewport fixture rejects an out-of-range selection without changing the model", () => {
  const { terminal, state } = viewportTerminal("claude");
  state.cursor = 99;
  expect(() => terminal.sendInput("s")).toThrow("Picker selection is out of range");
  expect(state.selected).toBe(2);
});
