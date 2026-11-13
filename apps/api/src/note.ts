import { decodeJson, PRESETS } from "@parsejudge/core";
import { Effect } from "effect";
import type { Env } from "./env.ts";
import { CompletionFailed, complete, modelUsage, recordUsage } from "./usage.ts";

/** A page gets a note when its best and worst scores differ by this much, or a parse failed. Matches the report. */
const NOTE_GAP = 3;

const PROMPT =
  "You summarize how document parsers did on one page. You get each parser's place on the page (best, middle or " +
  "worst) and the errors a judge found in its output. Write one plain sentence of at most 25 words that says which " +
  "parser did best, which did worst, and the main error that separates them. Use the parser names as given. Reply " +
  "with the sentence only, on one line.";

const SHORT_NAMES: Record<string, string> = {
  reducto: "Reducto",
  azure_document_intelligence: "Azure",
  aws_textract: "Textract",
  google_document_ai: "Google",
  mistral_ocr: "Mistral",
  extend: "Extend",
  llamaparse: "LlamaParse",
  datalab: "Datalab",
  pulse: "Pulse",
  cohere: "Cohere",
  nutrient: "Nutrient",
};

type Row = { preset_id: string; status: string; error: string | null; score: number | null; errors: string | null };

/** The report's names: the provider alone, plus the mode when the run has two options from one provider. */
const namer = (presetIds: ReadonlyArray<string>) => (presetId: string) => {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (preset === undefined) return presetId;
  const provider = SHORT_NAMES[preset.provider] ?? preset.provider;
  const siblings = presetIds.filter((id) => PRESETS.find((p) => p.id === id)?.provider === preset.provider).length;
  return siblings > 1 ? `${provider} ${preset.mode}` : provider;
};

type Flag = { category: string; severity: string; description: string };

/** Writes the page note for flagged pages. Fails on a model or HTTP error so the workflow step retries. */
export const writePageNote = Effect.fn("writePageNote")(function* (env: Env, runId: string, pageId: string) {
  const rows = yield* Effect.promise(() =>
    env.DB.prepare(
      `SELECT p.preset_id, p.status, p.error, v.score, v.errors FROM parses p
     LEFT JOIN verdicts v USING (run_id, page_id, preset_id) WHERE p.run_id = ? AND p.page_id = ?`,
    )
      .bind(runId, pageId)
      .all<Row>(),
  );
  const scores = rows.results.flatMap((r) => (r.status === "succeeded" && r.score !== null ? [r.score] : []));
  const failed = rows.results.some((r) => r.status !== "succeeded");
  if (!failed && (scores.length < 2 || Math.max(...scores) - Math.min(...scores) < NOTE_GAP)) return;
  const top = Math.max(...scores);
  const bottom = Math.min(...scores);
  const label = namer(rows.results.map((r) => r.preset_id));
  const lines = yield* Effect.forEach(rows.results, (r) => {
    if (r.status !== "succeeded") return Effect.succeed(`${label(r.preset_id)}: parse failed (${r.error ?? "no error message"})`);
    return decodeJson(r.errors ?? "[]").pipe(
      Effect.map((decoded) => {
        const found = (decoded as Array<Flag>).map((e) => `${e.severity} ${e.category}: ${e.description}`).join("; ");
        const place = r.score === null ? "not judged" : r.score === top ? "best" : r.score === bottom ? "worst" : "middle";
        return `${label(r.preset_id)}: ${place}. Errors: ${found || "none"}`;
      }),
    );
  });
  const startedAt = Date.now();
  const { content, usage } = yield* complete(
    env,
    {
      model: env.SMALL_MODEL,
      max_completion_tokens: 1000,
      reasoning_effort: "low",
      messages: [
        { role: "system", content: PROMPT },
        { role: "user", content: lines.join("\n") },
      ],
    },
    "30 seconds",
  );
  yield* recordUsage(env, {
    kind: "note",
    name: env.SMALL_MODEL,
    runId,
    pageId,
    status: "ok",
    latencyMs: Date.now() - startedAt,
    ...modelUsage(env.SMALL_MODEL, usage),
  });
  const note = content.trim();
  if (!note || note.includes("\n"))
    return yield* new CompletionFailed({ message: `Unusable page note: ${note ? "more than one line" : "empty"}` });
  yield* Effect.promise(() =>
    env.DB.prepare("INSERT OR REPLACE INTO page_notes (run_id, page_id, note) VALUES (?, ?, ?)").bind(runId, pageId, note).run(),
  );
});
