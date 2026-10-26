/**
 * Coverage for removing an image attach's temp files when its attach is aborted (PRD
 * §5.3, §8.4, C-API-44): an abort removes them synchronously, before the adapter's
 * attach driver unwinds, and so does an abort that lands while they are still being
 * written. `removeNow` is idempotent, a no-op without a temp dir, and a failed removal
 * stays for the attach's own cleanup to retry.
 */

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest";
import { materializeImages } from "../../src/core/images/materialize.ts";
import type { AttachDriver } from "../../src/runtime/session/image-attach.ts";
import { enqueueSubmission } from "../../src/runtime/session/image-attach.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const images = [{ data: PNG, format: "png" }] as const;

afterEach(() => {
  vi.doUnmock("node:fs");
  vi.resetModules();
});

describe("image temps on abort (C-API-44)", () => {
  test("C-API-44 an abort mid-attach removes the temp image before the driver unwinds", async () => {
    const controller = new AbortController();
    let file = "";
    let release = () => {};
    const driver: AttachDriver = (paths) => {
      file = paths[0] as string;
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const done = enqueueSubmission(images, driver, (attach) => attach!(controller.signal));
    await expect.poll(() => file).not.toBe("");
    expect(existsSync(file)).toBe(true);
    controller.abort();
    expect(existsSync(dirname(file))).toBe(false); // gone synchronously, inside abort()
    release();
    await done;
  });

  test("C-API-44 an abort that landed while writing removes the temp image before the driver runs", async () => {
    const controller = new AbortController();
    controller.abort(); // already aborted when the materialized files come back
    let existedAtDriver: boolean | undefined;
    const driver: AttachDriver = (paths) => {
      existedAtDriver = existsSync(paths[0] as string);
      return Promise.resolve();
    };
    await enqueueSubmission(images, driver, (attach) => attach!(controller.signal));
    expect(existedAtDriver).toBe(false);
  });

  test("C-API-44 removeNow is idempotent and leaves nothing for cleanup to do", async () => {
    const { paths, cleanup, removeNow } = await materializeImages(images);
    removeNow();
    expect(existsSync(dirname(paths[0] as string))).toBe(false);
    removeNow(); // no temp dir any more: a no-op
    await cleanup();
  });

  test("C-API-44 a failed removeNow never throws and the attach's cleanup still removes the dir", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async () => ({
      ...(await vi.importActual<typeof import("node:fs")>("node:fs")),
      rmSync: () => {
        throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
      },
    }));
    const { materializeImages: mocked } = await import("../../src/core/images/materialize.ts");
    const { paths, cleanup, removeNow } = await mocked(images);
    onTestFinished(cleanup);
    expect(() => removeNow()).not.toThrow();
    const dir = dirname(paths[0] as string);
    expect(existsSync(dir)).toBe(true); // kept for cleanup to retry
    await cleanup(); // the async removal is unaffected by the failed sync one
    expect(existsSync(dir)).toBe(false);
  });
});
