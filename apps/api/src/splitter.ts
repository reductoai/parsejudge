import { Container, getRandom } from "@cloudflare/containers";
import { InvalidDocument } from "@parsejudge/core";
import { Data, Effect } from "effect";
import type { Env } from "./env.ts";
import { readFrames } from "./frames.ts";

/** Splits PDFs too large to split inside the Worker's 128 MB (`containers/splitter`). */
export class Splitter extends Container<Env> {
  override defaultPort = 8080;
  override sleepAfter = "10m";
}

export class SplitterUnavailable extends Data.TaggedError("SplitterUnavailable")<{ readonly message: string }> {}

const INSTANCES = 4;

/** PDFs larger than this are split in the container; pdf-lib needs several times the file size in memory. */
export const SPLIT_IN_WORKER_MAX_BYTES = 5 * 1024 * 1024;

const unavailable = (error: unknown) => new SplitterUnavailable({ message: String(error) });

/**
 * Splits the PDF in the container and runs `onPage` on each page as it arrives. Returns the page count. `pdf` is a
 * stream of `size` bytes (an R2 object body), so the Worker never holds the whole file.
 */
export const splitInContainer = <E>(
  env: Env,
  pdf: ReadableStream<Uint8Array>,
  size: number,
  maxPages: number,
  onPage: (index: number, page: Uint8Array) => Effect.Effect<void, E>,
) =>
  Effect.gen(function* () {
    const splitter = yield* Effect.tryPromise({ try: () => getRandom(env.SPLITTER, INSTANCES), catch: unavailable });
    const response = yield* Effect.tryPromise({
      try: () =>
        splitter.fetch(
          new Request(`http://splitter/split?max=${maxPages}`, {
            method: "POST",
            headers: { "content-length": String(size) },
            body: pdf,
          }),
        ),
      catch: unavailable,
    });
    if (response.status === 422) {
      const message = yield* Effect.tryPromise({ try: () => response.text(), catch: unavailable });
      return yield* new InvalidDocument({ message });
    }
    if (!response.ok || response.body === null)
      return yield* new SplitterUnavailable({ message: `Splitter returned ${response.status}` });
    return yield* readFrames(response.body, onPage);
  });
