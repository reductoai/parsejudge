/// <reference types="node" />
// Runs the judge on the golden set: each page's control and planted copies, judged together the way production judges
// a page's parses, then scored against the planted errors.
//
//   node eval/cli.ts             the production judge (model and settings from wrangler.prod.jsonc), with OPENAI_API_KEY
//   node eval/cli.ts --oracle    a judge handed the answers: checks the pipeline end to end, measures nothing
//
// Options: --solo judges each copy in its own call; --pages id,id picks pages; --out dir (default eval/results/<time>).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JUDGE_VERSION, type JudgeConfig, type JudgeInput, judgePage, type PresetVerdict } from "@parsejudge/core";
import { Effect, Layer, Schedule } from "effect";
import { FetchHttpClient } from "effect/http";
import { renderPagePng } from "../src/render-page.ts";
import { type Variant, variantsOf } from "./inject.ts";
import { buildPdf, GOLDEN_PAGES, type GoldenPage } from "./pages.ts";
import { nodePdfium } from "./pdfium-node.ts";
import { type Judged, reportMarkdown, scoreGoldenSet } from "./score.ts";

/** Judges one page's parses. `markdownByPreset` is keyed by variant id. */
export type JudgeFn = (input: JudgeInput) => Effect.Effect<ReadonlyArray<PresetVerdict>, { readonly message: string }>;

export interface JudgeSettings {
  readonly models: ReadonlyArray<string>;
  readonly reasoningEffort: "low" | "medium" | "high";
  readonly baseUrl: string;
}

/** The judge settings production runs with, from wrangler.prod.jsonc's vars. */
export const productionJudgeSettings = (): JudgeSettings => {
  const config = readFileSync(join(import.meta.dirname, "../wrangler.prod.jsonc"), "utf8");
  const value = (name: string) => {
    const found = config.match(new RegExp(`"${name}":\\s*"([^"]*)"`))?.[1];
    if (found === undefined) throw new Error(`${name} is not set in wrangler.prod.jsonc`);
    return found;
  };
  const effort = value("JUDGE_REASONING_EFFORT");
  if (effort !== "low" && effort !== "medium" && effort !== "high") throw new Error(`Unknown reasoning effort ${effort}`);
  return {
    models: [value("JUDGE_MODEL"), ...value("JUDGE_FALLBACK_MODELS").split(",")].map((m) => m.trim()).filter(Boolean),
    reasoningEffort: effort,
    baseUrl: value("OPENAI_BASE_URL"),
  };
};

/**
 * The production judge (`judgePage`) called with an API key. Production authenticates with workload identity instead;
 * the judge only needs a bearer token, so a key works the same. `fetch` is for tests.
 */
export const openAIJudge =
  (apiKey: string, settings: JudgeSettings, fetch?: typeof globalThis.fetch): JudgeFn =>
  (input) => {
    const config: JudgeConfig = {
      token: Effect.succeed(apiKey),
      models: settings.models,
      reasoningEffort: settings.reasoningEffort,
      baseUrl: settings.baseUrl,
    };
    return judgePage(config, input).pipe(
      Effect.provide(
        Layer.mergeAll(FetchHttpClient.layer, fetch === undefined ? Layer.empty : Layer.succeed(FetchHttpClient.Fetch, fetch)),
      ),
    );
  };

/** A judge handed the answers: each copy's planted error, nothing on the control. It checks the pipeline, not a judge. */
export const oracleJudge =
  (variants: ReadonlyArray<Variant>): JudgeFn =>
  (input) => {
    const byId = new Map(variants.map((v) => [v.id, v]));
    return Effect.succeed(
      Object.keys(input.markdownByPreset).map((id): PresetVerdict => {
        const expected = byId.get(id)?.expected ?? null;
        return {
          presetId: id,
          score: expected === null ? 10 : expected.severity === "high" ? 4 : 8,
          reasoning: "oracle",
          errors:
            expected === null
              ? []
              : [
                  {
                    category: expected.categories[0] ?? "other",
                    severity: expected.severity,
                    description: byId.get(id)?.description ?? "",
                  },
                ],
        };
      }),
    );
  };

export interface RunOptions {
  readonly pages?: ReadonlyArray<GoldenPage>;
  /** Judge each copy in its own call instead of all of a page's copies together. */
  readonly solo?: boolean;
}

/** Renders each golden page, judges its copies, and returns what the judge said about each. A failed page is recorded. */
export const runGoldenSet = Effect.fn("runGoldenSet")(function* (judge: JudgeFn, options: RunOptions = {}) {
  const judged: Array<Judged> = [];
  for (const page of options.pages ?? GOLDEN_PAGES) {
    const pdf = yield* Effect.promise(() => buildPdf(page.blocks));
    const imagePng = yield* renderPagePng(nodePdfium, pdf);
    const variants = variantsOf(page);
    for (const group of options.solo === true ? variants.map((v) => [v]) : [variants]) {
      const input: JudgeInput = {
        pageId: page.id,
        imagePng,
        markdownByPreset: Object.fromEntries(group.map((v) => [v.id, v.markdown])),
      };
      const result = yield* judge(input).pipe(
        Effect.retry({ times: 2, schedule: Schedule.exponential("2 seconds") }),
        Effect.result,
      );
      if (result._tag === "Failure") {
        yield* Effect.logWarning("Judge failed on page", page.id, result.failure.message);
        for (const variant of group) judged.push({ variant, verdict: null, failure: result.failure.message });
        continue;
      }
      const byId = new Map(result.success.map((verdict) => [verdict.presetId, verdict]));
      for (const variant of group) {
        const verdict = byId.get(variant.id) ?? null;
        judged.push(verdict === null ? { variant, verdict, failure: "No verdict for this copy" } : { variant, verdict });
      }
    }
  }
  return judged;
});

/** The command line: see the top of this file. */
export const main = Effect.gen(function* () {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(`--${name}`);
  const option = (name: string) => {
    const at = args.indexOf(`--${name}`);
    return at === -1 ? undefined : args[at + 1];
  };
  const pageIds = option("pages")?.split(",");
  const pages = pageIds === undefined ? GOLDEN_PAGES : GOLDEN_PAGES.filter((p) => pageIds.includes(p.id));
  const oracle = flag("oracle");
  const settings = productionJudgeSettings();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!oracle && (apiKey === undefined || apiKey === "")) {
    console.error("Set OPENAI_API_KEY to run the production judge, or pass --oracle to check the pipeline without one.");
    process.exitCode = 1;
    return;
  }
  const judge = oracle ? oracleJudge(pages.flatMap(variantsOf)) : openAIJudge(apiKey ?? "", settings);
  const ranAt = new Date().toISOString();
  const report = scoreGoldenSet(yield* runGoldenSet(judge, { pages, solo: flag("solo") }));
  const heading = oracle
    ? `Golden set, oracle judge (checks the pipeline, not a judge), ${ranAt}`
    : `Golden set: ${settings.models[0]} (${JUDGE_VERSION}, reasoning ${settings.reasoningEffort}${flag("solo") ? ", solo" : ""}), ${ranAt}`;
  const markdown = reportMarkdown(report, heading);
  const out = option("out") ?? join(import.meta.dirname, "results", ranAt.replaceAll(":", "-"));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "report.md"), markdown);
  writeFileSync(
    join(out, "results.json"),
    `${JSON.stringify({ ranAt, oracle, solo: flag("solo"), judgeVersion: JUDGE_VERSION, settings, report }, null, 2)}\n`,
  );
  console.log(markdown);
  console.log(`Wrote ${join(out, "report.md")} and results.json`);
});
