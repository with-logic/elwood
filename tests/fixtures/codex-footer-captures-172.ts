/**
 * Codex 0.172.0 Plan-mode footers, captured 2026-11-25 on macOS (C-CODEX-26). Each is the
 * composer region, from the composer row to the hint row, of a real session with a private
 * `CODEX_HOME`: a `CodexSession` after `/plan` at `cols` columns, or a direct launch after a
 * Plan-mode turn. Every session showed a warnings badge (an Elwood session's includes Codex
 * ignoring the `hookTrust` flag), and 0.172 draws the Plan-mode badge in front of it, in its
 * short form at 60 columns and below and, at times, at 140.
 */
import type { CapturedFooter } from "./codex-footer-captures-170.ts";

/** None of these status footers wrapped: 0.172 shows only the model and effort. */
export const codexPlanModeFooters172: readonly CapturedFooter[] = [
  {
    shape: "after `/plan`, three warnings",
    cols: 140,
    wrapped: false,
    rows: [
      "› Ask Codex to do anything",
      " ",
      "  GPT-6-Luna medium",
      "  ← for agents · ? for shortcuts                                                      Plan mode (⇧tab to cycle) · ⚠ 3 warnings · f2 to view",
    ],
  },
  {
    shape: "after `/plan`, three warnings",
    cols: 100,
    wrapped: false,
    rows: [
      "› Ask Codex to do anything",
      " ",
      "  GPT-6-Luna medium",
      "  ← for agents · ? for shortcuts              Plan mode (⇧tab to cycle) · ⚠ 3 warnings · f2 to view",
    ],
  },
  {
    shape: "after `/plan`, three warnings",
    cols: 80,
    wrapped: false,
    rows: [
      "› Ask Codex to do anything",
      " ",
      "  GPT-6-Luna medium",
      "  ← for agents            Plan mode (⇧tab to cycle) · ⚠ 3 warnings · f2 to view",
    ],
  },
  {
    shape: "after `/plan`, three warnings",
    cols: 60,
    wrapped: false,
    rows: [
      "› Ask Codex to do anything",
      " ",
      "  GPT-6-Luna medium",
      "  ← for agents        Plan mode · ⚠ 3 warnings · f2 to view",
    ],
  },
  {
    shape: "after `/plan`, three warnings",
    cols: 50,
    wrapped: false,
    rows: [
      "› Ask Codex to do anything",
      " ",
      "  GPT-6-Luna medium",
      "  ← for agents               Plan mode · ⚠ 3 · f2",
    ],
  },
  {
    shape: "after `/plan`, three warnings",
    cols: 40,
    wrapped: false,
    rows: [
      "› Ask Codex to do anything",
      " ",
      "  GPT-6-Luna medium",
      "  ← for agents     Plan mode · ⚠ 3 · f2",
    ],
  },
  {
    shape: "after a Plan-mode turn, one warning",
    cols: 140,
    wrapped: false,
    rows: [
      "› Ask Codex to do anything",
      " ",
      "  GPT-6-Luna medium",
      "  ← for agents · ? for shortcuts                                                       Plan mode (⇧tab to cycle) · ⚠ 1 warning · f2 to view",
    ],
  },
  {
    shape: "after a Plan-mode turn, one warning, short badge",
    cols: 140,
    wrapped: false,
    rows: [
      "› Ask Codex to do anything",
      " ",
      "  GPT-6-Luna medium",
      "  ← for agents · ? for shortcuts                                                                       Plan mode · ⚠ 1 warning · f2 to view",
    ],
  },
];
