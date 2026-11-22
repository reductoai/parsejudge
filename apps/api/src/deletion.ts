import { Effect } from "effect";
import type { Env } from "./env.ts";
import { storage } from "./errors.ts";
import { documentKey, pagePdfKey, pagePngKey, sourceKey } from "./keys.ts";

type Scope = "data" | "report";

const removeKeys = Effect.fn("removeKeys")(function* (blobs: R2Bucket, keys: ReadonlyArray<string>) {
  for (let i = 0; i < keys.length; i += 1000) yield* storage(() => blobs.delete(keys.slice(i, i + 1000)));
});

const removePrefix = Effect.fn("removePrefix")(function* (blobs: R2Bucket, prefix: string) {
  let cursor: string | undefined;
  do {
    const after = cursor;
    const listed = yield* storage(() => blobs.list({ prefix, ...(after === undefined ? {} : { cursor: after }) }));
    yield* removeKeys(
      blobs,
      listed.objects.map((o) => o.key),
    );
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
});

const documentBlobs = Effect.fn("documentBlobs")(function* (env: Env, documentsSql: string, bind: string) {
  const docs = yield* storage(() =>
    env.DB.prepare(`SELECT id, format, source_key, pdf_key FROM documents WHERE id IN (${documentsSql})`)
      .bind(bind)
      .all<{ id: string; format: string; source_key: string | null; pdf_key: string | null }>(),
  );
  const pages = yield* storage(() =>
    env.DB.prepare(`SELECT id FROM pages WHERE document_id IN (${documentsSql})`).bind(bind).all<{ id: string }>(),
  );
  return [
    // Older documents have no recorded keys. A PDF's pdf_key is its source_key; deleting a key twice is harmless.
    ...docs.results.flatMap((d) => [d.source_key ?? sourceKey(d.id, d.format), d.pdf_key ?? documentKey(d.id)]),
    ...pages.results.flatMap((p) => [pagePdfKey(p.id), pagePngKey(p.id)]),
  ];
});

/**
 * Statements that remove documents (selected by `documentsSql`, one `?1` parameter) with their pages and every
 * parse, verdict and run link on those pages. Foreign keys are checked at commit, so the order is free.
 */
const documentStatements = (env: Env, documentsSql: string, bind: string) => {
  const pages = `SELECT id FROM pages WHERE document_id IN (${documentsSql})`;
  return [
    "PRAGMA defer_foreign_keys = on",
    `DELETE FROM verdicts WHERE page_id IN (${pages})`,
    `DELETE FROM parses WHERE page_id IN (${pages})`,
    `DELETE FROM judge_failures WHERE page_id IN (${pages})`,
    `DELETE FROM page_notes WHERE page_id IN (${pages})`,
    `DELETE FROM page_locations WHERE page_id IN (${pages})`,
    `DELETE FROM pages WHERE document_id IN (${documentsSql})`,
    // Documents before run links: `documentsSql` may select through run_documents.
    `DELETE FROM documents WHERE id IN (${documentsSql})`,
    `DELETE FROM run_documents WHERE document_id IN (${documentsSql})`,
  ].map((sql) => (sql.startsWith("PRAGMA") ? env.DB.prepare(sql) : env.DB.prepare(sql).bind(bind)));
};

/** Terminates a workflow instance unless it already ended. An instance that was never created or is gone is fine. */
const terminate = (binding: { get(id: string): Promise<WorkflowInstance> }, id: string) =>
  storage(() => binding.get(id)).pipe(
    Effect.flatMap((instance) =>
      storage(() => instance.status()).pipe(
        Effect.flatMap(({ status }) =>
          status !== "complete" && status !== "errored" && status !== "terminated"
            ? storage(() => instance.terminate())
            : Effect.void,
        ),
      ),
    ),
    // Anything else fails the stop, so a run is never deleted while it still runs.
    Effect.catchIf(
      (error) => error.message.includes("instance.not_found"),
      () => Effect.void,
    ),
  );

/** Stops a queued or running run: terminates its workflow and every page workflow it started, and deletes its keys. */
export const stopRun = Effect.fn("stopRun")(function* (env: Env, runId: string) {
  yield* terminate(env.RUN_WORKFLOW, runId);
  const pages = yield* storage(() =>
    env.DB.prepare("SELECT p.id FROM run_documents rd JOIN pages p ON p.document_id = rd.document_id WHERE rd.run_id = ?")
      .bind(runId)
      .all<{ id: string }>(),
  );
  for (let i = 0; i < pages.results.length; i += 50) {
    yield* Effect.forEach(pages.results.slice(i, i + 50), (p) => terminate(env.PAGE_WORKFLOW, `${runId}-${p.id}`), {
      concurrency: "unbounded",
      discard: true,
    });
  }
  yield* storage(() =>
    env.DB.batch([
      env.DB.prepare(
        "UPDATE runs SET status = 'failed', error = 'Stopped', completed_at = ? WHERE id = ? AND status IN ('queued', 'running')",
      ).bind(Date.now(), runId),
      env.DB.prepare("DELETE FROM run_credentials WHERE run_id = ?").bind(runId),
    ]),
  );
});

/**
 * Deletes a run's documents, page images and parse outputs. With scope "report" the run row and its summary go too;
 * with "data" the summary stays and the run is marked `data_deleted_at`. R2 goes first so a failed call can be retried.
 */
export const deleteRun = Effect.fn("deleteRun")(function* (env: Env, runId: string, scope: Scope) {
  const row = yield* storage(() =>
    env.DB.prepare("SELECT status FROM runs WHERE id = ?").bind(runId).first<{ status: string }>(),
  );
  if (row?.status === "queued" || row?.status === "running") yield* stopRun(env, runId);
  const docs = "SELECT document_id FROM run_documents WHERE run_id = ?1";
  yield* removeKeys(env.BLOBS, yield* documentBlobs(env, docs, runId));
  yield* removePrefix(env.BLOBS, `runs/${runId}/`);
  const run =
    scope === "report"
      ? [
          "DELETE FROM verdicts WHERE run_id = ?1",
          "DELETE FROM parses WHERE run_id = ?1",
          "DELETE FROM judge_failures WHERE run_id = ?1",
          "DELETE FROM page_notes WHERE run_id = ?1",
          "DELETE FROM page_locations WHERE run_id = ?1",
          "DELETE FROM run_credentials WHERE run_id = ?1",
          "DELETE FROM run_documents WHERE run_id = ?1",
          "DELETE FROM runs WHERE id = ?1",
        ]
      : ["UPDATE runs SET data_deleted_at = unixepoch() * 1000 WHERE id = ?1"];
  yield* storage(() =>
    env.DB.batch([...documentStatements(env, docs, runId), ...run.map((sql) => env.DB.prepare(sql).bind(runId))]),
  );
});

/** Stops the user's runs in progress, then deletes every run, report and document they own, then the user. */
export const deleteUser = Effect.fn("deleteUser")(function* (env: Env, userId: string) {
  const runs = yield* storage(() => env.DB.prepare("SELECT id FROM runs WHERE user_id = ?").bind(userId).all<{ id: string }>());
  for (const run of runs.results) yield* deleteRun(env, run.id, "report");
  const docs = "SELECT id FROM documents WHERE user_id = ?1";
  yield* removeKeys(env.BLOBS, yield* documentBlobs(env, docs, userId));
  yield* storage(() =>
    env.DB.batch([
      ...documentStatements(env, docs, userId),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
      env.DB.prepare("DELETE FROM logins WHERE user_id = ?").bind(userId),
      env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId),
    ]),
  );
});

