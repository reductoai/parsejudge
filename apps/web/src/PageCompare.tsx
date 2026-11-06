import DOMPurify from "dompurify";
import { marked } from "marked";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, type JudgedError, type PageDetail, type PageParse, type Preset, type Run } from "./api.ts";
import { Icon } from "./ax/Icon.tsx";
import { providerName, SHORT_NAMES } from "./names.ts";
import { navigate } from "./router.ts";
import { ShareDialog } from "./Share.tsx";

type View = "side" | "all";
type Severity = JudgedError["severity"];

const Caret = () => (
  <svg className="caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
    <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);

interface PageStat {
  readonly id: string;
  readonly filename: string;
  readonly index: number;
  readonly pageCount: number;
  readonly imageUrl: string;
  readonly order: number;
  readonly gap: number;
  readonly failed: boolean;
  readonly high: number;
  /** Score per preset; null when the parse failed, absent while it runs. */
  readonly scores: Readonly<Record<string, number | null>>;
}

type PageFilter = "all" | "flagged" | "high";
interface PageSort {
  readonly key: string;
  readonly desc: boolean;
}

const FLAG_GAP = 3;
const BLOCKS = "p,li,td,th,h1,h2,h3,h4,h5,h6,blockquote,pre";
const RANK: Record<Severity, number> = { high: 0, figure_error: 1, medium: 2, low: 3 };

const isFlagged = (page: PageStat) => page.failed || page.gap >= FLAG_GAP || page.high > 0;
const FILTERS: ReadonlyArray<readonly [PageFilter, string]> = [
  ["all", "All pages"],
  ["flagged", "Flagged"],
  ["high", "High severity"],
];
const inFilter = (filter: PageFilter) => (p: PageStat) => filter === "all" || (filter === "flagged" ? isFlagged(p) : p.high > 0);
const sortValue = (p: PageStat, key: string) => {
  if (key === "order") return p.order;
  if (key === "gap") return p.failed ? Number.POSITIVE_INFINITY : p.gap;
  const score = p.scores[key];
  return score === undefined ? -2 : score === null ? -1 : score;
};
const bySort =
  ({ key, desc }: PageSort) =>
  (a: PageStat, b: PageStat) =>
    (sortValue(a, key) - sortValue(b, key)) * (desc ? -1 : 1) || a.order - b.order;
const byScore = (a: PageParse, b: PageParse) => (b.score ?? -1) - (a.score ?? -1);
const flagsOf = (parse: PageParse) => [...(parse.errors ?? [])].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
const pageUrl = (shareId: string, pageId: string, view: View) => `/r/${shareId}/p/${pageId}${view === "all" ? "?view=all" : ""}`;

const pageStats = (run: Run): ReadonlyArray<PageStat> => {
  const cells = new Map<string, Array<Run["scores"][number]>>();
  for (const cell of run.scores) cells.set(cell.pageId, [...(cells.get(cell.pageId) ?? []), cell]);
  return run.documents
    .flatMap((doc) => doc.pages.map((page) => ({ doc, page })))
    .map(({ doc, page }, order) => {
      const own = cells.get(page.id) ?? [];
      const values = own.flatMap((c) => (c.status === "succeeded" && c.score !== null ? [c.score] : []));
      return {
        id: page.id,
        filename: doc.filename,
        index: page.index,
        pageCount: doc.pages.length,
        imageUrl: page.imageUrl,
        order,
        gap: values.length > 1 ? Math.max(...values) - Math.min(...values) : 0,
        failed: own.some((c) => c.status === "failed"),
        high: own.reduce((n, c) => n + c.high, 0),
        scores: Object.fromEntries(
          own.flatMap(
            (c): Array<[string, number | null]> =>
              c.status === "failed"
                ? [[c.presetId, null]]
                : c.status === "succeeded" && c.score !== null
                  ? [[c.presetId, c.score]]
                  : [],
          ),
        ),
      };
    });
};

const useDismiss = (open: boolean, close: () => void) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    addEventListener("mousedown", onDown);
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("mousedown", onDown);
      removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
};

