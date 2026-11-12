export interface Preset {
  readonly id: string;
  readonly provider: string;
  readonly label: string;
  readonly mode: string;
  readonly listPriceUsdPerPage: number;
  readonly hosted: boolean;
  readonly default: boolean;
}

export interface Interval {
  readonly low: number;
  readonly high: number;
}

export interface PresetSummary {
  readonly presetId: string;
  readonly label: string;
  readonly pages: number;
  readonly failedPages: number;
  readonly skippedPages?: number;
  readonly meanScore: number | null;
  readonly medianScore: number | null;
  readonly highSeverityRate: number | null;
  readonly highSeverityInterval: Interval | null;
  readonly listPriceUsdPerPage: number;
  readonly observedCostUsdPerPage: number | null;
  readonly latencyMsMean: number | null;
  readonly latencyMsP50: number | null;
  readonly latencyMsP95: number | null;
}

export interface RunSummary {
  readonly presets: ReadonlyArray<PresetSummary>;
  readonly skippedPages?: number;
  readonly headToHead: ReadonlyArray<{ presetId: string; opponentId: string; wins: number; ties: number; losses: number }>;
  readonly tradeoff: ReadonlyArray<{ presetId: string; listPriceUsdPerPage: number; meanScore: number; pareto: boolean }>;
}

export interface PageRef {
  readonly id: string;
  readonly index: number;
  readonly imageUrl: string;
  readonly note: string | null;
}

export interface DocumentInfo {
  readonly id: string;
  readonly filename: string;
  readonly format: string;
  readonly pages: ReadonlyArray<PageRef>;
}

export interface Run {
  readonly id: string;
  readonly shareId: string;
  readonly title: string | null;
  readonly status: string;
  readonly presetIds: ReadonlyArray<string>;
  readonly judgeVersion: string;
  readonly judgeModel: string;
  readonly documents: ReadonlyArray<DocumentInfo>;
  readonly scores: ReadonlyArray<CellScore>;
  readonly summary: RunSummary | null;
  readonly error: string | null;
  readonly createdAt: number;
  readonly completedAt: number | null;
  readonly dataDeletedAt: number | null;
  readonly visibility: Visibility;
  readonly shareContent: boolean;
  readonly documentCount: number;
  readonly pageCount: number;
  readonly owned: boolean;
}

export interface JudgedError {
  readonly category: string;
  readonly severity: "not_error" | "low" | "medium" | "high" | "figure_error";
  readonly description: string;
  /** Excerpts of the output this error is about; `occurrence` picks which match of `text` (1-based). */
  readonly quotes?: ReadonlyArray<{ readonly text: string; readonly occurrence: number }>;
}

export interface PageParse {
  readonly presetId: string;
  readonly status: string;
  readonly latencyMs: number | null;
  readonly queueMs: number | null;
  readonly markdown: string | null;
  readonly error: string | null;
  /** Set when the parse succeeded with partial output, e.g. the provider hit its token limit. */
  readonly warning: string | null;
  readonly score: number | null;
  readonly reasoning: string | null;
  readonly errors: ReadonlyArray<JudgedError> | null;
}

export interface PageDetail {
  readonly pageId: string;
  readonly imageUrl: string;
  readonly parses: ReadonlyArray<PageParse>;
}

export interface CellScore {
  readonly pageId: string;
  readonly presetId: string;
  readonly status: string;
  readonly score: number | null;
  readonly high: number;
}

export interface CellDone {
  readonly presetId: string;
  readonly pageId: string;
  readonly ok: boolean;
  readonly latencyMs: number | null;
}

export type RunEvent =
  | {
      readonly type: "progress";
      readonly done: number;
      readonly total: number;
      readonly status: string | null;
      readonly cells: ReadonlyArray<CellDone>;
      readonly started?: ReadonlyArray<string>;
    }
  | { readonly type: "parse_started"; readonly presetId: string }
  | ({ readonly type: "parse_done" } & CellDone)
  | { readonly type: "page_done"; readonly pageId: string; readonly done: number; readonly total: number }
  | { readonly type: "run_done"; readonly status: "succeeded" | "failed" };

let user: string | null = null;

/** Loads the signed-in email from the session cookie. Called once before the first render. */
export const loadUser = async () => {
  const response = await fetch("/v1/me").catch(() => null);
  user = response?.ok ? (((await response.json()) as { email: string | null }).email ?? null) : null;
};
export const currentUser = () => user;
export const setUser = (email: string | null) => {
  user = email;
};

export interface DraftDocument {
  readonly documentId: string;
  readonly filename: string;
  readonly format: string;
  readonly pageCount: number;
}
/** What a sign-in carries across tabs and browsers: the files uploaded while it was open and the chosen presets. */
export interface Draft {
  readonly presetIds: ReadonlyArray<string>;
  readonly documents: ReadonlyArray<DraftDocument>;
}
/** The sign-in link tab hands its draft to the landing page, and tells the tab that started sign-in. */
export const DRAFT_KEY = "parsejudge.draft";
export const AUTH_CHANNEL = "parsejudge.auth";

