import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import { Effect } from "effect";

const loading = new WeakMap<WebAssembly.Module, Promise<WrappedPdfiumModule>>();
const initialized = new WeakSet<WrappedPdfiumModule>();

/**
 * PDFium from a compiled pdfium.wasm, loaded and initialized once per module. The Worker passes its precompiled
 * module import (`render.ts`); Node compiles the same file from disk. The module instantiates synchronously.
 */
export const loadPdfium = (wasm: WebAssembly.Module): Effect.Effect<WrappedPdfiumModule> =>
  Effect.promise(() => {
    const cached = loading.get(wasm);
    if (cached !== undefined) return cached;
    const started = init({
      instantiateWasm: (imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance) => void) => {
        const instance = new WebAssembly.Instance(wasm, imports);
        receive(instance);
        return instance.exports;
      },
    });
    loading.set(wasm, started);
    return started;
  }).pipe(
    Effect.tap((m) =>
      Effect.sync(() => {
        if (initialized.has(m)) return;
        m.FPDF_InitLibrary();
        initialized.add(m);
      }),
    ),
  );
