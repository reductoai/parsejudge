import { Effect } from "effect";
import { plugins } from "#plugins";
import type { ProviderId } from "../domain.ts";
import { failure, type ProviderAdapter } from "../provider.ts";
import { azure } from "./azure.ts";
import { cohere } from "./cohere.ts";
import { datalab } from "./datalab.ts";
import { extend } from "./extend.ts";
import { google } from "./google.ts";
import { llamaparse } from "./llamaparse.ts";
import { mistral } from "./mistral.ts";
import { pulse } from "./pulse.ts";
import { reducto } from "./reducto.ts";
import { textract } from "./textract.ts";

const BUILTIN: Readonly<Record<ProviderId, ProviderAdapter>> = {
  reducto,
  azure_document_intelligence: azure,
  aws_textract: textract,
  google_document_ai: google,
  mistral_ocr: mistral,
  extend,
  llamaparse,
  datalab,
  pulse,
  cohere,
};

export const PROVIDERS: typeof BUILTIN & Readonly<Record<string, ProviderAdapter>> = {
  ...BUILTIN,
  ...Object.fromEntries(plugins.flatMap((plugin) => plugin.providers).map((adapter) => [adapter.id, adapter])),
};

/** Stands in for a provider this build has no adapter for, so the page fails instead of the run. */
const missing = (provider: string): ProviderAdapter => ({
  id: provider,
  credentialKeys: [],
  submit: () => Effect.fail(failure(provider, "no adapter in this build")),
});

export const adapterFor = (provider: string): ProviderAdapter => PROVIDERS[provider] ?? missing(provider);
