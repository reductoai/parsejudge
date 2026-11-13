/// <reference types="node" />
// PDFium for Node (tests and the judge golden set), compiled from the same pdfium.wasm the Worker imports.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPdfium } from "../src/pdfium.ts";

// The Workers types declare WebAssembly.Module abstract because Workers can't compile wasm at runtime. Node can.
const compile = WebAssembly.Module as unknown as new (bytes: Uint8Array) => WebAssembly.Module;
const wasm = new compile(readFileSync(join(import.meta.dirname, "../node_modules/@embedpdf/pdfium/dist/pdfium.wasm")));

export const nodePdfium = loadPdfium(wasm);
