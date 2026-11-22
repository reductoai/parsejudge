import { Effect } from "effect";
import { InvalidDocument } from "./pdf.ts";

/** Formats parsejudge accepts. Everything is normalized to PDF, then to one PNG per page. */
export type DocumentFormat = "pdf" | "docx" | "pptx";

export const MIME_TYPES: Record<DocumentFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** The part that only a DOCX or only a PPTX package contains. */
const MAIN_PARTS: ReadonlyArray<readonly [DocumentFormat, string]> = [
  ["docx", "word/document.xml"],
  ["pptx", "ppt/presentation.xml"],
];

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
/** The end-of-central-directory record is 22 bytes plus a comment of up to 64 KiB, at the very end of a ZIP. */
const END_RECORD_SEARCH = 22 + 0xffff;
/** A DOCX or PPTX directory is a few KiB; refuse to read one this large. */
const MAX_CENTRAL_DIRECTORY = 16 * 1024 * 1024;
const PDF_HEADER_SEARCH = 1024;

const notADocument = () => new InvalidDocument({ message: "Expected a PDF, DOCX or PPTX file." });

/** Where the central directory is, from the end-of-central-directory record nearest the end of `tail`. */
const centralDirectory = (tail: Uint8Array) => {
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  for (let end = tail.length - 22; end >= 0; end--) {
    if (view.getUint32(end, true) !== END_OF_CENTRAL_DIRECTORY) continue;
    return {
      entries: view.getUint16(end + 10, true),
      size: view.getUint32(end + 12, true),
      offset: view.getUint32(end + 16, true),
    };
  }
  return null;
};

/** Entry names from central directory bytes; stops at the first record that is not an entry. */
const entryNames = (directory: Uint8Array, entries: number): ReadonlyArray<string> => {
  const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  const names: Array<string> = [];
  let offset = 0;
  for (let i = entries; i > 0 && offset + 46 <= directory.length; i--) {
    if (view.getUint32(offset, true) !== CENTRAL_DIRECTORY_ENTRY) return [];
    const nameLength = view.getUint16(offset + 28, true);
    names.push(new TextDecoder().decode(directory.subarray(offset + 46, offset + 46 + nameLength)));
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return names;
};

/** Reads `length` bytes of a file starting at `offset`. Callers stay inside the file. */
export type ReadRange<E> = (offset: number, length: number) => Effect.Effect<Uint8Array, E>;

/**
 * Detects the format of a file of `size` bytes from at most three reads: its first KiB (PDF header), its last
 * 64 KiB (ZIP end record) and the ZIP's central directory. The file itself is never loaded.
 */
export const sniffFormatFrom = <E>(read: ReadRange<E>, size: number): Effect.Effect<DocumentFormat, InvalidDocument | E> =>
  Effect.gen(function* () {
    const head = yield* read(0, Math.min(size, PDF_HEADER_SEARCH));
    if (new TextDecoder("latin1").decode(head).includes("%PDF-")) return "pdf";
    const tailStart = Math.max(0, size - END_RECORD_SEARCH);
    const tail = size - tailStart <= head.length ? head : yield* read(tailStart, size - tailStart);
    const found = centralDirectory(tail);
    if (found === null || found.size > MAX_CENTRAL_DIRECTORY) return yield* notADocument();
    const length = Math.min(found.size, Math.max(0, size - found.offset));
    const directory =
      found.offset >= tailStart
        ? tail.subarray(found.offset - tailStart, found.offset - tailStart + length)
        : yield* read(found.offset, length);
    const names = new Set(entryNames(directory, found.entries));
    const match = MAIN_PARTS.find(([, part]) => names.has(part));
    return match === undefined ? yield* notADocument() : match[0];
  });

/** Detects the format from the bytes, not the filename or content-type. */
export const sniffFormat = (bytes: Uint8Array): Effect.Effect<DocumentFormat, InvalidDocument> =>
  sniffFormatFrom((offset, length) => Effect.succeed(bytes.subarray(offset, offset + length)), bytes.length);
