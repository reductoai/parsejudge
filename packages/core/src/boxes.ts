/** A box on the page image, in fractions of the page width and height. */
export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Some of a parse's text and the box around it on the page, in reading order. */
export interface SourceBox extends Rect {
  readonly text: string;
}

/**
 * Text with tags, whitespace and Markdown syntax removed, so an excerpt of the rendered output matches the cited words.
 * Case is kept: the locate step counts `occurrence` over exact matches.
 */
const squash = (text: string) => text.replace(/<[^>]*>/g, "").replace(/[\s*_|#`]+/g, "");

const sameLine = (a: Rect, b: Rect) => {
  const overlap = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return overlap > 0.5 * Math.min(a.height, b.height) && b.left >= a.left;
};

const union = (a: Rect, b: Rect): Rect => {
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  return {
    left,
    top,
    width: Math.max(a.left + a.width, b.left + b.width) - left,
    height: Math.max(a.top + a.height, b.top + b.height) - top,
  };
};

/**
 * The boxes on the page around an excerpt of the output: the `occurrence`-th match (1-based) of `quote` in the boxes'
 * text, or the last match when there are fewer. Words on one line merge into one box. Empty when nothing matches.
 */
export const boxesFor = (boxes: ReadonlyArray<SourceBox>, quote: string, occurrence: number): ReadonlyArray<Rect> => {
  const q = squash(quote);
  if (q === "") return [];
  const spans: Array<{ readonly start: number; readonly end: number; readonly box: SourceBox }> = [];
  let joined = "";
  for (const box of boxes) {
    const text = squash(box.text);
    if (text === "") continue;
    spans.push({ start: joined.length, end: joined.length + text.length, box });
    joined += text;
  }
  const hits: Array<number> = [];
  for (let at = joined.indexOf(q); at !== -1; at = joined.indexOf(q, at + 1)) hits.push(at);
  const at = hits[Math.max(1, Math.min(occurrence, hits.length)) - 1];
  if (at === undefined) return [];
  const rects: Array<Rect> = [];
  for (const { start, end, box } of spans) {
    if (end <= at || start >= at + q.length) continue;
    const rect = { left: box.left, top: box.top, width: box.width, height: box.height };
    const last = rects.at(-1);
    if (last !== undefined && sameLine(last, rect)) rects[rects.length - 1] = union(last, rect);
    else rects.push(rect);
  }
  return rects;
};
