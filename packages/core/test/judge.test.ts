import { Cause, Effect, Exit, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { describe, expect, it } from "vitest";
import { blindLabels, judgePage, unblind } from "../src/judge.ts";

const config = {
  token: Effect.succeed("test"),
  models: ["judge"],
  reasoningEffort: "medium" as const,
  baseUrl: "https://judge.test/v1",
};
const input = {
  pageId: "doc-0",
  imagePng: new Uint8Array([1, 2, 3]),
  markdownByPreset: { reducto_r1: "# A", aws_textract: "A" },
};

/** Runs the judge against a fake endpoint that answers with `evaluations(labels)`. */
const judgeWith = (evaluations: (labels: Array<string>) => unknown, status = 200) => {
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const labels: Array<string> = body.response_format.json_schema.schema.properties.evaluations.items.properties.label.enum;
    const content = JSON.stringify({ evaluations: evaluations(labels) });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
  }) as typeof globalThis.fetch;
  return Effect.runPromiseExit(
    judgePage(config, input).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
    ),
  );
};

const evaluation = (label: string, score: number) => ({ label, score, reasoning: "r", errors: [] });

describe("blindLabels", () => {
  it("is deterministic per page and independent of input order", async () => {
    const a = await Effect.runPromise(blindLabels("doc-0", ["reducto_r1", "aws_textract", "llamaparse_agentic"]));
    const b = await Effect.runPromise(blindLabels("doc-0", ["llamaparse_agentic", "reducto_r1", "aws_textract"]));
    expect(a).toEqual(b);
    expect(Object.keys(a)).toEqual(["parse_a", "parse_b", "parse_c"]);
    expect(new Set(Object.values(a))).toEqual(new Set(["reducto_r1", "aws_textract", "llamaparse_agentic"]));
  });
});

