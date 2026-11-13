import { decodeJson, findPreset, JudgedError, type RunSummary } from "@parsejudge/core";
import { Effect, Schema } from "effect";
import type { Env } from "./env.ts";

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** What a flagged page is mostly about, from the judge's error categories. */
const TOPIC: Partial<Record<JudgedError["category"], string>> = {
  table_structure: "tables",
  table_content: "tables",
  content_omission: "missing content",
  content_hallucination: "invented content",
  text_corruption: "garbled text",
  text_duplication: "duplicated text",
  generation_repetition_loop: "repeated text",
  reading_order: "reading order",
  field_association_error: "form fields",
  checkbox_state_error: "checkboxes",
  header_footer: "headers and footers",
  watermark: "watermarks",
  figure_precision: "figure summaries",
  figure_recall: "figure summaries",
};

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const duration = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
};

interface RunRow {
  readonly title: string | null;
  readonly status: string;
  readonly share_id: string;
  readonly summary: string | null;
  readonly error: string | null;
  readonly visibility: string;
  readonly created_at: number;
  readonly completed_at: number | null;
  readonly email: string;
  readonly notify_on_done: number;
}

const decodeErrors = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Array(JudgedError)));

/** Pages where scores differ by 3 or more, or a parse failed (the report's "flagged" pages), largest gap first. */
const flaggedPages = Effect.fn("flaggedPages")(function* (env: Env, runId: string, presetCount: number) {
  const [{ results: parses }, { results: verdicts }] = yield* Effect.all(
    [
      Effect.promise(() =>
        env.DB.prepare("SELECT page_id, status FROM parses WHERE run_id = ?")
          .bind(runId)
          .all<{ page_id: string; status: string }>(),
      ),
      Effect.promise(() =>
        env.DB.prepare("SELECT page_id, score, errors FROM verdicts WHERE run_id = ?")
          .bind(runId)
          .all<{ page_id: string; score: number; errors: string }>(),
      ),
    ],
    { concurrency: "unbounded" },
  );
  const pages = new Map<string, { scores: Array<number>; failed: number; errors: Array<JudgedError> }>();
  const page = (id: string) => {
    const entry = pages.get(id) ?? { scores: [], failed: 0, errors: [] };
    pages.set(id, entry);
    return entry;
  };
  for (const p of parses) if (p.status === "failed") page(p.page_id).failed++;
  for (const v of verdicts) {
    page(v.page_id).scores.push(v.score);
    const errors = decodeErrors(v.errors);
    if (errors._tag === "Success") page(v.page_id).errors.push(...errors.value);
    else yield* Effect.logError({ event: "notify_bad_verdict_errors", runId, pageId: v.page_id });
  }
  const flagged = [...pages]
    .map(([id, p]) => ({ id, ...p, gap: p.scores.length > 1 ? Math.max(...p.scores) - Math.min(...p.scores) : 0 }))
    .filter((p) => p.gap >= 3 || (presetCount > 0 && p.failed > 0))
    .sort((a, b) => b.gap - a.gap);
  const topics = new Map<string, number>();
  const disagreed = flagged.filter((p) => p.gap >= 3);
  for (const p of disagreed)
    for (const e of p.errors) {
      const topic = TOPIC[e.category];
      if (topic !== undefined) topics.set(topic, (topics.get(topic) ?? 0) + 1);
    }
  const total = [...topics.values()].reduce((a, b) => a + b, 0);
  const [topic, count] = [...topics].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  return { flagged, disagreed: disagreed.length, topic: count * 2 > total ? topic : null };
});

const FONT = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "'Geist Mono','SFMono-Regular',Menlo,Consolas,monospace";
const label =
  "color:#6B6B6B;font-size:11px;font-weight:500;letter-spacing:0.08em;line-height:14px;text-transform:uppercase;padding:0 0 10px";
const cell = "font-size:15px;line-height:18px;padding:12px 0;border-bottom:1px solid #EEEEEE";
const link = "color:#6B6B6B;text-decoration:underline";

