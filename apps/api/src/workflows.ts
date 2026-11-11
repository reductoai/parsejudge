import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { decodeJson, JUDGE_VERSION, judgePage } from "@parsejudge/core";
import { Data, Effect } from "effect";
import type { Env } from "./env.ts";
import { StorageFailed, storage } from "./errors.ts";
import { splitToR2 } from "./ingest.ts";
import { documentKey, markdownKey, pageId, pagePdfKey, pagePngKey } from "./keys.ts";
import { writeLocations } from "./locate.ts";
import { writePageNote } from "./note.ts";
import { emailRunDone } from "./notify.ts";
import { renderFirstPagePng } from "./render.ts";
import {
  type Cell,
  runEvents as events,
  finishRun,
  judgePool,
  type Pool,
  pollCell,
  providerPool,
  runStep,
  saveFailure,
  stopPendingPages,
  submitCell,
  summarizeRun,
} from "./run.ts";
import { MAX_POLLS, pollDelayMs } from "./schedule.ts";
import type { ProviderSlots } from "./slots.ts";
import { modelUsage, openAIToken, recordUsage } from "./usage.ts";

export interface RunWorkflowParams {
  readonly runId: string;
  /** Parse these pages again with these presets, re-judge them and re-summarize the run. */
  readonly retry?: { readonly pageIds: ReadonlyArray<string>; readonly presetIds: ReadonlyArray<string> };
}

export interface PageWorkflowParams {
  readonly runId: string;
  readonly pageId: string;
  readonly presetIds: ReadonlyArray<string>;
  /** Presets to parse; defaults to presetIds. The judge still compares every preset that has a parse. */
  readonly parsePresetIds?: ReadonlyArray<string>;
}

