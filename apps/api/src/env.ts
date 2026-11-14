import { Data, Effect, Schema } from "effect";
import type { Converter } from "./converter.ts";
import type { Splitter } from "./splitter.ts";
import type { DocumentWorkflowParams, PageWorkflowParams, RunWorkflowParams } from "./workflows.ts";

export interface Env {
  readonly DB: D1Database;
  readonly BLOBS: R2Bucket;
  readonly RUN_EVENTS: DurableObjectNamespace;
  readonly PROVIDER_SLOTS: DurableObjectNamespace;
  readonly CONVERTER: DurableObjectNamespace<Converter>;
  readonly SPLITTER: DurableObjectNamespace<Splitter>;
  readonly RUN_WORKFLOW: Workflow<RunWorkflowParams>;
  readonly PAGE_WORKFLOW: Workflow<PageWorkflowParams>;
  readonly DOCUMENT_WORKFLOW: Workflow<DocumentWorkflowParams>;
  readonly PUBLIC_URL: string;
  /** Primary OpenAI judge model, called directly with workload identity. */
  readonly JUDGE_MODEL: string;
  /** Comma-separated OpenAI models tried in order when the one before is rate limited. */
  readonly JUDGE_FALLBACK_MODELS?: string;
  readonly OPENAI_BASE_URL: string;
  readonly OPENAI_AUTH_URL: string;
  readonly OPENAI_IDENTITY_PROVIDER_ID: string;
  readonly OPENAI_SERVICE_ACCOUNT_ID: string;
  /** Claims of the JWT we sign for OpenAI OIDC workload identity; must match the identity provider and mapping. */
  readonly OPENAI_JWT_ISSUER: string;
  readonly OPENAI_JWT_AUDIENCE: string;
  readonly OPENAI_JWT_SUBJECT: string;
  /** Private P-256 JWK (JSON, with `kid`) whose public half is uploaded to the OpenAI identity provider. */
  readonly OPENAI_SIGNING_KEY: string;
  /** OpenAI model for the small-model steps (page notes, error locations, run titles), on the same workload identity. */
  readonly SMALL_MODEL: string;
  readonly JUDGE_REASONING_EFFORT: "low" | "medium" | "high";
  readonly MAX_PAGES_PER_RUN: string;
  /** Pages one user can start runs on in any 24 hours. Unset turns it off. */
  readonly MAX_PAGES_PER_DAY?: string;
  /** Largest upload accepted, in bytes. Unset turns it off (Cloudflare's request body limit still applies). */
  readonly MAX_UPLOAD_BYTES?: string;
  /** JSON map from provider id or "judge" to max requests in flight per API key, e.g. `{"reducto": 200}`. */
  readonly MAX_CONCURRENCY?: string;
  readonly BLOB_SIGNING_KEY: string;
  readonly CREDENTIALS_KEY: string;
  /** Analytics Engine dataset for per-call cost and latency (see usage.ts). Unbound turns it off. */
  readonly USAGE?: AnalyticsEngineDataset;
  /** "email" (sign-in by emailed code or link) or "dev" (also trusts the x-parsejudge-user header; local only). */
  readonly AUTH_MODE: string;
  /** HMAC key for sign-in codes, links and session ids. */
  readonly AUTH_KEY: string;
  readonly EMAIL: SendEmail;
  readonly EMAIL_FROM: string;
  /** Cloudflare Turnstile on sign-in. Unset turns the check off. */
  readonly TURNSTILE_SITEKEY?: string;
  readonly TURNSTILE_SECRET?: string;
  /** Per-login limits on title generation and on uploads before sign-in. Unset turns them off. */
  readonly TITLE_LIMIT?: RateLimit;
  readonly UPLOAD_LIMIT?: RateLimit;
  /** Hosted provider credentials (REDUCTO_API_KEY, AZURE_DI_KEY, ...). */
  readonly [credential: string]: unknown;
}

const positiveInt = Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/));

/** The vars and secrets every Worker entry point relies on. Provider keys are checked per preset when a run starts. */
export const EnvVars = Schema.Struct({
  PUBLIC_URL: Schema.String.check(Schema.isPattern(/^https?:\/\/[^/\s]+/)),
  AUTH_MODE: Schema.Literals(["email", "dev"]),
  AUTH_KEY: Schema.String.check(Schema.isMinLength(32)),
  /** 32 bytes, base64. */
  CREDENTIALS_KEY: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9+/]{43}=$/)),
  BLOB_SIGNING_KEY: Schema.NonEmptyString,
  EMAIL_FROM: Schema.String.check(Schema.isPattern(/^[^@\s]+@[^@\s]+$/)),
  JUDGE_REASONING_EFFORT: Schema.Literals(["low", "medium", "high"]),
  MAX_PAGES_PER_RUN: positiveInt,
  MAX_PAGES_PER_DAY: Schema.optional(positiveInt),
  MAX_UPLOAD_BYTES: Schema.optional(positiveInt),
  MAX_CONCURRENCY: Schema.optional(
    Schema.fromJsonString(Schema.Record(Schema.String, Schema.Int.check(Schema.isGreaterThan(0)))),
  ),
  TURNSTILE_SITEKEY: Schema.optional(Schema.String),
  TURNSTILE_SECRET: Schema.optional(Schema.String),
}).check(
  Schema.makeFilter((vars) =>
    vars.TURNSTILE_SITEKEY && !vars.TURNSTILE_SECRET ? "TURNSTILE_SITEKEY is set without TURNSTILE_SECRET" : undefined,
  ),
);

export class InvalidEnv extends Data.TaggedError("InvalidEnv")<{ readonly message: string }> {}

const decoded = new WeakMap<object, InvalidEnv | null>();

/** Why the deployment's env is unusable, or null. Decoded once per env object. */
export const envError = (env: Env): Effect.Effect<InvalidEnv | null> => {
  const known = decoded.get(env);
  if (known !== undefined) return Effect.succeed(known);
  const result = Schema.decodeUnknownExit(EnvVars)(env, { errors: "all" });
  const error = result._tag === "Success" ? null : new InvalidEnv({ message: String(result.cause) });
  decoded.set(env, error);
  return error === null ? Effect.succeed(null) : Effect.logError("invalid_env", error.message).pipe(Effect.as(error));
};
