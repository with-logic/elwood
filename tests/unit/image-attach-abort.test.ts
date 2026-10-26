/**
 * Coverage for removing an image attach's temp files when its attach is aborted (PRD
 * §5.3, §8.4, C-API-44). Materialization watches the attach's abort signal from the
 * moment its temp dir exists: an abort removes the dir synchronously, whether it lands
 * while a write is still in flight or while the adapter's attach driver runs. An attach
 * already aborted writes nothing, an abort removes nothing that is not the attach's own
 * temp dir, and a removal that fails at abort stays for the attach's cleanup to retry.
 */

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest";
import { materializeImages } from "../../src/core/images/materialize.ts";
import type { AttachDriver } from "../../src/runtime/session/image-attach.ts";
import { enqueueSubmission } from "../../src/runtime/session/image-attach.ts";
import { png } from "../fixtures/owned-turn/attachments.ts";
import { tempDir } from "../helpers/tmp.ts";

const images = [{ data: png, format: "png" }] as const;

afterEach(() => {
  vi.doUnmock("node:fs");
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
});

/** `node:fs/promises` with each `name` call held until `release`, recording its path. */
function hold(name: "writeFile" | "rm") {
  const held = { path: "", release: () => {} };
  const gate = new Promise<void>((resolve) => {
    held.release = resolve;
  });
  vi.doMock("node:fs/promises", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const original = actual[name] as (path: string, ...rest: unknown[]) => Promise<void>;
    const heldCall = (path: string, ...rest: unknown[]) => {
      held.path = path;
      return gate.then(() => original(path, ...rest));
    };
    return { ...actual, [name]: heldCall };
  });
  return held;
}

describe("image temps on abort (C-API-44)", () => {
  test("C-API-44 an abort mid-attach removes the temp image before the driver unwinds", async () => {
    const controller = new AbortController();
    let file = "";
    let release = () => {};
    const driver: AttachDriver = (paths, signal) => {
      file = paths[0] as string;
      if (signal.aborted) return Promise.resolve(); // only when an assertion below failed
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const done = enqueueSubmission(images, driver, (attach) => attach!(controller.signal));
    try {
      await expect.poll(() => file).not.toBe("");
      expect(existsSync(file)).toBe(true);
      controller.abort();
      expect(existsSync(dirname(file))).toBe(false); // gone synchronously, inside abort()
    } finally {
      controller.abort();
      release();
      await done.catch(() => undefined);
    }
  });

  test("C-API-44 an abort while a write is in flight removes the temp dir at once", async () => {
    const held = hold("writeFile");
    const { materializeImages: mocked } = await import("../../src/core/images/materialize.ts");
    const controller = new AbortController();
    const writing = mocked(images, controller.signal);
    const settled = writing.then(
      (materialized) => materialized,
      () => undefined,
    );
    try {
      await expect.poll(() => held.path).not.toBe("");
      expect(existsSync(dirname(held.path))).toBe(true); // the write has not landed yet
      controller.abort();
      expect(existsSync(dirname(held.path))).toBe(false); // gone synchronously, inside abort()
    } finally {
      controller.abort();
      held.release(); // the held write now lands in a removed dir
      await (await settled)?.cleanup();
    }
    await expect(writing).rejects.toMatchObject({ code: "image_attach_failed" });
    expect(existsSync(dirname(held.path))).toBe(false);
  });

  test("C-API-44 an abort while cleanup's removal is pending still removes the dir at once", async () => {
    const held = hold("rm");
    const { materializeImages: mocked } = await import("../../src/core/images/materialize.ts");
    const controller = new AbortController();
    const { paths, cleanup } = await mocked(images, controller.signal);
    const dir = dirname(paths[0] as string);
    const removing = cleanup();
    try {
      await expect.poll(() => held.path).toBe(dir);
      controller.abort();
      expect(existsSync(dir)).toBe(false); // gone synchronously, inside abort()
    } finally {
      held.release();
      await removing;
    }
    expect(existsSync(dir)).toBe(false);
  });

  test("C-API-44 an attach aborted before it materializes writes nothing", async () => {
    let made = 0;
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      const mkdtempSync = (prefix: string) => {
        made++;
        return actual.mkdtempSync(prefix);
      };
      return { ...actual, mkdtempSync };
    });
    const { materializeImages: mocked } = await import("../../src/core/images/materialize.ts");
    const controller = new AbortController();
    controller.abort(new Error("session closed"));
    await expect(mocked(images, controller.signal)).rejects.toThrow("session closed");
    expect(made).toBe(0);
  });

  test("C-API-44 an abort without a temp dir removes nothing, not even the caller's image", async () => {
    const dir = tempDir("elwood-caller-image-");
    const file = join(dir, "mine.png");
    writeFileSync(file, png);
    const controller = new AbortController();
    const { cleanup } = await materializeImages([{ path: file }], controller.signal);
    controller.abort();
    await cleanup();
    expect(readdirSync(dir)).toEqual(["mine.png"]);
  });

  test("C-API-44 a failed removal at abort never throws and cleanup still removes the dir", async () => {
    vi.doMock("node:fs", async () => ({
      ...(await vi.importActual<typeof import("node:fs")>("node:fs")),
      rmSync: () => {
        throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
      },
    }));
    const { materializeImages: mocked } = await import("../../src/core/images/materialize.ts");
    const controller = new AbortController();
    const { paths, cleanup } = await mocked(images, controller.signal);
    onTestFinished(cleanup);
    expect(() => controller.abort()).not.toThrow();
    const dir = dirname(paths[0] as string);
    expect(existsSync(dir)).toBe(true); // kept for cleanup to retry
    await cleanup(); // the async removal is unaffected by the failed sync one
    expect(existsSync(dir)).toBe(false);
  });
});
