import { plugins } from "#plugins";
import type { ProviderConfig } from "./provider.ts";

/**
 * A provider plus a fixed configuration. Runs, scores and prices are keyed by preset.
 * `hosted` presets run on the public site's credentials; the others need the user's own key.
 * `optIn` hosted presets are left out of the default selection.
 * `listPriceUsdPerPage` is the public list price, used when the provider does not report cost.
 */
export interface Preset {
  readonly id: string;
  readonly provider: string;
  readonly label: string;
  /** The option within the provider, e.g. "Agentic Plus". */
  readonly mode: string;
  readonly config: ProviderConfig;
  readonly listPriceUsdPerPage: number;
  readonly hosted: boolean;
  readonly optIn?: boolean;
}

const llamaparse = (tier: string): ProviderConfig => ({ tier, version: "latest", disable_cache: true });
const datalab = (mode: string): ProviderConfig => ({
  mode,
  output_format: "markdown",
  skip_cache: true,
  additional_config: { keep_pageheader_in_output: true, keep_pagefooter_in_output: true },
});

/** The markdown settings from Nutrient's own WholeDoc Bench adapter, with page headers and footers kept like the other providers here. */
const nutrient = (mode: string): ProviderConfig => ({
  mode,
  output: {
    format: "markdown",
    includeHeadersAndFooters: true,
    useHtmlTables: true,
    enableSemanticBlockFormatting: true,
    enableInlineFormatting: true,
  },
});

