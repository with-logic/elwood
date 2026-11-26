/**
 * Codex 0.172.0 Plan-mode footers, captured 2026-11-25 on macOS (C-CODEX-26). Each is the
 * composer region of a real `CodexSession` with a private `CODEX_HOME`, after `/plan`, at
 * `cols` columns. Every Elwood session carries the warnings badge (Codex ignores Elwood's
 * `hookTrust` session flag), and 0.172 draws the Plan-mode badge in front of it.
 */
export type PlanModeFooter = {
  /** The terminal's width when Codex drew the rows. */
  readonly cols: number;
  readonly rows: readonly string[];
};

export const codexPlanModeFooters172: readonly PlanModeFooter[] = [
  {
    cols: 140,
    rows: [
      "› Ask Codex to do anything",
      "",
      "  GPT-6-Luna medium",
      "  ← for agents · ? for shortcuts                                                      Plan mode (⇧tab to cycle) · ⚠ 3 warnings · f2 to view",
    ],
  },
  {
    cols: 100,
    rows: [
      "› Ask Codex to do anything",
      "",
      "  GPT-6-Luna medium",
      "  ← for agents · ? for shortcuts              Plan mode (⇧tab to cycle) · ⚠ 3 warnings · f2 to view",
    ],
  },
  {
    cols: 80,
    rows: [
      "› Ask Codex to do anything",
      "",
      "  GPT-6-Luna medium",
      "  ← for agents            Plan mode (⇧tab to cycle) · ⚠ 3 warnings · f2 to view",
    ],
  },
  {
    cols: 60,
    rows: [
      "› Ask Codex to do anything",
      "",
      "  GPT-6-Luna medium",
      "  ← for agents        Plan mode · ⚠ 3 warnings · f2 to view",
    ],
  },
  {
    cols: 50,
    rows: [
      "› Ask Codex to do anything",
      "",
      "  GPT-6-Luna medium",
      "  ← for agents               Plan mode · ⚠ 3 · f2",
    ],
  },
  {
    cols: 40,
    rows: [
      "› Ask Codex to do anything",
      "",
      "  GPT-6-Luna medium",
      "  ← for agents     Plan mode · ⚠ 3 · f2",
    ],
  },
];
