/**
 * A held image attach keeps its bytes in memory until the session could take its input
 * (PRD §5.3, C-API-28, C-API-44). A startup screen or a dialog can hold an attach for
 * minutes; byte images are written to temp files only once that hold clears, and an
 * attach closed during the hold writes none.
 */

import { existsSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { waitUntilAttachSafe } from "../../src/core/images/chip-wait.ts";
import { unsafeWriteRetryMs } from "../../src/core/input/constants.ts";
import { png } from "../fixtures/owned-turn/attachments.ts";

const materialized = { calls: 0 };
vi.mock("../../src/core/images/materialize.ts", async (original) => {
  const actual = await original<typeof import("../../src/core/images/materialize.ts")>();
  return {
    ...actual,
    materializeImages: (...args: Parameters<typeof actual.materializeImages>) => {
      materialized.calls += 1;
      return actual.materializeImages(...args);
    },
  };
});

const { enqueueSubmission } = await import("../../src/runtime/session/image-attach.ts");

const images = [{ data: png, format: "png" }] as const;
const terminal = {
  settled: () => Promise.resolve(),
  renderFailed: false,
  sendInput: () => {},
  snapshot: () => ({ text: "› " }),
};
const retries = (count: number) =>
  new Promise((resolve) => setTimeout(resolve, unsafeWriteRetryMs * count));

test("C-API-44 a held byte image reaches the disk only once the attach could write", async () => {
  materialized.calls = 0;
  let held = true;
  const attached: string[] = [];
  const driver = (paths: readonly string[]) => {
    attached.push(...paths.filter(existsSync));
    return Promise.resolve();
  };
  const signal = new AbortController().signal;
  const writable = (attach: AbortSignal) => waitUntilAttachSafe(terminal, () => held, attach);
  const done = enqueueSubmission(images, driver, (attach) => attach!(signal), undefined, writable);
  await retries(3);
  expect(materialized.calls).toBe(0);
  expect(attached).toEqual([]);
  held = false;
  await done;
  expect(materialized.calls).toBe(1);
  expect(attached).toHaveLength(1);
  expect(existsSync(attached[0]!)).toBe(false);
});

test("C-API-44 an attach closed during the hold writes no temp file", async () => {
  materialized.calls = 0;
  const close = new AbortController();
  const driver = vi.fn(() => Promise.resolve());
  const writable = (attach: AbortSignal) => waitUntilAttachSafe(terminal, () => true, attach);
  const done = enqueueSubmission(
    images,
    driver,
    (attach) => attach!(close.signal),
    undefined,
    writable,
  );
  await retries(2);
  close.abort();
  await expect(done).rejects.toMatchObject({ code: "image_attach_failed" });
  expect(materialized.calls).toBe(0);
  expect(driver).not.toHaveBeenCalled();
});
