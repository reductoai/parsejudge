import { decodeJson } from "@parsejudge/core";
import { Data, Duration, Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { deleteExpiredUploads } from "./deletion.ts";
import { type Env, envError } from "./env.ts";
import { storage } from "./errors.ts";

const LOGIN_TTL_MS = 15 * 60_000;
const SESSION_TTL_MS = 30 * 24 * 3_600_000;
const MAX_ATTEMPTS = 5;
/** Wrong codes per address across all its logins in 24 hours; after that only the link works. */
const MAX_FAILED_CODES_PER_DAY = 10;
const PER_EMAIL_AND_IP_PER_HOUR = 5;
const PER_EMAIL_PER_HOUR = 10;
const PER_IP_PER_HOUR = 20;
const ALL_PER_HOUR = 2000;
const LOGIN_COOKIE = "__Host-pj_login";
const SESSION_COOKIE = "__Host-pj_session";
/** Owner of uploads made before sign-in completes. */
export const PENDING_USER = "pending";

const encoder = new TextEncoder();
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
const randomCode = () => {
  for (;;) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
    if (n < 4_294_000_000) return String(n % 1_000_000).padStart(6, "0");
  }
};
const hmac = (env: Env, message: string) =>
  Effect.promise(() =>
    crypto.subtle.importKey("raw", encoder.encode(env.AUTH_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
  ).pipe(
    Effect.flatMap((key) => Effect.promise(() => crypto.subtle.sign("HMAC", key, encoder.encode(message)))),
    Effect.map((signature) => base64url(new Uint8Array(signature))),
  );
const sameHash = (a: string, b: string) =>
  a.length === b.length && crypto.subtle.timingSafeEqual(encoder.encode(a), encoder.encode(b));

const cookieValue = (header: string | null | undefined, name: string) => {
  for (const part of (header ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
};
const setCookie = (name: string, value: string, maxAgeMs: number) =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`;

const reply = (body: unknown, status = 200, cookies: ReadonlyArray<string> = []) => {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
};
const fail = (status: number, error: string) => reply({ error }, status);

/** The user of a valid session cookie. */
export const sessionUser = Effect.fn("sessionUser")(function* (env: Env, cookies: string | null | undefined) {
  const token = cookieValue(cookies, SESSION_COOKIE);
  if (token === undefined || token === "") return null;
  const idHash = yield* hmac(env, `session:${token}`);
  return yield* Effect.promise(() =>
    env.DB.prepare(
      `SELECT users.id, users.email FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.id_hash = ? AND sessions.expires_at > ?`,
    )
      .bind(idHash, Date.now())
      .first<{ id: string; email: string }>(),
  );
});

/** The sign-in this browser started (its login cookie), open or not. */
const browserLogin = Effect.fn("browserLogin")(function* (env: Env, cookies: string | null | undefined) {
  const [id, secret] = (cookieValue(cookies, LOGIN_COOKIE) ?? "").split(".");
  if (!id || !secret) return null;
  const row = yield* Effect.promise(() =>
    env.DB.prepare("SELECT id, secret_hash, used_at, expires_at, attempts FROM logins WHERE id = ?")
      .bind(id)
      .first<{ id: string; secret_hash: string; used_at: number | null; expires_at: number; attempts: number }>(),
  );
  return row !== null && sameHash(row.secret_hash, yield* hmac(env, `secret:${id}:${secret}`)) ? row : null;
});

/** The open sign-in this browser started, if any. */
export const pendingLogin = (env: Env, cookies: string | null | undefined) =>
  browserLogin(env, cookies).pipe(
    Effect.map((login) => (login !== null && login.used_at === null && login.expires_at > Date.now() ? login.id : null)),
  );

/** The address the rate limits count: no +tag, and no dots for gmail. Not used for identity. */
export const emailKey = (email: string) => {
  const [local = "", domain = ""] = email.split("@");
  const base = local.split("+")[0] ?? "";
  const gmail = domain === "gmail.com" || domain === "googlemail.com";
  return `${gmail ? base.replace(/\./g, "") : base}@${gmail ? "gmail.com" : domain}`;
};

/** The client the rate limits count: the IPv4 address, or the /64 of an IPv6 address. */
export const ipKey = (ip: string) => {
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === "" ? [] : tail.split(":");
  const groups = ip.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return `${groups
    .slice(0, 4)
    .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
};

const RESERVED = /\.(invalid|test|example|localhost|local)$/;

const readBody = (request: Request) =>
  Effect.tryPromise(() => request.json()).pipe(
    Effect.orElseSucceed(() => null),
    Effect.map((body) => (body as Record<string, unknown> | null) ?? {}),
  );

const emailText = (code: string, link: string) =>
  `Your ParseJudge sign-in code is ${code}.\n\nOr sign in with this link:\n${link}\n\nThe code and link work once and expire in 15 minutes. Files you added before signing in will be in your account. If you did not ask to sign in, ignore this email.`;
const emailHtml = (code: string, link: string) => `<div style="font-family:Inter,Arial,sans-serif;color:#0a0a0a;max-width:440px">
<p style="font-size:15px">Your ParseJudge sign-in code:</p>
<p style="font-size:32px;letter-spacing:6px;font-weight:600;margin:8px 0 24px">${code}</p>
<p><a href="${link}" style="display:inline-block;background:#0a0a0a;color:#fff;padding:12px 20px;border-radius:4px;text-decoration:none">Sign in to ParseJudge</a></p>
<p style="font-size:13px;color:#6b6b6b">The code and link work once and expire in 15 minutes. Files you added before signing in will be in your account. If you did not ask to sign in, ignore this email.</p>
</div>`;

/** POST /v1/auth/start: emails a code and a link, and sets `pj_login` so this browser can upload before sign-in completes. */
const start = Effect.fn("start")(function* (env: Env, request: Request) {
  const body = yield* readBody(request);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || RESERVED.test(email)) {
    return fail(400, "Enter a valid email address.");
  }
  const presetIds = Array.isArray(body.presetIds)
    ? body.presetIds.filter((id): id is string => typeof id === "string" && id.length <= 100).slice(0, 50)
    : [];
  const isHuman = yield* human(env, request, body.turnstile).pipe(
    Effect.catchTag("TurnstileUnavailable", (error) =>
      Effect.logError({ event: "auth_turnstile_unavailable", error: error.message }).pipe(Effect.as(null)),
    ),
  );
  if (isHuman === null) return fail(503, "Could not run the check that you are a person. Try again in a minute.");
  if (!isHuman) return fail(400, "Could not check that you are a person. Try again.");
  const ip = ipKey(request.headers.get("cf-connecting-ip") ?? "");
  const key = emailKey(email);
  const now = Date.now();
  const recent = yield* Effect.promise(() =>
    env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM logins WHERE email_key = ?1 AND ip = ?2 AND created_at > ?3) AS pair,
            (SELECT COUNT(*) FROM logins WHERE email_key = ?1 AND created_at > ?3) AS email,
            (SELECT COUNT(*) FROM logins WHERE ip = ?2 AND created_at > ?3) AS ip,
            (SELECT COUNT(*) FROM logins WHERE created_at > ?3) AS total`,
    )
      .bind(key, ip, now - 3_600_000)
      .first<{ pair: number; email: number; ip: number; total: number }>(),
  );
  if ((recent?.total ?? 0) >= ALL_PER_HOUR) {
    yield* Effect.logError({ event: "auth_global_limit", total: recent?.total });
    return fail(429, "Sign-in is busy. Try again in a few minutes.");
  }
  if (
    (recent?.pair ?? 0) >= PER_EMAIL_AND_IP_PER_HOUR ||
    (recent?.email ?? 0) >= PER_EMAIL_PER_HOUR ||
    (recent?.ip ?? 0) >= PER_IP_PER_HOUR
  ) {
    return fail(429, "Too many sign-in emails. Try again in an hour.");
  }
  const id = crypto.randomUUID();
  const secret = randomToken();
  const link = randomToken();
  const code = randomCode();
  const secretHash = yield* hmac(env, `secret:${id}:${secret}`);
  const codeHash = yield* hmac(env, `code:${id}:${code}`);
  const linkHash = yield* hmac(env, `link:${id}:${link}`);
  yield* Effect.promise(() =>
    env.DB.prepare(
      `INSERT INTO logins (id, email, email_key, secret_hash, code_hash, link_hash, preset_ids, ip, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, email, key, secretHash, codeHash, linkHash, JSON.stringify(presetIds), ip, now, now + LOGIN_TTL_MS)
      .run(),
  );
  const url = `${env.PUBLIC_URL}/auth?token=${id}.${link}`;
  const sent = yield* Effect.tryPromise(() =>
    env.EMAIL.send({
      from: { name: "ParseJudge", email: env.EMAIL_FROM },
      to: email,
      subject: `${code} is your ParseJudge sign-in code`,
      text: emailText(code, url),
      html: emailHtml(code, url),
    }),
  ).pipe(
    Effect.as(true),
    Effect.catch((error) => Effect.logError({ event: "auth_email_failed", error: String(error.cause) }).pipe(Effect.as(false))),
  );
  if (!sent) return fail(502, "We could not send the email. Try again.");
  // A new email from the same browser (resend, or a different address) takes over the files of its earlier sign-in.
  const earlier = yield* browserLogin(env, request.headers.get("cookie"));
  if (earlier !== null && earlier.used_at === null) {
    yield* Effect.promise(() =>
      env.DB.batch([
        env.DB.prepare("UPDATE documents SET login_id = ? WHERE login_id = ? AND user_id = ?").bind(id, earlier.id, PENDING_USER),
        env.DB.prepare("UPDATE logins SET expires_at = ?, replaced_by = ? WHERE id = ?").bind(now, id, earlier.id),
      ]),
    );
  }
  return reply({ ok: true }, 200, [setCookie(LOGIN_COOKIE, `${id}.${secret}`, LOGIN_TTL_MS)]);
});

const linkLogin = (token: unknown) => {
  if (typeof token !== "string") return null;
  const dot = token.indexOf(".");
  return dot > 0 ? { id: token.slice(0, dot), value: token.slice(dot + 1) } : null;
};

const pendingDocuments = (env: Env, loginId: string, userId: string) =>
  Effect.promise(() =>
    env.DB.prepare(
      `${CHAIN} SELECT id AS documentId, filename, format, page_count AS pageCount FROM documents
     WHERE login_id IN (SELECT id FROM chain) AND user_id = ?2 ORDER BY created_at`,
    )
      .bind(loginId, userId)
      .all(),
  );

const EXPIRED = "This sign-in has expired. Request a new email.";
const TOO_MANY_TODAY = "Too many wrong codes for this address today. Use the link in the email.";

/** The login `?1` and every earlier login from its browser that it replaced. */
const CHAIN = `WITH RECURSIVE chain(id) AS (SELECT ?1 UNION SELECT logins.id FROM logins JOIN chain ON logins.replaced_by = chain.id)`;

class TurnstileUnavailable extends Data.TaggedError("TurnstileUnavailable")<{ readonly message: string }> {}

const SiteVerify = Schema.Struct({
  success: Schema.Boolean,
  "error-codes": Schema.optional(Schema.Array(Schema.String)),
});
/** Siteverify codes that mean our secret is wrong, not that the visitor failed the check. */
const OUR_FAULT = new Set(["missing-input-secret", "invalid-input-secret", "internal-error"]);

/**
 * Cloudflare Turnstile, when the deployment sets TURNSTILE_SITEKEY. Fails with TurnstileUnavailable when the
 * check itself could not run. No retry: siteverify may have used up the single-use token.
 */
const human = (
  env: Env,
  request: Request,
  token: unknown,
): Effect.Effect<boolean, TurnstileUnavailable, HttpClient.HttpClient> => {
  if (!env.TURNSTILE_SITEKEY) return Effect.succeed(true);
  const secret = env.TURNSTILE_SECRET;
  if (!secret) return Effect.fail(new TurnstileUnavailable({ message: "TURNSTILE_SITEKEY is set without TURNSTILE_SECRET" }));
  const form = new FormData();
  form.set("secret", secret);
  form.set("response", typeof token === "string" ? token : "");
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) form.set("remoteip", ip);
  const unavailable = (error: unknown) => new TurnstileUnavailable({ message: String(error) });
  return HttpClient.execute(
    HttpClientRequest.post("https://challenges.cloudflare.com/turnstile/v0/siteverify").pipe(
      HttpClientRequest.bodyFormData(form),
    ),
  ).pipe(
    Effect.mapError(unavailable),
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? response.json.pipe(Effect.mapError(unavailable))
        : Effect.fail(unavailable(`siteverify returned HTTP ${response.status}`)),
    ),
    Effect.timeoutOrElse({
      duration: Duration.seconds(10),
      orElse: () => Effect.fail(unavailable("siteverify timed out after 10 seconds")),
    }),
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(SiteVerify)(body).pipe(
        Effect.mapError((error) => new TurnstileUnavailable({ message: `siteverify answered ${error.message}` })),
      ),
    ),
    Effect.flatMap((result) => {
      const ours = (result["error-codes"] ?? []).filter((code) => OUR_FAULT.has(code));
      return !result.success && ours.length > 0
        ? Effect.fail(new TurnstileUnavailable({ message: `siteverify: ${ours.join(", ")}` }))
        : Effect.succeed(result.success);
    }),
  );
};

