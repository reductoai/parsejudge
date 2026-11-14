import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { adapterFor, DEFAULT_PRESET_IDS, PRESETS } from "@parsejudge/core";
import { Cause, Data, Duration, Effect } from "effect";
import { FetchHttpClient, HttpClient, type HttpClientError } from "effect/http";
import * as z from "zod";
import { handler } from "./api.ts";
import { type Env, envError } from "./env.ts";
import { INTERNAL_HEADER, internalHeader } from "./internal.ts";
import { type AgentProps, listAgents, revokeAgents } from "./oauth.ts";
import { countErrors, flattenErrors, type PageRow, paginate, type RunErrorRow, selectPages } from "./results.ts";
import { signedUploadUrl } from "./uploads.ts";

const MAX_FETCH_BYTES = 100 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 120_000;

const INSTRUCTIONS = `ParseJudge compares document parsers on your documents. A blind judge model scores each parser's output on every page.

To evaluate local files:
1. Call create_upload_url. Upload the files with the curl command it returns: one command uploads many files in parallel, and every file goes into the same upload.
   Files on the web: call upload_from_url instead.
2. Call start_run with the uploadId. It runs every file the upload received; list_uploaded_files shows them first. Leave presetIds out to run the default hosted parsers (free).
   Parsers that are not hosted need your own key: pass it in credentials (see list_providers for the key names).
3. Call get_run until status is "succeeded" or "failed". The run's owner also gets an email when it finishes, unless they turned that off.
4. Read the results with get_run (summary), list_errors (every judge error in the run, filterable), list_pages and get_page. Share the reportUrl.
Errors come back as JSON: {"error": "...", "status": 500}. start_run with an idempotencyKey is safe to retry.`;

type Json = Record<string, unknown>;

/** A failure the tool reports to the agent as `{ error, status }`. */
class ApiError extends Data.TaggedError("ApiError")<{ readonly message: string; readonly status?: number }> {}

const describeStatus = (status: number) =>
  status === 404
    ? "Not found, or you can't open it."
    : status === 401
      ? "Your account no longer exists, or this connection was revoked."
      : status === 400
        ? "The request was rejected. Check the ids, that the documents are yours and not deleted, and the 1,000-page limit per run."
        : status >= 500
          ? `ParseJudge failed with HTTP ${status}, an error on our side. Retry; to be sure no run is created twice, pass the same idempotencyKey, or check list_runs first.`
          : `ParseJudge returned HTTP ${status}.`;

const ok = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const fail = (error: string, status?: number) => ({
  isError: true,
  content: [{ type: "text" as const, text: JSON.stringify(status === undefined ? { error } : { error, status }) }],
});

/** An MCP tool callback: the SDK needs a Promise, so the tool's Effect runs here. */
const tool =
  <A, E>(run: (args: A) => Effect.Effect<unknown, E, HttpClient.HttpClient>) =>
  (args: A) =>
    Effect.runPromise(
      run(args).pipe(
        Effect.map(ok),
        Effect.catchCause((cause) => {
          const error = Cause.squash(cause);
          if (error instanceof ApiError) return Effect.succeed(fail(error.message, error.status));
          return Effect.logError("MCP tool failed", error).pipe(
            Effect.as(fail(`ParseJudge failed: ${error instanceof Error ? error.message : String(error)}`, 500)),
          );
        }),
        Effect.provide(FetchHttpClient.layer),
      ),
    );

