/** A head-to-head focus, "a wins over / ties with / loses to b", kept in the URL as `?h2h=<a>:<outcome>:<b>`. */
export type Outcome = "wins" | "ties" | "losses";
export interface HeadToHeadFocus {
  readonly a: string;
  readonly b: string;
  readonly outcome: Outcome;
}

export const readH2H = (search: string): HeadToHeadFocus | null => {
  const m = /^(.+):(wins|ties|losses):(.+)$/.exec(new URLSearchParams(search).get("h2h") ?? "");
  if (!m?.[1] || !m[3] || m[1] === m[3]) return null;
  return { a: m[1], b: m[3], outcome: m[2] as Outcome };
};

export const h2hQuery = (f: HeadToHeadFocus) => `h2h=${encodeURIComponent(`${f.a}:${f.outcome}:${f.b}`).replaceAll("%3A", ":")}`;

export const verb = (outcome: Outcome) => (outcome === "wins" ? "over" : outcome === "losses" ? "under" : "tied with");

/** Whether a page's two scores give this outcome; pages where either parse has no score are out. */
export const h2hMatch = (f: HeadToHeadFocus, scores: Readonly<Record<string, number | null | undefined>>) => {
  const x = scores[f.a];
  const y = scores[f.b];
  if (typeof x !== "number" || typeof y !== "number") return false;
  return f.outcome === "wins" ? x > y : f.outcome === "losses" ? x < y : x === y;
};