/**
 * POST /v1/auth/link with `{ token }`: who the emailed link signs in and which files it carries over, without using it.
 * The link page shows this and signs in only on a click, so a link opened by a mail scanner or sent by someone else
 * signs no one in. `sameBrowser` is true when this browser started the sign-in.
 */
const peek = Effect.fn("peek")(function* (env: Env, request: Request) {
  const link = linkLogin((yield* readBody(request)).token);
  if (link === null) return fail(400, EXPIRED);
  const login = yield* Effect.promise(() =>
    env.DB.prepare("SELECT email, link_hash, used_at, expires_at, attempts FROM logins WHERE id = ?")
      .bind(link.id)
      .first<{ email: string; link_hash: string; used_at: number | null; expires_at: number; attempts: number }>(),
  );
  if (login === null || !sameHash(login.link_hash, yield* hmac(env, `link:${link.id}:${link.value}`))) {
    return fail(400, EXPIRED);
  }
  if (login.used_at !== null) return fail(400, "This link was already used. Request a new email to sign in again.");
  if (login.attempts >= MAX_ATTEMPTS) return fail(400, "This sign-in is locked after too many wrong codes. Request a new email.");
  if (login.expires_at <= Date.now()) return fail(400, EXPIRED);
  const documents = yield* pendingDocuments(env, link.id, PENDING_USER);
  const sameBrowser = (yield* pendingLogin(env, request.headers.get("cookie"))) === link.id;
  return reply({ email: login.email, documents: documents.results, sameBrowser });
});

