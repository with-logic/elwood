/** Proactive Claude authentication diagnostics (PRD §5.7, C-CLAUDE-23). */
export type LoginExpiringWarning = {
  readonly elwoodSessionId: string;
  readonly agent: "claude";
  readonly source: "terminal";
  readonly code: "login_expiring";
  readonly severity: "warning";
  readonly message: string;
  /** CLI-reported duration, not an exact expiry timestamp. */
  readonly expiresInDays: number;
  readonly recoveryCommand: "/login";
  readonly raw: string;
};

/** Login lapsed after readiness; the session stays alive for recovery (C-CLAUDE-18). */
export type LoginExpiredWarning = {
  readonly elwoodSessionId: string;
  readonly agent: "claude";
  readonly source: "terminal";
  readonly code: "login_expired";
  readonly severity: "warning";
  readonly message: string;
  readonly recoveryCommand: "/login";
  readonly raw: string;
};
