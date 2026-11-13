import pdfiumWasm from "../node_modules/@embedpdf/pdfium/dist/pdfium.wasm";
import { loadPdfium } from "./pdfium.ts";
import { renderPagePng } from "./render-page.ts";

export { RenderError } from "./render-page.ts";

/** Renders the first page of a PDF to PNG bytes, with the Worker's precompiled PDFium. */
export const renderFirstPagePng = (pdf: Uint8Array) => renderPagePng(loadPdfium(pdfiumWasm), pdf);
