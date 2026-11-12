/* The run report's interactive charts, ported from the design's evaluate-results.js:
   score vs price / latency (log x), head to head, and where providers disagree
   (range / line / distribution views, gap filter, head-to-head focus, page popover).
   `mountReport` builds into the report's own hosts and returns a cleanup. */
import type { PageDetail } from "../api.ts";

export interface Entry {
  readonly id: string;
  readonly tone: string;
  /** Chart label: the provider, plus the mode when the run has two modes of it. */
  readonly provider: string;
  /** The provider alone, for rows that show the mode beside it. */
  readonly short: string;
  readonly fullName: string;
  readonly mode: string;
  readonly mean: number;
  /** USD per page. */
  readonly price: number;
  /** Seconds, p50. */
  readonly p50: number | null;
}

export interface PageRow {
  readonly id: string;
  readonly doc: string;
  readonly page: number;
  readonly imageUrl: string;
  readonly note: string | null;
  readonly by: Readonly<Record<string, number | null>>;
  readonly min: number;
  readonly max: number;
  readonly gap: number;
  readonly mean: number;
}

type Outcome = "wins" | "ties" | "losses";
export type HeadToHead = Readonly<Record<string, Readonly<Record<string, Readonly<Record<Outcome, ReadonlyArray<string>>>>>>>;

export interface ReportData {
  readonly entries: ReadonlyArray<Entry>;
  readonly pages: ReadonlyArray<PageRow>;
  readonly h2h: HeadToHead;
  /** Page images and parser output are private to the owner. */
  readonly contentHidden: boolean;
  readonly detail: (pageId: string) => Promise<PageDetail | null>;
  readonly compare: (pageId: string) => string;
  readonly navigate: (href: string) => void;
}

