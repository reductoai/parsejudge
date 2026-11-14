import { Data, Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { JUDGED_CATEGORIES, JudgedError, type PresetVerdict } from "./domain.ts";
import { isRetryableStatus, JudgeError } from "./errors.ts";
import { httpErrorMessage, snippet } from "./http.ts";
import { findPreset } from "./presets.ts";
import { comparePrompt } from "./prompt.ts";

export const JUDGE_VERSION = "compare-v4";

export interface JudgeConfig {
  /** Bearer token for each call; may be cached and renewed by the caller. */
  readonly token: Effect.Effect<string, JudgeError, HttpClient.HttpClient>;
  /** The primary model, then the models tried in order when the one before is rate limited. */
  readonly models: ReadonlyArray<string>;
  readonly reasoningEffort: "low" | "medium" | "high";
  readonly baseUrl: string;
  /** Called with the model and `usage` object of each successful judge call. */
  readonly onUsage?: (model: string, usage: unknown) => Effect.Effect<void>;
}

export interface JudgeInput {
  /** Stable id of the page; seeds the label shuffle. */
  readonly pageId: string;
  readonly imagePng: Uint8Array;
  /** Markdown per preset id. Needs at least one entry. */
  readonly markdownByPreset: Readonly<Record<string, string>>;
}

const sha256Hex = (text: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
    Effect.map((digest) => [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")),
  );

/** Deterministic blinding: labels `parse_a`, `parse_b`, ... assigned by sha256(pageId:presetId) order. */
export const blindLabels = (pageId: string, presetIds: ReadonlyArray<string>) =>
  Effect.forEach(presetIds, (id) => sha256Hex(`${pageId}:${id}`).pipe(Effect.map((key) => ({ id, key }))), {
    concurrency: "unbounded",
  }).pipe(
    Effect.map((keyed) => {
      const sorted = [...keyed].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return Object.fromEntries(sorted.map(({ id }, index) => [`parse_${String.fromCharCode(97 + index)}`, id]));
    }),
  );

/** Replaces the blind labels the judge saw (`parse_a`) with the preset labels they stand for. */
export const unblind = (text: string, labelToPreset: Readonly<Record<string, string>>) =>
  text.replace(/\bparse_[a-z]\b/g, (label) => {
    const presetId = labelToPreset[label];
    return presetId === undefined ? label : (findPreset(presetId)?.label ?? presetId);
  });

const Verdicts = Schema.Struct({
  page_features: Schema.optional(Schema.Array(Schema.String)),
  evaluations: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      errors: Schema.Array(JudgedError),
      reasoning: Schema.String,
      score: Schema.Number,
    }),
  ),
});

/** Bounds one judge call below the 5-minute workflow step timeout; high reasoning effort can take minutes. */
const JUDGE_TIMEOUT = "4 minutes";

const CompletionError = Schema.Struct({
  code: Schema.optional(Schema.NullOr(Schema.Union([Schema.Number, Schema.String]))),
  type: Schema.optional(Schema.NullOr(Schema.String)),
  message: Schema.optional(Schema.String),
});

/** OpenAI answers 429 `insufficient_quota` when the project's spend limit is reached. Another model would not help. */
const isQuotaError = (text: string) => /"(?:code|type)"\s*:\s*"insufficient_quota"/.test(text);

/** A rate limit on our own usage of one model: try the next model. */
class RateLimited extends Data.TaggedError("RateLimited")<{ readonly message: string }> {}

/** The fields read from a chat completion. Anything can be absent; the checks below say which is missing. */
const Completion = Schema.Struct({
  error: Schema.optional(Schema.NullOr(CompletionError)),
  choices: Schema.optional(
    Schema.Array(
      Schema.Struct({
        finish_reason: Schema.optional(Schema.NullOr(Schema.String)),
        error: Schema.optional(Schema.NullOr(CompletionError)),
        message: Schema.optional(Schema.NullOr(Schema.Struct({ content: Schema.optional(Schema.NullOr(Schema.String)) }))),
      }),
    ),
  ),
  usage: Schema.optional(Schema.Unknown),
});

const JUDGED_SEVERITIES = ["high", "low", "figure_error"] as const;

const responseFormat = (labels: ReadonlyArray<string>) => ({
  type: "json_schema",
  json_schema: {
    name: "page_comparison",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["page_features", "evaluations"],
      properties: {
        page_features: { type: "array", items: { type: "string" } },
        evaluations: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label", "errors", "reasoning", "score"],
            properties: {
              label: { type: "string", enum: labels },
              errors: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["severity", "category", "visual_region_type", "location_hint", "description"],
                  properties: {
                    severity: { type: "string", enum: JUDGED_SEVERITIES },
                    category: { type: "string", enum: JUDGED_CATEGORIES },
                    visual_region_type: { type: "string" },
                    location_hint: { type: "string" },
                    description: { type: "string" },
                  },
                },
              },
              reasoning: { type: "string" },
              score: { type: "integer", minimum: 1, maximum: 10 },
            },
          },
        },
      },
    },
  },
});

const base64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

/**
 * One judge call per page: all parses, blinded, scored 1-10 against the page image. On a rate limit the next
 * model in `config.models` judges the page; all parses of a page are always judged by one model.
 */
