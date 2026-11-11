import { Effect, type Option } from "effect";
import type { HttpClient } from "effect/http";
import type { Cost } from "./domain.ts";
import { ProviderError } from "./errors.ts";

/** One page rendered to PNG. Every provider gets the same image, whatever the source format. The URL is short-lived and public. */
export interface PageInput {
  readonly imageUrl: string;
  readonly image: Effect.Effect<Uint8Array, ProviderError>;
}

export const DEFAULT_MAX_CONCURRENCY = 100;

export interface ParseOutput {
  readonly markdown: string;
  readonly raw: unknown;
  /** Cost reported by the provider for this call. Absent when the provider does not report it. */
  readonly reportedCost?: Cost;
  /** Shown next to the parse when the provider returned partial output, e.g. it hit its token limit. */
  readonly warning?: string;
}

/** Result of a submit call. Async providers return a job reference to poll later. */
export type Submission =
  | { readonly _tag: "Done"; readonly output: ParseOutput }
  | { readonly _tag: "Pending"; readonly job: string };

export const done = (output: ParseOutput): Submission => ({ _tag: "Done", output });
export const pending = (job: string): Submission => ({ _tag: "Pending", job });

export type Credentials = Readonly<Record<string, string>>;
export type ProviderConfig = Readonly<Record<string, unknown>>;

export interface ProviderAdapter {
  readonly id: string;
  /** Credential names the adapter reads, e.g. `AZURE_DI_KEY`. */
  readonly credentialKeys: ReadonlyArray<string>;
  /** Most requests in flight per API key. Defaults to `DEFAULT_MAX_CONCURRENCY`. */
  readonly maxConcurrency?: number;
  readonly submit: (
    page: PageInput,
    config: ProviderConfig,
    credentials: Credentials,
  ) => Effect.Effect<Submission, ProviderError, HttpClient.HttpClient>;
  /** Returns `None` while the job is still running. Required when `submit` can return `Pending`. */
  readonly poll?: (
    job: string,
    credentials: Credentials,
  ) => Effect.Effect<Option.Option<ParseOutput>, ProviderError, HttpClient.HttpClient>;
}

export const credential = (provider: string, credentials: Credentials, key: string) => {
  const value = credentials[key];
  return value === undefined || value.length === 0
    ? Effect.fail(new ProviderError({ provider, retryable: false, message: `Missing credential ${key}` }))
    : Effect.succeed(value);
};

export const failure = (provider: string, message: string, retryable = false) =>
  new ProviderError({ provider, retryable, message });

/**
 * A job that ended without a result, or reports a status the adapter does not know. Not retryable: polling the same
 * job again returns the same answer. The message keeps the provider's error text but not the body, which can hold
 * document content.
 */
export const jobFailure = (provider: string, status: string, error: string | null | undefined) =>
  failure(provider, `job ${status}: ${error ?? "no error message"}`);
