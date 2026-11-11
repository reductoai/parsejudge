import { Data, Effect } from "effect";

/** The splitter's response was cut off or could not be read. */
export class FramesBroken extends Data.TaggedError("FramesBroken")<{ readonly message: string }> {}

const u32 = (bytes: Uint8Array, at: number) => new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0);

/**
 * Bytes received but not read yet, kept as the chunks they arrived in. `take` copies bytes out once, so a page that
 * arrives in thousands of small chunks costs one copy of the page, not one copy of everything so far per chunk.
 */
const chunkQueue = () => {
  const chunks: Array<Uint8Array> = [];
  /** Bytes of `chunks[0]` already taken. */
  let head = 0;
  let length = 0;
  return {
    get length() {
      return length;
    },
    push: (chunk: Uint8Array) => {
      if (chunk.length === 0) return;
      chunks.push(chunk);
      length += chunk.length;
    },
    /** Removes and returns the next `n` bytes. Callers check `length` first. */
    take: (n: number) => {
      const out = new Uint8Array(n);
      let at = 0;
      for (let chunk = chunks[0]; at < n && chunk !== undefined; chunk = chunks[0]) {
        const count = Math.min(chunk.length - head, n - at);
        out.set(chunk.subarray(head, head + count), at);
        at += count;
        head += count;
        if (head === chunk.length) {
          chunks.shift();
          head = 0;
        }
      }
      length -= at;
      return out;
    },
    /** The uint32 at the front, left in the queue. Callers check `length >= 4` first. */
    peekU32: () => {
      const out = new Uint8Array(4);
      let at = 0;
      for (let i = 0, offset = head; at < 4 && i < chunks.length; i++, offset = 0) {
        const chunk = chunks[i] as Uint8Array;
        const count = Math.min(chunk.length - offset, 4 - at);
        out.set(chunk.subarray(offset, offset + count), at);
        at += count;
      }
      return u32(out, 0);
    },
  };
};

/**
 * Reads the splitter's response body: a uint32 page count, then per page a uint32 length and that many bytes.
 * Runs `onPage` for each page in order as soon as it is complete, so only about one page is held at a time.
 */
export const readFrames = <E>(
  body: ReadableStream<Uint8Array>,
  onPage: (index: number, page: Uint8Array) => Effect.Effect<void, E>,
): Effect.Effect<number, FramesBroken | E> =>
  Effect.gen(function* () {
    const reader = body.getReader();
    const queue = chunkQueue();
    let count: number | undefined;
    let index = 0;
    for (;;) {
      const next = yield* Effect.tryPromise({
        try: () => reader.read(),
        catch: (error) => new FramesBroken({ message: String(error) }),
      });
      if (next.done) break;
      queue.push(next.value);
      if (count === undefined && queue.length >= 4) count = u32(queue.take(4), 0);
      while (count !== undefined && index < count && queue.length >= 4 && queue.length >= 4 + queue.peekU32()) {
        const page = queue.take(u32(queue.take(4), 0));
        yield* onPage(index, page);
        index++;
      }
    }
    if (count === undefined || index < count)
      return yield* new FramesBroken({ message: `Response ended after ${index} of ${count ?? "?"} pages` });
    return count;
  });
