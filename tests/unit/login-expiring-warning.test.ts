/** Native renewal notice parsing and privacy (PRD §5.7, C-CLAUDE-23). */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { LoginExpiringWatcher } from "../../src/claude/login/renewal.ts";

const renewal = "Your login expires in 1 day · run /login to renew";
const welcome = (row: string) => `Claude Code v2.1.305\n${row}`;
const footer = (row: string) => `───\n❯ \n───\n  ⏸ manual mode on\n${row}`;
const observe = (text: string) => new LoginExpiringWatcher().observe(text, "session", true);

test("C-CLAUDE-23 recognizes the captured native banner and current empty-composer footer", () => {
  const capture = readFileSync(
    new URL("../fixtures/claude-2.1.281/working.txt", import.meta.url),
    "utf8",
  );
  expect(observe(capture)).toMatchObject([{ code: "login_expiring", expiresInDays: 1 }]);
  expect(observe(footer(renewal))).toMatchObject([{ expiresInDays: 1 }]);
  expect(observe(welcome(`⚠️ ${renewal}`))).toMatchObject([{ expiresInDays: 1 }]);
  expect(observe(welcome(`⚠ ${renewal.replace("1 day", "0 days")}`))).toMatchObject([
    { expiresInDays: 0 },
  ]);
  const current = `${welcome(`⚠ ${renewal.replace("1 day", "3 days")}`)}\n${footer(renewal)}`;
  expect(observe(current)).toMatchObject([{ expiresInDays: 1 }]);
});

test("C-CLAUDE-23 joins wrapped native notices", () => {
  const wrapped = renewal.replace(" · run", "\n  · run");
  expect(observe(welcome(`⚠ ${wrapped}`))).toMatchObject([{ expiresInDays: 1 }]);
  expect(observe(footer(wrapped))).toMatchObject([{ expiresInDays: 1 }]);
  const narrow = "Your login expires in\n1 day · run /login\nto renew";
  expect(observe(welcome(`⚠ ${narrow}`))).toMatchObject([{ expiresInDays: 1 }]);
  expect(observe(footer(narrow))).toMatchObject([{ expiresInDays: 1 }]);
});

test("C-CLAUDE-23 conversation boundaries permanently retire welcome recognition", () => {
  const watcher = new LoginExpiringWatcher();
  expect(watcher.observe(welcome("⏺ assistant response"), "session")).toEqual([]);
  expect(watcher.observe(welcome(`⚠ ${renewal}`), "session")).toEqual([]);
  expect(watcher.observe(footer(renewal), "session", true)).toMatchObject([{ expiresInDays: 1 }]);
});

test.each([
  renewal,
  `⚠ ${renewal}`,
  welcome(renewal),
  welcome(`❯ quote this:\n⚠ ${renewal}`),
  `⏺ quote:\n${welcome(`⚠ ${renewal}`)}`,
  welcome(`⚠ ${renewal}\nprivate`).replace("1 day", "9007199254740992 days"),
  welcome(`⚠ ${renewal}`).replace("1 day", "-1 days"),
  welcome(`⚠ ${renewal}`).replace("1 day", "1.5 days"),
  welcome(`⚠ ${renewal}`).replace("to renew", "to sign in"),
  footer(renewal).replace("❯ ", `❯ ${renewal}`),
  footer("no warning"),
  "",
  welcome(`⚠ Your ${"x".repeat(128)}\nnot a notice`),
])("C-CLAUDE-23 ignores quoted, malformed or unrelated text: %s", (text) => {
  expect(observe(text)).toEqual([]);
});
