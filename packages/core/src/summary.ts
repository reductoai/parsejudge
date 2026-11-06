import type { Cost, ErrorCategory, PresetVerdict } from "./domain.ts";
import { findPreset } from "./presets.ts";

/** Everything known about one (page, preset) cell after a run. */
export interface PageResult {
  readonly pageId: string;
  readonly presetId: string;
  readonly status: "succeeded" | "failed";
  /** Submit to result in hand, including vendor queueing and async processing. */
  readonly latencyMs?: number;
  /** Wait for a parsejudge concurrency slot before submit; not part of `latencyMs`. */
  readonly queueMs?: number;
  readonly cost?: Cost;
  readonly verdict?: PresetVerdict;
}

export interface Interval {
  readonly low: number;
  readonly high: number;
}

export interface PresetSummary {
  readonly presetId: string;
  readonly label: string;
  readonly pages: number;
  readonly failedPages: number;
  /** Parses the owner skipped with Continue. They are not results, so no score or head-to-head counts them. */
  readonly skippedPages: number;
  readonly meanScore: number | null;
  readonly medianScore: number | null;
  /** Share of judged pages with at least one high-severity error, with a Wilson 95% interval. */
  readonly highSeverityRate: number | null;
  readonly highSeverityInterval: Interval | null;
  readonly errorCounts: Readonly<Partial<Record<ErrorCategory, number>>>;
  readonly listPriceUsdPerPage: number;
  /** Mean provider-reported cost, or null when any succeeded page lacked one. */
  readonly observedCostUsdPerPage: number | null;
  readonly latencyMsMean: number | null;
  readonly latencyMsP50: number | null;
  readonly latencyMsP95: number | null;
}

export interface HeadToHead {
  readonly presetId: string;
  readonly opponentId: string;
  readonly wins: number;
  readonly ties: number;
  readonly losses: number;
}

export interface TradeoffPoint {
  readonly presetId: string;
  readonly listPriceUsdPerPage: number;
  readonly meanScore: number;
  readonly pareto: boolean;
}

export interface RunSummary {
  readonly presets: ReadonlyArray<PresetSummary>;
  /** Pages with at least one parse or verdict skipped with Continue. */
  readonly skippedPages: number;
  readonly headToHead: ReadonlyArray<HeadToHead>;
  readonly tradeoff: ReadonlyArray<TradeoffPoint>;
}

const mean = (values: ReadonlyArray<number>): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

const quantile = (values: ReadonlyArray<number>, q: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] ?? 0;
  return low + ((sorted[upper] ?? low) - low) * (position - lower);
};

export const wilson = (successes: number, total: number, z = 1.96): Interval | null => {
  if (total === 0) return null;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
};

const observedCost = (results: ReadonlyArray<PageResult>): number | null => {
  const succeeded = results.filter((result) => result.status === "succeeded");
  const reported = succeeded.flatMap((result) => (result.cost?.source === "provider" ? [result.cost.usd] : []));
  return succeeded.length > 0 && reported.length === succeeded.length ? mean(reported) : null;
};

const summarizePreset = (presetId: string, results: ReadonlyArray<PageResult>, skippedPages: number): PresetSummary => {
  const verdicts = results.flatMap((result) => (result.verdict === undefined ? [] : [result.verdict]));
  const scores = verdicts.map((verdict) => verdict.score);
  const withHigh = verdicts.filter((verdict) => verdict.errors.some((error) => error.severity === "high")).length;
  const errorCounts: Partial<Record<ErrorCategory, number>> = {};
  for (const error of verdicts.flatMap((verdict) => verdict.errors)) {
    errorCounts[error.category] = (errorCounts[error.category] ?? 0) + 1;
  }
  const latencies = results.flatMap((result) => (result.latencyMs === undefined ? [] : [result.latencyMs]));
  return {
    presetId,
    label: findPreset(presetId)?.label ?? presetId,
    pages: results.length,
    failedPages: results.filter((result) => result.status === "failed").length,
    skippedPages,
    meanScore: mean(scores),
    medianScore: quantile(scores, 0.5),
    highSeverityRate: verdicts.length === 0 ? null : withHigh / verdicts.length,
    highSeverityInterval: wilson(withHigh, verdicts.length),
    errorCounts,
    listPriceUsdPerPage: findPreset(presetId)?.listPriceUsdPerPage ?? 0,
    observedCostUsdPerPage: observedCost(results),
    latencyMsMean: mean(latencies),
    latencyMsP50: quantile(latencies, 0.5),
    latencyMsP95: quantile(latencies, 0.95),
  };
};

/** A failed page scores 1, the judge's floor, so failures count against a preset in head-to-head. */
const pageScore = (result: PageResult | undefined): number | undefined =>
  result?.verdict?.score ?? (result?.status === "failed" ? 1 : undefined);

const headToHead = (presetIds: ReadonlyArray<string>, results: ReadonlyArray<PageResult>): Array<HeadToHead> => {
  const byCell = new Map(results.map((result) => [`${result.pageId}\u0000${result.presetId}`, result]));
  const pageIds = [...new Set(results.map((result) => result.pageId))];
  return presetIds.flatMap((presetId) =>
    presetIds
      .filter((opponentId) => opponentId !== presetId)
      .map((opponentId) => {
        let wins = 0;
        let ties = 0;
        let losses = 0;
        for (const pageId of pageIds) {
          const own = pageScore(byCell.get(`${pageId}\u0000${presetId}`));
          const other = pageScore(byCell.get(`${pageId}\u0000${opponentId}`));
          if (own === undefined || other === undefined) continue;
          if (own > other) wins++;
          else if (own < other) losses++;
          else ties++;
        }
        return { presetId, opponentId, wins, ties, losses };
      }),
  );
};

/** List price vs accuracy. A point is Pareto-optimal when no other point is at least as cheap and at least as accurate, and better in one. */
const tradeoff = (presets: ReadonlyArray<PresetSummary>): Array<TradeoffPoint> => {
  const points = presets.flatMap((preset) =>
    preset.meanScore === null
      ? []
      : [{ presetId: preset.presetId, listPriceUsdPerPage: preset.listPriceUsdPerPage, meanScore: preset.meanScore }],
  );
  return points
    .map((point) => ({
      ...point,
      pareto: !points.some(
        (other) =>
          other.listPriceUsdPerPage <= point.listPriceUsdPerPage &&
          other.meanScore >= point.meanScore &&
          (other.listPriceUsdPerPage < point.listPriceUsdPerPage || other.meanScore > point.meanScore),
      ),
    }))
    .sort((a, b) => a.listPriceUsdPerPage - b.listPriceUsdPerPage);
};

/** What Continue skipped: the preset of each skipped parse, and the number of pages with anything skipped. */
export interface Skipped {
  readonly parses: ReadonlyArray<string>;
  readonly pages: number;
}

export const summarize = (results: ReadonlyArray<PageResult>, skipped: Skipped = { parses: [], pages: 0 }): RunSummary => {
  const presetIds = [...new Set([...results.map((result) => result.presetId), ...skipped.parses])];
  const presets = presetIds.map((id) =>
    summarizePreset(
      id,
      results.filter((result) => result.presetId === id),
      skipped.parses.filter((presetId) => presetId === id).length,
    ),
  );
  return { presets, skippedPages: skipped.pages, headToHead: headToHead(presetIds, results), tradeoff: tradeoff(presets) };
};
