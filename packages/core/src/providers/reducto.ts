import { Effect, Option, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import type { Rect, SourceBox } from "../boxes.ts";
import { decodeBody, sendJson } from "../http.ts";
import { array, joinNonEmpty, number, record, string } from "../json.ts";
import { credential, jobFailure, type ParseOutput, type ProviderAdapter, pending } from "../provider.ts";

const BASE_URL = "https://platform.reducto.ai";
const CREDIT_USD = 0.015;
const RUNNING = new Set(["Idle", "Pending", "InProgress", "Completing"]);

const Created = Schema.Struct({ job_id: Schema.String });
const Job = Schema.Struct({ status: Schema.String, reason: Schema.optional(Schema.NullOr(Schema.String)) });
const Chunks = Schema.Array(Schema.Struct({ content: Schema.String }));
/** A large result comes back as a URL to the chunks instead of the chunks. */
const Parsed = Schema.Struct({
  result: Schema.Union([Schema.Struct({ type: Schema.Literal("url"), url: Schema.String }), Schema.Struct({ chunks: Chunks })]),
});

const request = (key: string, req: HttpClientRequest.HttpClientRequest) => req.pipe(HttpClientRequest.bearerToken(key));

const output = Effect.fn("reducto.output")(function* (response: unknown) {
  const { result } = yield* decodeBody("reducto", Parsed, response);
  const fetched = "url" in result ? (yield* sendJson("reducto", HttpClientRequest.get(result.url))).body : undefined;
  const chunks = "url" in result ? yield* decodeBody("reducto", Chunks, fetched) : result.chunks;
  const credits = number(record(record(response).usage).credits);
  // The chunks behind a URL go into `raw` too: the URL expires, and `boxes` reads them later.
  const raw = fetched === undefined ? response : { ...record(response), result: { type: "full", chunks: fetched } };
  return {
    markdown: joinNonEmpty(chunks.map((chunk) => chunk.content)),
    raw,
    ...(credits === undefined ? {} : { reportedCost: { usd: credits * CREDIT_USD, source: "provider" } }),
  } satisfies ParseOutput;
});

const rect = (value: unknown): Rect | undefined => {
  const box = record(value);
  const [left, top, width, height] = [number(box.left), number(box.top), number(box.width), number(box.height)];
  return left === undefined || top === undefined || width === undefined || height === undefined
    ? undefined
    : { left, top, width, height };
};

/** Each block's cited words when the preset asks for `return_citations`, otherwise the block's own box. */
const boxes = (raw: unknown): ReadonlyArray<SourceBox> =>
  array(record(record(raw).result).chunks)
    .flatMap((chunk) => array(record(chunk).blocks))
    .flatMap((value) => {
      const block = record(value);
      const words = array(record(block.extra).word_citations).map(record);
      const parts = words.length > 0 ? words.map((w) => [w.text, w.bbox] as const) : [[block.content, block.bbox] as const];
      return parts.flatMap(([text, bbox]) => {
        const box = rect(bbox);
        const content = string(text);
        return box === undefined || content === undefined ? [] : [{ text: content, ...box }];
      });
    });

export const reducto: ProviderAdapter = {
  id: "reducto",
  credentialKeys: ["REDUCTO_API_KEY"],
  submit: Effect.fn("reducto.submit")(function* (page, config, credentials) {
    const key = yield* credential("reducto", credentials, "REDUCTO_API_KEY");
    const response = yield* sendJson(
      "reducto",
      request(key, HttpClientRequest.post(`${BASE_URL}/parse_async`)).pipe(
        HttpClientRequest.bodyJsonUnsafe({ ...config, input: page.imageUrl }),
      ),
    );
    return pending((yield* decodeBody("reducto", Created, response.body)).job_id);
  }),
  poll: Effect.fn("reducto.poll")(function* (job, credentials) {
    const key = yield* credential("reducto", credentials, "REDUCTO_API_KEY");
    const response = yield* sendJson("reducto", request(key, HttpClientRequest.get(`${BASE_URL}/job/${job}`)));
    const { status, reason } = yield* decodeBody("reducto", Job, response.body);
    if (RUNNING.has(status)) return Option.none();
    if (status !== "Completed") return yield* jobFailure("reducto", status, reason);
    return Option.some(yield* output(record(response.body).result));
  }),
  boxes,
};
