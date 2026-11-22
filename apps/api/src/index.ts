import { getOAuthApi, type OAuthHelpers, OAuthProvider, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { Cause, Effect, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { handler } from "./api.ts";
import { cleanUpAuth, handleAuth, sessionUser } from "./auth.ts";
import { verifyBlobUrl } from "./blobs.ts";
import { purgeZdr } from "./deletion.ts";
import type { Env } from "./env.ts";
import { INTERNAL_HEADER, internalHeader } from "./internal.ts";
import { mcpHandler } from "./mcp.ts";
import { AUTHORIZE_PATH, authorize, handleAgents, revokeAgents, SCOPE } from "./oauth.ts";
import { uploadUser } from "./uploads.ts";

export { Converter } from "./converter.ts";
export { RunEvents } from "./events.ts";
export { ProviderSlots } from "./slots.ts";
export { Splitter } from "./splitter.ts";
export { DocumentWorkflow, PageWorkflow, RunWorkflow } from "./workflows.ts";

const EVENTS_PATH = /^\/v1\/runs\/([^/]+)\/events$/;
const UPLOAD_PATH = /^\/v1\/uploads\/([^/]+)(?:\/([^/]+))?$/;

const jsonError = (status: number, error: string) => Response.json({ error }, { status });

/** decodeURIComponent, or null for a malformed escape instead of a URIError. */
const decodePath = (part: string) => Effect.try(() => decodeURIComponent(part)).pipe(Effect.orElseSucceed(() => null));

const ApiErrorBody = Schema.Struct({ error: Schema.String });

/** PUT /v1/uploads/<token>/<filename> (or ?filename=): an upload through a URL from the MCP create_upload_url tool. */
const signedUpload = Effect.fn("signedUpload")(function* (request: Request, env: Env, token: string, name: string | undefined) {
  if (request.method !== "PUT") return jsonError(405, "Use PUT.");
  const decodedToken = yield* decodePath(token);
  const decodedName = name === undefined ? undefined : yield* decodePath(name);
  if (decodedToken === null || decodedName === null) return jsonError(400, "The upload URL is malformed.");
  const upload = yield* uploadUser(env, decodedToken);
  if (upload === null) return jsonError(403, "This upload URL is invalid or expired.");
  const filename = decodedName ?? new URL(request.url).searchParams.get("filename");
  const query = new URLSearchParams({ filename: filename ?? "document", upload: upload.uploadId });
  // The body streams through to R2, which needs its length up front.
  const length = request.headers.get("content-length");
  if (request.body === null || length === null) {
    return Response.json(
      { filename, error: "Send the file as the request body, with a content-length header." },
      { status: 411 },
    );
  }
  const response = yield* Effect.promise(() =>
    handler(
      new Request(new URL(`/v1/documents?${query}`, request.url), {
        method: "POST",
        headers: {
          [INTERNAL_HEADER]: internalHeader(upload.userId),
          "content-type": "application/octet-stream",
          "content-length": length,
        },
        body: request.body,
      }),
    ),
  );
  if (response.ok) return response;
  const json = yield* Effect.tryPromise(() => response.json()).pipe(Effect.orElseSucceed(() => null));
  const error = Option.match(Schema.decodeUnknownOption(ApiErrorBody)(json), {
    onNone: () => `ParseJudge returned HTTP ${response.status}.`,
    onSome: (body) => body.error,
  });
  return Response.json({ filename, error }, { status: response.status });
});

const route = Effect.fn("route")(function* (request: Request, env: Env & { OAUTH_PROVIDER: OAuthHelpers }) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/blobs/")) {
    const key = yield* decodePath(url.pathname.slice("/blobs/".length));
    if (
      key === null ||
      !(yield* verifyBlobUrl(env.BLOB_SIGNING_KEY, key, url.searchParams.get("exp"), url.searchParams.get("sig")))
    ) {
      return jsonError(403, "This link is invalid or expired.");
    }
    const object = yield* Effect.promise(() => env.BLOBS.get(key));
    if (object === null) return jsonError(404, "Not found.");
    return new Response(object.body, { headers: { "content-type": key.endsWith(".png") ? "image/png" : "application/pdf" } });
  }
  // Sign-in codes, links and sessions are HMACs under AUTH_KEY; without a real key, serve nothing.
  if ((env.AUTH_KEY ?? "").length < 32) return new Response("AUTH_KEY is not set", { status: 500 });
  const upload = UPLOAD_PATH.exec(url.pathname);
  if (upload?.[1] !== undefined) return yield* signedUpload(request, env, upload[1], upload[2]);
  if (url.pathname === AUTHORIZE_PATH) return yield* authorize(request, env, env.OAUTH_PROVIDER);
  if (request.method !== "GET" && request.method !== "HEAD" && url.pathname.startsWith("/v1/")) {
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== url.origin) return new Response("Forbidden", { status: 403 });
  }
  const auth = handleAuth(env, request);
  if (auth !== null) return yield* auth;
  const agents = handleAgents(request, env, env.OAUTH_PROVIDER);
  if (agents !== null) return yield* agents;
  const events = EVENTS_PATH.exec(url.pathname);
  if (events?.[1] !== undefined) {
    const runId = events[1];
    return yield* Effect.promise(() => env.RUN_EVENTS.get(env.RUN_EVENTS.idFromName(runId)).fetch(request));
  }
  if (url.pathname === "/v1/account" && request.method === "DELETE") {
    const user = yield* sessionUser(env, request.headers.get("cookie"));
    const response = yield* Effect.promise(() => handler(request));
    if (response.ok && user !== null) yield* Effect.orDie(revokeAgents(env.OAUTH_PROVIDER, user.id));
    return response;
  }
  // Strip any forged internal identity before the API sees the request.
  if (request.headers.has(INTERNAL_HEADER)) {
    const headers = new Headers(request.headers);
    headers.delete(INTERNAL_HEADER);
    return yield* Effect.promise(() => handler(new Request(request, { headers })));
  }
  return yield* Effect.promise(() => handler(request));
});

