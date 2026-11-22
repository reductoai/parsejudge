import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { InvalidDocument, sniffFormat, sniffFormatFrom } from "../src/index.ts";

const fixture = (path: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${path}`, import.meta.url)));

describe("sniffFormat", () => {
  it("detects PDF, DOCX and PPTX from their bytes", () => {
    expect(Effect.runSync(sniffFormat(fixture("one.pdf")))).toBe("pdf");
    expect(Effect.runSync(sniffFormat(fixture("two-pages.docx")))).toBe("docx");
    expect(Effect.runSync(sniffFormat(fixture("two-slides.pptx")))).toBe("pptx");
  });

  it("rejects other files, including other ZIPs", () => {
    expect(Effect.runSync(Effect.flip(sniffFormat(new TextEncoder().encode("hello"))))).toBeInstanceOf(InvalidDocument);
    expect(Effect.runSync(Effect.flip(sniffFormat(fixture("workbook-mentioning-docx.xlsx"))))).toBeInstanceOf(InvalidDocument);
    const docx = fixture("two-pages.docx");
    expect(Effect.runSync(Effect.flip(sniffFormat(docx.subarray(0, docx.length / 2))))).toBeInstanceOf(InvalidDocument);
  });
});

/** A range reader over `bytes` that records every read. */
const recorded = (bytes: Uint8Array) => {
  const reads: Array<readonly [number, number]> = [];
  const read = (offset: number, length: number) =>
    Effect.sync(() => {
      reads.push([offset, length]);
      return bytes.slice(offset, offset + length);
    });
  return { reads, sniff: () => Effect.runSync(Effect.result(sniffFormatFrom(read, bytes.length))) };
};

/** `zip` with a comment of `length` bytes, which moves the central directory away from the end of the file. */
const withComment = (zip: Uint8Array, length: number) => {
  const out = new Uint8Array(zip.length + length).fill(0x78);
  out.set(zip);
  new DataView(out.buffer).setUint16(zip.length - 2, length, true);
  return out;
};

describe("sniffFormatFrom", () => {
  it("reads only the first KiB of a large PDF", () => {
    const pdf = new Uint8Array(50 * 1024 * 1024);
    pdf.set(fixture("one.pdf"));
    const { reads, sniff } = recorded(pdf);
    expect(sniff()).toMatchObject({ _tag: "Success", success: "pdf" });
    expect(reads).toEqual([[0, 1024]]);
  });

  it("finds DOCX and PPTX from the end record and central directory", () => {
    for (const [name, format] of [
      ["two-pages.docx", "docx"],
      ["two-slides.pptx", "pptx"],
    ] as const) {
      const { reads, sniff } = recorded(fixture(name));
      expect(sniff()).toMatchObject({ _tag: "Success", success: format });
      expect(reads.length).toBeLessThanOrEqual(2);
    }
  });

  it("reads the central directory separately when it starts before the last 64 KiB", () => {
    const docx = withComment(fixture("two-pages.docx"), 65_000);
    const { reads, sniff } = recorded(docx);
    expect(sniff()).toMatchObject({ _tag: "Success", success: "docx" });
    expect(reads).toHaveLength(3);
    expect(reads.reduce((n, [, length]) => n + length, 0)).toBeLessThan(docx.length);
  });

  it("agrees with sniffFormat on files that are not documents", () => {
    for (const bytes of [new Uint8Array(0), new TextEncoder().encode("hello"), fixture("workbook-mentioning-docx.xlsx")]) {
      expect(recorded(bytes).sniff()).toMatchObject({ _tag: "Failure" });
    }
  });
});
