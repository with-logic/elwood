/** Picker keys revalidate the live screen at write time (PRD §5.3, C-API-23/24). */
import { expect, test } from "vitest";
import { sendPickerInput } from "../../src/core/models/input.ts";
import type { ModelPickerIo } from "../../src/core/models/picker.ts";

test("C-API-24 navigation refuses a replaced picker or unrelated blocking dialog", async () => {
  let text = "picker";
  let blocked = false;
  const writes: string[] = [];
  const io: ModelPickerIo = {
    terminal: {
      snapshot: () => ({ text }),
      sendInput: (key) => {
        writes.push(String(key));
      },
    },
    blocked: () => blocked,
    submit: async () => {},
  };
  const expected = (screen: string) => screen === "picker";
  await sendPickerInput(io, "s", expected);
  expect(writes).toEqual(["s"]);
  blocked = true;
  expect(() => sendPickerInput(io, "\r", expected)).toThrowError(
    expect.objectContaining({ code: "model_automation_failed" }),
  );
  blocked = false;
  text = "different screen";
  expect(() => sendPickerInput(io, "\r", expected)).toThrow();
  expect(writes).toEqual(["s"]);
});
test("C-API-24 first-party confirmation ownership still revalidates its exact frame", async () => {
  let text = "owned cache warning";
  const writes: string[] = [];
  const io: ModelPickerIo = {
    terminal: {
      snapshot: () => ({ text }),
      sendInput: (key) => {
        writes.push(String(key));
      },
    },
    blocked: () => true,
    submit: async () => {},
  };
  const expected = (screen: string) => screen === "owned cache warning";
  await sendPickerInput(io, "\r", expected, true);
  text = "permission dialog";
  expect(() => sendPickerInput(io, "\r", expected, true)).toThrow();
  expect(writes).toEqual(["\r"]);
});
