/** Recognize native renewal notices without quoting terminal content (PRD §5.7, C-CLAUDE-23). */

import { emptyInputFrame } from "../../core/input/empty-frame.ts";
import type { LoginExpiringWarning } from "../../core/warnings/auth.ts";
import type { ElwoodTerminal, TerminalSnapshot } from "../../terminal/headless.ts";
import { claudeEmptyInputRows } from "../composer/empty-input.ts";
import { LOGIN_RECOVERY_COMMAND } from "../login-expired.ts";
import { loginRenewalNotice } from "./notice.ts";

const marker = /^⚠\uFE0F?\s*/;
// A canonical notice with a safe-integer duration fits within this word-wrap window.
const maxNoticeLength = 128;

function noticeRows(screenRows: readonly string[]): string[] {
  const rows = [...screenRows];
  for (let i = 0; i < rows.length; i += 1) {
    let joined = rows[i]!.trim();
    if (!/^Your\b/.test(joined.replace(marker, ""))) continue;
    for (let end = i + 1; end < rows.length && joined.length < maxNoticeLength; end += 1) {
      joined += ` ${rows[end]!.trim()}`;
      if (parseNotice(joined.replace(marker, "")) !== undefined) {
        // Preserve physical row indices for cursor-verified composer geometry.
        rows[i] = joined;
        rows.fill("", i + 1, end + 1);
        break;
      }
    }
  }
  return rows;
}

function renewalDays(
  rows: readonly string[],
  allowWelcome: boolean,
  nativeEmptyComposerFrame: boolean,
): number | undefined {
  const composer = rows.findLastIndex((row) => row.startsWith("❯"));
  if (nativeEmptyComposerFrame && claudeEmptyInputRows(rows, composer)) {
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

/** Requires the visible input cursor on the same completed native empty-composer frame. */
function hasNativeEmptyComposerFrame(terminal: ElwoodTerminal, rows: readonly string[]): boolean {
  return (
    emptyInputFrame(terminal, (_frameRows, cursorRow) =>
      claudeEmptyInputRows(rows.slice(cursorRow - 1), 1),
    ) !== undefined
  );
}

function parseNotice(row: string): number | undefined {
  const match = loginRenewalNotice.exec(row);
  if (!match) return undefined;
  const days = Number(match[1]);
  return Number.isSafeInteger(days) ? days : undefined;
}

export class LoginExpiringWatcher {
  private readonly seen = new Set<number>();
  private welcomeClosed = false;

  /** Full rendered screen input; each countdown is emitted once for this watcher's lifetime. */
  observe(
    screenText: string,
    elwoodSessionId: string,
    nativeEmptyComposerFrame = false,
  ): readonly LoginExpiringWarning[] {
    return this.observeRows(
      noticeRows(screenText.split(/\r?\n/)),
      elwoodSessionId,
      nativeEmptyComposerFrame,
    );
  }

  /** Normalize one captured screen once for notice parsing and live composer verification. */
  observeFrame(
    screen: TerminalSnapshot,
    elwoodSessionId: string,
    terminal: ElwoodTerminal,
  ): readonly LoginExpiringWarning[] {
    const rows = noticeRows(screen.lines);
    return this.observeRows(rows, elwoodSessionId, hasNativeEmptyComposerFrame(terminal, rows));
  }

  private observeRows(
    rows: readonly string[],
    elwoodSessionId: string,
    nativeEmptyComposerFrame: boolean,
  ): readonly LoginExpiringWarning[] {
    const days = renewalDays(rows, !this.welcomeClosed, nativeEmptyComposerFrame);
    this.welcomeClosed ||= rows.some((row) => /^\s*[❯⏺●•>]/.test(row));
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
        message: `Claude's login expires in ${days} ${days === 1 ? "day" : "days"}. Run ${LOGIN_RECOVERY_COMMAND} (or session.login()) to renew.`,
        raw: `login_expiring days=${days} recovery=${LOGIN_RECOVERY_COMMAND}`,
      },
    ];
  }
}