const BUILTIN_PRESETS: ReadonlyArray<Preset> = [
  {
    id: "reducto_r1",
    provider: "reducto",
    label: "Reducto r-1",
    mode: "r-1",
    config: { formatting: { merge_tables: false }, settings: { model: "r-1" } },
    listPriceUsdPerPage: 0.01,
    hosted: true,
  },
  {
    id: "reducto_r1_mini",
    provider: "reducto",
    label: "Reducto r-1 mini",
    mode: "r-1 mini",
    config: { formatting: { merge_tables: false }, settings: { model: "r-1-mini" } },
    listPriceUsdPerPage: 0.001,
    hosted: true,
  },
  {
    id: "azure_layout_high_res",
    provider: "azure_document_intelligence",
    label: "Azure Document Intelligence Layout (high-res)",
    mode: "Layout, high resolution",
    config: { modelId: "prebuilt-layout", features: ["ocrHighResolution"] },
    listPriceUsdPerPage: 0.016,
    hosted: true,
  },
  {
    id: "aws_textract",
    provider: "aws_textract",
    label: "AWS Textract (layout, tables)",
    mode: "Layout, tables",
    config: { featureTypes: ["LAYOUT", "TABLES"] },
    listPriceUsdPerPage: 0.015,
    hosted: true,
  },
  {
    id: "google_layout_parser",
    provider: "google_document_ai",
    label: "Google Document AI Layout Parser",
    mode: "Layout Parser",
    config: {},
    listPriceUsdPerPage: 0.01,
    hosted: true,
    optIn: true,
  },
  {
    id: "mistral_ocr_4_1",
    provider: "mistral_ocr",
    label: "Mistral OCR 4.1",
    mode: "OCR 4.1",
    config: { model: "mistral-ocr-4-1", table_format: "html" },
    listPriceUsdPerPage: 0.004,
    hosted: false,
  },
  {
    id: "extend_performance_agentic",
    provider: "extend",
    label: "Extend Performance (agentic)",
    mode: "Performance, agentic",
    config: {
      engine: "parse_performance",
      target: "markdown",
      chunkingStrategy: { type: "page" },
      blockOptions: {
        figures: { enabled: true, advancedChartExtractionEnabled: true },
        tables: { enabled: true, targetFormat: "html", cellBlocksEnabled: true, agentic: { enabled: true } },
        text: { signatureDetectionEnabled: true, agentic: { enabled: true } },
      },
    },
    listPriceUsdPerPage: 0.03,
    hosted: false,
  },
  {
    id: "extend_light",
    provider: "extend",
    label: "Extend Light",
    mode: "Light",
    config: {
      engine: "parse_light",
      target: "markdown",
      chunkingStrategy: { type: "page" },
      blockOptions: { figures: { enabled: true }, tables: { enabled: true, targetFormat: "html" } },
    },
    listPriceUsdPerPage: 0.005,
    hosted: false,
  },
  {
    id: "llamaparse_agentic_plus",
    provider: "llamaparse",
    label: "LlamaParse Agentic Plus",
    mode: "Agentic Plus",
    config: llamaparse("agentic_plus"),
    listPriceUsdPerPage: 45 * 0.00125,
    hosted: false,
  },
  {
    id: "llamaparse_agentic",
    provider: "llamaparse",
    label: "LlamaParse Agentic",
    mode: "Agentic",
    config: llamaparse("agentic"),
    listPriceUsdPerPage: 10 * 0.00125,
    hosted: false,
  },
  {
    id: "llamaparse_cost_effective",
    provider: "llamaparse",
    label: "LlamaParse Cost Effective",
    mode: "Cost effective",
    config: llamaparse("cost_effective"),
    listPriceUsdPerPage: 3 * 0.00125,
    hosted: false,
  },
  {
    id: "datalab_accurate",
    provider: "datalab",
    label: "Datalab Accurate",
    mode: "Accurate",
    config: datalab("accurate"),
    listPriceUsdPerPage: 0.01,
    hosted: false,
  },
  {
    id: "datalab_balanced",
    provider: "datalab",
    label: "Datalab Balanced",
    mode: "Balanced",
    config: datalab("balanced"),
    listPriceUsdPerPage: 0.004,
    hosted: false,
  },
  {
    id: "datalab_fast",
    provider: "datalab",
    label: "Datalab Fast",
    mode: "Fast",
    config: datalab("fast"),
    listPriceUsdPerPage: 0.004,
    hosted: false,
  },
  {
    id: "pulse_ultra_2",
    provider: "pulse",
    label: "Pulse Ultra 2",
    mode: "Ultra 2",
    config: { model: "pulse-ultra-2", figure_processing: { description: true } },
    listPriceUsdPerPage: 0.015,
    hosted: false,
  },
  {
    id: "pulse_ultra_2_refine",
    provider: "pulse",
    label: "Pulse Ultra 2 (refine)",
    mode: "Ultra 2, refine",
    config: { model: "pulse-ultra-2", refine: true, figure_processing: { description: true } },
    listPriceUsdPerPage: 0.015,
    hosted: false,
  },
  {
    id: "cohere_parse_v5",
    provider: "cohere",
    label: "Cohere Parse v5",
    mode: "Parse v5",
    config: { model: "parse-v5.0", output_format: "markdown" },
    listPriceUsdPerPage: 0.0015,
    hosted: false,
  },
  {
    id: "nutrient_agentic",
    provider: "nutrient",
    label: "Nutrient Agentic",
    mode: "Agentic",
    config: nutrient("agentic"),
    listPriceUsdPerPage: 0.018,
    hosted: false,
  },
  {
    id: "nutrient_understand",
    provider: "nutrient",
    label: "Nutrient Understand",
    mode: "Understand",
    config: nutrient("understand"),
    listPriceUsdPerPage: 0.009,
    hosted: false,
  },
  {
    id: "nutrient_structure",
    provider: "nutrient",
    label: "Nutrient Structure",
    mode: "Structure",
    config: nutrient("structure"),
    listPriceUsdPerPage: 0.0015,
    hosted: false,
  },
];

export const PRESETS: ReadonlyArray<Preset> = [...BUILTIN_PRESETS, ...plugins.flatMap((plugin) => plugin.presets)];

export const DEFAULT_PRESET_IDS: ReadonlyArray<string> = PRESETS.filter((preset) => preset.hosted && !preset.optIn).map(
  (preset) => preset.id,
);

const byId = new Map(PRESETS.map((preset) => [preset.id, preset]));

export const findPreset = (id: string): Preset | undefined => byId.get(id);
