import { describe, expect, it } from "vitest";
import { boxesFor, type SourceBox } from "../src/boxes.ts";

const word = (text: string, left: number, top: number): SourceBox => ({ text, left, top, width: 0.08, height: 0.02 });
const page = [
  word("Pay", 0.1, 0.1),
  word("$3", 0.2, 0.1),
  word("to", 0.3, 0.1),
  word("fund.", 0.4, 0.1),
  word("Pay", 0.1, 0.5),
  word("$3", 0.2, 0.5),
  word("again", 0.1, 0.6),
];

describe("boxesFor", () => {
  it("boxes the words of an excerpt, merged into one box per line", () => {
    expect(boxesFor(page, "Pay $3 to", 1)).toEqual([
      { left: 0.1, top: 0.1, width: expect.closeTo(0.28), height: expect.closeTo(0.02) },
    ]);
  });
  it("picks the occurrence the locate step chose", () => {
    expect(boxesFor(page, "Pay $3", 2)).toEqual([
      { left: 0.1, top: 0.5, width: expect.closeTo(0.18), height: expect.closeTo(0.02) },
    ]);
  });
  it("gives one box per line when the excerpt wraps", () => {
    expect(boxesFor(page, "$3 again", 1)).toEqual([word("$3", 0.2, 0.5), word("again", 0.1, 0.6)].map(({ text: _, ...r }) => r));
  });
  it("matches rendered text against cited text with Markdown or HTML around it", () => {
    expect(boxesFor([word("<b>Filing</b>", 0.1, 0.1), word("**Status**", 0.2, 0.1)], "Filing Status", 1)).toHaveLength(1);
  });
  it("counts occurrences case-sensitively, like the locate step", () => {
    expect(boxesFor([word("TOTAL", 0.1, 0.1), word("Total", 0.1, 0.5)], "Total", 1)).toEqual([
      { left: 0.1, top: 0.5, width: 0.08, height: 0.02 },
    ]);
  });
  it("falls back to a case-insensitive match when the excerpt differs only in case", () => {
    expect(boxesFor([word("Total", 0.1, 0.5)], "TOTAL", 1)).toHaveLength(1);
  });
  it("finds nothing for text that is not on the page", () => {
    expect(boxesFor(page, "Pay $5", 1)).toEqual([]);
    expect(boxesFor(page, "  ", 1)).toEqual([]);
  });
});