const RETRY: WorkflowStepConfig = { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" };
/** The judge is rate limited under load; back off for up to ~40 minutes before giving up on a page. */
const JUDGE_RETRY: WorkflowStepConfig = {
  retries: { limit: 8, delay: "10 seconds", backoff: "exponential" },
  timeout: "5 minutes",
};

/** Steps that must happen for a run to end: reporting a page and recording a run failure. About 85 minutes of retries. */
const MUST: WorkflowStepConfig = { retries: { limit: 10, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" };

const PAGES_TIMEOUT = "6 hours";
/** How long a page waits for a slot wake-up before it asks the pool again, and how many times (24 hours in all). */
const SLOT_WAIT = "5 minutes";
const SLOT_ROUNDS = 288;

/** Instance already exists: a retried fan-out step created it on an earlier attempt. */
const INSTANCE_EXISTS = 10405;

/** Some page workflows were not created; the step retries. */
class StartPagesFailed extends Data.TaggedError("StartPagesFailed")<{ readonly message: string }> {
  readonly retryable = true;
}

/**
 * Starts page workflows. `createBatch` reports per-instance failures in `errors` instead of throwing, so a
 * dropped instance would leave the run waiting for a page that never runs. Fail so the step retries.
 */
const startPages = Effect.fn("startPages")(function* (
  env: Env,
  instances: ReadonlyArray<WorkflowInstanceCreateOptions<PageWorkflowParams>>,
) {
  for (let offset = 0; offset < instances.length; offset += 100) {
    const batch = instances.slice(offset, offset + 100);
    const { errors } = yield* storage(() => env.PAGE_WORKFLOW.createBatch({ instances: batch }));
    const failed = errors.filter((error) => error.code !== INSTANCE_EXISTS);
    if (failed.length > 0) {
      return yield* new StartPagesFailed({
        message: `Could not start ${failed.length} page workflows: ${failed.map((e) => `${e.id} ${e.code} ${e.message}`).join("; ")}`,
      });
    }
  }
});

const slots = (env: Env, pool: string) =>
  env.PROVIDER_SLOTS.get(env.PROVIDER_SLOTS.idFromName(`v2:${pool}`)) as unknown as DurableObjectStub<ProviderSlots>;

/** A workflow step that failed after its retries. */
class StepFailed extends Data.TaggedError("StepFailed")<{ readonly step: string; readonly message: string }> {}
/** The page image could not be rendered, so no preset can run. */
class RenderFailed extends Data.TaggedError("RenderFailed")<{ readonly message: string }> {}
/** `pages-done` did not arrive before the timeout. */
class PagesTimedOut extends Data.TaggedError("PagesTimedOut")<{ readonly message: string }> {}
class NoPages extends Data.TaggedError("NoPages")<{ readonly message: string }> {}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A workflow step (or any promise) as an Effect that fails with `StepFailed`. */
const attempt = <A>(name: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (error) => new StepFailed({ step: name, message: messageOf(error) }) });

/** For steps the run does not depend on: a failure is logged, not thrown. */
const bestEffort = <A>(effect: Effect.Effect<A, StepFailed>, label: string, ...context: ReadonlyArray<unknown>) =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchTag("StepFailed", (error) => Effect.logError(label, ...context, error.step, error.message)),
  );

/** Renders a page's PNG once; later runs reuse it. */
const renderPage = Effect.fn("renderPage")(function* (env: Env, page: string) {
  if ((yield* storage(() => env.BLOBS.head(pagePngKey(page)))) !== null) return;
  const pdf = yield* storage(() => env.BLOBS.get(pagePdfKey(page)));
  if (pdf === null) return yield* new StorageFailed({ message: `Missing page ${page}` });
  const bytes = yield* storage(() => pdf.arrayBuffer());
  const png = yield* renderFirstPagePng(new Uint8Array(bytes));
  yield* storage(() => env.BLOBS.put(pagePngKey(page), png));
  yield* storage(() => env.DB.prepare("UPDATE pages SET rendered = 1 WHERE id = ?").bind(page).run());
});

/** Marks the run running and reads its presets and documents. */
const loadRun = Effect.fn("loadRun")(function* (env: Env, runId: string) {
  yield* storage(() => env.DB.prepare("UPDATE runs SET status = 'running' WHERE id = ?").bind(runId).run());
  const row = yield* storage(() =>
    env.DB.prepare("SELECT preset_ids FROM runs WHERE id = ?").bind(runId).first<{ preset_ids: string }>(),
  );
  const documents = yield* storage(() =>
    env.DB.prepare("SELECT document_id FROM run_documents WHERE run_id = ? ORDER BY document_id")
      .bind(runId)
      .all<{ document_id: string }>(),
  );
  return {
    presetIds: (yield* decodeJson(row?.preset_ids ?? "[]")) as Array<string>,
    documentIds: documents.results.map((d) => d.document_id),
  };
});

/** Re-opens the retried pages and starts a page workflow for each. */
const startRetry = Effect.fn("startRetry")(function* (
  env: Env,
  instanceId: string,
  runId: string,
  retry: NonNullable<RunWorkflowParams["retry"]>,
) {
  const row = yield* storage(() =>
    env.DB.prepare("SELECT preset_ids FROM runs WHERE id = ?").bind(runId).first<{ preset_ids: string }>(),
  );
  yield* storage(() => env.DB.prepare("UPDATE runs SET status = 'running', completed_at = NULL WHERE id = ?").bind(runId).run());
  yield* storage(() => events(env, runId).reopen(instanceId, retry.pageIds));
  const presetIds = (yield* decodeJson(row?.preset_ids ?? "[]")) as Array<string>;
  yield* startPages(
    env,
    retry.pageIds.map((pageId) => ({
      id: `${instanceId}-${pageId}`,
      params: { runId, pageId, presetIds, parsePresetIds: retry.presetIds },
    })),
  );
});

/** Upload already splits the document; this covers an upload whose split did not finish. */
const preparePages = Effect.fn("preparePages")(function* (env: Env, documentId: string) {
  const document = yield* storage(() =>
    env.DB.prepare("SELECT page_count, pdf_key FROM documents WHERE id = ?")
      .bind(documentId)
      .first<{ page_count: number; pdf_key: string | null }>(),
  );
  const count = document?.page_count ?? 0;
  const ids = Array.from({ length: count }, (_, index) => pageId(documentId, index));
  const split = yield* storage(() =>
    env.DB.prepare("SELECT COUNT(*) AS n FROM pages WHERE document_id = ?").bind(documentId).first<{ n: number }>(),
  );
  if (split?.n === count) return ids;
  const pdfKey = document?.pdf_key ?? documentKey(documentId);
  const pdf = yield* storage(() => env.BLOBS.head(pdfKey));
  if (pdf === null) return yield* new StorageFailed({ message: `Missing document ${documentId}` });
  // Large PDFs go through the splitter container, as on upload; the Worker cannot hold them.
  yield* splitToR2(env, documentId, pdfKey, pdf.size, count);
  yield* storage(() =>
    env.DB.batch(
      ids.map((id, index) =>
        env.DB.prepare("INSERT OR IGNORE INTO pages (id, document_id, page_index, rendered) VALUES (?, ?, ?, 0)").bind(
          id,
          documentId,
          index,
        ),
      ),
    ),
  );
  return ids;
});

/** Tells the run's subscribers whether the parse succeeded. */
const reportParse = Effect.fn("reportParse")(function* (env: Env, cell: Cell) {
  const row = yield* storage(() =>
    env.DB.prepare("SELECT status, latency_ms FROM parses WHERE run_id = ? AND page_id = ? AND preset_id = ?")
      .bind(cell.runId, cell.pageId, cell.presetId)
      .first<{ status: string; latency_ms: number | null }>(),
  );
  const ok = row?.status === "succeeded";
  yield* storage(() =>
    events(env, cell.runId).parseDone({
      presetId: cell.presetId,
      pageId: cell.pageId,
      ok,
      latencyMs: ok ? (row?.latency_ms ?? null) : null,
    }),
  );
});

/** Judges the page's succeeded parses together and stores a verdict per preset. */
const judge = Effect.fn("judge")(function* (env: Env, runId: string, page: string) {
  const rows = yield* storage(() =>
    env.DB.prepare("SELECT preset_id FROM parses WHERE run_id = ? AND page_id = ? AND status = 'succeeded'")
      .bind(runId, page)
      .all<{ preset_id: string }>(),
  );
  if (rows.results.length === 0) return;
  const markdownByPreset: Record<string, string> = {};
  for (const { preset_id } of rows.results) {
    const object = yield* storage(() => env.BLOBS.get(markdownKey(runId, page, preset_id)));
    markdownByPreset[preset_id] = object === null ? "" : yield* storage(() => object.text());
  }
  const image = yield* storage(() => env.BLOBS.get(pagePngKey(page)));
  if (image === null) return yield* new StorageFailed({ message: `Missing image for ${page}` });
  const imagePng = new Uint8Array(yield* storage(() => image.arrayBuffer()));
  const startedAt = Date.now();
  const verdicts = yield* judgePage(
    {
      token: openAIToken(env),
      models: [env.JUDGE_MODEL, ...(env.JUDGE_FALLBACK_MODELS ?? "").split(",").map((m) => m.trim())].filter(Boolean),
      reasoningEffort: env.JUDGE_REASONING_EFFORT,
      baseUrl: env.OPENAI_BASE_URL,
      onUsage: (model, usage) =>
        recordUsage(env, {
          kind: "judge",
          name: model,
          runId,
          pageId: page,
          status: "ok",
          latencyMs: Date.now() - startedAt,
          ...modelUsage(model, usage),
        }),
    },
    { pageId: page, imagePng, markdownByPreset },
  );
  yield* storage(() =>
    env.DB.batch(
      verdicts.map((verdict) =>
        env.DB.prepare(
          "INSERT OR REPLACE INTO verdicts (run_id, page_id, preset_id, score, reasoning, errors) VALUES (?, ?, ?, ?, ?, ?)",
        ).bind(runId, page, verdict.presetId, verdict.score, verdict.reasoning, JSON.stringify(verdict.errors)),
      ),
    ),
  );
});

export interface DocumentWorkflowParams {
  readonly documentId: string;
  readonly pageCount: number;
}

/** Started by each upload, so a document's page images are ready before a run starts. */
export class DocumentWorkflow extends WorkflowEntrypoint<Env, DocumentWorkflowParams> {
  override run(event: Readonly<WorkflowEvent<DocumentWorkflowParams>>, step: WorkflowStep) {
    const { documentId, pageCount } = event.payload;
    const env = this.env;
    // One bad page must not stop the rest; its PageWorkflow renders it again and records the failure.
    return Effect.runPromise(
      Effect.forEach(
        Array.from({ length: pageCount }, (_, index) => index),
        (index) => {
          const page = pageId(documentId, index);
          return bestEffort(
            attempt(`render ${index}`, () => step.do(`render ${index}`, RETRY, () => runStep(renderPage(env, page)))),
            "Page render failed",
            page,
          );
        },
        { discard: true },
      ),
    );
  }
}

/**
 * One run: split documents into pages, fan out one PageWorkflow per page, wait for all, then summarize.
 * Every failure ends in `recordFailure`, so the run row always reaches a final status.
 */
export class RunWorkflow extends WorkflowEntrypoint<Env, RunWorkflowParams> {
  override run(event: Readonly<WorkflowEvent<RunWorkflowParams>>, step: WorkflowStep) {
    const { runId, retry } = event.payload;
    const fanOut = retry === undefined ? this.fanOut(runId, step) : this.fanOutRetry(event.instanceId, runId, retry, step);
    return Effect.runPromise(
      fanOut.pipe(
        Effect.andThen(this.waitForPages(runId, step)),
        Effect.andThen(attempt("summarize", () => step.do("summarize", RETRY, () => runStep(summarizeRun(this.env, runId))))),
        Effect.andThen(
          bestEffort(
            attempt("notify done", () => step.do("notify done", () => events(this.env, runId).runDone("succeeded"))),
            "Run done event failed",
            runId,
          ),
        ),
        Effect.catch((error) => this.recordFailure(step, runId, error.message)),
        // A retry re-parses part of a finished run; the owner already got the done email.
        Effect.andThen(
          retry === undefined
            ? bestEffort(
                attempt("email owner", () => step.do("email owner", RETRY, () => runStep(emailRunDone(this.env, runId)))),
                "Run email failed",
                runId,
              )
            : Effect.void,
        ),
      ),
    );
  }

  private fanOut(runId: string, step: WorkflowStep): Effect.Effect<void, StepFailed | NoPages> {
    const env = this.env;
    return Effect.gen(function* () {
      const run = yield* attempt("load run", () => step.do("load run", () => runStep(loadRun(env, runId))));
      const pageIds = (yield* Effect.forEach(
        run.documentIds,
        (documentId) =>
          attempt(`prepare ${documentId}`, () =>
            step.do(`prepare ${documentId}`, RETRY, () => runStep(preparePages(env, documentId))),
          ),
        { concurrency: "unbounded" },
      )).flat();
      // Nothing would ever send `pages-done` for a run without pages.
      if (pageIds.length === 0) return yield* new NoPages({ message: "This run has no pages." });
      yield* attempt("fan out", () =>
        step.do("fan out", RETRY, () =>
          runStep(
            storage(() => events(env, runId).start(runId, pageIds.length)).pipe(
              Effect.andThen(
                startPages(
                  env,
                  pageIds.map((id) => ({ id: `${runId}-${id}`, params: { runId, pageId: id, presetIds: run.presetIds } })),
                ),
              ),
            ),
          ),
        ),
      );
    });
  }

  private fanOutRetry(
    instanceId: string,
    runId: string,
    retry: NonNullable<RunWorkflowParams["retry"]>,
    step: WorkflowStep,
  ): Effect.Effect<void, StepFailed> {
    return attempt("fan out retry", () =>
      step.do("fan out retry", RETRY, () => runStep(startRetry(this.env, instanceId, runId, retry))),
    );
  }

  /** Waits for `pages-done`. On timeout the error says how many pages never reported. */
  private waitForPages(runId: string, step: WorkflowStep): Effect.Effect<void, PagesTimedOut> {
    return attempt("pages done", () => step.waitForEvent("pages done", { type: "pages-done", timeout: PAGES_TIMEOUT })).pipe(
      Effect.asVoid,
      Effect.catchTag("StepFailed", (error) =>
        attempt("count pages", () =>
          step.do("count pages", () =>
            runStep(storage(() => events(this.env, runId).counts()).pipe(Effect.map(({ done, total }) => ({ done, total })))),
          ),
        ).pipe(
          Effect.map(
            ({ done, total }) => `${(total ?? 0) - done} of ${total ?? 0} pages did not finish within ${PAGES_TIMEOUT}.`,
          ),
          Effect.catchTag("StepFailed", () => Effect.succeed(`Pages did not finish within ${PAGES_TIMEOUT}: ${error.message}`)),
          Effect.flatMap((message) => Effect.fail(new PagesTimedOut({ message }))),
        ),
      ),
    );
  }

  /**
   * Marks the run failed with the error. If even that cannot be written, the instance errors with the cause, and
   * Continue can still finish the run.
   */
  private recordFailure(step: WorkflowStep, runId: string, message: string): Effect.Effect<void> {
    return attempt("record failure", () =>
      step.do("record failure", MUST, () => runStep(finishRun(this.env, runId, "failed", message))),
    ).pipe(
      Effect.flatMap((changed) =>
        changed
          ? bestEffort(
              attempt("stop pages", () => step.do("stop pages", RETRY, () => runStep(stopPendingPages(this.env, runId)))),
              "Could not stop pages of failed run",
              runId,
            ).pipe(
              Effect.andThen(
                bestEffort(
                  attempt("notify failed", () => step.do("notify failed", () => events(this.env, runId).runDone("failed"))),
                  "Run failed event failed",
                  runId,
                ),
              ),
            )
          : Effect.void,
      ),
      Effect.orDie,
    );
  }
}

/**
 * One page of one run: render it, parse it with every preset in parallel, then judge the parses together.
 * Every provider call and the judge call hold a slot in their pool, so each pool stays under its limit.
 * Only the render can fail the page; every other failure is recorded per preset. `report` always runs.
 */
export class PageWorkflow extends WorkflowEntrypoint<Env, PageWorkflowParams> {
  override run(event: Readonly<WorkflowEvent<PageWorkflowParams>>, step: WorkflowStep) {
    const { runId, pageId: page, presetIds, parsePresetIds = presetIds } = event.payload;
    const env = this.env;
    const parse = (presetId: string) => this.parse(step, event.instanceId, { runId, pageId: page, presetId });
    const judge = () => this.judgeWithSlot(step, event.instanceId, runId, page);
    const program = Effect.gen(function* () {
      yield* attempt("render", () => step.do("render", RETRY, () => runStep(renderPage(env, page)))).pipe(
        Effect.mapError((error) => new RenderFailed({ message: `Page render failed: ${error.message}` })),
      );
      yield* Effect.forEach(parsePresetIds, parse, { concurrency: "unbounded", discard: true });
      yield* judge();
      yield* Effect.forEach(
        presetIds,
        (presetId) =>
          bestEffort(
            attempt(`locate ${presetId}`, () =>
              step.do(`locate ${presetId}`, RETRY, () => runStep(writeLocations(env, runId, page, presetId))),
            ),
            "Locating errors failed",
            page,
            presetId,
          ),
        { concurrency: "unbounded", discard: true },
      );
      yield* bestEffort(
        attempt("note", () => step.do("note", RETRY, () => runStep(writePageNote(env, runId, page)))),
        "Page note failed",
        page,
      );
    }).pipe(
      // Without a page image nothing can run; record the failure for every preset.
      Effect.catchTag("RenderFailed", (error) =>
        bestEffort(
          attempt("record render failure", () =>
            step.do("record render failure", MUST, () =>
              runStep(
                Effect.forEach(parsePresetIds, (presetId) => saveFailure(env, { runId, pageId: page, presetId }, error.message), {
                  concurrency: "unbounded",
                  discard: true,
                }),
              ),
            ),
          ),
          "Could not record render failure",
          page,
        ),
      ),
      // The run waits for every page, so the page reports whatever happened above.
      Effect.ensuring(
        attempt("report", () => step.do("report", MUST, () => events(env, runId).pageDone(page))).pipe(Effect.orDie),
      ),
    );
    return Effect.runPromise(program);
  }

  /**
   * Runs `body` while holding a slot in `pool`. When the pool is full the workflow sleeps on an
   * event that the pool sends when a slot frees up. `body` gets the time spent waiting for the slot.
   * The slot is released even when acquiring or `body` fails. A failed release is logged, not thrown:
   * the lease expires on its own, and a release error must not turn a finished parse into a failure.
   */
  private withSlot<A, E>(
    step: WorkflowStep,
    instanceId: string,
    label: string,
    pool: Pool,
    body: (queueMs: number) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | StepFailed> {
    const env = this.env;
    const waiter = { lease: `${instanceId}:${label}`, instanceId, event: `slot-${label}` };
    return Effect.gen(function* () {
      const requested = yield* attempt(`acquire ${label}`, () =>
        step.do(`acquire ${label}`, RETRY, () =>
          runStep(
            storage(() => slots(env, pool.name).acquire(pool.limit, waiter)).pipe(
              Effect.map((granted) => ({ granted, at: Date.now() })),
            ),
          ),
        ),
      );
      let grantedAt = requested.at;
      if (!requested.granted) {
        // A lost wake-up must not strand the page: after each timeout, ask the pool again. It answers granted when
        // the slot was given to this waiter, keeps the waiter's place when it is still queued, and re-queues it when
        // it was dropped.
        for (let round = 0; ; round++) {
          const suffix = round === 0 ? "" : ` ${round}`;
          const woken = yield* attempt(`slot ${label}${suffix}`, () =>
            step.waitForEvent(`slot ${label}${suffix}`, { type: waiter.event, timeout: SLOT_WAIT }),
          ).pipe(
            Effect.as(true),
            Effect.catchTag("StepFailed", (error) => (round + 1 < SLOT_ROUNDS ? Effect.succeed(false) : Effect.fail(error))),
          );
          if (woken) break;
          const again = yield* attempt(`reacquire ${label} ${round + 1}`, () =>
            step.do(`reacquire ${label} ${round + 1}`, RETRY, () =>
              runStep(storage(() => slots(env, pool.name).acquire(pool.limit, waiter))),
            ),
          );
          if (again) break;
        }
        grantedAt = yield* attempt(`granted ${label}`, () => step.do(`granted ${label}`, () => Promise.resolve(Date.now())));
      }
      return yield* body(grantedAt - requested.at);
    }).pipe(
      Effect.ensuring(
        bestEffort(
          attempt(`release ${label}`, () =>
            step.do(`release ${label}`, RETRY, () => slots(env, pool.name).release(waiter.lease)),
          ),
          "Slot release failed",
          pool.name,
          waiter.lease,
        ),
      ),
    );
  }

  /** Submit once, then poll with durable sleeps. A failure is recorded, not thrown, so other presets still count. */
  private parse(step: WorkflowStep, instanceId: string, cell: Cell): Effect.Effect<void> {
    const env = this.env;
    const name = cell.presetId;
    const withSlot = (pool: Pool, body: (queueMs: number) => Effect.Effect<void, StepFailed>) =>
      this.withSlot(step, instanceId, name, pool, body);
    const submitAndPoll = (queueMs: number) =>
      Effect.gen(function* () {
        const { job, startedAt } = yield* attempt(`submit ${name}`, () =>
          step.do(`submit ${name}`, RETRY, () =>
            runStep(
              storage(() => events(env, cell.runId).parseStarted(cell.presetId)).pipe(
                Effect.andThen(submitCell(env, cell, queueMs)),
              ),
            ),
          ),
        );
        if (job === null) return;
        for (let poll = 0; poll < MAX_POLLS; poll++) {
          yield* attempt(`wait ${name} ${poll}`, () => step.sleep(`wait ${name} ${poll}`, pollDelayMs(poll)));
          const done = yield* attempt(`poll ${name} ${poll}`, () =>
            step.do(`poll ${name} ${poll}`, RETRY, () => runStep(pollCell(env, cell, job, startedAt, queueMs))),
          );
          if (done) return;
        }
        return yield* new StepFailed({ step: `poll ${name}`, message: "Timed out waiting for the provider" });
      });
    return Effect.gen(function* () {
      const pool = yield* attempt(`pool ${name}`, () => step.do(`pool ${name}`, RETRY, () => runStep(providerPool(env, cell))));
      yield* withSlot(pool, submitAndPoll);
    }).pipe(
      Effect.catchTag("StepFailed", (error) =>
        bestEffort(
          attempt(`record failure ${name}`, () =>
            step.do(`record failure ${name}`, MUST, () => runStep(saveFailure(env, cell, error.message).pipe(Effect.asVoid))),
          ),
          "Could not record parse failure",
          cell.pageId,
          name,
        ),
      ),
      Effect.ensuring(
        bestEffort(
          attempt(`report ${name}`, () => step.do(`report ${name}`, () => runStep(reportParse(env, cell)))),
          "Could not report parse",
          cell.pageId,
          name,
        ),
      ),
    );
  }

  /** Judges the page's parses. A failure is recorded in `judge_failures` and does not block the run. */
  private judgeWithSlot(step: WorkflowStep, instanceId: string, runId: string, page: string): Effect.Effect<void> {
    const env = this.env;
    return judgePool(env).pipe(
      Effect.mapError((error) => new StepFailed({ step: "judge pool", message: error.message })),
      Effect.flatMap((pool) =>
        this.withSlot(step, instanceId, "judge", pool, () =>
          attempt("judge", () => step.do("judge", JUDGE_RETRY, () => runStep(judge(env, runId, page)))),
        ),
      ),
      Effect.catchTag("StepFailed", (error) =>
        bestEffort(
          attempt("record judge failure", () =>
            step.do("record judge failure", MUST, () =>
              runStep(
                storage(() =>
                  env.DB.prepare("INSERT OR REPLACE INTO judge_failures (run_id, page_id, error) VALUES (?, ?, ?)")
                    .bind(runId, page, error.message)
                    .run(),
                ).pipe(Effect.asVoid),
              ),
            ),
          ),
          "Could not record judge failure",
          page,
        ),
      ),
    );
  }
}

export { JUDGE_VERSION };
