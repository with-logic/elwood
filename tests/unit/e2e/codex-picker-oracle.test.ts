/** Independent native Codex catalog checks traverse both ends and cancel (C-API-23/24). */
import { expect, onTestFinished, test, vi } from "vitest";
import { nativeCodexTarget, readCodexPicker } from "../../e2e/codex-picker-oracle.ts";
import { capturedFrame } from "../../helpers/captured-frames.ts";

const labels = [
  "GPT-6.2-Sol",
  "GPT-6.2-Astra",
  "GPT-6.1 Terra",
  "GPT-6.1-Sol",
  "GPT-6-Astra",
  "GPT-6-Sol",
  "GPT-6-Luna",
  "GPT-5.6-Sol",
  "GPT-5.6-Terra",
  "GPT-5.6-Luna",
];
const models = labels.map((label, index) => ({
  label,
  id: label.toLowerCase().replace(/\s+/g, "-"),
  isCurrent: index === 0,
  isDefault: false,
  raw: "",
}));

function nativePicker(cursor: number, frozen = false) {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const fixtureRows = (name: string) =>
    capturedFrame(`codex-0.169.0/model-picker/${name}`)
      .split("\n")
      .filter((line) => /^\s*(?:›\s*)?\d+\./.test(line));
  const rows = [...fixtureRows("top"), ...fixtureRows("bottom").slice(-2)];
  const inputs: string[] = [];
  let selected = cursor;
  let text = "› Ask Codex to do anything";
  const render = () => {
    const offset = Math.max(0, selected - 7);
    return [
      "Select Model and Effort",
      offset > 0 ? "↑" : "",
      ...rows
        .slice(offset, offset + 8)
        .map((line, index) =>
          line.replace(/^\s*(?:›\s*)?/, offset + index === selected ? "› " : "  "),
        ),
      offset + 8 < rows.length ? "↓" : "",
      "enter select · esc back",
    ].join("\n");
  };
  return {
    inputs,
    terminal: { snapshot: () => ({ text }) },
    sendKeys: (input: string) => {
      inputs.push(input);
      if (input === "/model") text = "› /model";
      if (input === "\r") text = render();
      if (input === "\u001b") text = "› Ask Codex to do anything";
      if (!frozen && (input === "\u001b[A" || input === "\u001b[B")) {
        selected += input === "\u001b[A" ? -1 : 1;
        if (selected < 0 || selected >= rows.length) throw new Error("Native picker wrapped");
        text = render();
      }
      return Promise.resolve();
    },
  };
}

test.each([
  0, 9,
])("C-API-23 native Codex oracle reads every ordered row from cursor %i", async (cursor) => {
  const session = nativePicker(cursor);
  const assertion = expect(readCodexPicker(session)).resolves.toEqual({
    labels,
    initiallyVisibleLabels: labels.slice(cursor === 0 ? 0 : 2, cursor === 0 ? 8 : 10),
  });
  await vi.runAllTimersAsync();
  await assertion;
  expect(session.inputs.at(-1)).toBe("\u001b");
  expect(session.inputs.filter((input) => input === "\r")).toHaveLength(1);
  expect(session.inputs.includes("\u001b[A")).toBe(cursor !== 0);
});

test("C-API-24 native Codex verification chooses a model outside the opening window", async () => {
  const session = nativePicker(0);
  const assertion = expect(nativeCodexTarget(session, models)).resolves.toMatchObject({
    id: "gpt-5.6-luna",
  });
  await vi.runAllTimersAsync();
  await assertion;
});

test.each([
  { listing: models.slice(0, 8) },
  { listing: [...models].reverse() },
])("C-API-23 native comparison rejects an incomplete or reordered listing %#", async ({
  listing,
}) => {
  const session = nativePicker(0);
  const outcome = nativeCodexTarget(session, listing).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  expect(await outcome).toMatchObject({
    error: { message: expect.stringContaining("complete native picker order") },
  });
  expect(session.inputs.at(-1)).toBe("\u001b");
});

test("C-API-23 a stalled native Codex walk hits its deadline and still cancels", async () => {
  const session = nativePicker(0, true);
  const assertion = expect(readCodexPicker(session)).rejects.toThrow("settled native Codex picker");
  await vi.runAllTimersAsync();
  await assertion;
  expect(session.inputs.at(-1)).toBe("\u001b");
});
