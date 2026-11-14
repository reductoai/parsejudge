import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Preset, type PresetSummary, type Run } from "./api.ts";
import { Icon } from "./ax/Icon.tsx";
import { type HeadToHead, mountReport, type PageRow } from "./ax/report-charts.ts";
import { presetTones, providerName, shortName } from "./names.ts";
import { navigate } from "./router.ts";

/** Series colors, one per provider mode: Reducto r-1 is brand plum; the rest take the accent ramps in order. */

const pct = (x: number) => `${Math.round(x * 100)}%`;
const secs = (ms: number | null) => (ms === null ? "–" : (ms / 1000).toFixed(1));
const perK = (usdPerPage: number) => {
  const k = usdPerPage * 1000;
  return `$${k < 10 ? Math.round(k * 100) / 100 : Math.round(k)}`;
};

type SortKey = "provider" | "mean" | "high" | "price" | "latency" | "failed";
type Sort = { readonly key: SortKey; readonly desc: boolean };

const COLUMNS: ReadonlyArray<{ readonly key: SortKey; readonly label: string; readonly num?: boolean }> = [
  { key: "provider", label: "Provider" },
  { key: "mean", label: "Mean score" },
  { key: "high", label: "High severity", num: true },
  { key: "price", label: "$ / 1k pages", num: true },
  { key: "latency", label: "p50 · p95", num: true },
  { key: "failed", label: "Failed", num: true },
];

/** Mean score at the precision the table shows, so rows that read the same count as a tie. */
const shown = (score: number | null) => (score === null ? -1 : Math.round(score * 10));
/** Tie-break: lower p50 latency first, unknown latency last. */
/** Failed parses plus parses skipped with Continue: neither produced a result. */
const failedOf = (p: PresetSummary) => p.failedPages + (p.skippedPages ?? 0);

const fastest = (a: PresetSummary, b: PresetSummary) =>
  (a.latencyMsP50 ?? Number.POSITIVE_INFINITY) - (b.latencyMsP50 ?? Number.POSITIVE_INFINITY);

const RECOMMENDED_PAGES = 100;

/** Shown at the top of a run judged on fewer than 100 pages, where the ranking is still mostly noise. */
export const SmallSampleNotice = ({ pages }: { readonly pages: number }) => {
  if (pages <= 0 || pages >= RECOMMENDED_PAGES) return null;
  const advice = `Runs under ${RECOMMENDED_PAGES} diverse pages can be very noisy. A sample of more than ${RECOMMENDED_PAGES} pages is highly recommended.`;
  return (
    <div className="rp-sample" role="note">
      <Icon name="triangle-alert" className="rp-sample-ic" />
      <span className="rp-sample-h">
        Small sample: {pages.toLocaleString("en-US")} {pages === 1 ? "page" : "pages"}
      </span>
      <span className="rp-sample-d" title={advice}>
        {advice}
      </span>
    </div>
  );
};

