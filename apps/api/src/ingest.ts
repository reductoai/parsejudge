import { type DocumentFormat, sniffFormatFrom, splitPages } from "@parsejudge/core";
import { Effect } from "effect";
import { convertToPdf } from "./converter.ts";
import type { Env } from "./env.ts";
import { StorageFailed, storage } from "./errors.ts";
import { documentKey, pageId, pagePdfKey } from "./keys.ts";
import { SPLIT_IN_WORKER_MAX_BYTES, splitInContainer } from "./splitter.ts";

/** Pages from the splitter are stored together once this many are waiting, or once they hold this many bytes. */
const PUT_BATCH = 32;
const PUT_BATCH_BYTES = 16 * 1024 * 1024;

const getObject = (env: Env, key: string, options?: R2GetOptions) =>
  storage(() => env.BLOBS.get(key, options)).pipe(
    Effect.flatMap((object) =>
      object === null ? Effect.fail(new StorageFailed({ message: `Missing ${key}` })) : Effect.succeed(object),
    ),
  );

/** Ranged reads of an R2 object, for sniffing its format without loading it. */
const readRange = (env: Env, key: string) => (offset: number, length: number) =>
  length === 0
    ? Effect.succeed(new Uint8Array(0))
    : getObject(env, key, { range: { offset, length } }).pipe(
        Effect.flatMap((object) => storage(() => object.arrayBuffer())),
        Effect.map((buffer) => new Uint8Array(buffer)),
      );

const hex = (digest: ArrayBuffer) => [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** SHA-256 of an R2 object, hashed as it streams. */
const digestObject = (env: Env, key: string) =>
  getObject(env, key).pipe(
    Effect.flatMap((object) => {
      const digest = new crypto.DigestStream("SHA-256");
      return storage(() => object.body.pipeTo(digest)).pipe(Effect.andThen(storage(() => digest.digest)), Effect.map(hex));
    }),
  );

const removeKeys = (env: Env, keys: ReadonlyArray<string>) =>
  Effect.forEach(
    Array.from({ length: Math.ceil(keys.length / 1000) }, (_, i) => keys.slice(i * 1000, (i + 1) * 1000)),
    (chunk) => storage(() => env.BLOBS.delete(chunk)),
    { discard: true },
  ).pipe(Effect.catch((error) => Effect.logError("Upload cleanup failed", keys[0], error.message)));

/**
 * Writes one PDF per page of the PDF at `pdfKey` (`size` bytes) and returns the page count. PDFs up to
 * `SPLIT_IN_WORKER_MAX_BYTES` are split here; larger ones stream from R2 through the splitter container, and their
 * pages are stored as they arrive. On failure the pages written so far are deleted.
 */
export const splitToR2 = Effect.fn("splitToR2")(function* (
  env: Env,
  documentId: string,
  pdfKey: string,
  size: number,
  maxPages: number,
) {
  let seen = 0;
  const put = (index: number, page: Uint8Array) => {
    seen = Math.max(seen, index + 1);
    return storage(() => env.BLOBS.put(pagePdfKey(pageId(documentId, index)), page));
  };
  const cleanUp = Effect.suspend(() =>
    removeKeys(
      env,
      Array.from({ length: seen }, (_, index) => pagePdfKey(pageId(documentId, index))),
    ),
  );
  const split = Effect.gen(function* () {
    const pdf = yield* getObject(env, pdfKey);
    if (size <= SPLIT_IN_WORKER_MAX_BYTES) {
      const pages = yield* splitPages(new Uint8Array(yield* storage(() => pdf.arrayBuffer())), maxPages);
      yield* Effect.forEach(pages, (page, index) => put(index, page), { concurrency: PUT_BATCH, discard: true });
      return pages.length;
    }
    const batch: Array<readonly [number, Uint8Array]> = [];
    let batchBytes = 0;
    const flush = Effect.suspend(() => {
      const pending = batch.splice(0);
      batchBytes = 0;
      return Effect.forEach(pending, ([index, page]) => put(index, page), { concurrency: "unbounded", discard: true });
    });
    const count = yield* splitInContainer(env, pdf.body, size, maxPages, (index, page) => {
      batch.push([index, page]);
      batchBytes += page.length;
      return batch.length >= PUT_BATCH || batchBytes >= PUT_BATCH_BYTES ? flush : Effect.void;
    });
    yield* flush;
    return count;
  });
  return yield* split.pipe(Effect.onError(() => cleanUp));
});

export interface Ingested {
  readonly format: DocumentFormat;
  /** The PDF the pages were split from: the upload itself for a PDF, the converted PDF otherwise. */
  readonly pdfKey: string;
  readonly pageCount: number;
  readonly sha256: string;
}

/**
 * Turns the upload at `sourceKey` (`size` bytes) into a PDF and one PDF per page, all in R2. The upload is read in
 * ranges and streams, never whole, except a PDF small enough to split here. On failure everything this wrote is
 * deleted; the upload itself belongs to the caller.
 */
export const ingestUpload = Effect.fn("ingestUpload")(function* (
  env: Env,
  documentId: string,
  sourceKey: string,
  size: number,
  maxPages: number,
) {
  const format = yield* sniffFormatFrom(readRange(env, sourceKey), size);
  const sha256 = yield* digestObject(env, sourceKey);
  if (format === "pdf") {
    const pageCount = yield* splitToR2(env, documentId, sourceKey, size, maxPages);
    return { format, pdfKey: sourceKey, pageCount, sha256 } satisfies Ingested;
  }
  const pdfKey = documentKey(documentId);
  const pdfSize = yield* convertToPdf(env, format, sourceKey, pdfKey);
  const pageCount = yield* splitToR2(env, documentId, pdfKey, pdfSize, maxPages).pipe(
    Effect.onError(() => removeKeys(env, [pdfKey])),
  );
  return { format, pdfKey, pageCount, sha256 } satisfies Ingested;
});
