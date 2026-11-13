export const PROVIDER_NAMES: Record<string, string> = {
  reducto: "Reducto",
  azure_document_intelligence: "Azure Document Intelligence",
  aws_textract: "AWS Textract",
  google_document_ai: "Google Document AI",
  mistral_ocr: "Mistral OCR",
  extend: "Extend",
  llamaparse: "LlamaParse",
  datalab: "Datalab",
  pulse: "Pulse",
  cohere: "Cohere",
  nutrient: "Nutrient",
};

export const SHORT_NAMES: Record<string, string> = {
  ...PROVIDER_NAMES,
  azure_document_intelligence: "Azure",
  aws_textract: "Textract",
  google_document_ai: "Google",
  mistral_ocr: "Mistral",
};

/** BYOK providers take a single API key. */
export const BYOK_KEY: Record<string, string> = {
  mistral_ocr: "MISTRAL_API_KEY",
  extend: "EXTEND_API_KEY",
  llamaparse: "LLAMA_CLOUD_API_KEY",
  datalab: "DATALAB_API_KEY",
  pulse: "PULSE_API_KEY",
  cohere: "COHERE_API_KEY",
  nutrient: "NUTRIENT_API_KEY",
};

/** `bedrock_data_automation` -> `Bedrock Data Automation`, for providers this build has no name for. */
const titleCase = (id: string) => id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
export const providerName = (id: string) => PROVIDER_NAMES[id] ?? titleCase(id);
export const shortName = (id: string) => SHORT_NAMES[id] ?? titleCase(id);
export const perThousand = (usdPerPage: number) => `$${Math.round(usdPerPage * 1000)}`;
export const seconds = (ms: number | null) => (ms === null ? "–" : `${(ms / 1000).toFixed(1)} s`);

/** Display order on the landing page. Providers not listed go last. */
export const PROVIDER_ORDER = [
  "reducto",
  "azure_document_intelligence",
  "aws_textract",
  "google_document_ai",
  "llamaparse",
  "mistral_ocr",
  "extend",
  "datalab",
  "pulse",
  "cohere",
  "nutrient",
];
export const providerRank = (id: string) => {
  const rank = PROVIDER_ORDER.indexOf(id);
  return rank === -1 ? PROVIDER_ORDER.length : rank;
};

const TONES = ["slate", "rust", "pine", "honey", "espresso", "ink"];

/** Each preset's chart colour, by its place in the run: r-1 is always plum. The same in the load state and report. */
export const presetTones = (presetIds: ReadonlyArray<string>): ReadonlyMap<string, string> => {
  const out = new Map<string, string>();
  let next = 0;
  for (const id of presetIds) out.set(id, id === "reducto_r1" ? "plum" : (TONES[next++ % TONES.length] ?? "ink"));
  return out;
};
