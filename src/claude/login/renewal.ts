/** Recognize native renewal notices without quoting terminal content (PRD §5.7, C-CLAUDE-23). */

import { emptyInputFrame } from "../../core/input/empty-frame.ts";
import type { LoginExpiringWarning } from "../../core/warnings/auth.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { claudeEmptyInputRows } from "../composer/empty-input.ts";
import { LOGIN_RECOVERY_COMMAND } from "../login-expired.ts";

const notice = /^Your login expires in (\d+) days? · run \/login to renew$/;
const marker = /^⚠\uFE0F?\s*/;
// A canonical notice with a safe-integer duration fits within this word-wrap window.
const maxNoticeLength = 128;

function noticeRows(text: string): string[] {
  const rows = text.split(/\r?\n/);
  for (let i = 0; i < rows.length; i += 1) {
    let joined = rows[i]!.trim();
    if (!/^Your\b/.test(joined.replace(marker, ""))) continue;
    for (let end = i + 1; end < rows.length && joined.length < maxNoticeLength; end += 1) {
      joined += ` ${rows[end]!.trim()}`;
      if (parseNotice(joined.replace(marker, "")) !== undefined) {
        rows.splice(i, end - i + 1, joined);
        break;
      }
    }
  }
  return rows;
}

function renewalDays(
  text: string,
  allowWelcome: boolean,
  nativeFooter: boolean,
): number | undefined {
  const rows = noticeRows(text);
  const composer = rows.findLastIndex((row) => row.startsWith("❯"));
  if (nativeFooter && claudeEmptyInputRows(rows, composer)) {
    for (const row of rows.slice(composer + 2)) {
      const footerDays = parseNotice(row.trim());
      if (footerDays !== undefined) return footerDays;
    }
  }
  if (!allowWelcome) return undefined;
  let welcome = false;
  for (const raw of rows) {
    const row = raw.trim();
    if (/^[❯⏺●•>]/.test(row)) break;
    if (/Claude Code v[\d.]+/.test(row)) welcome = true;
    if (!(welcome && marker.test(row))) continue;
    const days = parseNotice(row.replace(marker, ""));
    if (days !== undefined) return days;
  }
  return undefined;
}

export function hasNativeRenewalFooter(terminal: ElwoodTerminal): boolean {
  return (
    emptyInputFrame(terminal, (rows, cursorRow) =>
      claudeEmptyInputRows(noticeRows(rows.slice(cursorRow - 1).join("\n")), 1),
    ) !== undefined
  );
}

function parseNotice(row: string): number | undefined {
  const match = notice.exec(row);
  if (!match) return undefined;
  const days = Number(match[1]);
  return Number.isSafeInteger(days) ? days : undefined;
}

export class LoginExpiringWatcher {
  private readonly seen = new Set<number>();
  private welcomeClosed = false;

  observe(
    text: string,
    elwoodSessionId: string,
    nativeFooter = false,
  ): readonly LoginExpiringWarning[] {
    const days = renewalDays(text, !this.welcomeClosed, nativeFooter);
    this.welcomeClosed ||= /(?:^|\n)\s*[❯⏺●•>]/.test(text);
    if (days === undefined || this.seen.has(days)) return [];
    this.seen.add(days);
    return [
      {
        elwoodSessionId,
        agent: "claude",
        source: "terminal",
        code: "login_expiring",
        severity: "warning",
        expiresInDays: days,
        recoveryCommand: LOGIN_RECOVERY_COMMAND,
        message: `Claude's login expires in ${days} ${days === 1 ? "day" : "days"}. Run /login (or session.login()) to renew.`,
        raw: `login_expiring days=${days} recovery=/login`,
      },
    ];
  }
}
