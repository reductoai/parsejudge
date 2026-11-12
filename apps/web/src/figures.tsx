import { wilson } from "@parsejudge/core/summary";
import { range } from "d3-array";
import { randomLcg, randomNormal } from "d3-random";
import { scaleLinear } from "d3-scale";
import { linkHorizontal } from "d3-shape";
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";

const useWidth = (fallback: number) => {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = box.current;
    if (el === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [box, width] as const;
};

export const Figure = ({
  n,
  controls,
  caption,
  children,
}: {
  readonly n: number;
  readonly controls?: ReactNode;
  readonly caption: ReactNode;
  readonly children: ReactNode;
}) => (
  <figure className="fig" id={`figure-${n}`}>
    {controls && <div className="fig-controls">{controls}</div>}
    <div className="fig-body">{children}</div>
    <figcaption>
      <span>Figure {n}.</span> {caption}
    </figcaption>
  </figure>
);

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const useInView = (ref: RefObject<HTMLElement | null>) => {
  const [seen, setSeen] = useState(false);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const on = entry?.isIntersecting ?? false;
        setVisible(on);
        if (on) setSeen(true);
      },
      { threshold: 0.4 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return { seen, visible };
};

/** Advances a step counter on a timer while the element is on screen. Stays at 0 with reduced motion. */
const useAutoplay = (ref: RefObject<HTMLElement | null>, ms: number) => {
  const { visible } = useInView(ref);
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!visible || reducedMotion()) return;
    const id = window.setInterval(() => document.visibilityState === "visible" && setStep((s) => s + 1), ms);
    return () => window.clearInterval(id);
  }, [visible, ms]);
  return step;
};

const Steps = ({ items, active }: { readonly items: ReadonlyArray<string>; readonly active: number }) => (
  <div className="fig-steps" aria-hidden="true">
    {items.map((item, i) => (
      <span key={item} className={i === active ? "on" : undefined}>
        {item}
      </span>
    ))}
  </div>
);

/* Figure 1: one blind request per page. Uses the judge's real ordering rule: labels by sha256(pageId:presetId). */

const PARSERS = ["parser_1", "parser_2", "parser_3"] as const;
const PAGES = ["page_0001", "page_0002", "page_0003", "page_0004"] as const;
type Severity = "high" | "low";
const VERDICTS: Record<
  (typeof PAGES)[number],
  ReadonlyArray<{ readonly score: number; readonly errors: ReadonlyArray<Severity> }>
> = {
  page_0001: [
    { score: 9, errors: ["low"] },
    { score: 6, errors: ["high", "low"] },
    { score: 9, errors: ["low", "low"] },
  ],
  page_0002: [
    { score: 10, errors: [] },
    { score: 9, errors: ["low"] },
    { score: 4, errors: ["high", "high", "low"] },
  ],
  page_0003: [
    { score: 9, errors: ["low", "low"] },
    { score: 6, errors: ["high", "low"] },
    { score: 7, errors: ["high"] },
  ],
  page_0004: [
    { score: 9, errors: ["low", "low"] },
    { score: 5, errors: ["high", "low", "low"] },
    { score: 9, errors: ["low"] },
  ],
};

const sha256Hex = async (text: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const useBlinding = (pageId: string) => {
  const [hashes, setHashes] = useState<ReadonlyArray<string> | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all(PARSERS.map((id) => sha256Hex(`${pageId}:${id}`))).then((h) => live && setHashes(h));
    return () => {
      live = false;
    };
  }, [pageId]);
  const slots = useMemo(() => {
    if (hashes === null) return PARSERS.map((_, i) => i);
    const order = PARSERS.map((_, i) => i).sort((a, b) => ((hashes[a] ?? "") < (hashes[b] ?? "") ? -1 : 1));
    return PARSERS.map((_, i) => order.indexOf(i));
  }, [hashes]);
  return { hashes, slots };
};

const Glyph = ({ x, y, w, seed, color }: { x: number; y: number; w: number; seed: number; color: string }) => (
  <g>
    {[0, 1, 2].map((r) => (
      <rect key={r} x={x} y={y + r * 6} width={w * ([0.9, 0.7, 0.8][(r + seed) % 3] ?? 1)} height={2} rx={1} fill={color} />
    ))}
  </g>
);

const Marks = ({ x, y, errors }: { x: number; y: number; errors: ReadonlyArray<Severity> }) => (
  <g>
    {errors.map((s, i) => (
      <rect
        // biome-ignore lint/suspicious/noArrayIndexKey: errors have no identity beyond their slot
        key={i}
        x={x + i * 10}
        y={y - 4}
        width={7}
        height={7}
        rx={1}
        fill={s === "high" ? "var(--bad)" : "#d4d4d4"}
      />
    ))}
  </g>
);

