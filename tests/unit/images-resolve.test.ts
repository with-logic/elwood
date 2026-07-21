/**
 * Coverage for image validation/resolution (PRD §5.3, C-API-44): validation
 * (formats, readability, count/size limits) rejects before any temp file exists;
 * resolution materializes bytes to temp files and cleans them up.
 */

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { ElwoodError } from "../../src/core/errors.ts";
import { validateImages } from "../../src/core/images/resolve.ts";
import type { ImageInput } from "../../src/core/images/types.ts";
import { imageLimits } from "../../src/core/images/types.ts";
import { tempDirForUnit } from "./helpers.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function imageCode(fn: () => Promise<unknown>): Promise<string> {
  return fn().then(
    () => "no-throw",
    (error) => (error as ElwoodError).code,
  );
}

describe("ImageInput type exclusivity (C-API-44)", () => {
  test("C-API-44 the union rejects a mixed { path, data, format } object at compile time", () => {
    // @ts-expect-error — path and data are mutually exclusive (never-typed complements),
    // so a caller cannot smuggle an unvalidated path alongside bytes.
    const mixed: ImageInput = { path: "/x.png", data: PNG, format: "png" };
    expect(mixed).toBeDefined(); // runtime is irrelevant; the ts-expect-error is the assertion
  });
});

