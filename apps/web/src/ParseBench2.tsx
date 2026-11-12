import DOMPurify from "dompurify";
import { marked } from "marked";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { currentUser } from "./api.ts";
import { Shell, SiteBar, SiteFoot } from "./Nav.tsx";
import "./parsebench2.css";

type Judge = {
  readonly judge: string;
  readonly reasoning?: string;
  readonly errors?: ReadonlyArray<{ readonly description: string; readonly severity: string; readonly category?: string }>;
};
type Pair = {
  readonly id: number;
  readonly dir: "low" | "high";
  readonly subset: string;
  readonly vendor: string;
  readonly native: number;
  readonly gpt: number;
  readonly why?: ReadonlyArray<string>;
  readonly rules?: ReadonlyArray<{ readonly t: string; readonly ok: boolean; readonly x: string }>;
  readonly judges: ReadonlyArray<Judge>;
  readonly output: string;
  readonly gt_md?: string | null;
  readonly best?: { readonly vendor: string; readonly output: string } | null;
};

const BASE = "/parsebench-2";
const VENDORS: Record<string, string> = {
  reducto_r1: "Reducto r-1",
  llamaparse_agentic_plus: "LlamaParse Agentic Plus",
  datalab_accurate: "Datalab Accurate",
  extend_performance_agentic_formulas: "Extend Performance",
  mistral_ocr_4_1: "Mistral OCR",
  azure_layout_high_res_formulas: "Azure Layout",
  pulse_ultra_2: "Pulse Ultra 2",
  cohere_parse_v5: "Cohere Parse",
};
const DIRS = { low: "Scored too low", high: "Scored too high" } as const;
const SEV: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const vendor = (v: string) => VENDORS[v] ?? v;
const subset = (s: string) => {
  const t = s.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x < 1 ? x.toFixed(2) : x.toFixed(1));
const tone = (x: number) => (x < 5 ? "lo" : x >= 7 ? "hi" : "mid");
const judgeOf = (d: Pair) => d.judges.find((j) => j.judge.startsWith("gpt"));
const errorsOf = (d: Pair) => [...(judgeOf(d)?.errors ?? [])].sort((a, b) => (SEV[a.severity] ?? 9) - (SEV[b.severity] ?? 9));
const summary = (d: Pair) =>
  d.dir === "low" ? (judgeOf(d)?.reasoning ?? "") : (errorsOf(d)[0]?.description ?? judgeOf(d)?.reasoning ?? "");
const verdict = (d: Pair) =>
  d.dir === "low"
    ? `The output is right. ParseBench-2 gave it ${fmt(d.native)} out of 10.`
    : `The output has real mistakes. ParseBench-2 gave it ${fmt(d.native)} out of 10.`;

const useHash = () => {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const update = () => setHash(location.hash);
    addEventListener("hashchange", update);
    return () => removeEventListener("hashchange", update);
  }, []);
  return hash;
};

const Scores = ({ d, big }: { readonly d: Pair; readonly big?: boolean }) => (
  <div className={big ? "pb2-tiles" : "pb2-mini"}>
    {(
      [
        ["ParseBench-2", d.native],
        ["Parse Judge", d.gpt],
      ] as const
    ).map(([label, x]) => (
      <div key={label} className={tone(x)}>
        <small>{label}</small>
        <b>{fmt(x)}</b>
        {big && <span>out of 10</span>}
      </div>
    ))}
  </div>
);

const Markdown = ({ md }: { readonly md: string }) => {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(md || "*(empty output)*", { async: false })), [md]);
  // biome-ignore lint/security/noDangerouslySetInnerHtml: the HTML is sanitized with DOMPurify.
  return <div className="pb2-md" dangerouslySetInnerHTML={{ __html: html }} />;
};

const Rows = ({ title, count, children }: { readonly title: string; readonly count: string; readonly children: ReactNode }) => (
  <details className="pb2-more">
    <summary>
      {title}
      <span>{count}</span>
    </summary>
    <div className="pb2-rows">{children}</div>
  </details>
);

const Row = ({
  mark,
  text,
  note,
}: {
  readonly mark: "x" | "v" | "dot";
  readonly text: string;
  readonly note?: string | undefined;
}) => (
  <div>
    <i className={mark}>{mark === "x" ? "✕" : mark === "v" ? "✓" : "·"}</i>
    <span>
      {text}
      {note && <em>{note}</em>}
    </span>
  </div>
);