export const Report = ({
  run,
  presets,
  title,
  reveal = "",
}: {
  readonly run: Run;
  readonly presets: ReadonlyArray<Preset>;
  readonly title: string;
  /** "is-pre" holds the sections down; "is-in" lets them rise in after the load state. */
  readonly reveal?: string;
}) => {
  const summary = run.summary;
  const byId = useMemo(() => new Map(presets.map((p) => [p.id, p])), [presets]);
  const ranked = useMemo(
    () => [...(summary?.presets ?? [])].sort((a, b) => shown(b.meanScore) - shown(a.meanScore) || fastest(a, b)),
    [summary],
  );
  const name = (id: string) => {
    const preset = byId.get(id);
    if (!preset) return id;
    const siblings = run.presetIds.filter((other) => byId.get(other)?.provider === preset.provider).length;
    return siblings > 1 ? `${shortName(preset.provider)} ${preset.mode}` : shortName(preset.provider);
  };
  const tones = useMemo(() => presetTones(run.presetIds), [run.presetIds]);

  const contentHidden = !run.owned && !run.shareContent;
  const gone = run.dataDeletedAt !== null;
  const skipped = run.summary?.skippedPages ?? 0;
  const pages = useMemo(() => {
    const cell = new Map(run.scores.map((s) => [`${s.pageId}:${s.presetId}`, s]));
    return run.documents.flatMap((d) =>
      d.pages.map((p): PageRow => {
        const by: Record<string, number | null> = {};
        for (const id of run.presetIds) {
          const c = cell.get(`${p.id}:${id}`);
          by[id] = c?.status === "succeeded" ? (c.score ?? null) : null;
        }
        const ok = Object.values(by).filter((s): s is number => s !== null);
        const min = ok.length ? Math.min(...ok) : 0;
        const max = ok.length ? Math.max(...ok) : 0;
        return {
          id: p.id,
          doc: d.filename,
          page: p.index + 1,
          imageUrl: p.imageUrl,
          note: p.note,
          by,
          min,
          max,
          gap: max - min,
          mean: ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : 0,
        };
      }),
    );
  }, [run]);

  const root = useRef<HTMLDivElement>(null);
  const [grown, setGrown] = useState(false);
  const [sort, setSort] = useState<Sort>({ key: "mean", desc: true });
  const rank = useMemo(() => new Map(ranked.map((p, i) => [p.presetId, i + 1])), [ranked]);
  const rows = useMemo(() => {
    const label = (p: PresetSummary) => {
      const preset = byId.get(p.presetId);
      return preset ? `${providerName(preset.provider)} ${preset.mode}` : p.label;
    };
    const value = (p: PresetSummary): number | string | null =>
      sort.key === "provider"
        ? label(p)
        : sort.key === "mean"
          ? p.meanScore
          : sort.key === "high"
            ? p.highSeverityRate
            : sort.key === "price"
              ? p.listPriceUsdPerPage
              : sort.key === "latency"
                ? p.latencyMsP50
                : failedOf(p);
    return [...ranked].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      if (x === y) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      const order =
        typeof x === "string" ? x.localeCompare(String(y)) : sort.key === "mean" ? shown(x) - shown(Number(y)) : x - Number(y);
      return sort.desc ? -order : order;
    });
  }, [ranked, byId, sort]);
  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== "provider" }));
  // biome-ignore lint/correctness/useExhaustiveDependencies: the charts mount once per run and presets list.
  useEffect(() => {
    const el = root.current;
    if (el === null || summary === null || presets.length === 0) return;
    const entries = ranked.flatMap((p) => {
      const preset = byId.get(p.presetId);
      if (p.meanScore === null) return [];
      return [
        {
          id: p.presetId,
          tone: tones.get(p.presetId) ?? "ink",
          provider: name(p.presetId),
          short: preset ? shortName(preset.provider) : p.label,
          fullName: preset ? providerName(preset.provider) : p.label,
          mode: preset?.mode ?? "",
          mean: p.meanScore,
          price: p.listPriceUsdPerPage,
          p50: p.latencyMsP50 === null ? null : p.latencyMsP50 / 1000,
        },
      ];
    });
    const h2h: Record<string, Record<string, { wins: string[]; ties: string[]; losses: string[] }>> = {};
    for (const a of entries)
      for (const b of entries) {
        if (a === b) continue;
        const r = { wins: [] as string[], ties: [] as string[], losses: [] as string[] };
        for (const pg of pages) {
          const x = pg.by[a.id];
          const y = pg.by[b.id];
          if (x == null || y == null) continue;
          (x > y ? r.wins : x === y ? r.ties : r.losses).push(pg.id);
        }
        h2h[a.id] = { ...h2h[a.id], [b.id]: r };
      }
    const stop = mountReport(el, {
      entries,
      pages,
      h2h: h2h as HeadToHead,
      headToHead: summary.headToHead,
      headToHeadEntries: ranked.map((p) => ({ id: p.presetId, provider: name(p.presetId) })),
      contentHidden: contentHidden || gone,
      detail: (pageId) => api.page(run.id, pageId).catch(() => null),
      compare: (pageId) => `/r/${run.shareId}/p/${pageId}`,
      navigate,
    });
    const raf = requestAnimationFrame(() => setGrown(true));
    return () => {
      cancelAnimationFrame(raf);
      stop();
    };
  }, [run.id, presets.length]);

  if (summary === null) return null;

  const date = new Date(run.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const mcp = `claude mcp add --transport http parsejudge ${location.origin}/mcp`;
  const first = pages[0];
  const allPages =
    first && !contentHidden && !gone ? (
      <a
        className="btn primary"
        href={`/r/${run.shareId}/p/${first.id}`}
        onClick={(e) => {
          e.preventDefault();
          navigate(`/r/${run.shareId}/p/${first.id}`);
        }}
      >
        <span className="btn-label">All pages</span>
        <Icon name="arrow-right" />
      </a>
    ) : null;

  return (
    <div className={`page rp-page ${reveal}`} id="report" ref={root}>
      <SmallSampleNotice pages={run.pageCount - skipped} />
      <div className="rp-head">
        <div className="title-wrap">
          <h1>{title}</h1>
          <div className="pg-meta">
            {date} · {run.documentCount} documents · {run.pageCount} pages · {run.presetIds.length} providers
            {gone && ` · documents deleted ${new Date(run.dataDeletedAt ?? 0).toLocaleDateString("en-US")}`}
            {skipped > 0 && ` · ${skipped} ${skipped === 1 ? "page" : "pages"} skipped`}
            {contentHidden && " · scores only"}
          </div>
        </div>
        <div className="rp-head-acts">{allPages}</div>
      </div>

      <section className="rp-agent">
        <span className="rp-agent-ic">
          <Icon name="terminal" />
        </span>
        <span className="l">Ask your agent</span>
        <code className="mono">{mcp}</code>
        <CopyIcon text={mcp} />
      </section>

      <section>
        <div className="wf-table lb">
          <div className="thead">
            <div>#</div>
            {COLUMNS.map((c) => {
              const on = sort.key === c.key;
              return (
                <button
                  key={c.key}
                  type="button"
                  data-sk={c.key}
                  className={`col-h${c.num ? " num" : ""}${on ? ` sorted${sort.desc ? " desc" : ""}` : ""}`}
                  onClick={() => sortBy(c.key)}
                >
                  <span className="col-h-label">{c.label}</span>
                  <Icon name="chevron-down" className="sort-chev" />
                </button>
              );
            })}
          </div>
          {rows.map((p) => {
            const preset = byId.get(p.presetId);
            return (
              <div key={p.presetId} className={`trow s-${tones.get(p.presetId)}`}>
                <div className="rank">{rank.get(p.presetId)}</div>
                <div className="who">
                  <div className="who-t">
                    <div className="who-n">{preset ? providerName(preset.provider) : p.label}</div>
                    <div className="who-m">{preset?.mode}</div>
                  </div>
                </div>
                <div className="score">
                  <span className="score-n">{p.meanScore === null ? "–" : p.meanScore.toFixed(1)}</span>
                  <span className="score-bar">
                    <span style={{ width: grown ? `${(p.meanScore ?? 0) * 10}%` : 0 }} />
                  </span>
                </div>
                <div className="num">{p.highSeverityRate === null ? "–" : pct(p.highSeverityRate)}</div>
                <div className="num">{perK(p.listPriceUsdPerPage)}</div>
                <div className="num soft">
                  {secs(p.latencyMsP50)} · {secs(p.latencyMsP95)} s
                </div>
                <div className="num soft">{failedOf(p)}</div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rp-charts">
        <div className="rp-card">
          <div className="rp-chart-t">Score vs. price</div>
          <div id="chPrice" />
        </div>
        <div className="rp-card">
          <div className="rp-chart-t">Score vs. latency</div>
          <div id="chLatency" />
        </div>
      </section>

      <section className="rp-card">
        <div className="rp-sec-h">
          <h2>Head to head</h2>
          <span className="rp-count">Wins · ties · losses, row against column</span>
        </div>
        <div className="h2h-scroll">
          <table className="h2h" id="h2h" />
        </div>
      </section>

      <section className="rp-card dg-card" id="dgCard">
        <div className="rp-sec-h">
          <h2>Where providers disagree</h2>
          <span className="rp-count" id="dgCount" />
          <span id="dgFocus" />
          <span id="dgZoom" />
          <span className="sp" />
          <div className="mode-seg lg" id="dgSeg" role="tablist" aria-label="Score gap" />
          <div className="mode-seg lg" id="dgView" role="tablist" aria-label="Chart view" />
        </div>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the chart takes arrow keys and Enter, as in the design. */}
        <div className="dg-wrap" id="dgWrap" tabIndex={0} title="Score range per page" />
        <div className="dg-foot">
          <div className="dg-legend" id="dgLegend" />
          <span className="sp" />
          <div className="mode-seg lg" id="dgSort" role="tablist" aria-label="Page order" />
          {allPages}
        </div>
      </section>

      <section className="rp-card">
        <div className="rp-about">
          {[
            ["Judge", `${run.judgeModel} · ${run.judgeVersion}`],
            ["Rendering", "PDFium · PNG"],
            ["Blinding", "Shuffled, names hidden"],
            ["Run", run.shareId],
          ].map(([l, v]) => (
            <div key={l} className="rp-fact">
              <div className="l">{l}</div>
              <div className="v">{v}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};

/** The agent command's ghost copy button; a toast confirms the copy. */
const CopyIcon = ({ text }: { readonly text: string }) => {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (shown === 0) return;
    const timer = setTimeout(() => setShown(0), 1800);
    return () => clearTimeout(timer);
  }, [shown]);
  return (
    <>
      <button
        className="rp-copy"
        type="button"
        aria-label="Copy command"
        onClick={() => navigator.clipboard.writeText(text).then(() => setShown(Date.now()))}
      >
        <Icon name="copy" />
      </button>
      <div className={`ev-toast${shown ? " show" : ""}`} role="status">
        Copied
      </div>
    </>
  );
};