const NS = "http://www.w3.org/2000/svg";
const esc = (s: unknown) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
const svgEl = (tag: string, attrs: Record<string, string | number>, parent?: Element) => {
  const el = document.createElementNS(NS, tag);
  for (const k in attrs) el.setAttribute(k, String(attrs[k]));
  if (parent) parent.appendChild(el);
  return el;
};
const docShort = (d: string) => d.replace(/\.[^.]+$/i, "");
const SEV_RANK: Record<string, number> = { high: 0, figure_error: 1, medium: 2, low: 3 };
const category = (c: string) => {
  const s = c.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** 1-2-5 log ticks from the largest tick at or under `lo` to the smallest at or over `hi`. */
export const logTicks = (lo: number, hi: number) => {
  const all: number[] = [];
  for (let e = Math.floor(Math.log10(lo)) - 1; e <= Math.ceil(Math.log10(hi)) + 1; e++)
    for (const m of [1, 2, 5]) all.push(Number((m * 10 ** e).toPrecision(3)));
  const first = all.filter((t) => t <= lo).at(-1) ?? all[0] ?? lo;
  const last = all.find((t) => t >= hi && t > first) ?? hi;
  return all.filter((t) => t >= first && t <= last);
};

const ICON: Record<string, string> = {
  "chevron-left": '<path d="m15 18-6-6 6-6"/>',
  "chevron-right": '<path d="m9 18 6-6-6-6"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  "arrow-up-right": '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  "chart-candlestick":
    '<path d="M9 5v4"/><rect width="4" height="6" x="7" y="9" rx="1"/><path d="M9 15v2"/><path d="M17 3v2"/><rect width="4" height="8" x="15" y="5" rx="1"/><path d="M17 13v3"/><path d="M3 3v16a2 2 0 0 0 2 2h16"/>',
  "chart-line": '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m19 9-5 5-4-4-3 3"/>',
  "chart-area":
    '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M7 11.207a.5.5 0 0 1 .146-.353l2-2a.5.5 0 0 1 .708 0l3.292 3.292a.5.5 0 0 0 .708 0l4.292-4.292a.5.5 0 0 1 .854.353V16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1z"/>',
};
const icon = (n: string) =>
  `<svg class="lucide lucide-${n}" xmlns="${NS}" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n] ?? ""}</svg>`;

export const mountReport = (root: HTMLElement, R: ReportData): (() => void) => {
  const E = R.entries;
  const P = R.pages;
  const $ = (id: string) => root.querySelector<HTMLElement>(`#${id}`) as HTMLElement;
  const frame = (root.closest(".pjx") ?? document.body) as HTMLElement;
  const pane = root.closest(".content-pane") as HTMLElement | null;
  const cleanups: Array<() => void> = [];
  const on = <K extends keyof DocumentEventMap>(
    target: Document | Window | HTMLElement,
    type: K | string,
    fn: (e: never) => void,
    opts?: AddEventListenerOptions | boolean,
  ) => {
    target.addEventListener(type, fn as EventListener, opts);
    cleanups.push(() => target.removeEventListener(type, fn as EventListener, opts));
  };
  const score = (pg: PageRow | undefined, id: string) => pg?.by[id] ?? null;

  function axisTitles(
    svg: Element,
    W: number,
    H: number,
    m: { l: number; r: number; t: number; b: number },
    xt: string,
    yt: string,
  ) {
    const xl = svgEl("text", { class: "ax-t ax-x", x: (m.l + W - m.r) / 2, y: H - 2, "text-anchor": "middle" }, svg);
    xl.textContent = xt;
    const cy = (m.t + H - m.b) / 2;
    svgEl("text", { class: "ax-t", x: 10, y: cy, "text-anchor": "middle", transform: `rotate(-90 10 ${cy})` }, svg).textContent =
      yt;
    return xl;
  }

  /* ---------- shared tooltip ---------- */
  const tip = document.createElement("div");
  tip.className = "dg-tip";
  frame.appendChild(tip);
  cleanups.push(() => tip.remove());
  const place = (x: number) => Math.max(8 + tip.offsetWidth / 2, Math.min(x, innerWidth - 8 - tip.offsetWidth / 2));
  function showTipBelow(html: string, x: number, y: number) {
    tip.innerHTML = html;
    tip.style.left = `${place(x)}px`;
    tip.style.top = `${y + 8}px`;
    tip.classList.add("show");
  }
  function showTip(html: string, x: number, y: number) {
    tip.innerHTML = html;
    tip.style.left = `${place(x)}px`;
    tip.style.top = `${y - tip.offsetHeight - 8}px`;
    tip.classList.add("show");
  }
  const hideTip = () => tip.classList.remove("show");

  /* ---------- score vs price / latency (log x) ---------- */
  function scatter(
    host: HTMLElement,
    xOf: (e: Entry) => number | null,
    fmt: (v: number) => string,
    detail: (e: Entry) => string,
    xTitle: string,
  ) {
    host.innerHTML = "";
    const pts = E.filter((e) => xOf(e) !== null && (xOf(e) as number) > 0);
    if (pts.length === 0) return;
    const xs = pts.map((e) => xOf(e) as number);
    /* pad the log domain so the cheapest and dearest points sit off the plot edges */
    const pad = Math.max(0.15, 0.08 * (Math.log(Math.max(...xs)) - Math.log(Math.min(...xs))));
    const lx0 = Math.log(Math.min(...xs)) - pad;
    const lx1 = Math.log(Math.max(...xs)) + pad;
    const ticks = logTicks(Math.exp(lx0), Math.exp(lx1)).filter((t) => Math.log(t) >= lx0 && Math.log(t) <= lx1);
    const W = Math.max(280, host.clientWidth);
    const H = 228;
    const m = { l: 42, r: 18, t: 10, b: 42 };
    const svg = svgEl("svg", { class: "chart sc-in", width: W, height: H, viewBox: `0 0 ${W} ${H}` }, host);
    const sx = (v: number) => m.l + ((Math.log(v) - lx0) / (lx1 - lx0 || 1)) * (W - m.l - m.r);
    const lo = Math.max(1, Math.floor(Math.min(...pts.map((e) => e.mean))) - 1);
    const sy = (v: number) => m.t + ((10 - v) / (10 - lo)) * (H - m.t - m.b);
    /* the better quadrant: higher score for less (upper left of the plot's midpoints) */
    const midX = (m.l + W - m.r) / 2;
    const midY = (m.t + H - m.b) / 2;
    svgEl("rect", { class: "zone", x: m.l, y: m.t, width: midX - m.l, height: midY - m.t, rx: 4 }, svg);
    svgEl("text", { class: "zone-l", x: m.l + 8, y: m.t + 16 }, svg).textContent = "Ideal";
    for (let v = lo; v <= 10; v++) {
      svgEl("line", { class: v === lo ? "base" : "grid", x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v) }, svg);
      svgEl("text", { class: "ax", x: m.l - 8, y: sy(v) + 4, "text-anchor": "end" }, svg).textContent = String(v);
    }
    for (const t of ticks)
      svgEl("text", { class: "ax", x: sx(t), y: H - m.b + 16, "text-anchor": "middle" }, svg).textContent = fmt(t);
    axisTitles(svg, W, H, m, xTitle, "Mean score");
    /* labels: right of the point, nudged apart vertically when two collide */
    const placed: number[] = [];
    pts
      .slice()
      .sort((a, b) => b.mean - a.mean)
      .forEach((e, i) => {
        const cx = sx(xOf(e) as number);
        const cy = sy(e.mean);
        const g = svgEl("g", { class: `sc-pt s-${e.tone}`, style: `animation-delay:${i * 60}ms` }, svg);
        svgEl("circle", { cx, cy, r: 5 }, g);
        let ly = cy + 4;
        for (const p of placed) if (Math.abs(p - ly) < 15) ly = p + 15;
        placed.push(ly);
        const right = cx < W - 110;
        const t = svgEl("text", { x: right ? cx + 10 : cx - 10, y: ly, "text-anchor": right ? "start" : "end" }, g);
        t.innerHTML = `${esc(e.provider)} <tspan class="v">${e.mean.toFixed(1)}</tspan>`;
        g.addEventListener("mouseenter", () => {
          const r = (g.querySelector("circle") as SVGCircleElement).getBoundingClientRect();
          showTip(
            `${esc(e.fullName)} <span class="m">· ${esc(e.mode)}</span><br>${e.mean.toFixed(2)} mean · ${detail(e)}`,
            r.left + r.width / 2,
            r.top,
          );
        });
        g.addEventListener("mouseleave", hideTip);
      });
  }
  const priceK = (v: number) => {
    const k = v * 1000;
    return k < 10 ? String(Math.round(k * 100) / 100) : String(Math.round(k));
  };
  function charts() {
    scatter(
      $("chPrice"),
      (e) => e.price * 1000,
      (v) => `$${v}`,
      (e) => `$${priceK(e.price)} / 1k pages`,
      "Price per 1k pages (log)",
    );
    scatter(
      $("chLatency"),
      (e) => e.p50,
      (v) => `${v} s`,
      (e) => `${(e.p50 ?? 0).toFixed(1)} s p50`,
      "p50 latency (log)",
    );
  }

  /* ---------- head to head ---------- */
  let h2hOn: string | null = null;
  const ent = (id: string) => E.find((e) => e.id === id) as Entry;
  function h2h() {
    const head = `<tr><th></th>${E.map((e) => `<th>vs ${esc(e.provider)}</th>`).join("")}</tr>`;
    const rows = E.map(
      (a) =>
        `<tr><td><span class="rn">${esc(a.provider)}</span></td>${E.map((b) => {
          if (a === b) return '<td class="dash">—</td>';
          const r = R.h2h[a.id]?.[b.id];
          if (!r) return '<td class="dash">—</td>';
          const n = (k: Outcome, cls: string) =>
            `<button class="h2h-n ${cls}" type="button" data-a="${a.id}" data-b="${b.id}" data-k="${k}"${r[k].length && !R.contentHidden ? "" : " disabled"}>${r[k].length}</button>`;
          return `<td>${n("wins", "w")}<span class="sep">·</span>${n("ties", "t")}<span class="sep">·</span>${n("losses", "l")}</td>`;
        }).join("")}</tr>`,
    ).join("");
    $("h2h").innerHTML = `<thead>${head}</thead><tbody>${rows}</tbody>`;
    for (const b of $("h2h").querySelectorAll<HTMLButtonElement>(".h2h-n"))
      b.onclick = () => {
        const { a: ai = "", b: bi = "", k = "wins" } = b.dataset;
        const key = ai + bi + k;
        if (h2hOn === key) {
          setFocus(null);
          return;
        }
        const a = ent(ai);
        const c = ent(bi);
        const verb = k === "wins" ? "over" : k === "losses" ? "under" : "tied with";
        setFocus({ key, ids: new Set(R.h2h[ai]?.[bi]?.[k as Outcome] ?? []), label: `${a.provider} ${verb} ${c.provider}` });
        $("dgCard").scrollIntoView({ behavior: "smooth", block: "center" });
      };
  }

  /* ============================================================
     WHERE PROVIDERS DISAGREE
     ============================================================ */
  const GAPS: ReadonlyArray<[number, string]> = [
    [0, "All"],
    [2, "2+"],
    [3, "3+"],
    [5, "5+"],
  ];
  const BY_GAP = P.slice().sort((a, b) => b.gap - a.gap || a.mean - b.mean);
  let ORDER = BY_GAP.slice();
  const pageNo = (pg: PageRow) => P.indexOf(pg) + 1;
  const st: {
    thr: number;
    focus: { key: string; ids: Set<string>; label: string } | null;
    emph: string | null;
    sel: number;
    kb: number;
    kbMode: boolean;
    view: "range" | "line" | "area";
    sort: "page" | "gap";
    zoom: { a: number; b: number } | null;
  } = { thr: 0, focus: null, emph: null, sel: -1, kb: -1, kbMode: false, view: "line", sort: "gap", zoom: null };
  const VIEWS: ReadonlyArray<[typeof st.view, string, string]> = [
    ["range", "chart-candlestick", "Range"],
    ["line", "chart-line", "Lines"],
    ["area", "chart-area", "Distribution"],
  ];
  let lines: SVGElement[] = [];
  type BinStats = { mean: Record<string, number | null>; hi: number; lo: number; rep: PageRow };
  type Col = {
    g: SVGElement;
    bg: SVGElement;
    pg: PageRow;
    pages: ReadonlyArray<PageRow>;
    stats: BinStats;
    pts: SVGElement[];
    cx: number;
    rng: SVGElement | null;
  };
  let geo: {
    W: number;
    H: number;
    m: { l: number; r: number; t: number; b: number };
    slot: number;
    sy: (v: number) => number;
    dense: boolean;
    CAP: number;
    plotW: number;
    view: ReadonlyArray<PageRow>;
  } | null = null;
  let binOf = new Map<PageRow, number>();
  let cols: Col[] = [];
  let band: SVGElement | null = null;

  function seg() {
    $("dgSeg").innerHTML = GAPS.map(
      ([v, l]) =>
        `<button class="mode-btn${v === st.thr ? " active" : ""}" type="button" role="tab" aria-selected="${v === st.thr}" data-g="${v}">${l}</button>`,
    ).join("");
    for (const b of $("dgSeg").querySelectorAll<HTMLButtonElement>("[data-g]"))
      b.onclick = () => {
        st.thr = Number(b.dataset.g);
        seg();
        apply();
      };
  }
  function viewSeg() {
    $("dgView").innerHTML = VIEWS.map(
      ([v, ic, tipT]) =>
        `<button class="mode-btn icon${v === st.view ? " active" : ""}" type="button" role="tab" aria-selected="${v === st.view}" aria-label="${tipT}" data-v="${v}">${icon(ic)}</button>`,
    ).join("");
    for (const b of $("dgView").querySelectorAll<HTMLButtonElement>("[data-v]")) {
      b.onmouseenter = () => {
        const r = b.getBoundingClientRect();
        showTipBelow(b.getAttribute("aria-label") ?? "", r.left + r.width / 2, r.bottom);
      };
      b.onmouseleave = hideTip;
      b.onclick = () => {
        if (st.view === b.dataset.v) return;
        st.view = b.dataset.v as typeof st.view;
        close();
        hideTip();
        viewSeg();
        $("dgSeg").hidden = st.view === "area";
        sortSeg();
        /* cross-fade: the old view settles out, the new one draws in */
        const host = $("dgWrap");
        host.classList.add("is-swap");
        setTimeout(() => {
          build(true);
          host.classList.remove("is-swap");
        }, 140);
      };
    }
  }
  function sortSeg() {
    const host = $("dgSort");
    host.hidden = st.view === "area";
    host.innerHTML = (
      [
        ["page", "Page order"],
        ["gap", "Widest gap"],
      ] as const
    )
      .map(
        ([v, l]) =>
          `<button class="mode-btn${v === st.sort ? " active" : ""}" type="button" role="tab" aria-selected="${v === st.sort}" data-s="${v}">${l}</button>`,
      )
      .join("");
    for (const b of host.querySelectorAll<HTMLButtonElement>("[data-s]"))
      b.onclick = () => {
        if (st.sort === b.dataset.s) return;
        st.sort = b.dataset.s as typeof st.sort;
        sortSeg();
        close();
        hideTip();
        ORDER = st.sort === "gap" ? BY_GAP.slice() : P.slice();
        /* binned, the bins regroup: rebuild instead of sliding columns */
        if (st.zoom || geo?.dense) {
          st.zoom = null;
          build(true);
          return;
        }
        /* FLIP: remember each page's x, rebuild in the new order, slide every column home */
        const was: Record<string, number> = {};
        for (const c of cols) was[c.pg.id] = c.cx;
        build(false);
        const svg = $("dgWrap").querySelector("svg") as SVGSVGElement;
        for (const c of cols)
          for (const el of [c.g, c.bg]) {
            el.style.transition = "none";
            el.style.transform = `translateX(${(was[c.pg.id] ?? c.cx) - c.cx}px)`;
          }
        for (const l of lines) l.style.opacity = "0";
        void svg.getBoundingClientRect();
        requestAnimationFrame(() => {
          for (const c of cols)
            for (const el of [c.g, c.bg]) {
              el.style.transition = "";
              el.style.transform = "";
            }
          for (const l of lines) l.style.opacity = "";
        });
      };
  }
  function legend() {
    $("dgLegend").innerHTML = E.map(
      (e) =>
        `<button class="dg-leg s-${e.tone}${st.emph === e.id ? " is-on" : ""}" type="button" data-e="${e.id}" aria-pressed="${st.emph === e.id}"><span class="s-dot"></span>${esc(e.provider)}</button>`,
    ).join("");
    $("dgLegend").classList.toggle("has-on", !!st.emph);
    for (const b of $("dgLegend").querySelectorAll<HTMLButtonElement>("[data-e]"))
      b.onclick = () => {
        st.emph = st.emph === b.dataset.e ? null : (b.dataset.e ?? null);
        legend();
        apply();
      };
  }
  function setFocus(f: typeof st.focus) {
    st.focus = f;
    h2hOn = f ? f.key : null;
    for (const b of root.querySelectorAll<HTMLButtonElement>(".h2h-n"))
      b.classList.toggle("is-on", !!f && (b.dataset.a ?? "") + (b.dataset.b ?? "") + (b.dataset.k ?? "") === f.key);
    $("dgFocus").innerHTML = f
      ? `<span class="dg-focus">${esc(f.label)} · ${f.ids.size}<button class="sf-x" type="button" aria-label="Clear">${icon("x")}</button></span>`
      : "";
    if (f) ($("dgFocus").querySelector(".sf-x") as HTMLButtonElement).onclick = () => setFocus(null);
    /* binned, a focus recomputes each bin over its focused pages */
    if (geo?.dense && st.view !== "area") {
      close();
      build(false);
    } else apply();
  }

  const scored = (pg: PageRow) => E.filter((e) => score(pg, e.id) !== null);
  /* ---------- the range / line chart, at any page count ----------
     While a page gets at least 6px every page is its own column. Past that (benchmarks
     run 500-2k pages) consecutive pages in the current order share a
     column, a BIN of a round size: each provider's dot is its mean over the bin, the rod
     spans the provider means, and the gap track under the plot shows how many of the
     bin's pages disagree. Clicking a bin expands it into its own pages. */
  const BIN_PX = { range: 14, line: 12 } as const;
  function binStats(pages: ReadonlyArray<PageRow>): BinStats {
    const use = st.focus ? pages.filter(inFocus) : pages;
    const src = use.length ? use : pages;
    const mean: Record<string, number | null> = {};
    for (const e of E) {
      const ss = src.map((p) => score(p, e.id)).filter((s): s is number => s !== null);
      mean[e.id] = ss.length ? ss.reduce((a, s) => a + s, 0) / ss.length : null;
    }
    const ms = Object.values(mean).filter((v): v is number => v !== null);
    const rep = src.slice().sort((a, b) => b.gap - a.gap || a.mean - b.mean)[0] as PageRow;
    return { mean, hi: ms.length ? Math.max(...ms) : 10, lo: ms.length ? Math.min(...ms) : 10, rep };
  }
  function build(animate: boolean) {
    if (P.length === 0) return; // documents deleted: no pages to chart
    if (st.view === "area") {
      buildArea(animate);
      return;
    }
    /* hold the chart's height across the rebuild so the page never jumps (scroll anchoring) */
    const host = $("dgWrap");
    host.style.minHeight = `${host.offsetHeight}px`;
    host.innerHTML = "";
    requestAnimationFrame(() => {
      host.style.minHeight = "";
    });
    area = null;
    const isLine = st.view === "line";
    const W = Math.max(480, host.clientWidth);
    const H = 330;
    const m = { l: 42, r: 4, t: 10, b: 72 };
    const plotW = W - m.l - m.r;
    const view = st.zoom ? ORDER.slice(st.zoom.a, st.zoom.b) : ORDER;
    const N = view.length;
    const dense = N * 6 > plotW;
    /* bins hold a round number of pages (5, 10, 20…), the smallest that fits the width */
    const maxBins = Math.max(1, Math.floor(plotW / BIN_PX[isLine ? "line" : "range"]));
    const size = dense
      ? ([2, 5, 10, 20, 50, 100, 200, 500, 1000].find((z) => Math.ceil(N / z) <= maxBins) ?? Math.ceil(N / maxBins))
      : 1;
    const nb = Math.max(1, Math.ceil(N / size));
    const CAP = nb * size;
    const slot = plotW / nb;
    const groups = Array.from({ length: nb }, (_, b) => view.slice(b * size, (b + 1) * size));
    binOf = new Map();
    groups.forEach((g, b) => {
      for (const pg of g) binOf.set(pg, b);
    });
    const stats = groups.map(binStats);
    /* the axis fits what is drawn: single pages by their scores, bins by their means */
    const lo = dense
      ? Math.max(0, Math.floor(Math.min(10, ...stats.map((x) => x.lo))) - 1)
      : Math.max(0, Math.min(10, ...P.map((p) => p.min)) - 1);
    const sy = (v: number) => m.t + ((10 - v) / (10 - lo)) * (H - m.t - m.b);
    geo = { W, H, m, slot, sy, dense, CAP, plotW, view };
    const svg = svgEl(
      "svg",
      {
        class: `chart dg-svg${isLine ? " is-line" : ""}${dense ? " is-dense" : ""}${st.sort === "page" ? " by-page" : ""}${animate ? " is-pre" : ""}`,
        width: W,
        height: H,
        viewBox: `0 0 ${W} ${H}`,
        role: "img",
      },
      host,
    );
    band = svgEl("rect", { class: "band", x: m.l, y: m.t - 4, height: H - m.t - m.b + 4, rx: 4 }, svg);
    axisTitles(svg, W, H, m, st.sort === "gap" ? "Score gap, widest first" : "Page", "Score");
    for (let v = lo; v <= 10; v++) {
      svgEl("line", { class: v === lo ? "base" : "grid", x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v) }, svg);
      if ((v - lo) % (10 - lo > 6 ? 2 : 1) === 0 || v === 10)
        svgEl("text", { class: "ax", x: m.l - 8, y: sy(v) + 4, "text-anchor": "end" }, svg).textContent = String(v);
    }
    const TH = 24;
    const trackBase = H - m.b + 8 + TH;
    const axY = trackBase + 15;
    svgEl("text", { class: "ax gs-l", x: m.l - 8, y: H - m.b + 25, "text-anchor": "end" }, svg).textContent = "Gap";
    /* everything that moves when a set stretches open sits in one layer clipped to the plot */
    const cp = svgEl("clipPath", { id: "dgClip" }, svgEl("defs", {}, svg));
    svgEl("rect", { x: m.l - 6, y: 0, width: plotW + 10 + m.r, height: H }, cp);
    const plotLayer = svgEl("g", { "clip-path": "url(#dgClip)" }, svg);
    /* column washes live in their own layer UNDER the lines; each column's marks sit above */
    const bgLayer = svgEl("g", {}, plotLayer);
    const yOf = (b: number, id: string) => (dense ? (stats[b]?.mean[id] ?? null) : score(groups[b]?.[0] as PageRow, id));
    /* line view: one path per provider through its score (or bin mean); a gap breaks the line */
    lines = isLine
      ? E.map((e) => {
          let d = "";
          let pen = false;
          groups.forEach((_, b) => {
            const s = yOf(b, e.id);
            if (s === null) {
              pen = false;
              return;
            }
            d += `${pen ? "L" : "M"}${(m.l + slot * (b + 0.5)).toFixed(1)},${sy(s).toFixed(1)}`;
            pen = true;
          });
          return svgEl("path", { class: `dg-line s-${e.tone}`, "data-e": e.id, d, pathLength: 1 }, plotLayer);
        })
      : [];
    const ptR = isLine ? (dense ? 2 : 2.6) : dense ? Math.max(2, Math.min(3, slot * 0.2)) : 3.6;
    /* the gap track: binned, a stacked bar of the share of the bin's pages at gap 5+, 3-4
       and 2, scaled so the most disagreeing bin fills the band; a page alone, one bar as
       tall as its gap */
    const bucket = (gp: number) => (gp >= 5 ? 5 : gp >= 3 ? 3 : gp >= 2 ? 2 : 1);
    const poolOf = (pages: ReadonlyArray<PageRow>) => (st.focus ? pages.filter(inFocus) : pages);
    const shareOf = (pages: ReadonlyArray<PageRow>) => {
      const pl = poolOf(pages);
      return pl.length ? pl.filter((pg) => pg.gap >= 2).length / pl.length : 0;
    };
    const maxShare = dense ? Math.max(0.01, ...groups.map(shareOf)) : 1;
    const maxGapAll = Math.max(1, ...P.map((pg) => pg.gap));
    /* gap order: one label per run of equal gaps, centred under the run, dropped when it would crowd the last */
    const gapLabels: Array<{ x: number; gap: number; k: number }> = [];
    if (st.sort === "gap") {
      let start = 0;
      let lastX = Number.NEGATIVE_INFINITY;
      view.forEach((pg, k) => {
        if (view[k + 1]?.gap === pg.gap) return;
        const x = m.l + (((start + k + 1) / 2) * plotW) / CAP;
        if (x - lastX >= 20) {
          gapLabels.push({ x, gap: pg.gap, k: Math.floor((start + k) / 2) });
          lastX = x;
        }
        start = k + 1;
      });
    }
    cols = groups.map((pages, b) => {
      const cx = m.l + slot * (b + 0.5);
      const S = stats[b] as BinStats;
      const first = pages[0] as PageRow;
      const g = svgEl(
        "g",
        { class: "dg-col", "data-i": b, style: `--d:${animate ? Math.min(b * (dense ? 3 : 12), 520) : 0}ms` },
        plotLayer,
      );
      const bg = svgEl("g", { class: "dg-bg" }, bgLayer);
      svgEl("rect", { class: "qb", x: cx - slot / 2, y: m.t - 4, width: slot, height: H - m.t - m.b + 4 }, bg);
      svgEl(
        "rect",
        {
          class: "hov",
          x: cx - slot / 2 + (dense ? 0 : 1),
          y: m.t - 4,
          width: Math.max(2, slot - (dense ? 0 : 2)),
          height: H - m.t - m.b + 4,
          rx: dense ? 1 : 3,
        },
        bg,
      );
      /* the rod runs dot centre to dot centre (in a bin: lowest to highest provider mean) */
      const y1 = sy(dense ? S.hi : first.max);
      const y2 = sy(dense ? S.lo : first.min);
      const rng = isLine
        ? null
        : svgEl("rect", { class: "rng", x: cx - 1, y: y1, width: 2, height: Math.max(0, y2 - y1), rx: 1 }, g);
      const pts = E.flatMap((e) => {
        const v = yOf(b, e.id);
        return v === null ? [] : [svgEl("circle", { class: `pt s-${e.tone}`, "data-e": e.id, cx, cy: sy(v), r: ptR }, g)];
      });
      const cell = svgEl("g", { class: "gt" }, g);
      const bw = Math.max(1, Math.min(slot - (dense ? 1.5 : 6), 18));
      if (dense) {
        const pl = poolOf(pages);
        let y = trackBase;
        for (const k of [5, 3, 2]) {
          const h = (pl.filter((pg) => bucket(pg.gap) === k).length / (pl.length || 1) / maxShare) * TH;
          if (h <= 0) continue;
          y -= h;
          svgEl("rect", { class: "gt-s", "data-b": k, x: cx - bw / 2, y, width: bw, height: h }, cell);
        }
      } else {
        const h = Math.max(1.5, (first.gap / maxGapAll) * TH);
        svgEl(
          "rect",
          { class: "gt-s", "data-b": bucket(first.gap), x: cx - bw / 2, y: trackBase - h, width: bw, height: h, rx: 1 },
          cell,
        );
        /* page numbers at a stride in page order (a zoomed set starts mid-run); gap labels under their run */
        if (st.sort === "page") {
          const no = pageNo(first);
          const every = slot >= 22 ? 1 : N > 120 ? 50 : N > 60 ? 20 : 10;
          if (b === 0 || b === N - 1 || no % every === 0)
            svgEl("text", { class: "ax pg-l", x: cx, y: axY, "text-anchor": "middle" }, g).textContent = String(no);
        } else {
          const gl = gapLabels.find((l) => l.k === b);
          if (gl) svgEl("text", { class: "gap-l", x: gl.x, y: axY }, g).textContent = String(gl.gap);
        }
      }
      /* hit area = the plot only, never the axes */
      svgEl("rect", { class: "hit", x: cx - slot / 2, y: m.t - 4, width: slot, height: H - m.t - m.b + 4 }, g);
      return { g, bg, pg: S.rep, pages, stats: S, pts, cx, rng };
    });
    if (dense) {
      const ax = svgEl("g", { class: "dg-ax" }, svg);
      const lab = (x: number, t: number) => {
        svgEl("text", { class: "ax pg-l", x, y: axY, "text-anchor": "middle" }, ax).textContent = String(t);
      };
      if (st.sort === "page") {
        /* page numbers at a round stride that fits the width */
        const stride = [10, 20, 50, 100, 200, 250, 500, 1000].find((t) => N / t <= plotW / 64) ?? 1000;
        const xOf = (k: number) => m.l + ((k + 0.5) / CAP) * plotW;
        lab(xOf(0), pageNo(view[0] as PageRow));
        for (let k = stride - 1; k < N; k += stride) if (k > stride / 3) lab(xOf(k), pageNo(view[k] as PageRow));
      } else for (const l of gapLabels) lab(l.x, l.gap);
    }
    svg.addEventListener("mouseover", (e) => {
      const g = (e.target as Element).closest(".dg-col") as SVGElement | null;
      if (g) hover(Number(g.dataset.i));
      else {
        hideTip();
        for (const c of cols) c.bg.classList.remove("is-hov");
      }
    });
    svg.addEventListener("mouseleave", () => {
      hideTip();
      for (const c of cols) c.bg.classList.remove("is-hov");
    });
    /* a bin expands into its own pages; a single page opens its popover */
    svg.addEventListener("click", (e) => {
      const g = (e.target as Element).closest(".dg-col") as SVGElement | null;
      if (!g) return;
      if (dense) zoomTo(Number(g.dataset.i));
      else openAt(Number(g.dataset.i));
    });
    zoomChip();
    apply();
    if (animate)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          svg.classList.add("is-anim");
          svg.classList.remove("is-pre");
          setTimeout(() => svg.classList.remove("is-anim"), 1100);
        }),
      );
  }
  const inFocus = (pg: PageRow) => !st.focus || st.focus.ids.has(pg.id);
  const qualifies = (pg: PageRow) => (st.focus ? inFocus(pg) : pg.gap >= st.thr);
  const colLit = (c: Col) => c.pages.some((pg) => qualifies(pg) && inFocus(pg));
  function apply() {
    if (st.view === "area") {
      applyArea();
      return;
    }
    if (!geo || !band) return;
    for (const l of lines) {
      l.classList.toggle("is-mute", !!st.emph && l.dataset.e !== st.emph);
      l.classList.toggle("is-dim", !!st.focus);
    }
    const q = geo.view.filter(qualifies).length;
    band.style.width = st.sort === "gap" && !st.focus ? `${Math.max(0, (q / geo.CAP) * geo.plotW)}px` : "0px";
    const svg = $("dgWrap").querySelector("svg");
    svg?.classList.toggle("has-focus", !!st.focus);
    /* the gap track steps back the buckets under the gap filter */
    svg?.setAttribute("data-thr", String(st.focus ? 0 : st.thr));
    cols.forEach((c, i) => {
      c.g.classList.toggle("is-off", !st.focus && !colLit(c));
      c.g.classList.toggle("is-out", !c.pages.some(inFocus));
      c.g.classList.toggle("is-sel", i === st.sel);
      c.g.classList.toggle("is-kb", st.kbMode && i === st.kb && st.sel < 0);
      for (const k of ["is-off", "is-out", "is-sel", "is-kb"]) c.bg.classList.toggle(k, c.g.classList.contains(k));
      for (const p of c.pts) p.classList.toggle("is-mute", !!st.emph && p.dataset.e !== st.emph);
    });
    /* the chart head carries no page count: the lit columns say it */
    $("dgCount").textContent = "";
  }
  function hover(i: number) {
    const c = cols[i];
    if (!c) return;
    cols.forEach((x, j) => {
      x.bg.classList.toggle("is-hov", j === i);
    });
    const r = (c.bg.querySelector(".hov") as SVGElement).getBoundingClientRect();
    const ns = c.pages.map(pageNo);
    showTip(
      c.pages.length === 1
        ? `<span class="m">${pageNo(c.pg)} ·</span> ${esc(docShort(c.pg.doc))} <span class="m">· p. ${c.pg.page} · gap ${c.pg.gap}</span>`
        : st.sort === "page"
          ? `Pages ${Math.min(...ns)}–${Math.max(...ns)}`
          : `${c.pages.length} pages`,
      r.left + r.width / 2,
      r.bottom - 2,
    );
  }

  /* ---------- zoom: a bin expands into its own pages ----------
     The chart swaps to just that set, one column a page, with a chip naming the set:
     ‹ › walk to the neighbouring set of the same size, × (or Escape) returns. The move
     reads as stretching that stretch of the chart: the old chart rides on as a ghost
     clipped to the plot while the new columns spread out from where they sat. */
  function zoomTo(i: number) {
    const c = cols[i];
    if (!c) return;
    const a = ORDER.indexOf(c.pages[0] as PageRow);
    setZoom({ a, b: a + c.pages.length }, i);
  }
  function setZoom(z: typeof st.zoom, fromBin?: number) {
    close();
    hideTip();
    const host = $("dgWrap");
    const oldSvg = host.querySelector("svg");
    const og = geo;
    const prev = st.zoom;
    const srcCol = fromBin === undefined ? undefined : cols[fromBin];
    st.zoom = z;
    st.kb = -1;
    build(false);
    if (!oldSvg || !og || !geo || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const L = geo.m.l;
    const PW = geo.plotW;
    let x0 = 0;
    let w = PW;
    let dir = 0;
    const kind = srcCol ? "in" : !z && prev ? "out" : "step";
    if (srcCol) {
      x0 = srcCol.cx - og.slot / 2;
      w = og.slot;
    } else if (kind === "out" && prev) {
      const c = cols[binOf.get(ORDER[prev.a] as PageRow) ?? -1];
      if (!c) return;
      x0 = c.cx - geo.slot / 2;
      w = geo.slot * Math.max(1, Math.round((prev.b - prev.a) / Math.max(1, c.pages.length)));
    } else dir = z && prev ? Math.sign(z.a - prev.a) : 1;
    const ghost = document.createElement("div");
    ghost.className = "dg-ghost";
    ghost.style.left = `${L}px`;
    ghost.style.width = `${PW}px`;
    ghost.style.height = `${og.H}px`;
    oldSvg.style.marginLeft = `${-L}px`;
    oldSvg.style.transformOrigin = `${kind === "in" ? x0 : L}px 0`;
    ghost.appendChild(oldSvg);
    host.appendChild(ghost);
    const ghostTo =
      kind === "in"
        ? `translateX(${L - x0}px) scaleX(${PW / w})`
        : kind === "out"
          ? `translateX(${x0 - L}px) scaleX(${w / PW})`
          : `translateX(${-dir * PW}px)`;
    const startX = (cx: number) =>
      kind === "in" ? x0 + ((cx - L) / PW) * w : kind === "out" ? L + ((cx - x0) / w) * PW : cx + dir * PW;
    const fromY = (id: string | null) => {
      const v = id && srcCol ? srcCol.stats.mean[id] : null;
      return v === null || v === undefined ? null : og.sy(v);
    };
    const moved: SVGElement[] = [];
    for (const c of cols) {
      const dx = startX(c.cx) - c.cx;
      for (const el of [c.g, c.bg]) {
        el.style.transition = "none";
        el.style.transform = `translateX(${dx}px)`;
        moved.push(el);
      }
      if (kind !== "in") continue;
      for (const p of c.pts) {
        const y = fromY(p.getAttribute("data-e"));
        p.style.transition = "none";
        if (y !== null) p.style.setProperty("cy", `${y}px`);
      }
      if (c.rng) {
        c.rng.style.transition = "none";
        c.rng.style.opacity = "0";
      }
    }
    for (const l of lines) {
      const d = l.getAttribute("d") ?? "";
      const e = l.dataset.e ?? null;
      const d0 = d.replace(/([ML])([\d.]+),([\d.]+)/g, (_m, c: string, x: string, y: string) => {
        const yy = kind === "in" ? fromY(e) : null;
        return `${c}${startX(Number(x)).toFixed(1)},${yy === null ? y : yy.toFixed(1)}`;
      });
      l.style.transition = "none";
      l.style.setProperty("d", `path('${d0}')`);
      l.dataset.d = d;
    }
    const ax = host.querySelector<SVGElement>(".dg-ax");
    if (ax) {
      ax.style.transition = "none";
      ax.style.opacity = "0";
    }
    void host.offsetWidth;
    const move = "var(--dur-zoom) var(--ease-out)";
    requestAnimationFrame(() => {
      oldSvg.style.transition = `transform ${move}, opacity var(--dur-fade) var(--ease-out)`;
      oldSvg.style.transform = ghostTo;
      oldSvg.style.opacity = "0";
      for (const el of moved) {
        el.style.transition = `transform ${move}`;
        el.style.transform = "";
      }
      for (const c of cols) {
        for (const p of c.pts) {
          p.style.transition = `cy ${move}, opacity var(--dur-fade) var(--ease-standard)`;
          p.style.removeProperty("cy");
        }
        if (c.rng) {
          c.rng.style.transition = "opacity var(--dur-fade) var(--ease-standard) 120ms";
          c.rng.style.opacity = "";
        }
      }
      for (const l of lines) {
        l.style.transition = `d ${move}`;
        l.style.setProperty("d", `path('${l.dataset.d}')`);
      }
      if (ax) {
        ax.style.transition = "opacity var(--dur-fade) var(--ease-standard) 120ms";
        ax.style.opacity = "";
      }
    });
    setTimeout(() => {
      ghost.remove();
      for (const l of lines) {
        l.style.removeProperty("d");
        l.style.transition = "";
      }
      for (const el of moved) el.style.transition = "";
      for (const c of cols) for (const p of c.pts) p.style.transition = "";
    }, 400);
  }
  function zoomChip() {
    const host = $("dgZoom");
    const z = st.zoom;
    if (!z || st.view === "area") {
      host.innerHTML = "";
      return;
    }
    const set = ORDER.slice(z.a, z.b);
    const ns = set.map(pageNo);
    const gs = set.map((pg) => pg.gap);
    const hi = Math.max(...gs);
    const lo = Math.min(...gs);
    const label =
      st.sort === "page"
        ? `Pages ${Math.min(...ns)}–${Math.max(...ns)}`
        : `${set.length} pages · gap ${hi === lo ? hi : `${hi}–${lo}`}`;
    host.innerHTML = `<span class="dg-focus dg-zoom"><button class="sf-x" type="button" data-z="-1" aria-label="Previous set"${z.a <= 0 ? " disabled" : ""}>${icon("chevron-left")}</button><span class="t">${label}</span><button class="sf-x" type="button" data-z="1" aria-label="Next set"${z.b >= ORDER.length ? " disabled" : ""}>${icon("chevron-right")}</button><button class="sf-x" type="button" data-z="0" aria-label="Show all pages">${icon("x")}</button></span>`;
    for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-z]"))
      btn.onclick = () => {
        const d = Number(btn.dataset.z);
        const len = z.b - z.a;
        if (d === 0) setZoom(null);
        else if (d > 0) setZoom({ a: z.b, b: Math.min(ORDER.length, z.b + len) });
        else setZoom({ a: Math.max(0, z.a - len), b: z.a });
      };
  }

  /* ---------- area view: share of pages at or above each score ---------- */
  let area: {
    S: number[];
    sx: (s: number) => number;
    sy: (v: number) => number;
    series: Array<{ e: Entry; fill: SVGElement; line: SVGElement; dot: SVGElement }>;
  } | null = null;
  const areaPages = () => (st.focus ? P.filter(inFocus) : P);
  const share = (pages: ReadonlyArray<PageRow>, id: string, s: number) =>
    pages.length ? pages.filter((p) => (score(p, id) ?? -1) >= s).length / pages.length : 0;
  function buildArea(animate: boolean) {
    if (P.length === 0) return; // documents deleted: no pages to chart
    const host = $("dgWrap");
    host.style.minHeight = `${host.offsetHeight}px`;
    host.innerHTML = "";
    requestAnimationFrame(() => {
      host.style.minHeight = "";
    });
    cols = [];
    geo = null;
    lines = [];
    const W = Math.max(480, host.clientWidth);
    const H = 296;
    const m = { l: 52, r: 12, t: 10, b: 38 };
    const lo = Math.max(1, Math.min(10, ...P.map((p) => p.min)));
    /* strict → lenient: 10 on the left, lines climb toward 100% */
    const S: number[] = [];
    for (let s = 10; s >= lo; s--) S.push(s);
    const sx = (s: number) => m.l + ((10 - s) / (10 - lo || 1)) * (W - m.l - m.r);
    const sy = (v: number) => m.t + (1 - v) * (H - m.t - m.b);
    const svg = svgEl(
      "svg",
      { class: `chart dg-svg is-area${animate ? " is-pre" : ""}`, width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img" },
      host,
    );
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      svgEl("line", { class: v === 0 ? "base" : "grid", x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v) }, svg);
      svgEl("text", { class: "ax", x: m.l - 8, y: sy(v) + 4, "text-anchor": "end" }, svg).textContent = `${Math.round(v * 100)}%`;
    }
    for (const s of S)
      svgEl("text", { class: "ax", x: sx(s), y: H - m.b + 16, "text-anchor": "middle" }, svg).textContent =
        s === 10 ? "10" : `≥ ${s}`;
    axisTitles(svg, W, H, m, "Score", "Share of pages");
    const guide = svgEl("line", { class: "ar-guide", x1: 0, x2: 0, y1: m.t, y2: H - m.b }, svg);
    const fills = svgEl("g", {}, svg);
    const strokes = svgEl("g", {}, svg);
    const dots = svgEl("g", {}, svg);
    const series = E.map((e) => ({
      e,
      fill: svgEl("path", { class: `ar-fill s-${e.tone}`, "data-e": e.id }, fills),
      line: svgEl("path", { class: `dg-line s-${e.tone}`, "data-e": e.id, pathLength: 1 }, strokes),
      dot: svgEl("circle", { class: `ar-dot s-${e.tone}`, "data-e": e.id, r: 3.6, cx: -20, cy: -20 }, dots),
    }));
    const hit = svgEl(
      "rect",
      { class: "hit", x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: "transparent" },
      svg,
    );
    area = { S, sx, sy, series };
    hit.addEventListener("mousemove", (ev) => {
      const r = svg.getBoundingClientRect();
      const x = (ev as MouseEvent).clientX - r.left;
      const s = S.reduce((b, v) => (Math.abs(sx(v) - x) < Math.abs(sx(b) - x) ? v : b), S[0] ?? 10);
      const pages = areaPages();
      const cx = sx(s);
      guide.setAttribute("x1", String(cx));
      guide.setAttribute("x2", String(cx));
      guide.classList.add("on");
      const vals = series.map((o) => {
        const v = share(pages, o.e.id, s);
        o.dot.setAttribute("cx", String(cx));
        o.dot.setAttribute("cy", String(sy(v)));
        o.dot.classList.add("on");
        return [o.e, v] as const;
      });
      showTip(
        `${s === 10 ? "Scored 10" : `Scored ${s} or higher`}<br>${vals
          .slice()
          .sort((a, b) => b[1] - a[1])
          .map(([e, v]) => `${esc(e.provider)} <span class="m">${Math.round(v * 100)}%</span>`)
          .join(" · ")}`,
        r.left + cx,
        r.top + sy(0) - 6,
      );
    });
    hit.addEventListener("mouseleave", () => {
      hideTip();
      guide.classList.remove("on");
      for (const o of series) o.dot.classList.remove("on");
    });
    applyArea();
    if (animate)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          svg.classList.add("is-anim");
          svg.classList.remove("is-pre");
          setTimeout(() => svg.classList.remove("is-anim"), 900);
        }),
      );
  }
  function applyArea() {
    if (!area) return;
    const { S, sx, sy, series } = area;
    const pages = areaPages();
    for (const o of series) {
      const pts = S.map((s) => [sx(s), sy(share(pages, o.e.id, s))] as const);
      const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
      o.line.setAttribute("d", d);
      const lastX = pts[pts.length - 1]?.[0] ?? 0;
      const firstX = pts[0]?.[0] ?? 0;
      o.fill.setAttribute("d", `${d}L${lastX.toFixed(1)},${sy(0).toFixed(1)}L${firstX.toFixed(1)},${sy(0).toFixed(1)}Z`);
      const mute = !!st.emph && o.e.id !== st.emph;
      o.line.classList.toggle("is-mute", mute);
      o.fill.classList.toggle("is-mute", mute);
    }
    $("dgCount").textContent =
      `Share of ${st.focus ? pages.length : P.length} pages scoring at least each score. Higher is better.`;
  }

  /* ---------- page popover ---------- */
  const details = new Map<string, PageDetail | null>();
  const pop = document.createElement("div");
  pop.className = "pg-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Page details");
  frame.appendChild(pop);
  cleanups.push(() => pop.remove());
  let popOpen = false;
  function navList() {
    const l = cols.map((_, i) => i).filter((i) => colLit(cols[i] as Col));
    return l.length ? l : cols.map((_, i) => i);
  }
  function body(pg: PageRow) {
    const d = details.get(pg.id);
    const ranked = E.slice().sort((a, b) => (score(pg, b.id) ?? -1) - (score(pg, a.id) ?? -1));
    const thumb = R.contentHidden
      ? ""
      : `<div><div class="pp-thumb" data-zoom="1"><span class="shim"></span><img alt="" src="${esc(pg.imageUrl)}"></div></div>`;
    const note =
      pg.note ?? d?.parses.filter((p) => p.reasoning).sort((a, b) => (a.score ?? 0) - (b.score ?? 0))[0]?.reasoning ?? "";
    return `<div class="pp-body${R.contentHidden ? " no-thumb" : ""}">
      ${thumb}
      <div class="pp-main">
        ${note ? `<p class="pp-note">${esc(note)}</p>` : ""}
        <div class="pp-rows">${ranked
          .map((e) => {
            const s = score(pg, e.id);
            const parse = d?.parses.find((p) => p.presetId === e.id);
            const errs = (parse?.errors ?? []).slice().sort((a, b) => (SEV_RANK[a.severity] ?? 3) - (SEV_RANK[b.severity] ?? 3));
            const items = [
              ...(parse?.warning ? [`<li><span><span class="c hi">Cut off · </span>${esc(parse.warning)}</span></li>`] : []),
              ...errs
                .slice(0, 2)
                .map(
                  (x) =>
                    `<li><span><span class="c${x.severity === "high" ? " hi" : ""}">${x.severity === "high" ? "High · " : ""}${esc(category(x.category))} · </span>${esc(x.description)}</span></li>`,
                ),
              ...(errs.length > 2 ? [`<li><span class="c">${errs.length - 2} more</span></li>`] : []),
            ];
            const list =
              s === null
                ? `<li><span class="c hi">${esc(parse?.error ?? "Failed")}</span></li>`
                : d === undefined
                  ? ""
                  : items.length
                    ? items.join("")
                    : '<li><span class="clean">No errors</span></li>';
            return `<div class="pp-row s-${e.tone}">
            <div class="pp-row-h"><span class="pp-row-n">${esc(e.short)}<span class="m">${esc(e.mode)}</span></span><span class="pp-bar"><span style="width:${(s ?? 0) * 10}%"></span></span><span class="pp-row-s">${s ?? "–"}</span></div>
            <ul class="pp-errs">${list}</ul>
          </div>`;
          })
          .join("")}</div>
      </div>
    </div>`;
  }
  function head(pg: PageRow, i: number) {
    const nl = navList();
    const k = nl.indexOf(i);
    return `<div class="pp-head">
      <div class="pp-title"><span class="d">${esc(docShort(pg.doc))}</span><span class="p">Page ${pg.page}</span></div>
      <div class="pp-nav">${k >= 0 ? `<span class="pp-pos">${k + 1} / ${nl.length}</span>` : ""}
        <button class="icon-btn" type="button" data-nav="-1" aria-label="Previous page"${(k >= 0 ? k === 0 : !nl.some((j) => j < i)) ? " disabled" : ""}>${icon("chevron-left")}</button>
        <button class="icon-btn" type="button" data-nav="1" aria-label="Next page"${(k >= 0 ? k === nl.length - 1 : !nl.some((j) => j > i)) ? " disabled" : ""}>${icon("chevron-right")}</button>
        <button class="icon-btn" type="button" data-close aria-label="Close">${icon("x")}</button>
      </div>
    </div>`;
  }
  const foot = (pg: PageRow) =>
    R.contentHidden
      ? ""
      : `<div class="pp-foot"><span class="hint"></span><a class="btn" href="${esc(R.compare(pg.id))}" data-go><span class="btn-label">Compare outputs</span>${icon("arrow-up-right")}</a></div>`;

  function placePop(i: number) {
    const c = cols[i];
    if (!c) return;
    const r = (c.bg.querySelector(".hov") as SVGElement).getBoundingClientRect();
    const card = $("dgWrap").getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    let left = r.right + 10;
    let ox = "left";
    if (left + w > innerWidth - 8) {
      left = r.left - 10 - w;
      ox = "right";
    }
    left = Math.max(8, left);
    const top = Math.max(8, Math.min(card.top + card.height / 2 - h / 2, innerHeight - 8 - h));
    pop.style.setProperty("--ox", ox);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }
  function wire(pg: PageRow) {
    for (const b of pop.querySelectorAll<HTMLButtonElement>("[data-nav]")) b.onclick = () => step(Number(b.dataset.nav));
    (pop.querySelector("[data-close]") as HTMLButtonElement).onclick = close;
    const go = pop.querySelector<HTMLAnchorElement>("[data-go]");
    if (go)
      go.onclick = (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        R.navigate(R.compare(pg.id));
      };
    const t = pop.querySelector<HTMLElement>(".pp-thumb");
    if (t) {
      const img = t.querySelector("img") as HTMLImageElement;
      const ok = () => {
        img.classList.add("ok");
        t.querySelector(".shim")?.remove();
      };
      if (img.complete && img.naturalWidth) ok();
      else img.onload = ok;
      t.onclick = () => lightbox(pg.imageUrl);
    }
    /* parser errors come from the page itself, loaded once per page */
    if (!R.contentHidden && !details.has(pg.id))
      R.detail(pg.id).then((d) => {
        details.set(pg.id, d);
        const sel = cols[st.sel];
        if (!popOpen || !sel || sel.pg !== pg) return;
        const sw = pop.querySelector(".pp-swap") as HTMLElement;
        sw.innerHTML = body(pg);
        wire(pg);
        placePop(st.sel);
      });
  }
  function openAt(i: number, dir?: number) {
    hideTip();
    if (i === st.sel && popOpen && !dir) {
      close();
      return;
    }
    const c = cols[i];
    if (!c) return;
    const pg = c.pg;
    const wasOpen = popOpen;
    st.sel = i;
    if (st.kbMode) st.kb = i;
    apply();
    if (!wasOpen) {
      pop.classList.remove("glide");
      pop.innerHTML = `${head(pg, i)}<div class="pp-swap">${body(pg)}</div>${foot(pg)}`;
      wire(pg);
      placePop(i);
      void pop.offsetWidth;
      pop.classList.add("open");
      popOpen = true;
      return;
    }
    /* already open: glide to the new column and cross-fade the body in the travel direction */
    pop.classList.add("glide");
    (pop.querySelector(".pp-head") as HTMLElement).outerHTML = head(pg, i);
    const sw = pop.querySelector(".pp-swap") as HTMLElement;
    sw.style.setProperty("--dir", String(dir || 1));
    sw.classList.add("is-leaving");
    setTimeout(() => {
      sw.innerHTML = body(pg);
      const f = pop.querySelector(".pp-foot");
      if (f) f.outerHTML = foot(pg);
      sw.classList.remove("is-leaving");
      sw.classList.add("is-entering");
      wire(pg);
      placePop(i);
      requestAnimationFrame(() => requestAnimationFrame(() => sw.classList.remove("is-entering")));
    }, 110);
    placePop(i);
  }
  function step(d: number) {
    const nl = navList();
    const k = nl.indexOf(st.sel);
    const next =
      k >= 0
        ? nl[k + d]
        : d > 0
          ? nl.find((j) => j > st.sel)
          : nl
              .slice()
              .reverse()
              .find((j) => j < st.sel);
    if (next !== undefined) openAt(next, d);
  }
  function close() {
    if (!popOpen) return;
    pop.classList.remove("open", "glide");
    popOpen = false;
    st.sel = -1;
    apply();
  }
  on(document, "mousedown", (e: MouseEvent) => {
    const t = e.target as Element;
    if (!popOpen || pop.contains(t) || t.closest(".dg-col") || t.closest(".pg-lightbox")) return;
    close();
  });
  on(
    document,
    "mousedown",
    () => {
      if (st.kbMode) {
        st.kbMode = false;
        st.kb = -1;
        apply();
      }
    },
    true,
  );
  on(document, "keydown", (e: KeyboardEvent) => {
    if (frame.querySelector(".pg-lightbox")) {
      if (e.key === "Escape") closeLightbox();
      return;
    }
    if (popOpen) {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        step(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        step(-1);
      } else if (e.key === "Escape") {
        close();
        $("dgWrap").focus();
      }
      return;
    }
    if (e.key === "Escape" && st.zoom && st.view !== "area") {
      setZoom(null);
      return;
    }
    if (document.activeElement === $("dgWrap") && st.view !== "area") {
      const nl = navList();
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        let k = nl.indexOf(st.kb);
        k = k < 0 ? 0 : Math.max(0, Math.min(nl.length - 1, k + (e.key === "ArrowRight" ? 1 : -1)));
        st.kbMode = true;
        st.kb = nl[k] ?? 0;
        apply();
        hover(st.kb);
      } else if (e.key === "Enter" && st.kb >= 0) {
        e.preventDefault();
        if (geo?.dense) zoomTo(st.kb);
        else openAt(st.kb);
      }
    }
  });
  if (pane)
    on(
      pane,
      "scroll",
      () => {
        hideTip();
        if (popOpen) placePop(st.sel);
      },
      { passive: true },
    );

  /* ---------- lightbox ---------- */
  function lightbox(src: string) {
    const lb = document.createElement("div");
    lb.className = "pg-lightbox";
    lb.innerHTML = `<img alt="" src="${esc(src)}">`;
    lb.onclick = closeLightbox;
    frame.appendChild(lb);
    requestAnimationFrame(() => lb.classList.add("open"));
  }
  function closeLightbox() {
    const lb = frame.querySelector(".pg-lightbox");
    if (!lb) return;
    lb.classList.remove("open");
    setTimeout(() => lb.remove(), 200);
  }
  cleanups.push(() => frame.querySelector(".pg-lightbox")?.remove());

  /* ---------- boot ---------- */
  charts();
  h2h();
  seg();
  viewSeg();
  sortSeg();
  legend();
  build(true);
  let rT: ReturnType<typeof setTimeout> | undefined;
  on(window, "resize", () => {
    clearTimeout(rT);
    hideTip();
    rT = setTimeout(() => {
      close();
      charts();
      build(false);
    }, 120);
  });
  return () => {
    clearTimeout(rT);
    for (const c of cleanups) c();
  };
};
