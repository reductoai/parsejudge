// The text layer of a PDF's first page as PDFium reads it. Used to check that a golden page's Markdown says exactly
// what was drawn.
import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import { Effect } from "effect";

export const pdfText = Effect.fn("pdfText")(function* (pdfium: Effect.Effect<WrappedPdfiumModule>, pdf: Uint8Array) {
  const m = yield* pdfium;
  const malloc = (size: number) =>
    Effect.acquireRelease(
      Effect.sync(() => m.pdfium.wasmExports.malloc(size)),
      (pointer) => Effect.sync(() => m.pdfium.wasmExports.free(pointer)),
    );
  const pdfPtr = yield* malloc(pdf.length);
  m.pdfium.HEAPU8.set(pdf, pdfPtr);
  const doc = yield* Effect.acquireRelease(
    Effect.sync(() => m.FPDF_LoadMemDocument(pdfPtr, pdf.length, "")),
    (doc) => Effect.sync(() => doc !== 0 && m.FPDF_CloseDocument(doc)),
  );
  if (doc === 0) return yield* Effect.die(new Error("PDFium could not open the PDF"));
  const page = yield* Effect.acquireRelease(
    Effect.sync(() => m.FPDF_LoadPage(doc, 0)),
    (page) => Effect.sync(() => page !== 0 && m.FPDF_ClosePage(page)),
  );
  const textPage = yield* Effect.acquireRelease(
    Effect.sync(() => m.FPDFText_LoadPage(page)),
    (textPage) => Effect.sync(() => textPage !== 0 && m.FPDFText_ClosePage(textPage)),
  );
  const count = m.FPDFText_CountChars(textPage);
  // UTF-16LE, plus a terminating NUL.
  const buffer = yield* malloc((count + 1) * 2);
  m.FPDFText_GetText(textPage, 0, count, buffer);
  return new TextDecoder("utf-16le").decode(m.pdfium.HEAPU8.slice(buffer, buffer + count * 2));
}, Effect.scoped);