/** Why a login cookie's code can no longer be used. */
const closedReason = (login: { used_at: number | null; attempts: number }) =>
  login.used_at !== null
    ? "You already signed in with the link in the email, maybe in another browser. Request a new email to sign in here."
    : login.attempts >= MAX_ATTEMPTS
      ? "Too many wrong codes. Use the link in the email, or request a new email."
      : EXPIRED;

/**
 * POST /v1/auth/verify with `{ code }` (needs this browser's login cookie) or `{ token }` (the emailed link, any browser).
 * Each try counts against the login; it works once. On success the login's uploads move to the user,
 * or stay behind (deleted by the hourly clean-up) when `discard` is true.
 */
const verify = Effect.fn("verify")(function* (env: Env, request: Request) {
  const body = yield* readBody(request);
  let id: string;
  let kind: "code" | "link";
  let value: string;
  const link = linkLogin(body.token);
  if (link !== null) {
    kind = "link";
    id = link.id;
    value = link.value;
  } else if (typeof body.code === "string") {
    kind = "code";
    const mine = yield* browserLogin(env, request.headers.get("cookie"));
    if (mine === null) return fail(400, EXPIRED);
    if (mine.used_at !== null || mine.attempts >= MAX_ATTEMPTS) return fail(400, closedReason(mine));
    id = mine.id;
    value = body.code.replace(/\s/g, "");
    const loginId = id;
    const failed = yield* Effect.promise(() =>
      env.DB.prepare(
        `SELECT COALESCE(SUM(attempts - (used_at IS NOT NULL)), 0) AS n FROM logins
       WHERE email_key = (SELECT email_key FROM logins WHERE id = ?) AND created_at > ?`,
      )
        .bind(loginId, Date.now() - 24 * 3_600_000)
        .first<{ n: number }>(),
    );
    if ((failed?.n ?? 0) >= MAX_FAILED_CODES_PER_DAY) {
      return fail(400, TOO_MANY_TODAY);
    }
  } else {
    return fail(400, "Missing code.");
  }
  const now = Date.now();
  const login = yield* Effect.promise(() =>
    env.DB.prepare(
      // The per-address daily cap on wrong codes is checked in the same statement, so parallel guesses cannot pass it.
      `UPDATE logins SET attempts = attempts + 1
     WHERE id = ?1 AND used_at IS NULL AND expires_at > ?2 AND attempts < ?3 AND (?4 = 'link' OR (
       SELECT COALESCE(SUM(attempts - (used_at IS NOT NULL)), 0) FROM logins
       WHERE email_key = (SELECT email_key FROM logins WHERE id = ?1) AND created_at > ?5) < ?6)
     RETURNING email, code_hash, link_hash, preset_ids, attempts`,
    )
      .bind(id, now, MAX_ATTEMPTS, kind, now - 24 * 3_600_000, MAX_FAILED_CODES_PER_DAY)
      .first<{ email: string; code_hash: string; link_hash: string; preset_ids: string; attempts: number }>(),
  );
  if (login === null) {
    const closed = yield* Effect.promise(() =>
      env.DB.prepare("SELECT used_at, attempts, expires_at FROM logins WHERE id = ?")
        .bind(id)
        .first<{ used_at: number | null; attempts: number; expires_at: number }>(),
    );
    const open = closed !== null && closed.used_at === null && closed.attempts < MAX_ATTEMPTS && closed.expires_at > now;
    return fail(400, closed === null ? EXPIRED : open ? TOO_MANY_TODAY : closedReason(closed));
  }
  if (!sameHash(kind === "code" ? login.code_hash : login.link_hash, yield* hmac(env, `${kind}:${id}:${value}`))) {
    const left = MAX_ATTEMPTS - login.attempts;
    if (kind === "link") return fail(400, EXPIRED);
    if (left === 0) return fail(400, closedReason({ used_at: null, attempts: login.attempts }));
    return fail(400, `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.`);
  }
  yield* Effect.promise(() =>
    env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT (email) DO NOTHING")
      .bind(crypto.randomUUID(), login.email, now)
      .run(),
  );
  const user = yield* Effect.promise(() =>
    env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(login.email).first<{ id: string }>(),
  );
  if (user === null || user.id === PENDING_USER) return fail(500, "Sign-in failed. Try again.");
  const claimed = yield* Effect.promise(() =>
    env.DB.prepare("UPDATE logins SET used_at = ?, user_id = ? WHERE id = ? AND used_at IS NULL")
      .bind(now, body.discard === true ? null : user.id, id)
      .run(),
  );
  if (claimed.meta.changes !== 1) return fail(400, EXPIRED);
  const session = randomToken();
  const sessionHash = yield* hmac(env, `session:${session}`);
  yield* Effect.promise(() =>
    env.DB.batch([
      ...(body.discard === true
        ? []
        : [
            env.DB.prepare(`${CHAIN} UPDATE logins SET user_id = ?2 WHERE id IN (SELECT id FROM chain)`).bind(id, user.id),
            env.DB.prepare(
              `${CHAIN} UPDATE documents SET user_id = ?2 WHERE login_id IN (SELECT id FROM chain) AND user_id = ?3`,
            ).bind(id, user.id, PENDING_USER),
          ]),
      env.DB.prepare("INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(
        sessionHash,
        user.id,
        now,
        now + SESSION_TTL_MS,
      ),
    ]),
  );
  const documents = body.discard === true ? { results: [] } : yield* pendingDocuments(env, id, user.id);
  const presetIds = (yield* decodeJson(login.preset_ids)) as Array<string>;
  return reply({ email: login.email, draft: { presetIds, documents: documents.results } }, 200, [
    setCookie(SESSION_COOKIE, session, SESSION_TTL_MS),
    setCookie(LOGIN_COOKIE, "", 0),
  ]);
});