/** Deletes uploads of sign-ins that never completed (still owned by the pending user) made before `before`. */
export const deleteExpiredUploads = Effect.fn("deleteExpiredUploads")(function* (env: Env, before: number) {
  const docs = "SELECT id FROM documents WHERE user_id = 'pending' AND created_at < ?1";
  yield* removeKeys(env.BLOBS, yield* documentBlobs(env, docs, String(before)));
  yield* storage(() => env.DB.batch(documentStatements(env, docs, String(before))));
});

/** How long ZDR documents are kept: runs from their start, uploads that never ran from upload. */
export const ZDR_TTL_MS = 24 * 3_600_000;

/** Hourly: deletes the documents of finished ZDR runs older than a day (results stay), and ZDR uploads never run. */
export const purgeZdr = Effect.fn("purgeZdr")(function* (env: Env, now = Date.now()) {
  const cutoff = now - ZDR_TTL_MS;
  const runs = yield* storage(() =>
    env.DB.prepare(
      `SELECT id FROM runs WHERE zdr = 1 AND data_deleted_at IS NULL AND created_at <= ? AND status IN ('succeeded', 'failed')`,
    )
      .bind(cutoff)
      .all<{ id: string }>(),
  );
  for (const run of runs.results) yield* deleteRun(env, run.id, "data");
  const docs = yield* storage(() =>
    env.DB.prepare(
      "SELECT id FROM documents WHERE zdr = 1 AND created_at <= ? AND id NOT IN (SELECT document_id FROM run_documents)",
    )
      .bind(cutoff)
      .all<{ id: string }>(),
  );
  for (const doc of docs.results) {
    const one = "SELECT ?1";
    yield* removeKeys(env.BLOBS, yield* documentBlobs(env, one, doc.id));
    yield* storage(() => env.DB.batch(documentStatements(env, one, doc.id)));
  }
  return { runs: runs.results.length, documents: docs.results.length };
});