describe("judgePage", () => {
  it("maps blinded labels back to presets", async () => {
    const labels = await Effect.runPromise(blindLabels(input.pageId, Object.keys(input.markdownByPreset)));
    const exit = await judgeWith((ids) => ids.map((id) => evaluation(id, labels[id] === "reducto_r1" ? 9 : 4)));
    if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
    if (Exit.isSuccess(exit)) {
      expect(Object.fromEntries(exit.value.map((v) => [v.presetId, v.score]))).toEqual({ reducto_r1: 9, aws_textract: 4 });
    }
  });

  it("unblinds labels in error descriptions and location hints", async () => {
    const labels = await Effect.runPromise(blindLabels(input.pageId, Object.keys(input.markdownByPreset)));
    const [first, second] = Object.keys(labels) as [string, string];
    const error = {
      severity: "high",
      category: "reading_order",
      visual_region_type: "table",
      location_hint: `Row 2, unlike ${second}`,
      description: `Same as ${second}.`,
    };
    const exit = await judgeWith((ids) => ids.map((id) => ({ ...evaluation(id, 5), errors: id === first ? [error] : [] })));
    if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
    const flagged = exit.value.find((v) => v.presetId === labels[first]);
    expect(flagged?.errors[0]?.location_hint).not.toContain(second);
    expect(flagged?.errors).toEqual([
      { ...error, location_hint: unblind(error.location_hint, labels), description: unblind(error.description, labels) },
    ]);
  });

  it("fails when the judge skips or repeats a parse", async () => {
    const first = (ids: Array<string>) => ids[0] as string;
    expect(String(await judgeWith((ids) => [evaluation(first(ids), 5)]))).toContain("did not score every parse");
    expect(String(await judgeWith((ids) => [evaluation(first(ids), 5), evaluation(first(ids), 6)]))).toContain(
      "Duplicate judge label",
    );
  });

  it("rejects a repeated label even when every parse is present", async () => {
    const exit = await judgeWith((ids) => [
      evaluation(ids[0] as string, 2),
      evaluation(ids[0] as string, 10),
      evaluation(ids[1] as string, 5),
    ]);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("Duplicate judge label");
    expect(retryable(exit)).toBe(true);
  });

  it.each([
    ["figure_precision", "high"],
    ["figure_precision", "low"],
    ["figure_recall", "high"],
    ["figure_recall", "low"],
    ["text_corruption", "figure_error"],
  ])("rejects category %s with severity %s", async (category, severity) => {
    const exit = await judgeWith((ids) =>
      ids.map((id) => ({ ...evaluation(id, 5), errors: [{ category, severity, description: "Incorrect figure severity" }] })),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("Invalid judge error severity");
    expect(retryable(exit)).toBe(true);
  });

  it.each(["figure_precision", "figure_recall"])("accepts category %s with figure_error severity", async (category) => {
    const exit = await judgeWith((ids) =>
      ids.map((id) => ({
        ...evaluation(id, 5),
        errors: [{ category, severity: "figure_error", description: "Incorrect figure summary" }],
      })),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("fails on out-of-range scores and HTTP errors", async () => {
    expect(String(await judgeWith((ids) => ids.map((id) => evaluation(id, 11))))).toContain("out of range");
    expect(String(await judgeWith(() => [], 500))).toContain("HTTP 500");
  });

  it("fails with the provider error when a 200 response carries an error object", async () => {
    const fetch = (async () =>
      new Response(JSON.stringify({ error: { code: 429, message: "Rate limit exceeded" } }), {
        status: 200,
      })) as unknown as typeof globalThis.fetch;
    const exit = await Effect.runPromiseExit(
      judgePage(config, input).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
      ),
    );
    expect(String(exit)).toContain("judge error 429: Rate limit exceeded");
  });

  it("keeps the error of a 200 response but not its body, which can hold judge output", async () => {
    const respond = async (body: string) => {
      const fetch = (async () => new Response(body, { status: 200 })) as unknown as typeof globalThis.fetch;
      return String(
        await Effect.runPromiseExit(
          judgePage(config, input).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
          ),
        ),
      );
    };
    const choiceError = { choices: [{ finish_reason: "error", error: { code: 502, message: "upstream reset" } }] };
    expect(await respond(JSON.stringify(choiceError))).toContain("judge error 502: upstream reset");
    const invalid = await respond('{"choices": [');
    expect(invalid).toContain("Invalid judge response");
    expect(invalid).not.toContain('{"choices": [');
  });
});

const retryable = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? (Cause.squash(exit.cause) as { retryable?: boolean }).retryable : undefined;

describe("judgePage fallback", () => {
  const run = (models: Array<string>, answer: (model: string, labels: Array<string>) => Response) => {
    const seen: Array<string> = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      seen.push(body.model);
      return answer(body.model, body.response_format.json_schema.schema.properties.evaluations.items.properties.label.enum);
    }) as unknown as typeof globalThis.fetch;
    const used: Array<string> = [];
    const exit = Effect.runPromiseExit(
      judgePage({ ...config, models, onUsage: (model) => Effect.sync(() => used.push(model)) }, input).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
      ),
    );
    return { exit, seen, used };
  };
  const ok = (labels: Array<string>) =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ evaluations: labels.map((l) => evaluation(l, 7)) }) } }],
      }),
    );
  const rateLimited = () =>
    new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", type: "requests", message: "Rate limit reached" } }), {
      status: 429,
    });

  it("judges the page with the next model when one is rate limited", async () => {
    const { exit, seen, used } = run(["a", "b", "c"], (model, labels) => (model === "c" ? ok(labels) : rateLimited()));
    expect(Exit.isSuccess(await exit)).toBe(true);
    expect(seen).toEqual(["a", "b", "c"]);
    expect(used).toEqual(["c"]);
  });

  it("fails retryable after every model is rate limited", async () => {
    const { exit, seen } = run(["a", "b"], () => rateLimited());
    const result = await exit;
    expect(seen).toEqual(["a", "b"]);
    expect(String(result)).toContain("b HTTP 429");
    expect(retryable(result)).toBe(true);
  });

  it("does not fall back when the project spend limit is reached", async () => {
    const quota = () =>
      new Response(JSON.stringify({ error: { code: "insufficient_quota", type: "insufficient_quota", message: "quota" } }), {
        status: 429,
      });
    const { exit, seen } = run(["a", "b"], () => quota());
    const result = await exit;
    expect(seen).toEqual(["a"]);
    expect(String(result)).toContain("spend limit reached");
    expect(retryable(result)).toBe(false);
  });
});

describe("unblind", () => {
  it("replaces blind labels with preset labels and leaves unknown ones", () => {
    expect(
      unblind("Matches parse_a; parse_b drops a row; parse_c is unknown.", { parse_a: "reducto_r1", parse_b: "aws_textract" }),
    ).toBe("Matches Reducto r-1; AWS Textract (layout, tables) drops a row; parse_c is unknown.");
  });
});