const signOut = Effect.fn("signOut")(function* (env: Env, request: Request) {
  const token = cookieValue(request.headers.get("cookie"), SESSION_COOKIE);
  if (token) {
    const idHash = yield* hmac(env, `session:${token}`);
    yield* Effect.promise(() => env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(idHash).run());
  }
  return reply({ ok: true }, 200, [setCookie(SESSION_COOKIE, "", 0)]);
});

const me = (env: Env, request: Request) =>
  sessionUser(env, request.headers.get("cookie")).pipe(Effect.map((user) => reply({ email: user?.email ?? null })));

/** A route that fails or dies answers with a logged 500 in the `{ error }` shape the sign-in page reads. */
const guarded = <E, R>(env: Env, pathname: string, route: Effect.Effect<Response, E, R>) =>
  envError(env).pipe(
    Effect.flatMap((error) =>
      error !== null
        ? Effect.succeed(fail(503, "Sign-in is not configured on this server."))
        : route.pipe(
            Effect.catchCause((cause) =>
              Effect.logError({ event: "auth_route_failed", path: pathname, error: String(cause) }).pipe(
                Effect.as(fail(500, "Sign-in failed. Try again.")),
              ),
            ),
          ),
    ),
  );

/** Routes /v1/auth/* and /v1/me; null for any other path. */
export const handleAuth = (env: Env, request: Request): Effect.Effect<Response, never, HttpClient.HttpClient> | null => {
  const { pathname } = new URL(request.url);
  const post = request.method === "POST";
  if (pathname === "/v1/auth/start" && post) return guarded(env, pathname, start(env, request));
  if (pathname === "/v1/auth/config" && request.method === "GET") {
    return Effect.succeed(reply({ turnstileSiteKey: env.TURNSTILE_SITEKEY ?? null }));
  }
  if (pathname === "/v1/auth/link" && post) return guarded(env, pathname, peek(env, request));
  if (pathname === "/v1/auth/verify" && post) return guarded(env, pathname, verify(env, request));
  if (pathname === "/v1/auth/signout" && post) return guarded(env, pathname, signOut(env, request));
  if (pathname === "/v1/me" && request.method === "GET") return guarded(env, pathname, me(env, request));
  return null;
};