export const judgePage = Effect.fn("judge.page")(function* (config: JudgeConfig, input: JudgeInput) {
  const [first, ...fallbacks] = config.models;
  if (first === undefined) return yield* new JudgeError({ retryable: false, message: "No judge model is set." });
  let attempt = judgeWith(config, first, input);
  for (const model of fallbacks) {
    attempt = attempt.pipe(
      Effect.catchTag("RateLimited", (error) =>
        Effect.logWarning("judge model rate limited, falling back", { model, error: error.message }).pipe(
          Effect.andThen(judgeWith(config, model, input)),
        ),
      ),
    );
  }
  return yield* attempt.pipe(
    Effect.catchTag("RateLimited", (error) => Effect.fail(new JudgeError({ retryable: true, message: error.message }))),
  );
});

const judgeWith = Effect.fn("judge.model")(function* (config: JudgeConfig, model: string, input: JudgeInput) {
  yield* Effect.annotateCurrentSpan("model", model);
  const token = yield* config.token;
  const labelToPreset = yield* blindLabels(input.pageId, Object.keys(input.markdownByPreset));
  const labels = Object.keys(labelToPreset);
  const sections = labels
    .map((label) => `## ${label}\n\n\`\`\`\`text\n${input.markdownByPreset[labelToPreset[label] ?? ""] ?? ""}\n\`\`\`\``)
    .join("\n\n");
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.post(`${config.baseUrl}/chat/completions`).pipe(
    HttpClientRequest.bearerToken(token),
    HttpClientRequest.bodyJsonUnsafe({
      model,
      reasoning_effort: config.reasoningEffort,
      response_format: responseFormat(labels),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: comparePrompt(sections, labels.join(", ")) },
            { type: "image_url", image_url: { url: `data:image/png;base64,${base64(input.imagePng)}`, detail: "high" } },
          ],
        },
      ],
    }),
  );
  const { status, text } = yield* Effect.gen(function* () {
    const response = yield* client.execute(request);
    return { status: response.status, text: yield* response.text };
  }).pipe(
    Effect.mapError((error) => new JudgeError({ retryable: true, message: httpErrorMessage(error) })),
    Effect.timeoutOrElse({
      duration: JUDGE_TIMEOUT,
      orElse: () => Effect.fail(new JudgeError({ retryable: true, message: `Judge request timed out after ${JUDGE_TIMEOUT}` })),
    }),
  );
  if (status === 429 && isQuotaError(text)) {
    return yield* new JudgeError({ retryable: false, message: `Judge project spend limit reached: ${snippet(text)}` });
  }
  if (status === 429) return yield* new RateLimited({ message: `${model} HTTP 429: ${snippet(text)}` });
  if (status !== 200) {
    return yield* new JudgeError({ retryable: isRetryableStatus(status), message: `${model} HTTP ${status}: ${snippet(text)}` });
  }
  const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Completion))(text).pipe(
    Effect.mapError((error) => new JudgeError({ retryable: true, message: `Invalid judge response: ${error.message}` })),
  );
  const choice = body.choices?.[0];
  // A 200 can carry an `error` object, at the top level or on the choice.
  const error = body.error ?? choice?.error;
  if (error !== undefined && error !== null) {
    const code = Number(error.code);
    const message = `${model} error ${error.code}: ${String(error.message).slice(0, 500)}`;
    if (code === 429) return yield* new RateLimited({ message });
    return yield* new JudgeError({
      retryable: Number.isNaN(code) || isRetryableStatus(code),
      message,
    });
  }
  const content = choice?.message?.content;
  if (typeof content !== "string" || content === "") {
    return yield* new JudgeError({
      retryable: true,
      message: `Judge response has no message content (finish_reason ${choice?.finish_reason ?? "none"})`,
    });
  }
  const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Verdicts))(content).pipe(
    Effect.mapError((error) => new JudgeError({ retryable: true, message: `Invalid judge output: ${error.message}` })),
  );
  const verdicts = new Map<string, PresetVerdict>();
  for (const evaluation of parsed.evaluations) {
    const presetId = labelToPreset[evaluation.label];
    if (presetId === undefined) continue;
    if (verdicts.has(presetId)) {
      return yield* new JudgeError({ retryable: true, message: `Duplicate judge label: ${evaluation.label}` });
    }
    if (!Number.isInteger(evaluation.score) || evaluation.score < 1 || evaluation.score > 10) {
      return yield* new JudgeError({ retryable: true, message: `Judge score out of range: ${evaluation.score}` });
    }
    if (
      evaluation.errors.some((error) => {
        const figure = error.category === "figure_precision" || error.category === "figure_recall";
        return figure !== (error.severity === "figure_error");
      })
    ) {
      return yield* new JudgeError({ retryable: true, message: "Invalid judge error severity for its category." });
    }
    verdicts.set(presetId, {
      presetId,
      score: evaluation.score,
      reasoning: unblind(evaluation.reasoning, labelToPreset),
      errors: evaluation.errors.map((error) => ({
        ...error,
        description: unblind(error.description, labelToPreset),
        ...(error.location_hint === undefined ? {} : { location_hint: unblind(error.location_hint, labelToPreset) }),
      })),
    });
  }
  if (verdicts.size !== labels.length) {
    return yield* new JudgeError({ retryable: true, message: "Judge did not score every parse." });
  }
  if (config.onUsage !== undefined) yield* config.onUsage(model, body.usage);
  return [...verdicts.values()];
});
