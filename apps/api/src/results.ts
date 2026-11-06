/** Pure shaping of run results for MCP tools: filters, sorting and cursors over pages and errors. */

const SEVERITY_RANK: Record<string, number> = { high: 0, figure_error: 1, medium: 2, low: 3 };

export interface PageScore {
  readonly presetId: string;
  readonly status: string;
  readonly score: number | null;
  readonly high: number;
}

export interface PageRow {
  readonly pageId: string;
  readonly document: string;
  readonly page: number;
  readonly note: string | null;
  readonly gap: number | null;
  readonly scores: ReadonlyArray<PageScore>;
}

export interface PageQuery {
  readonly filter: "all" | "flagged" | "high";
  readonly sort: "document" | "gap" | "score";
  readonly presetId?: string | undefined;
  readonly maxScore?: number | undefined;
}

/** A cursor is the offset of the next item; it is valid for the same query on the same run. */
export const paginate = <A>(items: ReadonlyArray<A>, cursor: string | undefined, limit: number) => {
  const offset = cursor === undefined ? 0 : Math.max(0, Number.parseInt(cursor, 10) || 0);
  const end = offset + limit;
  return { total: items.length, items: items.slice(offset, end), nextCursor: end < items.length ? String(end) : null };
};

const presetScore = (row: PageRow, presetId: string) => row.scores.find((s) => s.presetId === presetId);

export const selectPages = (rows: ReadonlyArray<PageRow>, q: PageQuery): Array<PageRow> => {
  const kept = rows.filter((row) => {
    if (q.filter === "flagged" && row.note === null) return false;
    if (q.filter === "high" && !row.scores.some((s) => s.high > 0)) return false;
    const scores = q.presetId === undefined ? row.scores : row.scores.filter((s) => s.presetId === q.presetId);
    if (scores.length === 0) return false;
    if (q.maxScore !== undefined) {
      const maxScore = q.maxScore;
      return scores.some((s) => s.score !== null && s.score <= maxScore);
    }
    return true;
  });
  if (q.sort === "gap") kept.sort((a, b) => (b.gap ?? -1) - (a.gap ?? -1));
  if (q.sort === "score") {
    const low = (row: PageRow) =>
      q.presetId === undefined ? Math.min(...row.scores.map((s) => s.score ?? 11)) : (presetScore(row, q.presetId)?.score ?? 11);
    kept.sort((a, b) => low(a) - low(b));
  }
  return kept;
};

export interface RunErrorRow {
  readonly pageId: string;
  readonly document: string;
  readonly page: number;
  readonly presetId: string;
  readonly score: number;
  readonly reasoning: string;
  readonly errors: unknown;
}

export interface ErrorQuery {
  readonly presetIds?: ReadonlyArray<string> | undefined;
  readonly severities?: ReadonlyArray<string> | undefined;
  readonly categories?: ReadonlyArray<string> | undefined;
}

export interface FlatError {
  readonly pageId: string;
  readonly document: string;
  readonly page: number;
  readonly presetId: string;
  readonly score: number;
  readonly severity: string;
  readonly category: string;
  readonly description: string;
  readonly quotes: ReadonlyArray<string>;
}

/** One entry per judge error, most severe first, then lowest score. */
export const flattenErrors = (rows: ReadonlyArray<RunErrorRow>, q: ErrorQuery): Array<FlatError> => {
  const errors = rows
    .filter((row) => q.presetIds === undefined || q.presetIds.includes(row.presetId))
    .flatMap((row) =>
      (row.errors as ReadonlyArray<{ severity: string; category: string; description: string; quotes?: unknown }>).map(
        (error) => ({
          pageId: row.pageId,
          document: row.document,
          page: row.page,
          presetId: row.presetId,
          score: row.score,
          severity: error.severity,
          category: error.category,
          description: error.description,
          quotes: Array.isArray(error.quotes)
            ? (error.quotes as ReadonlyArray<{ text?: unknown }>).flatMap((quote) =>
                typeof quote?.text === "string" ? [quote.text] : [],
              )
            : [],
        }),
      ),
    )
    .filter(
      (error) =>
        (q.severities === undefined || q.severities.includes(error.severity)) &&
        (q.categories === undefined || q.categories.includes(error.category)),
    );
  errors.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || a.score - b.score);
  return errors;
};

/** Error counts by preset, severity and category, for the whole filtered set. */
export const countErrors = (errors: ReadonlyArray<FlatError>) => {
  const counts: Record<string, { total: number; bySeverity: Record<string, number>; byCategory: Record<string, number> }> = {};
  for (const e of errors) {
    const c = counts[e.presetId] ?? { total: 0, bySeverity: {}, byCategory: {} };
    counts[e.presetId] = c;
    c.total += 1;
    c.bySeverity[e.severity] = (c.bySeverity[e.severity] ?? 0) + 1;
    c.byCategory[e.category] = (c.byCategory[e.category] ?? 0) + 1;
  }
  return counts;
};