const authJson = async <T>(response: Response): Promise<T> => {
  const body = (await response.json().catch(() => ({}))) as { readonly error?: string };
  if (!response.ok) throw new Error(body.error ?? `Sign-in failed (${response.status}).`);
  return body as T;
};
const post = (path: string, body: unknown) =>
  fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const auth = {
  config: () => fetch("/v1/auth/config").then(authJson<{ readonly turnstileSiteKey: string | null }>),
  start: (email: string, presetIds: ReadonlyArray<string>, turnstile: string | null) =>
    post("/v1/auth/start", { email, presetIds, turnstile }).then(authJson),
  /** Who the emailed link signs in and which files it carries over, without using it. */
  link: (token: string) =>
    post("/v1/auth/link", { token }).then(
      authJson<{ readonly email: string; readonly documents: ReadonlyArray<DraftDocument>; readonly sameBrowser: boolean }>,
    ),
  verify: (body: { readonly code: string } | { readonly token: string; readonly discard?: boolean }) =>
    post("/v1/auth/verify", body)
      .then(authJson<{ readonly email: string; readonly draft: Draft }>)
      .then((result) => {
        user = result.email;
        return result;
      }),
  signOut: () =>
    post("/v1/auth/signout", {}).then(() => {
      user = null;
    }),
};

const json = async <T>(response: Response): Promise<T> => {
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json()) as T;
};

const ok = async (response: Response) => {
  if (response.status === 409) throw new Error("A run is still in progress. Try again when it finishes.");
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
};

export interface RunListItem {
  readonly id: string;
  readonly shareId: string;
  readonly title: string | null;
  readonly status: string;
  readonly presetIds: ReadonlyArray<string>;
  readonly documents: number;
  readonly pages: number;
  readonly judged: number;
  readonly top: { readonly presetId: string; readonly meanScore: number } | null;
  readonly createdAt: number;
  readonly dataDeletedAt: number | null;
  readonly visibility: Visibility;
  readonly shareContent: boolean;
}

export type Visibility = "private" | "link";

export interface Agent {
  readonly id: string;
  readonly name: string;
  readonly connectedAt: number;
}

export interface AccountInfo {
  readonly email: string;
  readonly notifyOnDone: boolean;
}

const patch = (url: string, body: unknown) =>
  fetch(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const api = {
  account: () => fetch("/v1/account").then(json<AccountInfo>),
  agents: () => fetch("/v1/agents").then(json<ReadonlyArray<Agent>>),
  disconnectAgent: (id: string) => fetch(`/v1/agents/${encodeURIComponent(id)}`, { method: "DELETE" }).then(ok),
  setNotify: (notifyOnDone: boolean) => patch("/v1/account", { notifyOnDone }).then(json<AccountInfo>),
  setVisibility: (runId: string, visibility: Visibility) => patch(`/v1/runs/${runId}`, { visibility }).then(ok),
  setShareContent: (runId: string, shareContent: boolean) => patch(`/v1/runs/${runId}`, { shareContent }).then(ok),
  continueRun: (runId: string) => fetch(`/v1/runs/${runId}/continue`, { method: "POST" }).then(json<{ skipped: number }>),
  rotateLink: (runId: string) => fetch(`/v1/runs/${runId}/share-link`, { method: "POST" }).then(json<{ shareId: string }>),
  runs: () => fetch("/v1/runs").then(json<ReadonlyArray<RunListItem>>),
  rename: (runId: string, title: string) =>
    fetch(`/v1/runs/${runId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    }).then(ok),
  presets: () => fetch("/v1/presets").then(json<ReadonlyArray<Preset>>),
  /** XHR, not fetch, for upload progress. `onProgress` gets the share of bytes sent, 0 to 1. */
  upload: (file: File, onProgress: (sent: number) => void, zdr: boolean) =>
    new Promise<{ documentId: string; pageCount: number }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/v1/documents?filename=${encodeURIComponent(file.name)}${zdr ? "&zdr=1" : ""}`);
      xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onerror = () => reject(new Error("Upload failed. Check your connection and retry."));
      xhr.onload = () => {
        const body = (() => {
          try {
            return JSON.parse(xhr.responseText) as { documentId: string; pageCount: number; error?: string };
          } catch {
            return null;
          }
        })();
        if (xhr.status >= 200 && xhr.status < 300 && body !== null) resolve(body);
        else if (body?.error) reject(new Error(body.error));
        // Cloudflare answers 413 (body too large) and 503 (Worker out of memory) without our JSON.
        else if (xhr.status === 413 || xhr.status === 503) reject(new Error("File is too large to process."));
        else reject(new Error(`Upload failed (${xhr.status}).`));
      };
      xhr.send(file);
    }),
  createRun: (body: {
    documentIds: ReadonlyArray<string>;
    presetIds: ReadonlyArray<string>;
    title?: string | undefined;
    credentials: Record<string, Record<string, string>>;
    zdr?: boolean;
  }) =>
    fetch("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<{ runId: string; shareId: string }>),
  title: (filenames: ReadonlyArray<string>) =>
    fetch("/v1/titles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filenames }),
    }).then(json<{ title: string | null }>),
  run: (runId: string) => fetch(`/v1/runs/${runId}`).then(json<Run>),
  shared: (shareId: string) => fetch(`/v1/share/${shareId}`).then(json<Run>),
  deleteRun: (runId: string, scope: "data" | "report") =>
    fetch(`/v1/runs/${runId}?scope=${scope}`, { method: "DELETE" }).then(ok),
  deleteAccount: () => fetch("/v1/account", { method: "DELETE" }).then(ok),
  page: (runId: string, pageId: string) => fetch(`/v1/runs/${runId}/pages/${pageId}`).then(json<PageDetail>),
  events: (runId: string, onEvent: (event: RunEvent) => void) => {
    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/v1/runs/${runId}/events`);
    socket.onmessage = (message) => onEvent(JSON.parse(String(message.data)) as RunEvent);
    return () => socket.close();
  },
};