const buildServer = (env: Env, userId: string, oauth: OAuthHelpers) => {
  const base = env.PUBLIC_URL.replace(/\/+$/, "");
  const call = Effect.fn("call")(function* (method: string, path: string, body?: unknown) {
    const headers = new Headers({ [INTERNAL_HEADER]: internalHeader(userId) });
    let payload: BodyInit | null = null;
    if (body instanceof ArrayBuffer) {
      payload = body;
      headers.set("content-type", "application/octet-stream");
      // A Request does not get a content-length header from its body; the upload handler needs one.
      headers.set("content-length", String(body.byteLength));
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers.set("content-type", "application/json");
    }
    const response = yield* Effect.promise(() => handler(new Request(`${base}${path}`, { method, headers, body: payload })));
    if (!response.ok) return yield* new ApiError({ message: describeStatus(response.status), status: response.status });
    return response.status === 204 ? null : ((yield* Effect.promise(() => response.json())) as Json);
  });
  const reportUrl = (shareId: unknown) => `${base}/r/${String(shareId)}`;

  /** A run by id, share id, or report URL. */
  const findRun = (ref: string) => {
    const key = /\/r\/([^/?#]+)/.exec(ref)?.[1] ?? ref.trim();
    return call("GET", `/v1/runs/${encodeURIComponent(key)}`).pipe(
      Effect.catchIf(
        (error) => error.status === 404,
        () => call("GET", `/v1/share/${encodeURIComponent(key)}`),
      ),
      Effect.map((run): Json => run ?? {}),
    );
  };

  /** Downloads a public http(s) file and uploads it like a browser upload. */
  const uploadFromUrl = Effect.fn("uploadFromUrl")(function* (url: string, filename: string | undefined) {
    const source = new URL(url);
    if (source.protocol !== "https:" && source.protocol !== "http:") {
      return yield* new ApiError({ message: "Only http and https URLs work." });
    }
    const bytes = yield* HttpClient.get(source.href).pipe(
      Effect.flatMap(
        (response): Effect.Effect<ArrayBuffer, ApiError | HttpClientError.HttpClientError> =>
          response.status < 200 || response.status >= 300
            ? Effect.fail(new ApiError({ message: `Downloading the file returned HTTP ${response.status}.` }))
            : Number(response.headers["content-length"] ?? 0) > MAX_FETCH_BYTES
              ? Effect.fail(new ApiError({ message: "The file is over 100 MB." }))
              : response.arrayBuffer,
      ),
      Effect.timeoutOrElse({
        duration: Duration.millis(FETCH_TIMEOUT_MS),
        orElse: () => Effect.fail(new ApiError({ message: `Downloading the file took over ${FETCH_TIMEOUT_MS / 1000} s.` })),
      }),
      Effect.mapError((error) =>
        error._tag === "ApiError" ? error : new ApiError({ message: `Could not download the file: ${error.message}` }),
      ),
    );
    if (bytes.byteLength > MAX_FETCH_BYTES) return yield* new ApiError({ message: "The file is over 100 MB." });
    const last = source.pathname.split("/").pop() ?? "";
    const name =
      filename ?? ((yield* Effect.try(() => decodeURIComponent(last)).pipe(Effect.orElseSucceed(() => last))) || "document");
    return yield* call("POST", `/v1/documents?filename=${encodeURIComponent(name)}`, bytes);
  });

  const server = new McpServer({ name: "parsejudge", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  const read = { readOnlyHint: true, openWorldHint: false };
  const runRef = z.string().describe("Run id, share id, or report URL (https://parsejudge.com/r/...)");

  server.registerTool(
    "list_providers",
    {
      description:
        "Parser presets you can run. hosted=true runs free on ParseJudge's keys; the others need your own key, passed to start_run as credentials[provider][key] for each name in credentialKeys. default=true is in the default set.",
      annotations: read,
    },
    tool(() =>
      Effect.succeed(
        PRESETS.map((preset) => ({
          id: preset.id,
          provider: preset.provider,
          label: preset.label,
          mode: preset.mode,
          listPriceUsdPer1kPages: Math.round(preset.listPriceUsdPerPage * 1000 * 100) / 100,
          hosted: preset.hosted,
          default: DEFAULT_PRESET_IDS.includes(preset.id),
          credentialKeys: preset.hosted ? [] : adapterFor(preset.provider).credentialKeys,
        })),
      ),
    ),
  );

  server.registerTool(
    "create_upload_url",
    {
      description:
        "A URL for uploading local files, valid for 1 hour and for any number of files. PUT each file's raw bytes to <url>/<file name>; the response has the commands. Files can go up in parallel. Accepts PDF, images, DOCX, PPTX and XLSX. Every file is tagged with the uploadId: pass it to start_run to run all of them, without tracking document ids.",
    },
    tool(() =>
      signedUploadUrl(env, userId).pipe(
        Effect.map(({ url, uploadId, expiresAt }) => ({
          uploadId,
          url: `${url}/`,
          method: "PUT",
          expiresAt: new Date(expiresAt).toISOString(),
          uploadFiles: `curl -sS --fail-with-body --parallel --parallel-max 16 -T "{a.pdf,b.docx}" "${url}/"`,
          uploadFolder: `find ./docs -type f -print0 | xargs -0 -P 16 -I{} curl -sS --fail-with-body -T {} "${url}/"`,
          notes:
            'curl -T with a URL ending in "/" adds the file name to the URL. Each response is {documentId, pageCount}, or {filename, error} for a file that could not be read.',
          next: `Call start_run with uploadId "${uploadId}".`,
        })),
      ),
    ),
  );

  server.registerTool(
    "list_uploaded_files",
    {
      description: "The files an upload URL from create_upload_url has received so far, oldest first.",
      inputSchema: { uploadId: z.string() },
      annotations: read,
    },
    tool(({ uploadId }: { uploadId: string }) =>
      call("GET", `/v1/documents?upload=${encodeURIComponent(uploadId)}`).pipe(
        Effect.map((body) => {
          const files = (body ?? []) as unknown as Array<{ pageCount: number }>;
          return { uploadId, files: files.length, pages: files.reduce((n, f) => n + f.pageCount, 0), documents: files };
        }),
      ),
    ),
  );

  server.registerTool(
    "upload_from_url",
    {
      description:
        "Download a document from a public http(s) URL into your account. Returns {documentId, pageCount} for start_run.",
      inputSchema: {
        url: z.string().url(),
        filename: z.string().optional().describe("Name to show in reports. Defaults to the last part of the URL path."),
      },
    },
    tool(({ url, filename }: { url: string; filename?: string | undefined }) => uploadFromUrl(url, filename)),
  );

  server.registerTool(
    "suggest_title",
    {
      description: "A short run title from file names, the same one the app suggests.",
      inputSchema: { filenames: z.array(z.string()).min(1) },
      annotations: read,
    },
    tool(({ filenames }: { filenames: Array<string> }) => call("POST", "/v1/titles", { filenames })),
  );

  const credentials = z
    .record(z.string(), z.record(z.string(), z.string()))
    .optional()
    .describe(
      'Your own keys by provider, e.g. {"llamaparse": {"LLAMA_CLOUD_API_KEY": "llx-..."}}. Stored encrypted with this run only.',
    );

  const uploadedIds = Effect.fn("uploadedIds")(function* (uploadId: string) {
    const files = ((yield* call("GET", `/v1/documents?upload=${encodeURIComponent(uploadId)}`)) ?? []) as unknown as Array<{
      documentId: string;
    }>;
    if (files.length === 0) return yield* new ApiError({ message: `Upload ${uploadId} has no files yet.` });
    return files.map((f) => f.documentId);
  });

  const startRun = Effect.fn("startRun")(function* (args: {
    documentIds: ReadonlyArray<string>;
    presetIds?: ReadonlyArray<string> | undefined;
    title?: string | undefined;
    credentials?: Record<string, Record<string, string>> | undefined;
    idempotencyKey?: string | undefined;
  }) {
    for (const id of args.presetIds ?? []) {
      const preset = PRESETS.find((p) => p.id === id);
      if (preset === undefined) return yield* new ApiError({ message: `Unknown preset ${id}. Call list_providers for the ids.` });
      if (preset.hosted) continue;
      const missing = adapterFor(preset.provider).credentialKeys.filter((key) => !args.credentials?.[preset.provider]?.[key]);
      if (missing.length > 0) {
        return yield* new ApiError({ message: `${preset.label} needs credentials.${preset.provider}: ${missing.join(", ")}.` });
      }
    }
    const created = yield* call("POST", "/v1/runs", {
      documentIds: args.documentIds,
      ...(args.presetIds === undefined ? {} : { presetIds: args.presetIds }),
      ...(args.title === undefined ? {} : { title: args.title }),
      ...(args.idempotencyKey === undefined ? {} : { idempotencyKey: args.idempotencyKey }),
      credentials: args.credentials ?? {},
    });
    return { ...created, reportUrl: reportUrl(created?.shareId), next: "Call get_run with the runId to follow progress." };
  });

  server.registerTool(
    "start_run",
    {
      description:
        "Start an evaluation. Pass uploadId to run every file sent to that upload URL, or documentIds, or both. Up to 1,000 pages per run. Without presetIds it runs the default hosted parsers. Returns runId and the report URL.",
      inputSchema: {
        uploadId: z.string().optional().describe("From create_upload_url: runs every file that upload received."),
        documentIds: z.array(z.string()).optional().describe("From upload_from_url or earlier uploads."),
        presetIds: z.array(z.string()).min(1).optional().describe("Preset ids from list_providers."),
        title: z.string().max(80).optional().describe("Run title. Without one, a title is made from the file names."),
        idempotencyKey: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Any unique string. A retry with the same key returns the run the first call created instead of a new one."),
        credentials,
      },
    },
    tool(
      Effect.fn("start_run")(function* ({
        uploadId,
        documentIds,
        ...rest
      }: Omit<Parameters<typeof startRun>[0], "documentIds"> & {
        uploadId?: string | undefined;
        documentIds?: Array<string> | undefined;
      }) {
        const ids = [...new Set([...(uploadId === undefined ? [] : yield* uploadedIds(uploadId)), ...(documentIds ?? [])])];
        if (ids.length === 0) return yield* new ApiError({ message: "Pass uploadId or documentIds." });
        return yield* startRun({ ...rest, documentIds: ids });
      }),
    ),
  );

  server.registerTool(
    "list_runs",
    {
      description: "Your runs, newest first, with status, progress, top preset and who can open the report.",
      inputSchema: { search: z.string().optional().describe("Only runs whose title contains this text.") },
      annotations: read,
    },
    tool(({ search }: { search?: string | undefined }) =>
      call("GET", "/v1/runs").pipe(
        Effect.map((body) =>
          ((body ?? []) as unknown as Array<Json>)
            .filter(
              (row) =>
                search === undefined ||
                String(row.title ?? "")
                  .toLowerCase()
                  .includes(search.toLowerCase()),
            )
            .map((row) => ({ ...row, reportUrl: reportUrl(row.shareId) })),
        ),
      ),
    ),
  );

  server.registerTool(
    "get_run",
    {
      description:
        "A run's status, progress and, once it succeeded, the summary: per preset mean and median score (0-10), high-severity error rate, error counts, failed pages, list price, observed cost, latency, head-to-head wins/ties/losses and the price-accuracy Pareto frontier. Works for your runs and for reports shared by link. The documents list (id, filename, pages) is left out unless includeDocuments is true.",
      inputSchema: {
        run: runRef,
        includeDocuments: z.boolean().default(false),
        includeSummary: z.boolean().default(true),
      },
      annotations: read,
    },
    tool(
      Effect.fn("get_run")(function* ({
        run: ref,
        includeDocuments,
        includeSummary,
      }: {
        run: string;
        includeDocuments: boolean;
        includeSummary: boolean;
      }) {
        const run = yield* findRun(ref);
        const documents = run.documents as Array<{ id: string; filename: string; pages: Array<unknown> }>;
        const scores = run.scores as Array<{ status: string }>;
        const pages = documents.reduce((n, d) => n + d.pages.length, 0);
        return {
          id: run.owned === true ? run.id : undefined,
          shareId: run.shareId,
          reportUrl: reportUrl(run.shareId),
          title: run.title,
          status: run.status,
          error: run.error,
          owned: run.owned,
          visibility: run.visibility,
          shareContent: run.shareContent,
          presetIds: run.presetIds,
          judge: { version: run.judgeVersion, model: run.judgeModel },
          documentCount: run.documentCount,
          pageCount: run.pageCount,
          documents: includeDocuments
            ? documents.map((d) => ({ id: d.id, filename: d.filename, pages: d.pages.length }))
            : undefined,
          progress: { pages, parsesDone: scores.length, parsesTotal: pages * (run.presetIds as Array<string>).length },
          summary: includeSummary ? run.summary : undefined,
          createdAt: run.createdAt,
          completedAt: run.completedAt,
          dataDeletedAt: run.dataDeletedAt,
        };
      }),
    ),
  );

  server.registerTool(
    "list_pages",
    {
      description:
        "Pages of a run with each preset's score, the gap between best and worst score, and (flagged pages) a one-sentence note on how the parsers differ. Filter by presetId and maxScore to find where one parser lost points. Paginated: pass nextCursor back as cursor. For the judge's errors across the run use list_errors; for one page's outputs use get_page.",
      inputSchema: {
        run: runRef,
        filter: z
          .enum(["all", "flagged", "high"])
          .default("all")
          .describe("flagged: pages with a note. high: any high-severity error."),
        presetId: z.string().optional().describe("Only this preset's scores, and only pages it has a score on."),
        maxScore: z
          .number()
          .min(1)
          .max(10)
          .optional()
          .describe("Only pages where the preset (or any preset) scored at most this."),
        sort: z.enum(["document", "gap", "score"]).default("document").describe("score: lowest first."),
        compact: z
          .boolean()
          .default(true)
          .describe(
            'true: scores only, as {presetId: score or "failed"}. false: also status, high-severity count, note and URL.',
          ),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(500).default(50),
      },
      annotations: read,
    },
    tool(
      Effect.fn("list_pages")(function* (args: {
        run: string;
        filter: "all" | "flagged" | "high";
        presetId?: string | undefined;
        maxScore?: number | undefined;
        sort: "document" | "gap" | "score";
        compact: boolean;
        cursor?: string | undefined;
        limit: number;
      }) {
        const run = yield* findRun(args.run);
        const scores = run.scores as Array<{
          pageId: string;
          presetId: string;
          status: string;
          score: number | null;
          high: number;
        }>;
        const byPage = new Map<string, typeof scores>();
        for (const s of scores) byPage.set(s.pageId, [...(byPage.get(s.pageId) ?? []), s]);
        const documents = run.documents as Array<{
          filename: string;
          pages: Array<{ id: string; index: number; note: string | null }>;
        }>;
        const rows: Array<PageRow> = documents.flatMap((d) =>
          d.pages.map((page) => {
            const parses = byPage.get(page.id) ?? [];
            const scored = parses.flatMap((p) => (p.score === null ? [] : [p.score]));
            return {
              pageId: page.id,
              document: d.filename,
              page: page.index + 1,
              note: page.note,
              gap: scored.length > 1 ? Math.max(...scored) - Math.min(...scored) : null,
              scores: parses.map((p) => ({ presetId: p.presetId, status: p.status, score: p.score, high: p.high })),
            };
          }),
        );
        const { total, items, nextCursor } = paginate(selectPages(rows, args), args.cursor, args.limit);
        const shown = (row: PageRow) =>
          args.presetId === undefined ? row.scores : row.scores.filter((s) => s.presetId === args.presetId);
        return {
          total,
          nextCursor,
          pages: items.map((row) =>
            args.compact
              ? {
                  pageId: row.pageId,
                  document: row.document,
                  page: row.page,
                  gap: row.gap,
                  scores: Object.fromEntries(shown(row).map((s) => [s.presetId, s.status === "succeeded" ? s.score : "failed"])),
                }
              : {
                  ...row,
                  scores: Object.fromEntries(
                    shown(row).map((s) => [s.presetId, { status: s.status, score: s.score, high: s.high }]),
                  ),
                  url: `${reportUrl(run.shareId)}/p/${row.pageId}`,
                },
          ),
        };
      }),
    ),
  );

  server.registerTool(
    "list_errors",
    {
      description:
        "Every error the judge found in a run, one entry each, most severe first and then lowest score: preset, file, page, score, severity, category, description, and the excerpts of the parser's output it is about. Filter by presets, severities and categories. counts gives totals per preset over the whole filtered set. Paginated: pass nextCursor back as cursor.",
      inputSchema: {
        run: runRef,
        presetIds: z.array(z.string()).optional().describe("Only these presets."),
        severities: z.array(z.enum(["high", "figure_error", "medium", "low"])).optional(),
        categories: z
          .array(z.string())
          .optional()
          .describe(
            "e.g. content_omission, text_corruption, table_structure, reading_order. See errorCounts in get_run's summary.",
          ),
        includeReasoning: z.boolean().default(false).describe("Add the judge's reasoning for each error's parse."),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: read,
    },
    tool(
      Effect.fn("list_errors")(function* (args: {
        run: string;
        presetIds?: Array<string> | undefined;
        severities?: Array<string> | undefined;
        categories?: Array<string> | undefined;
        includeReasoning: boolean;
        cursor?: string | undefined;
        limit: number;
      }) {
        const run = yield* findRun(args.run);
        const rows = ((yield* call("GET", `/v1/runs/${encodeURIComponent(String(run.id))}/errors`)) ??
          []) as unknown as Array<RunErrorRow>;
        const errors = flattenErrors(rows, args);
        const { total, items, nextCursor } = paginate(errors, args.cursor, args.limit);
        const reasoning = new Map(rows.map((r) => [`${r.pageId}:${r.presetId}`, r.reasoning]));
        return {
          total,
          nextCursor,
          counts: countErrors(errors),
          errors: items.map((e) => (args.includeReasoning ? { ...e, reasoning: reasoning.get(`${e.pageId}:${e.presetId}`) } : e)),
        };
      }),
    ),
  );

  server.registerTool(
    "get_page",
    {
      description:
        "One page of a run: the page image URL (expires in 1 hour), and for each preset its status, latency, Markdown output, judge score, reasoning and errors (category, severity, description, and the excerpts of the output each error is about).",
      inputSchema: {
        run: runRef,
        pageId: z.string(),
        presetIds: z.array(z.string()).optional().describe("Only these presets."),
        includeMarkdown: z.boolean().default(true),
      },
      annotations: read,
    },
    tool(
      Effect.fn("get_page")(function* (args: {
        run: string;
        pageId: string;
        presetIds?: Array<string> | undefined;
        includeMarkdown: boolean;
      }) {
        const run = yield* findRun(args.run);
        const page = yield* call(
          "GET",
          `/v1/runs/${encodeURIComponent(String(run.id))}/pages/${encodeURIComponent(args.pageId)}`,
        );
        const parses = ((page?.parses ?? []) as Array<Json>)
          .filter((p) => args.presetIds === undefined || args.presetIds.includes(String(p.presetId)))
          .map((p) => (args.includeMarkdown ? p : { ...p, markdown: undefined }));
        return { ...page, parses, url: `${reportUrl(run.shareId)}/p/${args.pageId}` };
      }),
    ),
  );

  server.registerTool(
    "rename_run",
    { description: "Rename one of your runs.", inputSchema: { runId: z.string(), title: z.string().min(1).max(80) } },
    tool(({ runId, title }: { runId: string; title: string }) =>
      call("PATCH", `/v1/runs/${encodeURIComponent(runId)}`, { title }).pipe(Effect.as({ runId, title })),
    ),
  );

  server.registerTool(
    "set_sharing",
    {
      description:
        'Who can open a run\'s report: "link" (anyone with the report URL, no sign-in) or "private" (only you). shareContent false gives link viewers only the scores, latency and cost: no documents, page images or parser output. Omitted fields stay as they are.',
      inputSchema: {
        runId: z.string(),
        visibility: z.enum(["link", "private"]).optional(),
        shareContent: z.boolean().optional(),
      },
    },
    tool(
      ({
        runId,
        visibility,
        shareContent,
      }: {
        runId: string;
        visibility?: "link" | "private" | undefined;
        shareContent?: boolean | undefined;
      }) =>
        call("PATCH", `/v1/runs/${encodeURIComponent(runId)}`, { visibility, shareContent }).pipe(
          Effect.as({ runId, visibility, shareContent }),
        ),
    ),
  );

  server.registerTool(
    "rotate_share_link",
    {
      description: "Give a run a new report URL. The old URL stops working.",
      inputSchema: { runId: z.string() },
      annotations: { destructiveHint: true },
    },
    tool(({ runId }: { runId: string }) =>
      call("POST", `/v1/runs/${encodeURIComponent(runId)}/share-link`).pipe(
        Effect.map((rotated) => ({ runId, shareId: rotated?.shareId, reportUrl: reportUrl(rotated?.shareId) })),
      ),
    ),
  );

  server.registerTool(
    "delete_run",
    {
      description:
        'Delete one of your runs. scope "data" deletes the documents, page images and parser outputs and keeps the summary; "report" deletes the report too. A run in progress is stopped first. Cannot be undone.',
      inputSchema: { runId: z.string(), scope: z.enum(["data", "report"]) },
      annotations: { destructiveHint: true },
    },
    tool(({ runId, scope }: { runId: string; scope: "data" | "report" }) =>
      call("DELETE", `/v1/runs/${encodeURIComponent(runId)}?scope=${scope}`).pipe(Effect.as({ runId, deleted: scope })),
    ),
  );

  server.registerTool(
    "get_account",
    { description: "Your email and whether you get an email when a run finishes.", annotations: read },
    tool(() => call("GET", "/v1/account")),
  );

  server.registerTool(
    "update_account",
    {
      description: "Turn the email sent when a run finishes on or off.",
      inputSchema: { notifyOnDone: z.boolean() },
    },
    tool(({ notifyOnDone }: { notifyOnDone: boolean }) => call("PATCH", "/v1/account", { notifyOnDone })),
  );

  server.registerTool(
    "list_connected_agents",
    { description: "Apps and agents connected to your account, including this one.", annotations: read },
    tool(() => listAgents(oauth, userId)),
  );

  server.registerTool(
    "disconnect_agent",
    {
      description: "Revoke a connected agent's access. Disconnecting this agent ends this connection.",
      inputSchema: { agentId: z.string().describe("id from list_connected_agents") },
      annotations: { destructiveHint: true },
    },
    tool(({ agentId }: { agentId: string }) =>
      Effect.promise(() => oauth.revokeGrant(agentId, userId)).pipe(Effect.as({ disconnected: agentId })),
    ),
  );

  server.registerTool(
    "delete_all_data",
    {
      description:
        'Delete your account and everything in it: all runs (in-progress runs are stopped first), documents, reports and share links, and disconnect every agent. Cannot be undone. Pass confirm: "delete my data".',
      inputSchema: { confirm: z.literal("delete my data") },
      annotations: { destructiveHint: true },
    },
    tool(() =>
      call("DELETE", "/v1/account").pipe(
        Effect.andThen(
          revokeAgents(oauth, userId).pipe(
            Effect.catch((error) =>
              Effect.logError({ event: "mcp_revoke_after_delete_failed", error: String(error) }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new ApiError({
                      message: "Your data is deleted, but disconnecting your agents failed. Their access no longer works.",
                      status: 500,
                    }),
                  ),
                ),
              ),
            ),
          ),
        ),
        Effect.as({ deleted: true }),
      ),
    ),
  );

  return server;
};

const jsonRpcError = (status: number, code: number, message: string) =>
  Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status });

const serve = Effect.fn("serve")(function* (request: Request, env: Env, ctx: ExecutionContext, oauth: OAuthHelpers) {
  if ((yield* envError(env)) !== null) return jsonRpcError(503, -32603, "ParseJudge is not configured on this server.");
  const userId = (ctx.props as Partial<AgentProps> | undefined)?.userId;
  if (typeof userId !== "string" || userId === "") {
    return jsonRpcError(401, -32001, "This connection has no user. Connect ParseJudge again.");
  }
  const server = buildServer(env, userId, oauth);
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  yield* Effect.promise(() => server.connect(transport));
  return yield* Effect.promise(() => transport.handleRequest(request));
});

/** The MCP endpoint (Streamable HTTP, stateless). OAuthProvider has already checked the token. */
export const mcpHandler = (oauth: (env: Env) => OAuthHelpers) => ({
  fetch: (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> =>
    Effect.runPromise(
      Effect.suspend(() => serve(request, env, ctx, oauth(env))).pipe(
        Effect.catchCause((cause) =>
          Effect.logError({ event: "mcp_request_failed", error: String(Cause.squash(cause)) }).pipe(
            Effect.as(jsonRpcError(500, -32603, "ParseJudge failed to handle the request. Retry.")),
          ),
        ),
      ),
    ),
});