export const BlindRequestFigure = () => {
  const [box, width] = useWidth(720);
  const step = useAutoplay(box, 2600);
  const page = step % PAGES.length;
  const focus = step % PARSERS.length;
  const pageId = PAGES[page] ?? PAGES[0];
  const { hashes, slots } = useBlinding(pageId);
  const W = Math.max(320, width);
  const wide = W >= 640;
  const H = 236;
  const top = 48;
  const rowGap = 56;
  const rowY = (i: number) => top + 24 + i * rowGap;
  const thumbW = wide ? 64 : 0;
  const gap = wide ? 40 : 0;
  const x1 = thumbW + gap;
  const linkStart = x1 + (wide ? 96 : 70);
  const x3 = W - (wide ? 140 : 92);
  const avail = x3 - 12 - linkStart;
  const linkSpace = Math.max(28, (avail - 200) / 2);
  const reqX = linkStart + linkSpace;
  const reqW = avail - 2 * linkSpace;
  const link = linkHorizontal<unknown, readonly [number, number]>()
    .source((d) => (d as { s: readonly [number, number] }).s)
    .target((d) => (d as { t: readonly [number, number] }).t)
    .x((p) => p[0])
    .y((p) => p[1]);
  const path = (s: readonly [number, number], t: readonly [number, number]) => link({ s, t } as never) ?? "";
  const verdicts = VERDICTS[pageId];
  const tone = (i: number) => (i === focus ? "var(--accent)" : "#c8c8c8");
  return (
    <Figure
      n={1}
      controls={<Steps items={PAGES} active={page} />}
      caption={
        <>
          Each page is one judge request, and every parser gets the same page image. Outputs are relabeled <code>parse_a</code>,{" "}
          <code>parse_b</code>, … in an order set by <code>sha256(page_id:parser_id)</code>, so the order changes from page to
          page but can be reproduced. The judge lists errors (red: high, grey: low), then scores each label. Names are put back
          only after the response.
        </>
      }
    >
      <div ref={box}>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label="Blind judging of one page" className="fig1">
          <g fontSize={12} fill="var(--muted)">
            {wide && (
              <text x={0} y={16}>
                Page image
              </text>
            )}
            <text x={x1} y={16}>
              Parsers
            </text>
            <text x={reqX - 8} y={16}>
              Judge request
            </text>
            <text x={x3} y={16}>
              Scores
            </text>
          </g>
          {wide && (
            <g>
              <rect x={0} y={top + 8} width={thumbW} height={84} fill="#fff" stroke="var(--line)" />
              <rect x={8} y={top + 18} width={30} height={4} fill="var(--ink)" />
              {[0, 1, 2].map((r) => (
                <rect key={r} x={8} y={top + 30 + r * 6} width={[48, 40, 44][r]} height={2} fill="#bdbdbd" />
              ))}
              {[0, 1, 2, 3].map((r) => (
                <line key={r} x1={8} x2={56} y1={top + 54 + r * 7} y2={top + 54 + r * 7} stroke="#bdbdbd" />
              ))}
              {[8, 24, 40, 56].map((x) => (
                <line key={x} x1={x} x2={x} y1={top + 54} y2={top + 75} stroke="#bdbdbd" />
              ))}
              <text x={0} y={top + 112} fontSize={11} fill="var(--faint)" className="mono-svg">
                200 DPI PNG
              </text>
              {PARSERS.map((id, i) => (
                <path
                  key={id}
                  d={path([thumbW, top + 50], [x1 - 6, rowY(i)])}
                  fill="none"
                  stroke="var(--line)"
                  strokeWidth={1.5}
                />
              ))}
            </g>
          )}
          {PARSERS.map((id, i) => (
            <g key={id}>
              <text x={x1} y={rowY(i) - 6} fontSize={13} fill={i === focus ? "var(--ink)" : "var(--muted)"}>
                Parser {i + 1}
              </text>
              {wide && (
                <text x={x1} y={rowY(i) + 10} fontSize={10.5} fill="var(--faint)" className="mono-svg">
                  {hashes?.[i]?.slice(0, 8) ?? "········"}…
                </text>
              )}
              <path
                className="fig1-link"
                d={path([linkStart, rowY(i)], [reqX - 8, rowY(slots[i] ?? i)])}
                fill="none"
                stroke={tone(i)}
                strokeWidth={i === focus ? 2 : 1.5}
              />
              <path
                className="fig1-link"
                d={path([reqX + reqW + 8, rowY(slots[i] ?? i)], [x3 - 10, rowY(i)])}
                fill="none"
                stroke={tone(i)}
                strokeWidth={i === focus ? 2 : 1.5}
              />
            </g>
          ))}
          <rect x={reqX - 8} y={top} width={reqW + 16} height={rowGap * 3 + 4} fill="#fff" stroke="var(--ink)" />
          {PARSERS.map((id, slot) => {
            const owner = slots.indexOf(slot);
            return (
              <g key={id}>
                <text x={reqX} y={rowY(slot) - 6} fontSize={12} fill="var(--ink)" className="mono-svg">
                  parse_{String.fromCharCode(97 + slot)}
                </text>
                <Glyph
                  x={reqX}
                  y={rowY(slot) + 2}
                  w={Math.min(70, reqW)}
                  seed={owner}
                  color={owner === focus ? "var(--accent)" : "#cfcfcf"}
                />
              </g>
            );
          })}
          {PARSERS.map((id, i) => {
            const v = verdicts[i];
            if (!v) return null;
            return (
              <g key={id}>
                <text x={x3} y={rowY(i) - 6} fontSize={13} fill={i === focus ? "var(--ink)" : "var(--muted)"}>
                  Parser {i + 1}
                </text>
                <text x={W - 2} y={rowY(i) + 8} fontSize={20} textAnchor="end" fill="var(--ink)" fontWeight={300}>
                  {v.score}
                </text>
                <Marks x={x3} y={rowY(i) + 8} errors={v.errors} />
              </g>
            );
          })}
        </svg>
      </div>
    </Figure>
  );
};