/** The Worker's default handler under the OAuth provider: the one place browser and API requests run as Effects. */
const app = {
  fetch: (request: Request, env: Env & { OAUTH_PROVIDER: OAuthHelpers }): Promise<Response> =>
    Effect.runPromise(route(request, env).pipe(Effect.provide(FetchHttpClient.layer))),
};

/** One provider per origin: the resource metadata names the /mcp URL the client used. */
const providers = new Map<string, { options: OAuthProviderOptions<Env>; provider: OAuthProvider<Env> }>();

const oauthFor = (origin: string) => {
  let entry = providers.get(origin);
  if (entry === undefined) {
    const options: OAuthProviderOptions<Env> = {
      apiRoute: "/mcp",
      apiHandler: mcpHandler((env) => getOAuthApi(options, env)),
      defaultHandler: app as unknown as ExportedHandler<Env>,
      authorizeEndpoint: AUTHORIZE_PATH,
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      scopesSupported: [SCOPE],
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
      requiredScopes: [SCOPE],
      clientIdMetadataDocumentEnabled: true,
    };
    entry = { options, provider: new OAuthProvider<Env>(options) };
    providers.set(origin, entry);
  }
  return entry.provider;
};

export default {
  fetch: (request, env, ctx) =>
    Effect.runPromise(
      Effect.tryPromise(() => oauthFor(new URL(request.url).origin).fetch(request, env, ctx)).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Unhandled request error", request.method, new URL(request.url).pathname, Cause.squash(cause)).pipe(
            Effect.as(jsonError(500, "Internal error.")),
          ),
        ),
      ),
    ),
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(Effect.runPromise(cleanUpAuth(env)));
    ctx.waitUntil(
      Effect.runPromise(purgeZdr(env).pipe(Effect.catch((error) => Effect.logError("ZDR purge failed", error.message)))),
    );
  },
} satisfies ExportedHandler<Env>;
