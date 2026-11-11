import { readFileSync } from "node:fs";
import { Effect, Exit, Layer, Option } from "effect";
import { FetchHttpClient } from "effect/http";
import { describe, expect, it } from "vitest";
import type { Credentials, PageInput } from "../src/provider.ts";
import { adapterFor, PROVIDERS } from "../src/providers/index.ts";

const page: PageInput = { imageUrl: "https://pages.test/p.png", image: Effect.succeed(new Uint8Array([1])) };
const credentials: Credentials = {
  REDUCTO_API_KEY: "k",
  MISTRAL_API_KEY: "k",
  PULSE_API_KEY: "k",
  LLAMA_CLOUD_API_KEY: "k",
  AZURE_DI_KEY: "k",
  COHERE_API_KEY: "k",
};

/** Runs an adapter call against a fetch that always answers `respond()`. */
const run = <A, E>(effect: Effect.Effect<A, E, import("effect/http").HttpClient.HttpClient>, respond: () => Response) =>
  Effect.runPromiseExit(
    effect.pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(Layer.succeed(FetchHttpClient.Fetch, (async () => respond()) as unknown as typeof globalThis.fetch)),
    ),
  );

const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });

const poll = (provider: string, body: unknown) => {
  const adapter = adapterFor(provider);
  if (adapter.poll === undefined) throw new Error(`${provider} cannot poll`);
  return run(adapter.poll("https://jobs.test/job-1", credentials), json(body));
};

const failureOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`);
  return String(exit.cause);
};

describe("provider adapters", () => {
  it("fail on a 200 body without the parse instead of returning empty markdown", async () => {
    const exit = await run(PROVIDERS.mistral_ocr.submit(page, {}, credentials), json({ detail: "model overloaded" }));
    expect(failureOf(exit)).toContain("model overloaded");
  });

  it("keep the network error behind a transport failure", async () => {
    const exit = await run(PROVIDERS.mistral_ocr.submit(page, {}, credentials), () => {
      throw new TypeError("Network connection lost");
    });
    expect(failureOf(exit)).toContain("Network connection lost");
  });

  it("stop polling a job that ended without a result, with the provider's error", async () => {
    expect(failureOf(await poll("pulse", { status: "canceled", error: "canceled by user" }))).toContain(
      "job canceled: canceled by user",
    );
    expect(failureOf(await poll("reducto", { status: "Cancelled", reason: "stopped" }))).toContain("job Cancelled: stopped");
    expect(
      failureOf(
        await poll("azure_document_intelligence", { status: "failed", error: { code: "InvalidContent", message: "bad image" } }),
      ),
    ).toContain("InvalidContent bad image");
  });

  it("keep polling a job that is still running", async () => {
    expect(await poll("reducto", { status: "InProgress" })).toEqual(Exit.succeed(Option.none()));
  });

  it("fail a LlamaParse job whose page failed", async () => {
    const exit = await poll("llamaparse", {
      job: { status: "COMPLETED" },
      markdown: { pages: [{ page_number: 1, success: false, error: "OCR timeout" }] },
    });
    expect(failureOf(exit)).toContain("OCR timeout");
  });

  it("keep the LlamaParse page header, which comes apart from the page markdown (recorded response)", async () => {
    const recorded = JSON.parse(
      readFileSync(new URL("fixtures/responses/llamaparse-agentic-header.json", import.meta.url), "utf8"),
    );
    const exit = await poll("llamaparse", recorded);
    if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
    expect(Option.getOrThrow(exit.value).markdown).toMatch(
      /^MONETARY POLICY REPORT: JULY 2024 47\n\n## \*\*Developments in the Federal Reserve/,
    );
  });

  it("decode a completed Reducto job", async () => {
    const exit = await poll("reducto", {
      status: "Completed",
      result: { result: { type: "full", chunks: [{ content: "# A" }, { content: "B" }] }, usage: { credits: 2 } },
    });
    if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
    expect(Option.getOrThrow(exit.value).markdown).toBe("# A\n\nB");
  });
  it("keep Cohere output cut off at MAX_TOKENS, with a warning (recorded W-9 response)", async () => {
    const recorded = JSON.parse(readFileSync(new URL("fixtures/responses/cohere-max-tokens.json", import.meta.url), "utf8"));
    const exit = await run(PROVIDERS.cohere.submit(page, {}, credentials), json(recorded));
    if (Exit.isFailure(exit) || exit.value._tag !== "Done") throw new Error("expected a finished parse");
    expect(exit.value.output.markdown).toContain("1 Name of entity/individual.");
    expect(exit.value.output.warning).toContain("MAX_TOKENS");
  });
});

describe("Google Document AI", () => {
  const PROCESSOR = "projects/p/locations/eu/processors/abc";
  const layout = {
    document: {
      documentLayout: {
        blocks: [
          {
            textBlock: { type: "heading-1", text: "Invoice", blocks: [{ textBlock: { type: "paragraph", text: "Due <now>" } }] },
          },
          { listBlock: { type: "ordered", listEntries: [{ blocks: [{ textBlock: { text: "One" } }] }, { blocks: [] }] } },
          {
            tableBlock: {
              headerRows: [{ cells: [{ colSpan: 2, blocks: [{ textBlock: { text: "Item & cost" } }] }] }],
              bodyRows: [{ cells: [{ blocks: [{ textBlock: { text: "Pen" } }] }, { blocks: [{ textBlock: { text: "$1" } }] }] }],
            },
          },
        ],
      },
    },
  };

  const serviceAccount = async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
    return JSON.stringify({
      client_email: "parsejudge@p.iam.gserviceaccount.com",
      private_key: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----\n`,
    });
  };

  const pngPage: PageInput = {
    imageUrl: "https://pages.test/p.png",
    image: Effect.succeed(
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"),
    ),
  };

  it("exchanges a signed service-account assertion for a token, then renders the layout as markdown", async () => {
    const requests: Array<{ url: string; auth: string | null; body: string }> = [];
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({ url: request.url, auth: request.headers.get("authorization"), body: await request.text() });
      return request.url.startsWith("https://oauth2.googleapis.com/")
        ? new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }))
        : new Response(JSON.stringify(layout));
    };
    const creds = { GOOGLE_DOCAI_CREDENTIALS: await serviceAccount(), GOOGLE_DOCAI_PROCESSOR: PROCESSOR };
    const exit = await Effect.runPromiseExit(
      PROVIDERS.google_document_ai
        .submit(pngPage, {}, creds)
        .pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.provide(Layer.succeed(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch)),
        ),
    );
    expect(requests.map((r) => r.url)).toEqual([
      "https://oauth2.googleapis.com/token",
      `https://eu-documentai.googleapis.com/v1/${PROCESSOR}:process`,
    ]);
    const assertion = new URLSearchParams(requests[0]?.body).get("assertion") ?? "";
    expect(JSON.parse(Buffer.from(assertion.split(".")[1] ?? "", "base64url").toString())).toMatchObject({
      iss: "parsejudge@p.iam.gserviceaccount.com",
      aud: "https://oauth2.googleapis.com/token",
    });
    expect(requests[1]?.auth).toBe("Bearer tok");
    const sent = JSON.parse(requests[1]?.body ?? "{}").rawDocument;
    expect(sent.mimeType).toBe("application/pdf");
    expect(Buffer.from(sent.content, "base64").subarray(0, 5).toString()).toBe("%PDF-");
    if (!Exit.isSuccess(exit) || exit.value._tag !== "Done") throw new Error(String(exit));
    expect(exit.value.output.markdown).toBe(
      '# Invoice\n\nDue <now>\n\n1. One\n\n<table><tr><th colspan="2">Item &amp; cost</th></tr><tr><td>Pen</td><td>$1</td></tr></table>',
    );
  });

  it("rejects a processor that is not a full resource name, before calling Google", async () => {
    const exit = await run(
      PROVIDERS.google_document_ai.submit(page, {}, { GOOGLE_DOCAI_CREDENTIALS: "{}", GOOGLE_DOCAI_PROCESSOR: "abc" }),
      () => {
        throw new Error("no request expected");
      },
    );
    expect(failureOf(exit)).toContain("GOOGLE_DOCAI_PROCESSOR must be");
  });
});
