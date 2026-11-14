import { Container, getRandom } from "@cloudflare/containers";
import { type DocumentFormat, InvalidDocument, MIME_TYPES } from "@parsejudge/core";
import { Data, Effect, Schedule } from "effect";
import type { Env } from "./env.ts";
import { StorageFailed } from "./errors.ts";

/**
 * Converts DOCX and PPTX to PDF. The image decides the engine: this repo ships LibreOffice
 * (`containers/libreoffice`); parsejudge.com runs Reducto's engine behind the same contract,
 * `POST /convert` with the document's MIME type as content-type, answered with the PDF.
 */
export class Converter extends Container<Env> {
  override defaultPort = 8080;
  override sleepAfter = "10m";
}

export class ConverterUnavailable extends Data.TaggedError("ConverterUnavailable")<{ readonly message: string }> {}

const INSTANCES = 4;

const unavailable = (error: unknown) => new ConverterUnavailable({ message: String(error) });

/**
 * One conversion attempt: streams the upload at `sourceKey` from R2 to the converter, and the PDF it answers with
 * to `pdfKey`. Returns the PDF's size. Neither file is held in memory when the converter sends a content-length.
 */
const convertOnce = (env: Env, format: Exclude<DocumentFormat, "pdf">, sourceKey: string, pdfKey: string) =>
  Effect.gen(function* () {
    const source = yield* Effect.tryPromise({ try: () => env.BLOBS.get(sourceKey), catch: unavailable });
    if (source === null) return yield* new StorageFailed({ message: `Missing upload ${sourceKey}` });
    const converter = yield* Effect.tryPromise({ try: () => getRandom(env.CONVERTER, INSTANCES), catch: unavailable });
    const response = yield* Effect.tryPromise({
      try: () =>
        converter.fetch(
          new Request("http://converter/convert", {
            method: "POST",
            headers: { "content-type": MIME_TYPES[format], "content-length": String(source.size) },
            body: source.body,
          }),
        ),
      catch: unavailable,
    });
    if (response.status === 422) {
      return yield* new InvalidDocument({ message: `The ${format.toUpperCase()} file could not be converted.` });
    }
    if (!response.ok || response.body === null) {
      return yield* new ConverterUnavailable({ message: `Converter returned ${response.status}` });
    }
    const length = Number(response.headers.get("content-length") ?? Number.NaN);
    const storeFailed = (error: unknown) => new ConverterUnavailable({ message: `Storing the converted PDF failed: ${error}` });
    // R2 needs a known length; an engine that sends no content-length has its PDF read into memory instead.
    const pdf = Number.isSafeInteger(length)
      ? Effect.succeed(response.body.pipeThrough(new FixedLengthStream(length)))
      : Effect.tryPromise({ try: () => response.arrayBuffer(), catch: storeFailed });
    const body = yield* pdf;
    const stored = yield* Effect.tryPromise({ try: () => env.BLOBS.put(pdfKey, body), catch: storeFailed });
    if (stored === null) return yield* new ConverterUnavailable({ message: "Storing the converted PDF failed" });
    return stored.size;
  });

/** Converts the DOCX or PPTX at `sourceKey` to a PDF at `pdfKey` and returns the PDF's size in bytes. */
export const convertToPdf = (env: Env, format: Exclude<DocumentFormat, "pdf">, sourceKey: string, pdfKey: string) =>
  convertOnce(env, format, sourceKey, pdfKey).pipe(
    Effect.retry({
      schedule: Schedule.exponential("1 second"),
      times: 4,
      while: (error) => error._tag === "ConverterUnavailable",
    }),
  );
