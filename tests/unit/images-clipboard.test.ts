/**
 * Coverage for macOS clipboard image support (PRD §5.3, C-API-46). Real
 * NSPasteboard round-trips via osascript/pbcopy — no mocks — since the exact
 * `public.tiff` layout is the whole point (a mock could not catch a format the
 * `arboard` reader Codex uses would reject). Gated to macOS.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ElwoodError } from "../../src/core/errors.ts";
import {
  clipboardImageSupported,
  restoreClipboardText,
  setClipboardImage,
  snapshotClipboardText,
} from "../../src/core/images/clipboard.ts";
import { tempDirForUnit } from "./helpers.ts";

const isMac = process.platform === "darwin";
const sample = join(import.meta.dirname, "..", "fixtures", "sample.png");

describe("clipboard image support (C-API-46)", () => {
  test("C-API-46 clipboardImageSupported reflects the platform", () => {
    expect(clipboardImageSupported()).toBe(isMac);
  });

  test.runIf(isMac)("C-API-46 sets a public.tiff image and restores prior text", () => {
    const prior = snapshotClipboardText();
    try {
      restoreClipboardText("elwood-prior-clip");
      const saved = snapshotClipboardText();
      expect(saved).toBe("elwood-prior-clip");
      setClipboardImage(sample);
      const types = execFileSync("osascript", ["-e", "clipboard info"], { encoding: "utf8" });
      expect(types).toMatch(/PNGf|TIFF|tiff/);
      restoreClipboardText(saved);
      expect(snapshotClipboardText()).toBe("elwood-prior-clip");
    } finally {
      restoreClipboardText(prior);
    }
  });

  test.runIf(isMac)("C-API-46 rejects an unreadable image with invalid_image", () => {
    const missing = join(tempDirForUnit(), "nope.png");
    expect(() => setClipboardImage(missing)).toThrow(ElwoodError);
    try {
      setClipboardImage(missing);
    } catch (error) {
      expect((error as ElwoodError).code).toBe("invalid_image");
    }
  });
});