describe("validateImages (C-API-44)", () => {
  test("C-API-44 accepts an existing file and supported byte formats, returning a snapshot", async () => {
    const dir = tempDirForUnit();
    const file = join(dir, "shot.png");
    writeFileSync(file, PNG);
    const snap = await validateImages([{ path: file }, { data: PNG, format: "jpeg" }]);
    expect(snap).toHaveLength(2);
    expect((snap[0] as { path: string }).path).toBe(file); // resolved to absolute
  });

  test("C-API-44 clones byte buffers so later caller mutation is inert", async () => {
    const bytes = Uint8Array.from(PNG);
    const [snap] = await validateImages([{ data: bytes, format: "png" }]);
    bytes[0] = 0; // mutate the caller's buffer after validation
    expect((snap as { data: Uint8Array }).data[0]).toBe(PNG[0]); // snapshot unchanged
  });

  test("C-API-44 rejects malformed JS entries with invalid_image, not a raw error", async () => {
    expect(await imageCode(() => validateImages([null as never]))).toBe("invalid_image");
    expect(await imageCode(() => validateImages([{} as never]))).toBe("invalid_image");
    expect(await imageCode(() => validateImages([{ data: "x", format: "png" } as never]))).toBe(
      "invalid_image",
    );
  });

  test("C-API-44 rejects a non-array container", async () => {
    expect(await imageCode(() => validateImages("nope" as never))).toBe("invalid_image");
    expect(await imageCode(() => validateImages(null as never))).toBe("invalid_image");
  });

  test("C-API-44 rejects a non-string path value", async () => {
    expect(await imageCode(() => validateImages([{ path: 42 } as never]))).toBe("invalid_image");
  });

  test("C-API-44 rejects an entry with BOTH path and data (non-exclusive)", async () => {
    const mixed = { path: "/x.png", data: PNG, format: "png" } as never;
    expect(await imageCode(() => validateImages([mixed]))).toBe("invalid_image");
  });

  test("C-API-44 rejects a non-Uint8Array typed-array as data", async () => {
    const wrong = { data: new Uint16Array([1, 2, 3]), format: "png" } as never;
    expect(await imageCode(() => validateImages([wrong]))).toBe("invalid_image");
  });

  test("C-API-44 rejects an oversized byte input WITHOUT cloning it", async () => {
    // The size guard MUST reject before `Uint8Array.from` duplicates the buffer
    // (OOM guard): moving the clone before the guard would keep this green while
    // reintroducing the peak-allocation risk, so assert `from` is never called.
    const big = new Uint8Array(imageLimits.maxBytesPerImage + 1);
    big[0] = 1;
    const fromSpy = vi.spyOn(Uint8Array, "from");
    try {
      expect(await imageCode(() => validateImages([{ data: big, format: "png" }]))).toBe(
        "invalid_image",
      );
      expect(fromSpy).not.toHaveBeenCalled();
    } finally {
      fromSpy.mockRestore();
    }
  });

  test("C-API-44 rejects a prototype-key format via own-key check", async () => {
    expect(
      await imageCode(() => validateImages([{ data: PNG, format: "toString" as never }])),
    ).toBe("invalid_image");
  });

  test("C-API-44 accepts inputs exactly AT each limit (inclusive bounds)", async () => {
    const atCount = Array.from({ length: imageLimits.maxCount }, () => ({
      data: PNG,
      format: "png" as const,
    }));
    await expect(validateImages(atCount)).resolves.toHaveLength(imageLimits.maxCount);
    const atSize = new Uint8Array(imageLimits.maxBytesPerImage);
    atSize[0] = 1;
    await expect(validateImages([{ data: atSize, format: "png" }])).resolves.toHaveLength(1);
  });

  test("C-API-44 rejects an unsupported byte format", async () => {
    expect(await imageCode(() => validateImages([{ data: PNG, format: "tiff" as never }]))).toBe(
      "invalid_image",
    );
  });

  test("C-API-44 rejects empty byte data", async () => {
    await expect(validateImages([{ data: new Uint8Array(0), format: "png" }])).rejects.toThrow(
      /Image data is empty/,
    );
  });

  test("C-API-44 rejects an empty path and a missing path", async () => {
    await expect(validateImages([{ path: "" }])).rejects.toThrow(/empty/);
    expect(await imageCode(() => validateImages([{ path: "/no/such/x.png" }]))).toBe(
      "invalid_image",
    );
  });

  test("C-API-44 rejects a directory (not a file)", async () => {
    const dir = tempDirForUnit();
    await expect(validateImages([{ path: dir }])).rejects.toThrow(/invalid_image|not a/);
  });

  test("C-API-44 rejects a file that is not readable", async () => {
    const dir = tempDirForUnit();
    const file = join(dir, "secret.png");
    writeFileSync(file, PNG);
    chmodSync(file, 0o000);
    try {
      expect(await imageCode(() => validateImages([{ path: file }]))).toBe("invalid_image");
    } finally {
      chmodSync(file, 0o644);
    }
  });

  test("C-API-44 rejects too many images", async () => {
    const many = Array.from({ length: imageLimits.maxCount + 1 }, () => ({
      data: PNG,
      format: "png" as const,
    }));
    await expect(validateImages(many)).rejects.toThrow(/Too many images/);
  });

  test("C-API-44 rejects a byte input over the per-image limit", async () => {
    const big = new Uint8Array(imageLimits.maxBytesPerImage + 1);
    big[0] = 1;
    await expect(validateImages([{ data: big, format: "png" }])).rejects.toThrow(/per-image/);
  });

  test("C-API-44 rejects a path whose file is over the per-image limit", async () => {
    const dir = tempDirForUnit();
    const file = join(dir, "big.png");
    writeFileSync(file, Buffer.alloc(imageLimits.maxBytesPerImage + 1));
    await expect(validateImages([{ path: file }])).rejects.toThrow(/per-image/);
  });

  test("C-API-44 rejects when the aggregate byte total is exceeded", async () => {
    const half = new Uint8Array(imageLimits.maxBytesPerImage);
    half[0] = 1;
    // Three ~25MiB images = ~75MiB > 50MiB total, but each is within per-image.
    await expect(
      validateImages([
        { data: half, format: "png" },
        { data: half, format: "png" },
        { data: half, format: "png" },
      ]),
    ).rejects.toThrow(/total/);
  });

  test("C-API-44 PATH images share the aggregate total (no byte-input bypass)", async () => {
    const dir = tempDirForUnit(); // three ~25MiB files > the shared 50MiB ceiling
    const big = Buffer.alloc(imageLimits.maxBytesPerImage);
    const paths = ["a.png", "b.png", "c.png"].map((name) => {
      const file = join(dir, name);
      writeFileSync(file, big);
      return { path: file };
    });
    await expect(validateImages(paths)).rejects.toThrow(/total/);
  });

  test("C-API-44 rejects an entry with an extra own key on either variant", async () => {
    const bytesExtra = { data: PNG, format: "png", extra: 1 } as never;
    expect(await imageCode(() => validateImages([bytesExtra]))).toBe("invalid_image");
    expect(await imageCode(() => validateImages([{ path: "/x.png", extra: 1 } as never]))).toBe(
      "invalid_image",
    );
  });
});