/** Wraps each located excerpt in a numbered mark and returns the marks per flag. */
const markQuotes = (root: HTMLElement, flags: ReadonlyArray<JudgedError>): Array<Array<HTMLElement>> =>
  flags.map((flag, i) => {
    const marks: Array<HTMLElement> = [];
    for (const quote of flag.quotes ?? []) {
      const q = quote.text;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const matches: Array<{ node: Text; at: number }> = [];
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = node as Text;
        if (text.parentElement?.closest(".flag-badges")) continue;
        for (let at = text.data.indexOf(q); at !== -1; at = text.data.indexOf(q, at + 1)) matches.push({ node: text, at });
      }
      const match = matches[quote.occurrence - 1];
      if (match !== undefined) {
        const { node, at } = match;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + q.length);
        const mark = document.createElement("mark");
        mark.className = `flag ${flag.severity}`;
        range.surroundContents(mark);
        marks.push(mark);
        const block = mark.closest("table") ?? mark.closest(BLOCKS) ?? mark;
        block.classList.add("flagged");
        if (flag.severity === "high") block.classList.add("flagged-high");
        let badges = block.querySelector(":scope > .flag-badges");
        if (badges === null) {
          badges = document.createElement("span");
          badges.className = "flag-badges";
          block.append(badges);
        }
        if (badges.querySelector(`[data-n="${i + 1}"]`) === null) {
          const badge = document.createElement("span");
          badge.className = `flag-num ${flag.severity}`;
          badge.dataset.n = String(i + 1);
          badge.textContent = String(i + 1);
          badges.append(badge);
        }
      }
    }
    return marks;
  });

const LINK_BLOCKS = "p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,table";
const WORDS = new WeakMap<Element, ReadonlySet<string>>();
const wordsOf = (text: string): ReadonlySet<string> =>
  new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1));
const overlap = (a: ReadonlySet<string>, b: ReadonlySet<string>) => {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return (2 * shared) / (a.size + b.size);
};

/** Tags the top-level blocks of one output so a hover can find its counterpart in the other column. */
const tagBlocks = (root: HTMLElement, column: number) => {
  for (const el of root.querySelectorAll<HTMLElement>(LINK_BLOCKS)) {
    if (el.tagName !== "TABLE" && el.closest("table")) continue;
    if (el.tagName === "P" && el.closest("li,blockquote")) continue;
    if (el.tagName === "LI" && el.querySelector("li")) continue;
    el.classList.add("lb");
    el.dataset.col = String(column);
    WORDS.set(el, wordsOf(el.textContent ?? ""));
  }
};

const LINK_MIN = 0.3;
const linkBlocks = (root: HTMLElement, target: EventTarget | null) => {
  const block = target instanceof Element ? target.closest<HTMLElement>(".lb") : null;
  if (block?.classList.contains("linked")) return;
  for (const el of root.querySelectorAll(".lb.linked")) el.classList.remove("linked");
  const mine = block === null ? undefined : WORDS.get(block);
  if (block === null || mine === undefined) return;
  let match: Element | null = null;
  let top = LINK_MIN;
  for (const other of root.querySelectorAll(`.lb[data-col="${block.dataset.col === "0" ? 1 : 0}"]`)) {
    const score = overlap(mine, WORDS.get(other) ?? new Set());
    if (score >= top) {
      top = score;
      match = other;
    }
  }
  if (match === null) return;
  block.classList.add("linked");
  match.classList.add("linked");
};

const FlaggedOutput = ({
  markdown,
  flags,
  column,
  onFound,
}: {
  readonly markdown: string;
  readonly column: number;
  readonly flags: ReadonlyArray<JudgedError>;
  readonly onFound: (marks: Array<Array<HTMLElement>>) => void;
}) => {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(markdown, { async: false })), [markdown]);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current === null) return;
    ref.current.innerHTML = html;
    tagBlocks(ref.current, column);
    onFound(markQuotes(ref.current, flags));
  }, [html, flags, column, onFound]);
  return <div ref={ref} className="markdown flagged-output" />;
};

const FlagCard = ({
  flag,
  n,
  marks,
}: {
  readonly flag: JudgedError;
  readonly n: number;
  readonly marks: ReadonlyArray<HTMLElement>;
}) => {
  const [next, setNext] = useState(0);
  const jump = () => {
    marks[next % marks.length]?.scrollIntoView({ behavior: "smooth", block: "center" });
    setNext(next + 1);
  };
  return (
    <div className={`flag-card ${flag.severity}`}>
      <div className="flex" style={{ gap: 8 }}>
        <span className={`flag-num ${flag.severity}`}>{n}</span>
        <span className={`sev ${flag.severity}`}>{flag.severity.toUpperCase()}</span>
        <span className="mono" style={{ fontSize: 13 }}>
          {flag.category}
        </span>
        {marks.length > 0 && (
          <button type="button" className="plain jump" onClick={jump}>
            {(next % marks.length) + 1} of {marks.length} ↓
          </button>
        )}
      </div>
      <p>{flag.description}</p>
    </div>
  );
};