class CleanUpFailed extends Data.TaggedError("CleanUpFailed")<{ readonly step: string; readonly message: string }> {}

const cleanUpStep = <A, E extends { readonly message: string }>(step: string, run: Effect.Effect<A, E>) =>
  run.pipe(
    Effect.mapError((error) => new CleanUpFailed({ step, message: error.message })),
    Effect.tapError((error) => Effect.logError({ event: "auth_cleanup_failed", step: error.step, message: error.message })),
  );

/**
 * Hourly: drops uploads of sign-ins that never completed, old logins and expired sessions. The two steps are
 * independent, so one failing does not skip the other; it still rejects so the cron run shows as failed.
 */
export const cleanUpAuth = (env: Env) => {
  const dayAgo = Date.now() - 24 * 3_600_000;
  return Effect.all(
    [
      cleanUpStep("uploads", deleteExpiredUploads(env, dayAgo)),
      cleanUpStep(
        "logins and sessions",
        storage(() =>
          env.DB.batch([
            env.DB.prepare("DELETE FROM logins WHERE created_at < ?").bind(dayAgo),
            env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(Date.now()),
          ]),
        ),
      ),
    ],
    { concurrency: "unbounded", mode: "result" },
  ).pipe(
    Effect.flatMap((results) => {
      const failed = results.flatMap((result) => (result._tag === "Failure" ? [result.failure.step] : []));
      return failed.length === 0
        ? Effect.void
        : Effect.fail(new CleanUpFailed({ step: failed.join(", "), message: "Auth clean-up failed" }));
    }),
  );
};
