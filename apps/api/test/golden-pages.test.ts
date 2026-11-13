/// <reference types="node" />

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { buildPdf, GOLDEN_PAGES, toMarkdown } from "../eval/pages.ts";
import { pdfText } from "../eval/pdf-text.ts";
import { nodePdfium } from "../eval/pdfium-node.ts";
import { renderPagePng } from "../src/render-page.ts";

/** The words of a Markdown text, without its syntax: heading marks, table pipes and rules, checkbox marks. */
const markdownWords = (markdown: string) =>
  markdown
    .replace(/^# /gm, "")
    .replace(/^\| (?:--- \| )*--- \|$/gm, "")
    .replace(/\[[x ]\]/g, "")
    .replaceAll("|", " ")
    .split(/\s+/)
    .filter((word) => word !== "");

const sorted = (words: ReadonlyArray<string>) => [...words].sort();

describe.each(GOLDEN_PAGES.map((page) => [page.id, page] as const))("golden page %s", (_, page) => {
  it("draws exactly the words its Markdown says", async () => {
    const pdf = await buildPdf(page.blocks);
    const text = await Effect.runPromise(pdfText(nodePdfium, pdf));
    expect(sorted(text.split(/\s+/).filter((word) => word !== ""))).toEqual(sorted(markdownWords(toMarkdown(page.blocks))));
  });

  it("renders to a page image", async () => {
    const png = await Effect.runPromise(renderPagePng(nodePdfium, await buildPdf(page.blocks)));
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect({ width: view.getUint32(16), height: view.getUint32(20) }).toEqual({ width: 1700, height: 2200 });
  });

  it("builds the same PDF every time", async () => {
    expect(await buildPdf(page.blocks)).toEqual(await buildPdf(page.blocks));
  });
});
