import type { JudgeInput, PresetVerdict } from "@parsejudge/core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { type Variant, variantsOf } from "../eval/inject.ts";
import { GOLDEN_PAGES } from "../eval/pages.ts";
import { type JudgeFn, openAIJudge, oracleJudge, productionJudgeSettings, runGoldenSet } from "../eval/run.ts";
import { type Judged, reportMarkdown, scoreGoldenSet } from "../eval/score.ts";

const ALL = GOLDEN_PAGES.flatMap(variantsOf);

const variant = (id: string) => {
  const found = ALL.find((v) => v.id === id);
  if (found === undefined) throw new Error(`No variant ${id}`);
  return found;
};

const verdict = (v: Variant, score: number, errors: PresetVerdict["errors"]): Judged => ({
  variant: v,
  verdict: { presetId: v.id, score, reasoning: "", errors },
});

describe("scoreGoldenSet", () => {
  const judged: ReadonlyArray<Judged> = [
    verdict(variant("regional-sales/control"), 9, [{ category: "text_corruption", severity: "low", description: "spurious" }]),
    // Caught exactly.
    verdict(variant("regional-sales/changed-digit"), 5, [{ category: "table_content", severity: "high", description: "1,289" }]),
    // Flagged, but filed under a category the planted error doesn't accept.
    verdict(variant("regional-sales/swapped-columns"), 6, [{ category: "reading_order", severity: "high", description: "x" }]),
    // Right category, wrong severity.
    verdict(variant("regional-sales/dropped-row"), 8, [{ category: "content_omission", severity: "low", description: "row" }]),
    // Missed.
    verdict(variant("regional-sales/invented-sentence"), 9, []),
    // The judge failed on another page.
    { variant: variant("bird-survey/control"), verdict: null, failure: "HTTP 500" },
    { variant: variant("bird-survey/merged-columns"), verdict: null, failure: "HTTP 500" },
  ];
  const report = scoreGoldenSet(judged);

  it("separates flagging, category and severity", () => {
    expect(report.byKind["changed-digit"]).toEqual({ planted: 1, flagged: 1, rightCategory: 1, rightSeverity: 1 });
    expect(report.byKind["swapped-columns"]).toEqual({ planted: 1, flagged: 1, rightCategory: 0, rightSeverity: 0 });
    expect(report.byKind["dropped-row"]).toEqual({ planted: 1, flagged: 1, rightCategory: 1, rightSeverity: 0 });
    expect(report.byKind["invented-sentence"]).toEqual({ planted: 1, flagged: 0, rightCategory: 0, rightSeverity: 0 });
    expect(report.total).toEqual({ planted: 4, flagged: 3, rightCategory: 2, rightSeverity: 1 });
  });

  it("counts errors on controls as false alarms and leaves failed pages out", () => {
    expect(report.controls).toEqual({ judged: 1, withErrors: 1, errors: 1, meanScore: 9 });
    expect(report.failed).toEqual(["bird-survey"]);
    expect(report.byKind["merged-columns"]).toBeUndefined();
  });

  it("measures how far high-severity copies score below their control", () => {
    // changed-digit 9-5, swapped-columns 9-6, dropped-row 9-8, invented-sentence 9-9.
    expect(report.highSeverityScoreGap).toBe((4 + 3 + 1 + 0) / 4);
  });

  it("lists misses with what the judge said", () => {
    const markdown = reportMarkdown(report, "Test");
    expect(markdown).toContain("| **All** | 4 | 3/4 (75%) | 2/4 (50%) | 1/4 (25%) |");
    expect(markdown).toContain('`regional-sales/swapped-columns` (Values of "July" and "August" swapped');
    expect(markdown).toContain("judge reported reading_order/high");
    expect(markdown).toContain("`regional-sales/control`: text_corruption/low: spurious");
    expect(markdown).toContain("Judge failed on: bird-survey");
  });
});

