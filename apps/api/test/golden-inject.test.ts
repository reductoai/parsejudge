import { JUDGED_CATEGORIES } from "@parsejudge/core";
import { describe, expect, it } from "vitest";
import { INJECTION_KINDS, type Variant, variantsOf } from "../eval/inject.ts";
import { GOLDEN_PAGES, toMarkdown } from "../eval/pages.ts";

const page = (id: string) => {
  const found = GOLDEN_PAGES.find((p) => p.id === id);
  if (found === undefined) throw new Error(`No golden page ${id}`);
  return found;
};

const variant = (pageId: string, kind: Variant["kind"]) => {
  const found = variantsOf(page(pageId)).find((v) => v.kind === kind);
  if (found === undefined) throw new Error(`No ${kind} variant of ${pageId}`);
  return found;
};

const control = (pageId: string) => toMarkdown(page(pageId).blocks);

const words = (text: string) => text.split(/\s+/).filter((word) => word !== "");

/** Words in `a` that `b` lacks, counting repeats. */
const missing = (a: string, b: string) => {
  const left = [...words(b)];
  return words(a).filter((word) => {
    const at = left.indexOf(word);
    if (at === -1) return true;
    left.splice(at, 1);
    return false;
  });
};

describe("variantsOf", () => {
  it.each(GOLDEN_PAGES.map((p) => [p.id, p] as const))("gives %s an untouched control and distinct variants", (_, p) => {
    const [first, ...rest] = variantsOf(p);
    expect(first).toMatchObject({ kind: "control", markdown: toMarkdown(p.blocks), expected: null });
    for (const v of rest) {
      expect(v.markdown).not.toBe(first?.markdown);
      expect(v.expected?.categories.every((c) => (JUDGED_CATEGORIES as ReadonlyArray<string>).includes(c))).toBe(true);
    }
    expect(new Set(rest.map((v) => v.markdown)).size).toBe(rest.length);
  });

  it("plants every kind of error on at least one page", () => {
    const planted = new Set(GOLDEN_PAGES.flatMap((p) => variantsOf(p).map((v) => v.kind)));
    for (const kind of INJECTION_KINDS) expect(planted.has(kind)).toBe(true);
  });

  it("is deterministic", () => {
    expect(GOLDEN_PAGES.map(variantsOf)).toEqual(GOLDEN_PAGES.map(variantsOf));
  });
});

describe("each planted error changes exactly what it says", () => {
  it("changed-digit: one table cell, one digit", () => {
    const v = variant("regional-sales", "changed-digit");
    expect(missing(control("regional-sales"), v.markdown)).toEqual(["1,284"]);
    expect(missing(v.markdown, control("regional-sales"))).toEqual(["1,289"]);
    expect(v.expected).toEqual({ categories: ["table_content"], severity: "high" });
  });

  it("changed-digit outside tables is a text error, in forms, prose and columns", () => {
    expect(missing(variant("incident-report", "changed-digit").markdown, control("incident-report"))).toEqual(["PX-4471-0933"]);
    expect(missing(variant("maintenance-notice", "changed-digit").markdown, control("maintenance-notice"))).toEqual(["2021."]);
    expect(missing(variant("bird-survey", "changed-digit").markdown, control("bird-survey"))).toEqual(["125"]);
    expect(variant("bird-survey", "changed-digit").expected?.categories).toEqual(["text_corruption"]);
  });

  it("dropped-row: the South row and nothing else", () => {
    const v = variant("regional-sales", "dropped-row");
    expect(control("regional-sales")).toContain("| South | 962 | 1,045 | 1,118 | 3,125 |");
    expect(v.markdown).toBe(control("regional-sales").replace("| South | 962 | 1,045 | 1,118 | 3,125 |\n", ""));
  });

  it("swapped-columns: July and August values trade places under the same headers", () => {
    const v = variant("regional-sales", "swapped-columns");
    expect(v.markdown).toContain("| Region | July | August | September | Total |");
    expect(v.markdown).toContain("| North | 1,197 | 1,284 | 1,402 | 3,883 |");
    expect(missing(v.markdown, control("regional-sales"))).toEqual([]);
  });

  it("flipped-checkbox: the first group marked No instead of Yes", () => {
    const v = variant("incident-report", "flipped-checkbox");
    expect(control("incident-report")).toContain("Police report filed? [x] Yes [ ] No");
    expect(v.markdown).toBe(
      control("incident-report").replace("Police report filed? [x] Yes [ ] No", "Police report filed? [ ] Yes [x] No"),
    );
  });

  it("merged-columns: each left line followed by the right line beside it", () => {
    const v = variant("bird-survey", "merged-columns");
    expect(v.markdown).toContain("Observers counted 37 species along the The south meadow was quieter. Only 11 north trail");
    expect(missing(v.markdown, control("bird-survey"))).toEqual([]);
    expect(missing(control("bird-survey"), v.markdown)).toEqual([]);
  });

  it("dropped-paragraph: the last paragraph, and nothing else", () => {
    const v = variant("maintenance-notice", "dropped-paragraph");
    const last = "The district expects the work to cost $86,450, which is covered by the 2025 capital budget.";
    expect(control("maintenance-notice")).toContain(last);
    expect(v.markdown).not.toContain(last);
    expect(missing(v.markdown, control("maintenance-notice"))).toEqual([]);
  });

  it("repetition-loop: the sentence eight more times", () => {
    const v = variant("maintenance-notice", "repetition-loop");
    const sentence = "Water service to 214 homes will be shut off during this window.";
    expect(control("maintenance-notice").split(sentence).length - 1).toBe(1);
    expect(v.markdown.split(sentence).length - 1).toBe(9);
  });

  it("invented-sentence: one added sentence", () => {
    const v = variant("incident-report", "invented-sentence");
    expect(v.markdown.split("A second inspection is scheduled").length - 1).toBe(1);
    expect(control("incident-report")).not.toContain("A second inspection");
  });

  it("lowercased-heading: low severity", () => {
    const v = variant("maintenance-notice", "lowercased-heading");
    expect(v.markdown.startsWith("# notice of scheduled maintenance\n")).toBe(true);
    expect(v.expected).toEqual({ categories: ["text_corruption"], severity: "low" });
  });
});