const Checks = ({ d }: { readonly d: Pair }) => {
  const why = d.why ?? [];
  const rules = d.rules ?? [];
  const table = why[0]?.startsWith("table_next") ? why.filter((w) => !w.startsWith("rules:")) : [];
  const passed = rules.filter((r) => r.ok);
  const rows = [
    ...table.map((w, i) => {
      const m = /^\[(\w+)\] (.*)$/.exec(w.trim());
      return i === 0 ? (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity beyond their slot
        <Row key={`t${i}`} mark="x" text={w.replace(/^table_next: /, "Table check: ")} />
      ) : (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity beyond their slot
        <Row key={`t${i}`} mark="dot" text={m?.[2] ?? w.trim()} note={m?.[1]} />
      );
    }),
    ...[...rules.filter((r) => !r.ok), ...passed].map((r, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity beyond their slot
      <Row key={`r${i}`} mark={r.ok ? "v" : "x"} text={r.x || (r.ok ? "passed" : "failed")} note={r.t.replace(/_/g, " ")} />
    )),
  ];
  return (
    <Rows title="What ParseBench-2 checked" count={rules.length ? `${passed.length}/${rules.length} passed` : ""}>
      {rows.length ? rows : <Row mark="dot" text={why.join(" ") || "No per-check detail."} />}
    </Rows>
  );
};

const Mistakes = ({ d }: { readonly d: Pair }) => {
  const errors = errorsOf(d);
  if (!errors.length) return null;
  return (
    <Rows title="Mistakes Parse Judge found" count={String(errors.length)}>
      {errors.map((e, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity beyond their slot
        <Row key={i} mark="x" text={e.description} note={`${e.severity} · ${(e.category ?? "").replace(/_/g, " ")}`} />
      ))}
    </Rows>
  );
};

const List = ({
  pairs,
  view,
  dir,
  setDir,
  vend,
  setVend,
}: {
  readonly pairs: ReadonlyArray<Pair>;
  readonly view: ReadonlyArray<Pair>;
  readonly dir: Pair["dir"];
  readonly setDir: (d: Pair["dir"]) => void;
  readonly vend: string;
  readonly setVend: (v: string) => void;
}) => (
  <>
    <header className="article-head pb2-head">
      <h1>ParseBench-2 Examples</h1>
    </header>
    <div className="pb2-ctl">
      <div className="pb2-seg">
        {(Object.keys(DIRS) as Array<Pair["dir"]>).map((k) => (
          <button key={k} type="button" aria-pressed={k === dir} onClick={() => setDir(k)}>
            {DIRS[k]}
            <span>{pairs.filter((d) => d.dir === k && (!vend || d.vendor === vend)).length}</span>
          </button>
        ))}
      </div>
      <select value={vend} onChange={(e) => setVend(e.target.value)} aria-label="Parser">
        <option value="">All parsers</option>
        {[...new Set(pairs.map((d) => d.vendor))].map((v) => (
          <option key={v} value={v}>
            {vendor(v)}
          </option>
        ))}
      </select>
    </div>
    <div className="pb2-cards">
      {view.map((d) => (
        <a key={d.id} className="pb2-card" href={`#p${d.id}`}>
          <img loading="lazy" src={`${BASE}/thumb/${d.id}.webp`} alt="" />
          <div>
            <h3>{vendor(d.vendor)}</h3>
            <div className="pb2-sub">{subset(d.subset)}</div>
            <Scores d={d} />
            <p>{summary(d)}</p>
          </div>
        </a>
      ))}
      {!view.length && <p className="pb2-note">No examples for this parser here.</p>}
    </div>
    <article className="article pb2-ed">
      <h2>Why these scores are wrong</h2>
      <p>
        ParseBench-2 is a benchmark for PDF and document parsers. It does not look at the page. It runs automatic rules and a
        strict table matcher against each parser's output and turns the result into a score. Each example here puts the page, the
        output and the correct answer side by side, so you can judge for yourself.
      </p>
      <p>
        It fails correct tables. In 25 examples, Parse Judge scores the output 7 or higher (18 of them 9 or 10) while ParseBench-2
        gives 3 or less. In 20 of these the table matcher is the cause: if one header is worded a little differently, or a merged
        header cell is split another way, every cell under it counts as wrong. A table with every number right can score 0.
      </p>
      <p>
        It passes broken pages. In 15 examples, ParseBench-2 scores 8.5 or higher while Parse Judge gives 5 or less. The rules
        check only a few cells or phrases per page, so the rest goes unchecked. One page was read back to front and still scored
        10.
      </p>
      <h2>How Parse Judge scores</h2>
      <p>
        Parse Judge is a vision model that reads the page image next to the parser's output and scores how faithful the output is,
        from 0 to 10. It uses the same judge and prompt as every run on this site; see the <a href="/methodology">methodology</a>.
      </p>
      <p>
        Teams choose a parser by its benchmark score. A score that fails correct tables and passes broken pages points them the
        wrong way. A parsing benchmark should score what a person reading the page would see.
      </p>
    </article>
  </>
);

