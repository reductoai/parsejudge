import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import { Data, Effect } from "effect";
import { encodePng } from "./png.ts";

const DPI = 200;
const MAX_DIMENSION = 2400;
const BITMAP_BGRA = 4;
const RENDER_ANNOTATIONS = 0x01;

/** PDFium could not render the page. A workflow step retries it. */
export class RenderError extends Data.TaggedError("RenderError")<{ readonly message: string }> {
  readonly retryable = true;
}

/**
 * Renders the first page of a PDF to PNG bytes with the given PDFium (see `pdfium.ts`). Every allocation is freed on
 * every path, or renders would leak wasm memory.
 */
export const renderPagePng = Effect.fn("renderPagePng")(function* (pdfium: Effect.Effect<WrappedPdfiumModule>, pdf: Uint8Array) {
  const m = yield* pdfium;
  const pdfPtr = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const pointer = m.pdfium.wasmExports.malloc(pdf.length);
      m.pdfium.HEAPU8.set(pdf, pointer);
      return pointer;
    }),
    (pointer) => Effect.sync(() => m.pdfium.wasmExports.free(pointer)),
  );
  const doc = yield* Effect.acquireRelease(
    Effect.sync(() => m.FPDF_LoadMemDocument(pdfPtr, pdf.length, "")),
    (doc) => Effect.sync(() => doc !== 0 && m.FPDF_CloseDocument(doc)),
  );
  if (doc === 0) return yield* new RenderError({ message: "PDFium could not open the page." });
  const page = yield* Effect.acquireRelease(
    Effect.sync(() => m.FPDF_LoadPage(doc, 0)),
    (page) => Effect.sync(() => page !== 0 && m.FPDF_ClosePage(page)),
  );
  if (page === 0) return yield* new RenderError({ message: "PDFium could not load the page." });
  const widthPt = m.FPDF_GetPageWidthF(page);
  const heightPt = m.FPDF_GetPageHeightF(page);
  const scale = Math.min(DPI / 72, MAX_DIMENSION / Math.max(widthPt, heightPt));
  const width = Math.max(1, Math.round(widthPt * scale));
  const height = Math.max(1, Math.round(heightPt * scale));
  const bitmap = yield* Effect.acquireRelease(
    Effect.sync(() => m.FPDFBitmap_CreateEx(width, height, BITMAP_BGRA, 0, 0)),
    (bitmap) => Effect.sync(() => bitmap !== 0 && m.FPDFBitmap_Destroy(bitmap)),
  );
  if (bitmap === 0) return yield* new RenderError({ message: `PDFium could not allocate a ${width}x${height} bitmap.` });
  m.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
  m.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, RENDER_ANNOTATIONS);
  const stride = m.FPDFBitmap_GetStride(bitmap);
  const buffer = m.FPDFBitmap_GetBuffer(bitmap);
  return yield* encodePng(m.pdfium.HEAPU8.slice(buffer, buffer + stride * height), width, height, stride);
}, Effect.scoped);
