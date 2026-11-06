import { describe, expect, it } from "vitest";
import { countErrors, flattenErrors, type PageRow, paginate, type RunErrorRow, selectPages } from "../src/results.ts";

const row = (pageId: string, gap: number, scores: Record<string, number | null>, note: string | null = null): PageRow => ({
  pageId,
  document: "a.pdf",
  page: 1,
  note,
  gap,
  scores: Object.entries(scores).map(([presetId, score]) => ({
    presetId,
    status: score === null ? "failed" : "succeeded",
    score,
    high: score !== null && score < 5 ? 1 : 0,
  })),
});

const rows = [
  row("p1", 1, { r1: 9, tx: 8 }),
  row("p2", 6, { r1: 4, tx: 10 }, "r1 dropped a table"),
  row("p3", 0, { r1: 7, tx: null }),
];

describe("selectPages", () => {
  it("keeps pages where one preset scored at most maxScore, lowest first", () => {
    const kept = selectPages(rows, { filter: "all", sort: "score", presetId: "r1", maxScore: 7 });
    expect(kept.map((r) => r.pageId)).toEqual(["p2", "p3"]);
  });

  it("drops pages the preset has no score on", () => {
    expect(selectPages(rows, { filter: "all", sort: "document", presetId: "tx", maxScore: 9 }).map((r) => r.pageId)).toEqual([
      "p1",
    ]);
  });

  it("applies flagged and high filters", () => {
    expect(selectPages(rows, { filter: "flagged", sort: "document" }).map((r) => r.pageId)).toEqual(["p2"]);
    expect(selectPages(rows, { filter: "high", sort: "gap" }).map((r) => r.pageId)).toEqual(["p2"]);
  });
});

describe("paginate", () => {
  it("walks every item once with nextCursor", () => {
    const items = Array.from({ length: 7 }, (_, i) => i);
    const first = paginate(items, undefined, 3);
    const second = paginate(items, first.nextCursor ?? undefined, 3);
    const third = paginate(items, second.nextCursor ?? undefined, 3);
    expect([...first.items, ...second.items, ...third.items]).toEqual(items);
    expect(third.nextCursor).toBeNull();
    expect(first.total).toBe(7);
  });
});

describe("flattenErrors", () => {
  const errorRows: Array<RunErrorRow> = [
    {
      pageId: "p1",
      document: "a.pdf",
      page: 1,
      presetId: "r1",
      score: 9,
      reasoning: "fine",
      errors: [{ severity: "low", category: "text_corruption", description: "typo", quotes: [{ text: "teh", occurrence: 1 }] }],
    },
    {
      pageId: "p2",
      document: "a.pdf",
      page: 2,
      presetId: "r1",
      score: 4,
      reasoning: "bad",
      errors: [{ severity: "high", category: "table_structure", description: "merged columns" }],
    },
    {
      pageId: "p2",
      document: "a.pdf",
      page: 2,
      presetId: "tx",
      score: 6,
      reasoning: "ok",
      errors: [{ severity: "high", category: "content_omission", description: "missing row" }],
    },
  ];

  it("returns one entry per error, most severe and lowest score first", () => {
    const errors = flattenErrors(errorRows, {});
    expect(errors.map((e) => `${e.presetId}:${e.description}`)).toEqual(["r1:merged columns", "tx:missing row", "r1:typo"]);
    expect(errors[2]?.quotes).toEqual(["teh"]);
  });

  it("filters by preset, severity and category", () => {
    expect(flattenErrors(errorRows, { presetIds: ["r1"], severities: ["high"] }).map((e) => e.description)).toEqual([
      "merged columns",
    ]);
    expect(flattenErrors(errorRows, { categories: ["content_omission"] }).map((e) => e.presetId)).toEqual(["tx"]);
  });

  it("counts by preset", () => {
    const counts = countErrors(flattenErrors(errorRows, {}));
    expect(counts.r1).toEqual({
      total: 2,
      bySeverity: { high: 1, low: 1 },
      byCategory: { table_structure: 1, text_corruption: 1 },
    });
  });
});