const Detail = ({ d, view }: { readonly d: Pair; readonly view: ReadonlyArray<Pair> }) => {
  const mobile = useMemo(() => matchMedia("(max-width: 860px)").matches, []);
  const [tab, setTab] = useState<"page" | "out" | "ref">(mobile ? "page" : "out");
  useEffect(() => setTab(mobile ? "page" : "out"), [mobile]);
  const i = view.indexOf(d);
  const step = (k: number) => {
    const n = view[(i + k + view.length) % view.length];
    if (n) location.hash = `p${n.id}`;
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).matches("input, select")) return;
      if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "Escape") location.hash = "";
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  });
  const ref = d.gt_md
    ? { title: "Correct answer", note: "", md: d.gt_md }
    : d.best
      ? {
          title: "Best other parser",
          note: `This page has no answer key, so this is the best other parser (${vendor(d.best.vendor)}).`,
          md: d.best.output,
        }
      : null;
  const judge = judgeOf(d);
  const tabs = [
    ["page", "Page", true],
    ["out", "This output", false],
    ...(ref ? [["ref", ref.title, false] as const] : []),
  ] as const;
  const shown = !mobile && tab === "page" ? "out" : tab;
  const page = <img src={`${BASE}/img/${d.id}.webp`} alt="Source page" />;
  return (
    <>
      <div className="pb2-dhead">
        <div className="pb2-dnav">
          <button
            type="button"
            className="pb2-back"
            onClick={() => {
              location.hash = "";
            }}
          >
            ← All examples
          </button>
          <span>
            {i + 1} / {view.length}
          </span>
          <button type="button" aria-label="Previous" onClick={() => step(-1)}>
            ‹
          </button>
          <button type="button" aria-label="Next" onClick={() => step(1)}>
            ›
          </button>
        </div>
        <h1>
          {vendor(d.vendor)} · {subset(d.subset)}
        </h1>
        <p className="pb2-say pb2-big">{verdict(d)}</p>
        <Scores d={d} big />
        {judge?.reasoning && (
          <p className="pb2-say">
            <span>Parse Judge says</span>
            {judge.reasoning}
          </p>
        )}
      </div>
      <div className="pb2-body">
        {!mobile && <div className="pb2-page">{page}</div>}
        <div>
          <div className="pb2-seg">
            {tabs
              .filter(([, , mobileOnly]) => mobile || !mobileOnly)
              .map(([k, t]) => (
                <button key={k} type="button" aria-pressed={shown === k} onClick={() => setTab(k)}>
                  {t}
                </button>
              ))}
          </div>
          {shown === "ref" && ref?.note && <p className="pb2-note">{ref.note}</p>}
          <div className="pb2-box">{shown === "page" ? page : <Markdown md={shown === "ref" && ref ? ref.md : d.output} />}</div>
          <Checks d={d} />
          <Mistakes d={d} />
        </div>
      </div>
    </>
  );
};

export const ParseBench2 = () => {
  const [pairs, setPairs] = useState<ReadonlyArray<Pair>>([]);
  const [dir, setDir] = useState<Pair["dir"]>("low");
  const [vend, setVend] = useState("");
  const hash = useHash();
  const pane = useRef<HTMLDivElement>(null);
  useEffect(() => {
    document.title = "ParseBench-2 Examples · Parse Judge";
    fetch(`${BASE}/data.json`)
      .then((r) => r.json() as Promise<ReadonlyArray<Pair>>)
      .then(setPairs);
    return () => {
      document.title = "Parse Judge";
    };
  }, []);
  const id = /^#p(\d+)$/.exec(hash)?.[1];
  const current = id === undefined ? undefined : pairs.find((d) => String(d.id) === id);
  useEffect(() => {
    if (current && current.dir !== dir) {
      setDir(current.dir);
      setVend("");
    }
  }, [current, dir]);
  useEffect(() => pane.current?.scrollTo(0, 0), []);
  const view = pairs.filter((d) => d.dir === dir && (!vend || d.vendor === vend));
  return (
    <Shell topbar={<SiteBar user={currentUser()} />} label="ParseBench-2 Examples" pane={pane}>
      <div className="page md-page pb2">
        {current ? (
          <Detail d={current} view={view.includes(current) ? view : pairs.filter((d) => d.dir === current.dir)} />
        ) : (
          <List pairs={pairs} view={view} dir={dir} setDir={setDir} vend={vend} setVend={setVend} />
        )}
      </div>
      <SiteFoot />
    </Shell>
  );
};
