/// <reference types="node" />

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.ts";

vi.mock("@cloudflare/containers", () => ({
  Container: class {},
  getRandom: async (namespace: { stub: unknown }) => namespace.stub,
}));

// Workers-only APIs, over Node streams and crypto.
const workers = globalThis as unknown as Record<string, unknown>;
workers.FixedLengthStream = class extends TransformStream<Uint8Array, Uint8Array> {
  constructor(readonly expectedLength: number) {
    super();
  }
};
(crypto as unknown as Record<string, unknown>).DigestStream = class extends WritableStream<Uint8Array> {
  readonly digest: Promise<ArrayBuffer>;
  constructor(_algorithm: string) {
    const hash = createHash("sha256");
    let done: (digest: ArrayBuffer) => void = () => undefined;
    super({
      write: (chunk) => void hash.update(chunk),
      close: () => done(new Uint8Array(hash.digest()).buffer),
    });
    this.digest = new Promise((resolve) => {
      done = resolve;
    });
  }
};
// Workers send a stream body without `duplex`; Node requires it.
const NodeRequest = Request;
workers.Request = class extends NodeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init?.body instanceof ReadableStream ? ({ ...init, duplex: "half" } as RequestInit) : init);
  }
};

const { ingestUpload } = await import("../src/ingest.ts");
const { documentKey, pagePdfKey, uploadKey } = await import("../src/keys.ts");

const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(import.meta.dirname, "../../../packages/core/test/fixtures", name)));
const ONE_PAGE_PDF = fixture("one.pdf");
const DOCX = fixture("two-pages.docx");
const MB = 1024 * 1024;

const bytesOf = async (value: unknown): Promise<Uint8Array> => {
  if (value instanceof ReadableStream) return new Uint8Array(await new Response(value).arrayBuffer());
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new TextEncoder().encode(String(value));
};

/** R2 in memory. `wholeReads` lists keys read into memory whole, which large uploads must never be. */
const bucket = () => {
  const objects = new Map<string, Uint8Array>();
  const wholeReads: Array<string> = [];
  return {
    objects,
    wholeReads,
    put: async (key: string, value: unknown) => {
      const bytes = await bytesOf(value);
      objects.set(key, bytes);
      return { key, size: bytes.length };
    },
    head: async (key: string) => {
      const bytes = objects.get(key);
      return bytes === undefined ? null : { key, size: bytes.length };
    },
    get: async (key: string, options?: { range?: { offset: number; length: number } }) => {
      const bytes = objects.get(key);
      if (bytes === undefined) return null;
      const range = options?.range;
      const part = range === undefined ? bytes : bytes.slice(range.offset, range.offset + range.length);
      return {
        key,
        size: bytes.length,
        body: new Response(part).body,
        arrayBuffer: async () => {
          if (range === undefined) wholeReads.push(key);
          return part.slice().buffer;
        },
      };
    },
    delete: async (keys: string | ReadonlyArray<string>) => {
      for (const key of typeof keys === "string" ? [keys] : keys) objects.delete(key);
    },
  };
};

const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};

/** The splitter's response: a page count, then each page as a length and its bytes. */
const frames = (pages: ReadonlyArray<Uint8Array>) =>
  new Blob([u32(pages.length), ...pages.flatMap((page) => [u32(page.length), page])].map((part) => part.slice()));

/** A container stub that records each request's headers and body size. */
const container = (answer: (body: Uint8Array) => Response | Promise<Response>) => {
  const requests: Array<{ url: string; headers: Headers; size: number }> = [];
  return {
    requests,
    stub: {
      fetch: async (request: Request) => {
        const body = new Uint8Array(await request.arrayBuffer());
        requests.push({ url: request.url, headers: request.headers, size: body.length });
        return answer(body);
      },
    },
  };
};

const pdfResponse = (pdf: Uint8Array) =>
  new Response(pdf.slice(), { headers: { "content-type": "application/pdf", "content-length": String(pdf.length) } });

let blobs: ReturnType<typeof bucket>;
const envWith = (containers: { converter?: ReturnType<typeof container>; splitter?: ReturnType<typeof container> }) =>
  ({ BLOBS: blobs, CONVERTER: containers.converter, SPLITTER: containers.splitter }) as unknown as Env;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A "PDF" over the in-Worker split limit, for the fake splitter. */
const largePdf = (size: number) => {
  const bytes = new Uint8Array(size).fill(0x20);
  bytes.set(new TextEncoder().encode("%PDF-1.7\n"));
  return bytes;
};

const ingest = (env: Env, upload: Uint8Array, maxPages = 1000) => {
  blobs.objects.set(uploadKey("doc"), upload);
  return Effect.runPromise(Effect.result(ingestUpload(env, "doc", uploadKey("doc"), upload.length, maxPages)));
};

