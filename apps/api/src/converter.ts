import { Container, getRandom } from "@cloudflare/containers";
import { type DocumentFormat, InvalidDocument, MIME_TYPES } from "@parsejudge/core";
import { Data, Effect, Schedule } from "effect";
import type { Env } from "./env.ts";

/**
 * Converts DOCX and PPTX to PDF. The image decides the engine: this repo ships LibreOffice
 * (`containers/libreoffice`); parsejudge.com runs Reducto's engine behind the same contract,
 * `POST /convert` with the document's MIME type as content-type, answered with the PDF.
 */
export class Converter extends Container<Env> {
  override defaultPort = 8080;
  override sleepAfter = "10m";
}

class ConverterUnavailable extends Data.TaggedError("ConverterUnavailable")<{ readonly message: string }> {}

export const INSTANCES = 4; // must equal max_instances in both wrangler configs (test/containers.test.ts)

const convert = (env: Env, format: Exclude<DocumentFormat, "pdf">, bytes: Uint8Array) =>
  Effect.tryPromise({
    try: () => getRandom(env.CONVERTER, INSTANCES),
    catch: (error) => new ConverterUnavailable({ message: String(error) }),
  }).pipe(
    Effect.flatMap((converter) =>
      Effect.tryPromise({
        try: () =>
          converter.fetch(
            new Request("http://converter/convert", {
              method: "POST",
              headers: { "content-type": MIME_TYPES[format] },
              body: bytes,
            }),
          ),
        catch: (error) => new ConverterUnavailable({ message: String(error) }),
      }),
    ),
    Effect.flatMap(
      (response): Effect.Effect<Uint8Array, InvalidDocument | ConverterUnavailable> =>
        response.status === 422
          ? Effect.fail(new InvalidDocument({ message: `The ${format.toUpperCase()} file could not be converted.` }))
          : response.ok
            ? Effect.tryPromise({
                try: () => response.arrayBuffer(),
                catch: (error) => new ConverterUnavailable({ message: `Reading the converted PDF failed: ${error}` }),
              }).pipe(Effect.map((buffer) => new Uint8Array(buffer)))
            : Effect.fail(new ConverterUnavailable({ message: `Converter returned ${response.status}` })),
    ),
    Effect.retry({
      schedule: Schedule.exponential("1 second"),
      times: 4,
      while: (error) => error._tag === "ConverterUnavailable",
    }),
  );

/** The document as a PDF: PDFs pass through, DOCX and PPTX go through the converter. */
export const toPdf = (env: Env, format: DocumentFormat, bytes: Uint8Array) =>
  format === "pdf" ? Effect.succeed(bytes) : convert(env, format, bytes);
