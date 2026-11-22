import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { readFrames } from "../src/frames.ts";

const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};

/** A body delivered in chunks of `size` bytes, so frames and length prefixes straddle chunk boundaries. */
const chunked = (bytes: Uint8Array, size: number) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
      controller.close();
    },
  });

const encode = (pages: ReadonlyArray<Uint8Array>) => {
  const parts = [u32(pages.length), ...pages.flatMap((p) => [u32(p.length), p])];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

describe("readFrames", () => {
  const pages = [new Uint8Array([1, 2, 3]), new Uint8Array(0), new Uint8Array(1000).fill(7)];

  it.each([1, 3, 5, 4096])("reads every page when chunks are %i bytes", async (size) => {
    const got: Array<Uint8Array> = [];
    const count = await Effect.runPromise(
      readFrames(chunked(encode(pages), size), (_, page) =>
        Effect.sync(() => {
          got.push(page);
        }),
      ),
    );
    expect(count).toBe(3);
    expect(got).toEqual(pages);
  });

  it("reads large pages that arrive in many small chunks", async () => {
    const large = [new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251), new Uint8Array(7), new Uint8Array(65_537).fill(9)];
    for (const size of [997, 64 * 1024]) {
      const got: Array<Uint8Array> = [];
      const count = await Effect.runPromise(
        readFrames(chunked(encode(large), size), (_, page) =>
          Effect.sync(() => {
            got.push(page);
          }),
        ),
      );
      expect(count).toBe(3);
      // Lengths and a checksum, not the bytes: deep-comparing megabytes of Uint8Array is very slow.
      expect(got.map((p) => [p.length, p.reduce((sum, b) => (sum * 31 + b) % 1_000_003, 0)])).toEqual(
        large.map((p) => [p.length, p.reduce((sum, b) => (sum * 31 + b) % 1_000_003, 0)]),
      );
    }
  });

  it("fails when the body ends inside a page", async () => {
    const body = encode(pages).slice(0, 20);
    const error = await Effect.runPromise(Effect.flip(readFrames(chunked(body, 7), () => Effect.void)));
    expect(error.message).toMatch(/ended after 2 of 3 pages/);
  });
});
