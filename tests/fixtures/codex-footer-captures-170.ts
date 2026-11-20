/**
 * Sanitized Codex 0.170.0 footers, captured 2026-11-19 on macOS (C-CODEX-26). Each is the
 * composer region of a real session that `startCodex` launched at `cols` columns, with a
 * private `CODEX_HOME` and a loopback Responses provider (no model quota). Captures after
 * one turn carry the thread name. The temp-folder id and random suffix were replaced with
 * text of the same length, so every row length and break point is as Codex drew it.
 */
export type CapturedFooter = {
  readonly shape: string;
  /** The terminal's width when Codex drew the rows. */
  readonly cols: number;
  /** Whether Codex wrapped the status footer onto continuation rows. */
  readonly wrapped: boolean;
  readonly rows: readonly string[];
};

export const codexFooterCaptures170: readonly CapturedFooter[] = [
  {
    shape: "long directory and thread name, two status rows",
    cols: 160,
    wrapped: true,
    rows: [
      "› Ask Codex to do anything",
      "",
      "  GPT-6-Astra default · /var/folders/00/temporary_folder_identifier_00/T/elwood_capture-CAPTUR/workspace/area-0123456789abcdef/group-fedcba9876543210/nested-",
      "  0123456789abcdef-fedcba9876543210/tasks-0123456789abcdef/item-fedcba9876543210/checkout · [note:first] You are an example, working on a long task tha…",
      "  ← for agents · ? for shortcuts                                                                                                      ⚠ 3 warnings · f2 to view",
    ],
  },
  {
    shape: "long directory and thread name, three status rows",
    cols: 100,
    wrapped: true,
    rows: [
      "› Ask Codex to do anything",
      "",
      "  GPT-6-Astra default · /var/folders/00/temporary_folder_identifier_00/T/elwood_capture-CAPTUR/",
      "  workspace/area-0123456789abcdef/group-fedcba9876543210/nested-0123456789abcdef-fedcba9876543210/",
      "  tasks-0123456789abcdef/item-fedcba9876543210/checkout · [note:first] You are an example, working…",
      "  ← for agents · ? for shortcuts                                          ⚠ 3 warnings · f2 to view",
    ],
  },
  {
    shape: "long directory cut with an ellipsis after three rows",
    cols: 80,
    wrapped: true,
    rows: [
      "› Ask Codex to do anything",
      "",
      "  GPT-6-Astra default · /var/folders/00/temporary_folder_identifier_00/T/",
      "  elwood_capture-CAPTUR/workspace/area-0123456789abcdef/group-fedcba9876543210/",
      "  nested-0123456789abcdef-fedcba9876543210/tasks-0123456789abcdef/item-…",
      "  ← for agents · ? for shortcuts                      ⚠ 3 warnings · f2 to view",
    ],
  },
  {
    shape: "long directory, first row far short of the width",
    cols: 60,
    wrapped: true,
    rows: [
      "› Ask Codex to do anything",
      "",
      "  GPT-6-Astra default · /var/folders/00/",
      "  temporary_folder_identifier_00/T/elwood_capture-CAPTUR/",
      "  workspace/area-0123456789abcdef/group-fedcba9876543210/…",
      "  ← for agents · ? for shortcuts  ⚠ 3 warnings · f2 to view",
    ],
  },
  {
    shape: "long directory beside the shortened hint",
    cols: 46,
    wrapped: true,
    rows: [
      "› Ask Codex to do anything",
      "",
      "  GPT-6-Astra default · /var/folders/00/",
      "  temporary_folder_identifier_00/T/",
      "  elwood_capture-CAPTUR/workspace/area-…",
      "  ← for agents      ⚠ 3 warnings · f2 to view",
    ],
  },
  {
    shape: "long directory beside the shortened badge",
    cols: 36,
    wrapped: true,
    rows: [
      "› Ask Codex to do anything",
      "",
      "  GPT-6-Astra default · /var/",
      "  folders/00/",
      "  temporary_folder_identifier_00/T/…",
      "  ← for agents             ⚠ 3 · f2",
    ],
  },
  {
    shape: "thread name moved to the second row at a space",
    cols: 59,
    wrapped: true,
    rows: [
      "› Ask Codex to do anything",
      "",
      "  GPT-6-Astra default · /tmp/elwc-CAPTUR/s · [note:first]",
      "  You are an example, working on a long task tha…",
      "  ← for agents · ? for shortcuts ⚠ 3 warnings · f2 to view",
    ],
  },
  {
    shape: "first row ends at the separator before the thread name",
    cols: 46,
    wrapped: true,
    rows: [
      "› Ask Codex to do anything",
      "",
      "  GPT-6-Astra default · /tmp/elwc-CAPTUR/s ·",
      "  [note:first] You are an example, working on",
      "  a long task tha…",
      "  ← for agents      ⚠ 3 warnings · f2 to view",
    ],
  },
  {
    shape: "short directory and thread name at 30 columns",
    cols: 30,
    wrapped: true,
    rows: [
      "› Ask Codex to do anything",
      "",
      "  GPT-6-Astra default · /tmp/",
      "  elwc-CAPTUR/s · [note:first]",
      "  You are an example, working…",
      "  ← for agents       ⚠ 3 · f2",
    ],
  },
  {
    shape: "wide characters fill the second row in 78 code points",
    cols: 100,
    wrapped: true,
    rows: [
      "› Ask Codex to do anything",
      "",
      "  GPT-6-Astra default · /tmp/elwc-CAPTUR/作業場所/プロジェクト-一二三四五六七八九十/資料-一二三四五",
      "  六七八九十一二三四五六七八九十/チェックアウト · [note:first] You are an example, working on a long",
      "  task tha…",
      "  ← for agents · ? for shortcuts                                          ⚠ 3 warnings · f2 to view",
    ],
  },
  {
    shape: "wide characters cut inside a directory name",
    cols: 60,
    wrapped: true,
    rows: [
      "› Ask Codex to do anything",
      "",
      "  GPT-6-Astra default · /tmp/elwc-CAPTUR/作業場所/プロジェク",
      "  ト-一二三四五六七八九十/資料-一二三四五六七八九十一二三四",
      "  五六七八九十/チェックアウト · [note:first] You are an…",
      "  ← for agents · ? for shortcuts  ⚠ 3 warnings · f2 to view",
    ],
  },
  {
    shape: "one status row beside the shortened hint",
    cols: 46,
    wrapped: false,
    rows: [
      "› Ask Codex to do anything",
      "",
      "  GPT-6-Astra default · /tmp/elwc-CAPTUR/s",
      "  ← for agents      ⚠ 3 warnings · f2 to view",
    ],
  },
];
