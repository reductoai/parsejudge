/// <reference types="node" />

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { nodePdfium } from "../eval/pdfium-node.ts";
import { renderPagePng } from "../src/render-page.ts";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(import.meta.dirname, "../../../packages/core/test/fixtures", name)));

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width and height from a PNG's IHDR chunk. */
const pngSize = (png: Uint8Array) => {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

describe("renderPagePng", () => {
  it("renders the first page of a PDF to a PNG at 200 DPI", async () => {
    const png = await Effect.runPromise(renderPagePng(nodePdfium, fixture("one.pdf")));
    expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    // A US Letter page, 612 x 792 points, at 200 DPI.
    expect(pngSize(png)).toEqual({ width: 1700, height: 2200 });
  });

  it("fails with RenderError on bytes that are not a PDF", async () => {
    const error = await Effect.runPromise(Effect.flip(renderPagePng(nodePdfium, new TextEncoder().encode("not a pdf"))));
    expect(error).toMatchObject({ _tag: "RenderError", message: "PDFium could not open the page." });
  });

  it("loads PDFium once and renders again with the same instance", async () => {
    const [a, b] = await Effect.runPromise(Effect.all([nodePdfium, nodePdfium]));
    expect(a).toBe(b);
    const png = await Effect.runPromise(renderPagePng(nodePdfium, fixture("one.pdf")));
    expect(pngSize(png).width).toBe(1700);
  });
});