/* Figure 2: a subset chosen after scoring. Simulated: 1,000 candidate pages, two parsers whose scores share page difficulty. */

type SimPage = { readonly a: number; readonly b: number; readonly i: number };

const simulatePages = (): ReadonlyArray<SimPage> => {
  const normal = randomNormal.source(randomLcg(0.42))(0, 1);
  const clamp = (x: number) => Math.max(1, Math.min(10, Math.round(x)));
  return range(1000).map((i) => {
    const difficulty = normal();
    return { a: clamp(8 - 1.5 * difficulty + 1.1 * normal()), b: clamp(8.3 - 1.5 * difficulty + 1.1 * normal()), i };
  });
};

const sample = <T,>(items: ReadonlyArray<T>, k: number, seed: number): ReadonlyArray<T> => {
  const random = randomLcg(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out.slice(0, k);
};

const meanOf = (xs: ReadonlyArray<SimPage>, key: "a" | "b") => xs.reduce((s, p) => s + p[key], 0) / (xs.length || 1);

const ScoreBars = ({ title, pages }: { readonly title: string; readonly pages: ReadonlyArray<SimPage> }) => {
  const a = meanOf(pages, "a");
  const b = meanOf(pages, "b");
  const x = scaleLinear().domain([1, 10]).range([0, 100]);
  const lead = a > b ? `A leads by ${(a - b).toFixed(2)}` : `B leads by ${(b - a).toFixed(2)}`;
  return (
    <div className="bars">
      <div className="bars-head">
        <span>{title}</span>
        <span className="lead">{lead}</span>
      </div>
      {(
        [
          ["A", a, "var(--ink)"],
          ["B", b, "var(--accent)"],
        ] as const
      ).map(([name, v, color]) => (
        <div key={name} className="bar-row">
          <span>{name}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${x(v)}%`, background: color }} />
          </span>
          <span className="mono">{v.toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
};

export const SubsetFigure = () => {
  const pages = useMemo(simulatePages, []);
  const [box, width] = useWidth(720);
  const step = useAutoplay(box, 3200);
  const mode = step % 2 === 0 ? "advance" : "after";
  const seed = Math.floor(step / 2) + 1;
  const chosen = useMemo(() => {
    const pool = mode === "advance" ? pages : pages.filter((p) => p.a >= p.b);
    return sample(pool, 100, seed / 7);
  }, [pages, mode, seed]);
  const picked = useMemo(() => new Set(chosen.map((p) => p.i)), [chosen]);
  const W = Math.max(320, width);
  const per = W < 520 ? 4 : 6;
  const r = W < 520 ? 1.9 : 2.3;
  const pitch = r * 2 + 1;
  const bins = range(-5, 6);
  const x = scaleLinear().domain([-5.5, 5.5]).range([0, W]);
  const binOf = (p: SimPage) => Math.max(-5, Math.min(5, p.a - p.b));
  const stacks = new Map<number, Array<SimPage>>(bins.map((b) => [b, []]));
  for (const p of [...pages].sort((m, n) => Number(picked.has(m.i)) - Number(picked.has(n.i)) || m.i - n.i))
    stacks.get(binOf(p))?.push(p);
  const tallest = Math.max(...[...stacks.values()].map((s) => Math.ceil(s.length / per)));
  const H = tallest * pitch + 60;
  const base = H - 30;
  return (
    <Figure
      n={2}
      controls={<Steps items={["100 pages picked before scoring", "100 pages picked after scoring"]} active={step % 2} />}
      caption={
        <>
          Simulated. Each dot is one of 1,000 test pages, placed by parser A’s score minus parser B’s. 100 of them are published
          (blue). The figure switches between two ways of picking them. Picked at random, the 100 match the full set: B is ahead.
          Picked only from pages where A did at least as well as B, the order flips, and nothing in the published pages shows it.
        </>
      }
    >
      <div ref={box}>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label="Dot plot of 1,000 pages">
          {bins.map((b) =>
            (stacks.get(b) ?? []).map((p, k) => {
              const col = k % per;
              const row = Math.floor(k / per);
              return (
                <circle
                  key={p.i}
                  className="fig2-dot"
                  cx={x(b) + (col - (per - 1) / 2) * pitch}
                  cy={base - r - row * pitch}
                  r={r}
                  fill={picked.has(p.i) ? "var(--accent)" : "#d9d9d9"}
                />
              );
            }),
          )}
          <line x1={0} x2={W} y1={base + 2} y2={base + 2} stroke="var(--line)" />
          {bins.map((b) => (
            <text key={b} x={x(b)} y={base + 18} fontSize={11} fill="var(--faint)" textAnchor="middle">
              {b === -5 ? "≤−5" : b === 5 ? "≥5" : b > 0 ? `+${b}` : b === 0 ? "0" : `−${-b}`}
            </text>
          ))}
          <text x={0} y={12} fontSize={12} fill="var(--muted)">
            ← B scored higher
          </text>
          <text x={W} y={12} fontSize={12} fill="var(--muted)" textAnchor="end">
            A scored higher →
          </text>
        </svg>
      </div>
      <div className="bars-grid">
        <ScoreBars title="All 1,000 pages" pages={pages} />
        <ScoreBars title="Published 100 pages" pages={chosen} />
      </div>
    </Figure>
  );
};

/* Figure 3: how many pages it takes to separate two high-severity error rates. */

const RATES = [
  { name: "Parser A", p: 0.1, color: "var(--ink)" },
  { name: "Parser B", p: 0.16, color: "var(--accent)" },
] as const;
const N_MIN = 20;
const N_MAX = 1000;

const interval = (p: number, n: number) => wilson(p * n, n) ?? { low: 0, high: 1 };
const separated = (n: number) => interval(RATES[0].p, n).high < interval(RATES[1].p, n).low;
const SEPARATE_AT = range(N_MIN, N_MAX + 1).find(separated) ?? N_MAX;

const pct = (v: number) => `${Math.round(v * 100)}%`;
const SIZES = [50, 100, 200, 500, 1000] as const;
const AXIS = [0, 0.1, 0.2, 0.3] as const;
const X_MAX = 0.32;

export const SampleSizeFigure = () => {
  const box = useRef<HTMLDivElement>(null);
  const { seen } = useInView(box);
  const x = scaleLinear().domain([0, X_MAX]).range([0, 100]).clamp(true);
  return (
    <Figure
      n={3}
      caption={
        <>
          Share of pages with a high-severity error for two parsers whose true rates are 10% and 16%, with 95% Wilson intervals,
          at five run sizes. The intervals only stop overlapping at about {SEPARATE_AT} pages. Below that, the run cannot tell
          which parser makes fewer serious errors. A run can have up to 1,000 pages.
        </>
      }
    >
      <div ref={box} className={seen ? "ci in" : "ci"}>
        <div className="ci-row ci-head">
          <span>Pages</span>
          <span className="ci-track">
            {AXIS.map((v) => (
              <span key={v} className="ci-tick" style={{ left: `${x(v)}%` }}>
                {pct(v)}
              </span>
            ))}
          </span>
          <span />
        </div>
        {SIZES.map((n, row) => (
          <div key={n} className="ci-row">
            <span className="ci-n">{n.toLocaleString("en-US")}</span>
            <span className="ci-track">
              {AXIS.map((v) => (
                <span key={v} className="ci-grid" style={{ left: `${x(v)}%` }} />
              ))}
              {RATES.map((r, k) => {
                const ci = interval(r.p, n);
                return (
                  <span key={r.name} className="ci-bar" style={{ top: 9 + k * 10 }}>
                    <span
                      className="ci-span"
                      style={{
                        background: r.color,
                        left: `${x(ci.low)}%`,
                        transitionDelay: `${row * 140}ms`,
                        width: `${x(ci.high) - x(ci.low)}%`,
                      }}
                    />
                    <span className="ci-dot" style={{ background: r.color, left: `${x(r.p)}%` }} />
                  </span>
                );
              })}
            </span>
            <span className={separated(n) ? "ci-verdict good" : "ci-verdict"}>{separated(n) ? "Separate" : "Overlap"}</span>
          </div>
        ))}
        <div className="readout">
          {RATES.map((r) => (
            <div key={r.name}>
              <span className="swatch" style={{ background: r.color }} />
              {r.name}, true rate {pct(r.p)}
            </div>
          ))}
        </div>
      </div>
    </Figure>
  );
};
