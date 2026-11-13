import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import { decodeBody, sendJson } from "../http.ts";
import { number, record } from "../json.ts";
import { credential, done, type ProviderAdapter } from "../provider.ts";

const BASE_URL = "https://api.nutrient.io";
const API_VERSION = "2026-05-25";
const CREDIT_USD = 0.001;

const Parsed = Schema.Struct({ output: Schema.Struct({ markdown: Schema.String }) });

export const nutrient: ProviderAdapter = {
  id: "nutrient",
  credentialKeys: ["NUTRIENT_API_KEY"],
  submit: Effect.fn("nutrient.submit")(function* (page, config, credentials) {
    const key = yield* credential("nutrient", credentials, "NUTRIENT_API_KEY");
    const response = yield* sendJson(
      "nutrient",
      HttpClientRequest.post(`${BASE_URL}/extraction/parse`).pipe(
        HttpClientRequest.bearerToken(key),
        HttpClientRequest.setHeader("x-nutrient-api-version", API_VERSION),
        HttpClientRequest.setHeader("x-nutrient-engine-version", "latest"),
        HttpClientRequest.bodyJsonUnsafe({ ...config, url: page.imageUrl }),
      ),
    );
    const { output } = yield* decodeBody("nutrient", Parsed, response.body);
    const credits = number(record(record(record(response.body).usage).data_extraction_credits).cost);
    return done({
      markdown: output.markdown,
      raw: response.body,
      ...(credits === undefined ? {} : { reportedCost: { usd: credits * CREDIT_USD, source: "provider" as const } }),
    });
  }),
};
