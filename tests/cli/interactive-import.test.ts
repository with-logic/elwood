/** Interactive mode must not load headless session runtimes (PRD §12A.9, C-CLI-25). */
import { expect, test, vi } from "vitest";
import { parseCliArgs } from "../../src/cli/args/index.ts";
import { runDefaultInteractive } from "../../src/cli/main.ts";
import { mainHarness } from "./main-fakes.ts";

// A forbidden dependency fails immediately instead of depending on machine-speed timing.
vi.mock("../../src/cli/session/launch.ts", () => {
  throw new Error("Interactive mode loaded headless session launch.");
});

test("C-CLI-25 interactive rejects non-TTY input without loading headless sessions", async () => {
  const parsed = parseCliArgs(["interactive"]);
  if (parsed.command !== "interactive") throw new Error("expected interactive command");
  await expect(runDefaultInteractive(parsed, mainHarness().context)).rejects.toThrow(
    "interactive requires terminal stdin and stdout.",
  );
});