/** Emails the run's owner that the report is ready (or that the run failed), unless they turned it off. */
export const emailRunDone = Effect.fn("emailRunDone")(function* (env: Env, runId: string) {
  const row = yield* Effect.promise(() =>
    env.DB.prepare(
      `SELECT r.title, r.status, r.share_id, r.summary, r.error, r.visibility, r.created_at, r.completed_at, u.email, u.notify_on_done
     FROM runs r JOIN users u ON u.id = r.user_id WHERE r.id = ?`,
    )
      .bind(runId)
      .first<RunRow>(),
  );
  if (row === null || row.notify_on_done !== 1 || !row.email.includes("@") || row.email.endsWith(".invalid")) return;
  const counts = yield* Effect.promise(() =>
    env.DB.prepare(
      "SELECT COUNT(*) AS documents, COALESCE(SUM(d.page_count), 0) AS pages FROM run_documents rd JOIN documents d ON d.id = rd.document_id WHERE rd.run_id = ?",
    )
      .bind(runId)
      .first<{ documents: number; pages: number }>(),
  );
  const site = env.PUBLIC_URL.replace(/\/+$/, "");
  const host = site.replace(/^https?:\/\//, "");
  const url = `${site}/r/${row.share_id}`;
  const title = row.title ?? "Untitled run";
  const ok = row.status === "succeeded";
  const summary = row.summary === null ? null : ((yield* decodeJson(row.summary)) as RunSummary);
  const all = (summary?.presets ?? []).map((p) => ({ ...p, preset: findPreset(p.presetId) }));
  const presets = all
    .map(({ preset, ...p }) => {
      if (preset === undefined) return p;
      const name = PROVIDER_NAMES[preset.provider] ?? preset.label;
      const siblings = all.filter((o) => o.preset?.provider === preset.provider).length;
      return { ...p, label: siblings > 1 ? `${name} ${preset.mode}` : name };
    })
    .sort((a, b) => (b.meanScore ?? -1) - (a.meanScore ?? -1));
  const best = presets[0]?.meanScore == null ? null : presets[0];
  const { flagged, disagreed, topic } = yield* flaggedPages(env, runId, presets.length);

  const facts = [
    title,
    plural(counts?.documents ?? 0, "document"),
    plural(counts?.pages ?? 0, "page"),
    ...(row.completed_at === null ? [] : [`finished in ${duration(row.completed_at - row.created_at)}`]),
  ].join(" · ");
  const preview = ok
    ? `${plural(presets.length, "provider")}, ${plural(counts?.pages ?? 0, "page")}.${
        best === null ? "" : ` ${best.label} scored highest at ${best.meanScore?.toFixed(1)} out of 10.`
      }`
    : `The run failed: ${row.error ?? "unknown error"}`;
  const notes = ok
    ? [
        disagreed === 0
          ? "The providers scored within 3 points of each other on every page."
          : `The providers disagreed by 3 points or more on ${plural(disagreed, "page")}${topic === null ? "" : `, mostly on ${topic}`}.`,
        ...presets
          .filter((p) => p.failedPages > 0)
          .map((p) => `${p.failedPages === 1 ? "One page" : `${p.failedPages} pages`} failed for ${p.label}.`),
      ].join(" ")
    : `The run failed: ${row.error ?? "unknown error"}`;
  const firstFlagged = flagged[0];
  const flaggedUrl = firstFlagged === undefined ? null : `${url}/p/${firstFlagged.id}`;
  const mcp = `claude mcp add --transport http parsejudge ${site}/mcp`;
  const who =
    row.visibility === "private"
      ? `Only you can open this report: ${host}/r/${row.share_id}.`
      : `Anyone with the link can view this report: ${host}/r/${row.share_id}.`;

  const text = [
    ok ? "Your report is ready." : "Your run failed.",
    facts,
    "",
    ...(ok
      ? presets.map(
          (p) =>
            `${p.label}: ${p.meanScore?.toFixed(1) ?? "–"} mean score, ${p.highSeverityRate === null ? "–" : `${Math.round(p.highSeverityRate * 100)}%`} of pages high-severity`,
        )
      : []),
    ...(ok ? [""] : []),
    notes,
    "",
    `View the report: ${url}`,
    ...(ok && flaggedUrl !== null ? [`See the ${plural(flagged.length, "flagged page")}: ${flaggedUrl}`] : []),
    "",
    `Ask your agent about this run: ${mcp}`,
    "",
    `${who} Change who can open it or delete the run from the report page.`,
    `You're getting this because you started this run. Turn off run emails: ${site}/account`,
  ].join("\n");

  const rows = presets
    .map(
      (p, i) =>
        `<tr><td style="${cell};color:#0A0A0A">${escapeHtml(p.label)}</td><td style="${cell};width:110px;text-align:right;color:${
          i === 0 && p.meanScore !== null ? "#1D3FD8" : "#0A0A0A"
        }">${p.meanScore?.toFixed(1) ?? "–"}</td><td style="${cell};width:130px;text-align:right;color:#6B6B6B">${
          p.highSeverityRate === null ? "–" : `${Math.round(p.highSeverityRate * 100)}% of pages`
        }</td></tr>`,
    )
    .join("");
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>@media (max-width:480px){.pad{padding-left:24px!important;padding-right:24px!important}.outer{padding:24px 8px!important}}</style></head><body style="margin:0;padding:0;background:#F2F2F2">
<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F2F2;font-family:${FONT};-webkit-font-smoothing:antialiased"><tr><td align="center" class="outer" style="padding:64px 16px">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;background:#FFFFFF;border:1px solid #E7E7E7;border-radius:6px;border-collapse:separate">
<tr><td class="pad" style="padding:48px 48px 40px">
<div style="color:#0A0A0A;font-size:15px;font-weight:500;line-height:18px">Parse Judge</div>
<div style="color:#0A0A0A;font-size:36px;font-weight:300;letter-spacing:-0.03em;line-height:42px;padding-top:32px">${ok ? "Your report is ready." : "Your run failed."}</div>
<div style="color:#6B6B6B;font-size:15px;line-height:24px;padding-top:12px">${escapeHtml(facts)}</div>
${
  ok && rows !== ""
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:32px;border-collapse:collapse"><tr><td style="${label};border-bottom:1px solid #0A0A0A">Provider</td><td style="${label};border-bottom:1px solid #0A0A0A;width:110px;text-align:right">Mean score</td><td style="${label};border-bottom:1px solid #0A0A0A;width:130px;text-align:right">High-severity</td></tr>${rows}</table>`
    : ""
}
<div style="color:#0A0A0A;font-size:15px;line-height:24px;padding-top:32px">${escapeHtml(notes)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:32px"><tr>
<td style="background:#0A0A0A;border-radius:4px"><a href="${escapeHtml(url)}" style="display:inline-block;padding:14px 24px;color:#FFFFFF;font-size:15px;font-weight:500;line-height:18px;text-decoration:none;white-space:nowrap">${ok ? "View the report" : "Open the run"}</a></td>
${
  ok && flaggedUrl !== null
    ? `<td style="padding-left:20px"><a href="${escapeHtml(flaggedUrl)}" style="color:#0A0A0A;font-size:14px;line-height:18px;text-decoration:underline">See the ${plural(flagged.length, "flagged page")}</a></td>`
    : ""
}
</tr></table>
</td></tr>
<tr><td class="pad" style="border-top:1px solid #EEEEEE;padding:24px 48px">
<div style="color:#0A0A0A;font-size:14px;line-height:18px">Ask your agent about this run</div>
<div style="background:#F7F7F7;border-radius:4px;padding:10px 12px;margin-top:8px;color:#0A0A0A;font-family:${MONO};font-size:12px;line-height:16px">${escapeHtml(mcp)}</div>
</td></tr>
<tr><td class="pad" style="background:#FAFAFA;border-top:1px solid #EEEEEE;border-radius:0 0 6px 6px;padding:24px 48px 36px;color:#6B6B6B;font-size:12px;line-height:18px">
<div>${escapeHtml(who)} Change who can open it or delete the run from the report page.</div>
<div style="padding-top:8px">You're getting this because you started this run. <a href="${escapeHtml(`${site}/account`)}" style="${link}">Turn off run emails</a> · Open source on <a href="https://github.com/reductoai/parsejudge" style="${link}">GitHub</a></div>
</td></tr>
</table></td></tr></table></body></html>`;

  yield* Effect.promise(() =>
    env.EMAIL.send({
      from: { name: "Parse Judge", email: env.EMAIL_FROM },
      to: row.email,
      subject: ok ? `Your report is ready: ${title}` : `Your run failed: ${title}`,
      text,
      html,
    }),
  );
});