describe("runGoldenSet", () => {
  const recording = (judge: JudgeFn) => {
    const inputs: Array<JudgeInput> = [];
    const wrapped: JudgeFn = (input) => {
      inputs.push(input);
      return judge(input);
    };
    return { inputs, judge: wrapped };
  };

  it("judges each page's copies together, with the rendered page image", async () => {
    const { inputs, judge } = recording(oracleJudge(ALL));
    const report = scoreGoldenSet(await Effect.runPromise(runGoldenSet(judge)));
    expect(inputs).toHaveLength(GOLDEN_PAGES.length);
    expect(inputs.map((i) => Object.keys(i.markdownByPreset).length)).toEqual(GOLDEN_PAGES.map((p) => variantsOf(p).length));
    expect([...(inputs[0]?.imagePng.subarray(1, 4) ?? [])]).toEqual([0x50, 0x4e, 0x47]);
    // The oracle is handed the answers, so this only shows the pipeline carries them through.
    expect(report.total).toEqual({ planted: 24, flagged: 24, rightCategory: 24, rightSeverity: 24 });
    expect(report.controls.withErrors).toBe(0);
  });

  it("judges each copy alone with solo", async () => {
    const { inputs, judge } = recording(oracleJudge(ALL));
    await Effect.runPromise(runGoldenSet(judge, { solo: true, pages: GOLDEN_PAGES.slice(0, 1) }));
    expect(inputs.map((i) => Object.keys(i.markdownByPreset))).toEqual(
      GOLDEN_PAGES.slice(0, 1)
        .flatMap(variantsOf)
        .map((v) => [v.id]),
    );
  });

  it("records a page whose judge call keeps failing and goes on", async () => {
    const failing: JudgeFn = (input) =>
      input.pageId === "regional-sales" ? Effect.fail({ message: "HTTP 503" }) : oracleJudge(ALL)(input);
    const judged = await Effect.runPromise(
      runGoldenSet(failing, { pages: GOLDEN_PAGES.filter((p) => p.id !== "maintenance-notice") }),
    );
    const report = scoreGoldenSet(judged);
    expect(report.failed).toEqual(["regional-sales"]);
    expect(judged.find((j) => j.variant.id === "regional-sales/dropped-row")?.failure).toBe("HTTP 503");
  }, 30_000);
});

describe("openAIJudge", () => {
  it("sends production's judge request with the key, and maps verdicts back to the copies", async () => {
    const settings = productionJudgeSettings();
    const requests: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
    const fakeFetch = (async (url: URL | string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body });
      const labels = (
        body as {
          response_format: {
            json_schema: {
              schema: { properties: { evaluations: { items: { properties: { label: { enum: Array<string> } } } } } };
            };
          };
        }
      ).response_format.json_schema.schema.properties.evaluations.items.properties.label.enum;
      const content = {
        page_features: [],
        evaluations: labels.map((label) => ({ label, errors: [], reasoning: "ok", score: 9 })),
      };
      return new Response(
        JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }], usage: {} }),
      );
    }) as unknown as typeof fetch;
    const page = GOLDEN_PAGES.find((p) => p.id === "incident-report");
    const judged = await Effect.runPromise(
      runGoldenSet(openAIJudge("test-key", settings, fakeFetch), { pages: page === undefined ? [] : [page] }),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${settings.baseUrl}/chat/completions`);
    expect(requests[0]?.auth).toBe("Bearer test-key");
    expect(requests[0]?.body).toMatchObject({ model: settings.models[0], reasoning_effort: settings.reasoningEffort });
    expect(JSON.stringify(requests[0]?.body)).toContain("data:image/png;base64,");
    // Copies are blinded as parse_a, parse_b, ... in the request and come back under their own ids.
    expect(JSON.stringify(requests[0]?.body)).not.toContain("incident-report/");
    expect(judged.map((j) => j.verdict?.presetId)).toEqual((page === undefined ? [] : variantsOf(page)).map((v) => v.id));
  });

  it("reads the judge settings production runs with", () => {
    const settings = productionJudgeSettings();
    expect(settings.models.length).toBeGreaterThan(0);
    expect(["low", "medium", "high"]).toContain(settings.reasoningEffort);
    expect(settings.baseUrl.startsWith("https://")).toBe(true);
  });
});
