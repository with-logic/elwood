/** Real early-exiting clipboard reader containment (PRD §5.3, C-API-46). */
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFile = () => actual.execFile("/usr/bin/false");
  Object.defineProperty(execFile, promisify.custom, {
    value: () => promisify(actual.execFile)("/usr/bin/false"),
  });
  return { ...actual, execFile };
});

const { restoreClipboardText } = await import("../../src/codex/images/clipboard.ts");

test("C-API-46 a real reader exiting before a large write never raises unhandled EPIPE", async () => {
  await expect(restoreClipboardText("x".repeat(1024 * 1024))).resolves.toBe(false);
});
