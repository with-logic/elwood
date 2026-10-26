/**
 * `shellQuote` makes any argument one word that a POSIX shell reads back unchanged (PRD §4.2,
 * §9.2): a real `/bin/sh` prints each quoted value as it was, embedded single quotes included.
 */

import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { shellQuote } from "../../src/runtime/shell-quote.ts";

test.each([
  "it's",
  "'",
  "''",
  "'\\''",
  "",
  "two words",
  '$HOME `id` "x" \\n',
  "line\nbreak",
  "-n",
])("a real shell reads %j back unchanged", (value) => {
  const printed = execFileSync("/bin/sh", ["-c", `printf '%s' ${shellQuote(value)}`], {
    encoding: "utf8",
  });
  expect(printed).toBe(value);
});

test("an embedded single quote closes the quoting, is escaped, and reopens it", () => {
  expect(shellQuote("it's")).toBe("'it'\\''s'");
});