beforeEach(() => {
  blobs = bucket();
});

describe("ingestUpload", () => {
  it("splits a small PDF in the Worker and keeps the upload as its PDF", async () => {
    const result = await ingest(envWith({}), ONE_PAGE_PDF);
    expect(result).toMatchObject({
      _tag: "Success",
      success: { format: "pdf", pdfKey: uploadKey("doc"), pageCount: 1, sha256: sha256(ONE_PAGE_PDF) },
    });
    expect(blobs.objects.has(pagePdfKey("doc-0"))).toBe(true);
    // Stored once: no copy under the old document key.
    expect(blobs.objects.has(documentKey("doc"))).toBe(false);
  });

  it("streams a large PDF to the splitter without reading it into memory", async () => {
    const upload = largePdf(12 * MB);
    const pages = [new Uint8Array(3 * MB).fill(1), new Uint8Array(10).fill(2), new Uint8Array(9 * MB).fill(3)];
    const splitter = container(() => new Response(frames(pages)));
    const result = await ingest(envWith({ splitter }), upload);
    expect(result).toMatchObject({ _tag: "Success", success: { format: "pdf", pageCount: 3, sha256: sha256(upload) } });
    expect(splitter.requests).toHaveLength(1);
    expect(splitter.requests[0]?.size).toBe(upload.length);
    expect(splitter.requests[0]?.headers.get("content-length")).toBe(String(upload.length));
    expect(splitter.requests[0]?.url).toBe("http://splitter/split?max=1000");
    // Hashes, not the bytes: a deep comparison of megabytes of Uint8Array is very slow.
    const stored = pages.map((_, index) => blobs.objects.get(pagePdfKey(`doc-${index}`)));
    expect(stored.map((page) => (page === undefined ? null : sha256(page)))).toEqual(pages.map(sha256));
    expect(blobs.wholeReads).toEqual([]);
  });

  it("converts a DOCX through the converter and splits the PDF it stored", async () => {
    const converter = container(() => pdfResponse(ONE_PAGE_PDF));
    const result = await ingest(envWith({ converter }), DOCX);
    expect(result).toMatchObject({
      _tag: "Success",
      success: { format: "docx", pdfKey: documentKey("doc"), pageCount: 1, sha256: sha256(DOCX) },
    });
    expect(converter.requests[0]?.size).toBe(DOCX.length);
    expect(converter.requests[0]?.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    const converted = blobs.objects.get(documentKey("doc"));
    expect(converted === undefined ? null : sha256(converted)).toBe(sha256(ONE_PAGE_PDF));
    expect(blobs.wholeReads).not.toContain(uploadKey("doc"));
  });

  it("retries the converter with a fresh read of the upload", async () => {
    let calls = 0;
    const converter = container(() => (++calls === 1 ? new Response("busy", { status: 503 }) : pdfResponse(ONE_PAGE_PDF)));
    const result = await ingest(envWith({ converter }), DOCX);
    expect(result).toMatchObject({ _tag: "Success", success: { pageCount: 1 } });
    expect(converter.requests.map((r) => r.size)).toEqual([DOCX.length, DOCX.length]);
  }, 10_000);

  it("reports a file the converter cannot read as an invalid document", async () => {
    const converter = container(() => new Response("bad", { status: 422 }));
    const result = await ingest(envWith({ converter }), DOCX);
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "InvalidDocument" } });
    expect([...blobs.objects.keys()]).toEqual([uploadKey("doc")]);
  });

  it("rejects a file that is not a document after reading only its ends", async () => {
    const upload = new Uint8Array(20 * MB).fill(0x41);
    const result = await ingest(envWith({}), upload);
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "InvalidDocument" } });
    expect(blobs.wholeReads).toEqual([]);
  });

  it("deletes the pages and converted PDF it wrote when the split breaks off", async () => {
    const pdf = largePdf(6 * MB);
    const cut = frames([new Uint8Array(100).fill(1), new Uint8Array(100).fill(2), new Uint8Array(100).fill(3)]);
    const splitter = container(async () => new Response((await cut.arrayBuffer()).slice(0, 250)));
    const converter = container(() => pdfResponse(pdf));
    const result = await ingest(envWith({ converter, splitter }), DOCX);
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "FramesBroken" } });
    expect([...blobs.objects.keys()]).toEqual([uploadKey("doc")]);
  });

  it("passes the page limit to the splitter and fails when it refuses", async () => {
    const splitter = container(() => new Response("Document has 3 pages; the limit is 2.", { status: 422 }));
    const result = await ingest(envWith({ splitter }), largePdf(6 * MB), 2);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "InvalidDocument", message: "Document has 3 pages; the limit is 2." },
    });
    expect(splitter.requests[0]?.url).toBe("http://splitter/split?max=2");
  });
});