const SeverityCounts = ({ parse }: { readonly parse: PageParse }) => {
  const counts = (["high", "figure_error", "medium", "low"] as const)
    .map((sev) => [sev, flagsOf(parse).filter((f) => f.severity === sev).length] as const)
    .filter(([, n]) => n > 0);
  if (parse.status !== "succeeded") return <span style={{ color: "var(--bad)" }}>Parse failed</span>;
  if (counts.length === 0) return <span>No errors</span>;
  return (
    <span className="flex" style={{ gap: 4 }}>
      {counts.map(([sev, n]) => (
        <span key={sev} className={`sev ${sev}`}>
          {n} {sev.toUpperCase()}
        </span>
      ))}
    </span>
  );
};

const ProviderMenu = ({
  parses,
  current,
  other,
  otherSlot,
  name,
  onPick,
}: {
  readonly parses: ReadonlyArray<PageParse>;
  readonly current: string;
  readonly other: string | undefined;
  readonly otherSlot: string;
  readonly name: (presetId: string) => string;
  readonly onPick: (presetId: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  const close = useMemo(() => () => setOpen(false), []);
  const ref = useDismiss(open, close);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button type="button" className="provider-trigger" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="slot">{otherSlot === "B" ? "A" : "B"}</span>
        <span className="clip">{name(current)}</span>
        <Caret />
      </button>
      {open && (
        <div className="popover menu">
          {[...parses].sort(byScore).map((parse) => {
            const taken = parse.presetId === other;
            return (
              <button
                key={parse.presetId}
                type="button"
                className={`menu-row${parse.presetId === current ? " current" : ""}`}
                disabled={taken}
                onClick={() => {
                  onPick(parse.presetId);
                  setOpen(false);
                }}
              >
                <span className="menu-main">
                  <span>
                    {name(parse.presetId)}
                    {parse.presetId === current && " ✓"}
                  </span>
                  <span className="menu-sub">{taken ? `Showing in column ${otherSlot}` : <SeverityCounts parse={parse} />}</span>
                </span>
                <span>{parse.score ?? "–"}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

const Score = ({ score, best }: { readonly score: number | null; readonly best: boolean }) => (
  <span className="big-score" style={{ color: best ? "var(--accent)" : "var(--ink)" }}>
    {score ?? "–"}
    <span>/ 10</span>
  </span>
);

const Warning = ({ parse }: { readonly parse: PageParse }) =>
  parse.warning === null ? null : (
    <p className="issues-line clip" style={{ color: "var(--bad)" }} title={parse.warning}>
      ⚠ {parse.warning}
    </p>
  );

const Issues = ({
  parse,
  flags,
  found,
}: {
  readonly parse: PageParse;
  readonly flags: ReadonlyArray<JudgedError>;
  readonly found: ReadonlyArray<ReadonlyArray<HTMLElement>>;
}) => {
  const [open, setOpen] = useState(false);
  const close = useMemo(() => () => setOpen(false), []);
  const ref = useDismiss(open, close);
  if (parse.status !== "succeeded")
    return (
      <p className="issues-line clip" style={{ color: "var(--bad)" }} title={parse.error ?? undefined}>
        {parse.error ?? "Parse failed."}
      </p>
    );
  const counts = (["high", "figure_error", "medium", "low"] as const)
    .map((sev) => [sev, flags.filter((f) => f.severity === sev).length] as const)
    .filter(([, n]) => n > 0);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button type="button" className="issues-line issues-trigger" aria-expanded={open} onClick={() => setOpen(!open)}>
        {counts.length === 0 ? (
          <span style={{ color: "var(--good)" }}>✓ No errors</span>
        ) : (
          counts.map(([sev, n]) => (
            <span key={sev} className={`sev ${sev}`}>
              {n} {sev.toUpperCase()}
            </span>
          ))
        )}
        <span className="issues-more">
          {flags.length === 0 ? "Judge's note" : `${flags.length} issue${flags.length === 1 ? "" : "s"}`} <Caret />
        </span>
      </button>
      <Warning parse={parse} />
      {open && (
        <div className="popover issues-pop">
          {flags.length === 0 ? (
            <p className="reasoning" style={{ margin: 0 }}>
              {parse.reasoning}
            </p>
          ) : (
            <div className="flag-list">
              {flags.map((flag, i) => (
                <FlagCard key={`${flag.category}:${flag.description}`} flag={flag} n={i + 1} marks={found[i] ?? []} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const Column = ({
  column,
  parse,
  best,
  menu,
  focus,
}: {
  readonly column: number;
  readonly parse: PageParse;
  readonly best: boolean;
  readonly menu: React.ReactNode;
  /** Index of a flag to scroll to when the column opens. */
  readonly focus: number | null;
}) => {
  const flags = useMemo(() => flagsOf(parse), [parse]);
  const [found, setFound] = useState<Array<Array<HTMLElement>>>([]);
  useEffect(() => {
    const marks = focus === null ? undefined : found[focus];
    if (marks === undefined || marks.length === 0) return;
    marks[0]?.scrollIntoView({ behavior: "smooth", block: "center" });
    for (const mark of marks) mark.classList.add("pulse");
    const timer = setTimeout(() => {
      for (const mark of marks) mark.classList.remove("pulse");
    }, 1600);
    return () => clearTimeout(timer);
  }, [focus, found]);
  return (
    <article className="pc-col">
      <div className="pc-col-head">
        <div className="flex" style={{ gap: 16, justifyContent: "space-between" }}>
          <div style={{ flex: 1, minWidth: 0 }}>{menu}</div>
          <Score score={parse.score} best={best} />
        </div>
        <Issues parse={parse} flags={flags} found={found} />
      </div>
      {parse.status === "succeeded" && parse.markdown !== null && (
        <div className="pc-col-body">
          <FlaggedOutput markdown={parse.markdown} flags={flags} column={column} onFound={setFound} />
        </div>
      )}
    </article>
  );
};

const DocPicker = ({
  stats,
  rows: sequence,
  current,
  presetIds,
  label,
  filter,
  sort,
  onFilter,
  onSort,
  onPick,
}: {
  readonly stats: ReadonlyArray<PageStat>;
  readonly rows: ReadonlyArray<PageStat>;
  readonly current: PageStat;
  readonly presetIds: ReadonlyArray<string>;
  readonly label: (presetId: string) => string;
  readonly filter: PageFilter;
  readonly sort: PageSort;
  readonly onFilter: (filter: PageFilter) => void;
  readonly onSort: (sort: PageSort) => void;
  readonly onPick: (pageId: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const close = useMemo(() => () => setOpen(false), []);
  const ref = useDismiss(open, close);
  const needle = query.trim().toLowerCase();
  const rows = sequence.filter((p) => p.filename.toLowerCase().includes(needle)).slice(0, 200);
  const grid = `minmax(0, 1fr) repeat(${presetIds.length}, 64px) 44px`;
  const pick = (id: string | undefined) => {
    if (id === undefined) return;
    setOpen(false);
    onPick(id);
  };
  const head = (key: string, text: string, title?: string) => (
    <button
      type="button"
      className={`plain sort-head${sort.key === key ? " on" : ""}`}
      style={{ justifyContent: key === "order" ? "flex-start" : "flex-end" }}
      title={title}
      onClick={() => onSort({ key, desc: sort.key === key ? !sort.desc : key === "gap" })}
    >
      <span className="clip">{text}</span>
      {sort.key === key && <span aria-hidden="true">{sort.desc ? "↓" : "↑"}</span>}
    </button>
  );
  return (
    <div ref={ref} className="picker-wrap" style={{ minWidth: 0, position: "relative" }}>
      <button type="button" className="picker-trigger" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="clip" title={current.filename}>
          {current.filename}
        </span>
        <span style={{ color: "var(--muted)", flexShrink: 0 }}>p. {current.index + 1}</span>
        <Caret />
      </button>
      {open && (
        <div className="popover picker" style={{ width: `min(${380 + presetIds.length * 72}px, calc(100vw - 32px))` }}>
          <div style={{ padding: 16 }}>
            <input
              className="search"
              placeholder="Search documents"
              value={query}
              // biome-ignore lint/a11y/noAutofocus: the picker opens to type into.
              autoFocus
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") setCursor(Math.min(cursor + 1, rows.length - 1));
                else if (e.key === "ArrowUp") setCursor(Math.max(cursor - 1, 0));
                else if (e.key === "Enter") pick(rows[cursor]?.id);
                else return;
                e.preventDefault();
              }}
            />
            <div className="flex" style={{ gap: 6, marginTop: 12 }}>
              {FILTERS.map(([key, text], i) => (
                <Fragment key={key}>
                  {i > 0 && (
                    <span className="caret" aria-hidden="true">
                      ›
                    </span>
                  )}
                  <button
                    type="button"
                    className={`chip-sm${filter === key ? " on" : ""}`}
                    onClick={() => {
                      onFilter(key);
                      setCursor(0);
                    }}
                  >
                    {text} · {stats.filter(inFilter(key)).length}
                  </button>
                </Fragment>
              ))}
            </div>
          </div>
          <div className="picker-row picker-head" style={{ gridTemplateColumns: grid }}>
            {head("order", "Document · page")}
            {presetIds.map((id) => (
              <Fragment key={id}>{head(id, label(id), label(id))}</Fragment>
            ))}
            {head("gap", "Gap", "Best score minus worst score")}
          </div>
          <div className="picker-rows">
            {rows.length === 0 && <p style={{ color: "var(--muted)", padding: "12px 16px" }}>No pages match.</p>}
            {rows.map((p, i) => {
              const low = Math.min(...Object.values(p.scores).filter((v): v is number => v !== null));
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`picker-row${p.id === current.id ? " viewing" : ""}${i === cursor ? " cursor" : ""}`}
                  style={{ gridTemplateColumns: grid }}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => pick(p.id)}
                >
                  <span style={{ minWidth: 0 }}>
                    <span className="clip" style={{ display: "block" }} title={p.filename}>
                      {p.filename}
                    </span>
                    <span className="menu-sub">
                      Page {p.index + 1} of {p.pageCount}
                      {p.id === current.id && " · viewing"}
                    </span>
                  </span>
                  {presetIds.map((id) => {
                    const score = p.scores[id];
                    return (
                      <span
                        key={id}
                        className="num"
                        style={{
                          color: score === null ? "var(--bad)" : score === low && p.gap > 0 ? "var(--ink)" : "var(--muted)",
                          textAlign: "right",
                        }}
                      >
                        {score === undefined ? "–" : score === null ? "failed" : score}
                      </span>
                    );
                  })}
                  <span className="num" style={{ textAlign: "right" }}>
                    {p.failed ? "–" : p.gap}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="picker-foot">J / K next and previous page in this list · ↑↓ to browse</div>
        </div>
      )}
    </div>
  );
};

const pairKey = (shareId: string) => `parsejudge.pair.${shareId}`;
const loadPair = (shareId: string): ReadonlyArray<string> => {
  try {
    return JSON.parse(localStorage.getItem(pairKey(shareId)) ?? "[]") as Array<string>;
  } catch {
    return [];
  }
};

export const PageCompare = ({
  shareId,
  pageId,
  view,
}: {
  readonly shareId: string;
  readonly pageId: string;
  readonly view: View;
}) => {
  const [run, setRun] = useState<Run | null>(null);
  const [sharing, setSharing] = useState(false);
  const [presets, setPresets] = useState<ReadonlyArray<Preset>>([]);
  const [detail, setDetail] = useState<PageDetail | null>(null);
  const [pair, setPair] = useState<ReadonlyArray<string>>(() => loadPair(shareId));

  useEffect(() => {
    api.shared(shareId).then(setRun);
    api.presets().then(setPresets);
  }, [shareId]);

  useEffect(() => {
    if (run === null) return;
    setDetail(null);
    api.page(run.id, pageId).then(setDetail);
  }, [run, pageId]);

  const [chosenFilter, setFilter] = useState<PageFilter | null>(null);
  const [sort, setSort] = useState<PageSort>({ key: "gap", desc: true });
  const [focus, setFocus] = useState<{ readonly presetId: string; readonly flag: number } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page clears the focused flag.
  useEffect(() => setFocus(null), [pageId]);

  const stats = useMemo(() => (run === null ? [] : pageStats(run)), [run]);
  const position = stats.findIndex((p) => p.id === pageId);
  const current = stats[position];
  const filter = chosenFilter ?? (current !== undefined && isFlagged(current) ? "flagged" : "all");
  const sequence = useMemo(() => stats.filter(inFilter(filter)).sort(bySort(sort)), [stats, filter, sort]);
  const at = sequence.findIndex((p) => p.id === pageId);
  const prev = at === -1 ? sequence.at(-1) : sequence[at - 1];
  const next = at === -1 ? sequence[0] : sequence[at + 1];
  const filterName = FILTERS.find(([key]) => key === filter)?.[1] ?? "";
  const go = (id: string | undefined, nextView: View = view) => id !== undefined && navigate(pageUrl(shareId, id, nextView));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "j") go(next?.id);
      if (event.key === "k") go(prev?.id);
      if (event.key === "ArrowLeft") go(stats[position - 1]?.id);
      if (event.key === "ArrowRight") go(stats[position + 1]?.id);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  if (run === null || current === undefined) return <p style={{ padding: 24 }}>Loading…</p>;

  const presetOf = (id: string) => presets.find((p) => p.id === id);
  const runProviders = run.presetIds.map((id) => presetOf(id)?.provider);
  const name = (id: string) => {
    const preset = presetOf(id);
    if (preset === undefined) return id;
    const siblings = runProviders.filter((p) => p === preset.provider).length;
    return siblings > 1 ? `${providerName(preset.provider)} · ${preset.mode}` : providerName(preset.provider);
  };
  const short = (id: string) => {
    const preset = presetOf(id);
    if (preset === undefined) return id;
    const siblings = runProviders.filter((p) => p === preset.provider).length;
    return siblings > 1 ? preset.mode : (SHORT_NAMES[preset.provider] ?? preset.provider);
  };

  const parses = detail?.parses ?? [];
  const best = Math.max(...parses.map((p) => p.score ?? -1));
  const ranked = [...parses].sort(byScore);
  const ids = parses.map((p) => p.presetId);
  const a = pair[0] !== undefined && ids.includes(pair[0]) ? pair[0] : ranked[0]?.presetId;
  const b =
    pair[1] !== undefined && ids.includes(pair[1]) && pair[1] !== a
      ? pair[1]
      : ranked.findLast((p) => p.presetId !== a)?.presetId;
  const choose = (slot: 0 | 1, id: string) => {
    const next = slot === 0 ? [id, b ?? ""] : [a ?? "", id];
    setPair(next);
    localStorage.setItem(pairKey(shareId), JSON.stringify(next));
  };
  const issues = parses.reduce((n, p) => n + flagsOf(p).length, 0);
  const openSide = (presetId: string, flag: number | null) => {
    const top = ranked[0]?.presetId;
    const other = presetId === top ? ranked[1]?.presetId : top;
    const pairNext = presetId === top ? [presetId, other ?? ""] : [other ?? "", presetId];
    setPair(pairNext);
    localStorage.setItem(pairKey(shareId), JSON.stringify(pairNext));
    setFocus(flag === null ? null : { presetId, flag });
    go(pageId, "side");
  };

  return (
    <div className="pc">
      <header className="pc-header">
        <div className="flex" style={{ gap: 16, minWidth: 0 }}>
          <button type="button" className="plain" style={{ flexShrink: 0 }} onClick={() => navigate(`/r/${shareId}`)}>
            Parse Judge
          </button>
          <span style={{ color: "var(--faint)" }}>/</span>
          <DocPicker
            stats={stats}
            rows={sequence}
            current={current}
            presetIds={run.presetIds}
            label={short}
            filter={filter}
            sort={sort}
            onFilter={setFilter}
            onSort={setSort}
            onPick={(id) => go(id)}
          />
        </div>
        <div className="flex" style={{ gap: 12 }}>
          {sequence.length > 0 && (
            <div className="seg">
              <button type="button" aria-label="Previous page in list" disabled={prev === undefined} onClick={() => go(prev?.id)}>
                ‹
              </button>
              <span>{at === -1 ? `${filterName} · ${sequence.length}` : `${filterName} · ${at + 1} of ${sequence.length}`}</span>
              <button type="button" aria-label="Next page in list" disabled={next === undefined} onClick={() => go(next?.id)}>
                ›
              </button>
            </div>
          )}
          <div className="seg toggle">
            {(["side", "all"] as const).map((v) => (
              <button key={v} type="button" className={view === v ? "on" : ""} onClick={() => go(pageId, v)}>
                {v === "side" ? "Side by side" : "Table"}
              </button>
            ))}
          </div>
          <button className="btn" type="button" onClick={() => setSharing(true)}>
            <Icon name="link" />
            <span className="btn-label">Share</span>
          </button>
        </div>
      </header>
      {sharing && (
        <ShareDialog
          runId={run.id}
          shareId={run.shareId}
          visibility={run.visibility}
          shareContent={run.shareContent}
          owned={run.owned}
          path={pageUrl(run.shareId, pageId, view).slice(`/r/${run.shareId}`.length)}
          onClose={() => setSharing(false)}
          onChange={(c) => {
            setRun({ ...run, ...c });
            if (c.shareId !== run.shareId) navigate(pageUrl(c.shareId, pageId, view));
          }}
        />
      )}
      <div className="split pc-body">
        <aside className={`pc-original${view === "all" ? " narrow" : ""}`}>
          <div className="eyebrow">Original</div>
          <img src={current.imageUrl} alt={`${current.filename}, page ${current.index + 1}`} />
        </aside>
        {detail === null && <p style={{ padding: 24 }}>Loading…</p>}
        {detail !== null && view === "side" && (
          // biome-ignore lint/a11y/noStaticElementInteractions: hover only highlights matching blocks.
          <div
            className="pc-cols"
            onMouseMove={(e) => linkBlocks(e.currentTarget, e.target)}
            onMouseLeave={(e) => linkBlocks(e.currentTarget, null)}
          >
            {([a, b] as const).map((id, slot) => {
              const parse = parses.find((p) => p.presetId === id);
              if (parse === undefined) return null;
              return (
                <Column
                  key={parse.presetId}
                  column={slot}
                  focus={focus?.presetId === parse.presetId ? focus.flag : null}
                  parse={parse}
                  best={parse.score === best}
                  menu={
                    <ProviderMenu
                      parses={parses}
                      current={parse.presetId}
                      other={slot === 0 ? b : a}
                      otherSlot={slot === 0 ? "B" : "A"}
                      name={name}
                      onPick={(next) => choose(slot === 0 ? 0 : 1, next)}
                    />
                  }
                />
              );
            })}
          </div>
        )}
        {detail !== null && view === "all" && (
          <main className="pc-table">
            <div className="flex" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: 12, justifyContent: "space-between" }}>
              <div>
                <h2>Every provider on this page</h2>
                <p className="reasoning" style={{ margin: "4px 0 0" }}>
                  Scores and issues for every provider. Switch to Side by side to read the outputs.
                </p>
              </div>
              <span style={{ color: "var(--muted)", fontSize: 13 }}>
                {parses.length} providers · {issues} issues
              </span>
            </div>
            <div className="scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Score</th>
                    <th>Issues the judge found</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {ranked.map((parse) => {
                    const flags = flagsOf(parse);
                    return (
                      <tr key={parse.presetId}>
                        <td>
                          <button
                            type="button"
                            className="plain"
                            style={{ textAlign: "left" }}
                            onClick={() => openSide(parse.presetId, null)}
                          >
                            <div>{providerName(presetOf(parse.presetId)?.provider ?? parse.presetId)}</div>
                            <div className="menu-sub">{presetOf(parse.presetId)?.mode}</div>
                          </button>
                        </td>
                        <td className="table-score" style={{ color: parse.score === best ? "var(--accent)" : undefined }}>
                          {parse.score ?? "–"}
                        </td>
                        <td>
                          <Warning parse={parse} />
                          {parse.status !== "succeeded" ? (
                            <span style={{ color: "var(--bad)" }}>{parse.error ?? "Parse failed."}</span>
                          ) : flags.length === 0 ? (
                            <>
                              <div style={{ color: "var(--good)" }}>✓ No errors</div>
                              <div className="reasoning">{parse.reasoning}</div>
                            </>
                          ) : (
                            flags.map((flag, i) => (
                              <button
                                key={`${flag.category}:${flag.description}`}
                                type="button"
                                className="plain table-flag"
                                title="Show in the output"
                                onClick={() => openSide(parse.presetId, i)}
                              >
                                <span className={`sev ${flag.severity}`}>{flag.severity.toUpperCase()}</span>
                                <div>
                                  <div className="mono" style={{ fontSize: 13 }}>
                                    {flag.category}
                                  </div>
                                  <div>{flag.description}</div>
                                </div>
                              </button>
                            ))
                          )}
                        </td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          {parse.status === "succeeded" && (
                            <button type="button" className="btn" onClick={() => openSide(parse.presetId, null)}>
                              Compare →
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </main>
        )}
      </div>
    </div>
  );
};
