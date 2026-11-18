/** Codex model IDs remain directly usable as launch/switch selectors (C-API-23/41). */
import { expectTypeOf, test } from "vitest";
import type { CodexSession, CodexSessionApi, listCodexModels } from "../../src/index.ts";

test("C-API-23 Codex-specific model listings retain non-null string IDs", () => {
  type ListedId<F extends (...args: never[]) => unknown> =
    Awaited<ReturnType<F>> extends readonly { readonly id: infer Id }[] ? Id : never;
  expectTypeOf<ListedId<typeof listCodexModels>>().toEqualTypeOf<string>();
  expectTypeOf<ListedId<CodexSessionApi["listModels"]>>().toEqualTypeOf<string>();
  expectTypeOf<ListedId<CodexSession["listModels"]>>().toEqualTypeOf<string>();
});
