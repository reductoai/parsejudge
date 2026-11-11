import { useEffect, useMemo, useRef, useState } from "react";
import { api, auth, currentUser, DRAFT_KEY, type Draft, type Preset, type RunListItem } from "./api.ts";
import { Icon } from "./ax/Icon.tsx";
import { Go, Shell, SiteBar, SiteFoot } from "./Nav.tsx";
import { BYOK_KEY, providerName, providerRank, shortName } from "./names.ts";
import { navigate } from "./router.ts";
import { SignIn } from "./SignIn.tsx";

const MAX_PAGES_PER_RUN = 1000;

/** A PDF's page count, read in the browser so an oversized file is refused before it uploads. Undefined when unknown. */
const countPages = async (file: File): Promise<number | undefined> => {
  if (!file.name.toLowerCase().endsWith(".pdf")) return undefined;
  try {
    const { PDFDocument } = await import("pdf-lib");
    const pdf = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true, updateMetadata: false });
    return pdf.getPageCount();
  } catch {
    return undefined;
  }
};

const DOCUMENT_NAME = /\.(pdf|docx|pptx)$/i;
const isZip = (file: File) => file.name.toLowerCase().endsWith(".zip");
const baseName = (path: string) => path.split("/").pop() ?? path;
// Finder and Office leave resource forks and lock files beside the real documents.
const isJunk = (path: string) => path.startsWith("__MACOSX/") || /^[.~]/.test(baseName(path));

/** The PDF, DOCX and PPTX files inside a .zip, at any depth. */
const unzipDocuments = async (zip: File): Promise<ReadonlyArray<File>> => {
  const { unzip } = await import("fflate");
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
    unzip(bytes, { filter: (f) => DOCUMENT_NAME.test(f.name) && !isJunk(f.name) }, (error, out) =>
      error ? reject(error) : resolve(out),
    ),
  );
  return Object.entries(entries)
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([path, data]) => new File([data as Uint8Array<ArrayBuffer>], baseName(path)));
};

interface Upload {
  readonly id: string;
  readonly name: string;
  readonly format: string;
  readonly documentId?: string;
  readonly pageCount?: number;
  /** Counted in the browser before upload, for PDFs. */
  readonly localPages?: number;
  /** Share of bytes sent, 0 to 1. */
  readonly sent?: number;
  /** A .zip whose documents are still being extracted. */
  readonly unzipping?: boolean;
  readonly error?: string;
}

const price = (usdPerThousand: number) =>
  usdPerThousand < 10 ? String(Math.round(usdPerThousand * 100) / 100) : String(Math.round(usdPerThousand));
const modeCost = (p: Preset) => `$${price(p.listPriceUsdPerPage * 1000)}`;
const perK = (presets: ReadonlyArray<Preset>) => {
  const prices = presets.map((p) => p.listPriceUsdPerPage * 1000);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  return lo === hi ? `$${price(lo)} / 1k pages` : `$${price(lo)}–${price(hi)} / 1k pages`;
};
const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
const runDate = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** The API key popover (.fb-menu chrome), placed under the row's side slot and kept in the viewport. */
const KeyMenu = ({
  provider,
  anchor,
  onSave,
  onClose,
  zdr,
}: {
  readonly provider: string;
  readonly anchor: HTMLElement;
  readonly zdr: boolean;
  readonly onSave: (key: string) => void;
  readonly onClose: () => void;
}) => {
  const menu = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState("");
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const el = menu.current;
    if (el === null) return;
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const top = r.bottom + 6 + h > innerHeight - 8 ? r.top - 6 - h : r.bottom + 6;
    setAt({ left: Math.max(8, Math.min(r.right - w, innerWidth - 8 - w)), top: Math.max(8, top) });
    el.querySelector("input")?.focus();
  }, [anchor]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Element;
      if (!menu.current?.contains(t) && !t.closest("[data-key],[data-m],[data-all]")) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const scroll = () => onClose();
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    document.querySelector(".content-pane")?.addEventListener("scroll", scroll);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
      document.querySelector(".content-pane")?.removeEventListener("scroll", scroll);
    };
  }, [onClose]);
  const save = () => value.trim() && onSave(value.trim());
  return (
    <div ref={menu} className="fb-menu pv-key-menu" style={at ? { left: at.left, top: at.top } : { left: -9999, top: 0 }}>
      <label className="field-label" htmlFor="keyIn">
        {providerName(provider)} API key
      </label>
      <input
        className="set-name-input"
        id="keyIn"
        type="password"
        autoComplete="off"
        placeholder="Paste key"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && save()}
      />
      <div className="pv-key-note">Encrypted. Deleted when the run ends.</div>
      {zdr && <div className="pv-key-note">ZDR may not apply depending on your terms with this provider.</div>}
      <div className="pv-key-acts">
        <button className="btn" type="button" onClick={onClose}>
          <span className="btn-label">Cancel</span>
        </button>
        <button className="btn primary" type="button" disabled={!value.trim()} onClick={save}>
          <span className="btn-label">Save</span>
        </button>
      </div>
    </div>
  );
};

const ProviderRow = ({
  provider,
  presets,
  selected,
  setSelected,
  hasKey,
  askKey,
}: {
  readonly provider: string;
  readonly presets: ReadonlyArray<Preset>;
  readonly selected: ReadonlySet<string>;
  readonly setSelected: (ids: ReadonlyArray<string>, on: boolean) => void;
  readonly hasKey: boolean;
  readonly askKey: (provider: string, anchor: HTMLElement, then: () => void) => void;
}) => {
  const side = useRef<HTMLDivElement>(null);
  const hosted = presets.some((p) => p.hosted);
  const on = presets.filter((p) => selected.has(p.id)).length;
  const all = on === presets.length;
  const state = on === 0 ? "" : all ? "is-on" : "is-part";
  const locked = !hosted && !hasKey;
  const pick = (ids: ReadonlyArray<string>, value: boolean) => {
    if (value && locked && side.current) askKey(provider, side.current, () => setSelected(ids, true));
    else setSelected(ids, value);
  };
  const toggleAll = () =>
    pick(
      presets.map((p) => p.id),
      !all,
    );
  return (
    <div className={`pv-row${locked ? " is-locked" : ""}`} data-p={provider}>
      {/* biome-ignore lint/a11y/useSemanticElements: the design's tri-state row checkbox is a button. */}
      <button
        className={`pv-check ${state}`}
        type="button"
        role="checkbox"
        aria-checked={all ? "true" : on ? "mixed" : "false"}
        aria-label={providerName(provider)}
        data-all={provider}
        onClick={toggleAll}
      >
        <Icon name="check" />
      </button>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the row checkbox is the keyboard control for the same action. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: clicking the name toggles the provider, as in the design. */}
      <span className="pv-name" data-all={provider} onClick={toggleAll}>
        {providerName(provider)}
      </span>
      <div className="pv-modes">
        {presets.map((p) => (
          <button
            key={p.id}
            className={`nx-ichip pv-chip${selected.has(p.id) ? " is-on" : ""}`}
            type="button"
            aria-pressed={selected.has(p.id)}
            data-m={p.id}
            onClick={() => pick([p.id], !selected.has(p.id))}
          >
            <Icon name="check" className="pv-tick" />
            <span>{p.mode}</span>
            <span className="pv-cost">{modeCost(p)}</span>
          </button>
        ))}
      </div>
      <div className="pv-side" ref={side}>
        {hosted ? (
          perK(presets)
        ) : hasKey ? (
          <span className="pv-key-ok">
            <Icon name="check" />
            Key added
          </span>
        ) : (
          <button
            className="dl-act"
            type="button"
            data-key={provider}
            onClick={() =>
              side.current &&
              askKey(provider, side.current, () => {
                if (on === 0 && presets[0]) setSelected([presets[0].id], true);
              })
            }
          >
            Add key
          </button>
        )}
      </div>
    </div>
  );
};

/** One row per run, linking to its report; a running run shows its progress. */
const PreviousRuns = ({ presets }: { readonly presets: ReadonlyArray<Preset> }) => {
  const [runs, setRuns] = useState<ReadonlyArray<RunListItem> | null>(null);
  const [version, setVersion] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new version reloads the list.
  useEffect(() => {
    api.runs().then(setRuns, () => setRuns([]));
  }, [version]);
  useEffect(() => {
    if (!runs?.some((r) => r.status === "queued" || r.status === "running")) return;
    const timer = setTimeout(() => setVersion((v) => v + 1), 5000);
    return () => clearTimeout(timer);
  }, [runs]);
  const provider = (id: string) => {
    const p = presets.find((x) => x.id === id);
    return p ? shortName(p.provider) : id;
  };
  if (runs === null) return null;
  return (
    <section className="su-sec" aria-labelledby="runsTitle">
      <div>
        <div className="su-sec-title" id="runsTitle">
          Previous runs
        </div>
        <div className="su-sec-meta">{runs.length ? plural(runs.length, "run") : ""}</div>
      </div>
      <div className="su-fields">
        {runs.length === 0 ? (
          <div className="empty-state">
            <div className="es-title">No runs yet</div>
          </div>
        ) : (
          // biome-ignore lint/a11y/useSemanticElements: the design's data list is a grid of link rows.
          <div className="wf-table runs" role="list">
            <div className="thead" aria-hidden="true">
              <div>Run</div>
              <div>Providers</div>
              <div>Top score</div>
              <div>Date</div>
              <div />
            </div>
            {runs.map((r) => {
              const live = r.status === "queued" || r.status === "running";
              const title = r.title ?? "Untitled run";
              const providers = [...new Set(r.presetIds.map(provider))];
              const percent = r.pages === 0 ? 0 : Math.round((r.judged / r.pages) * 100);
              return (
                <Go
                  key={r.id}
                  className="trow"
                  role="listitem"
                  to={`/r/${r.shareId}`}
                  aria-label={`${title}, ${live ? "running" : r.top ? `top score ${provider(r.top.presetId)} ${r.top.meanScore.toFixed(1)}` : r.status}, ${runDate(r.createdAt)}`}
                >
                  <div className="run-n">
                    <span className="run-t">{title}</span>
                    <span className="run-m">
                      {plural(r.documents, "document")} · {plural(r.pages, "page")}
                    </span>
                  </div>
                  <div className="run-p">{providers.join(", ")}</div>
                  <div className="run-s">
                    {live ? (
                      <span className="run-live">
                        <span className="spin" />
                        {percent}%
                      </span>
                    ) : r.top ? (
                      <>
                        <span className="run-lead">{provider(r.top.presetId)}</span> {r.top.meanScore.toFixed(1)}
                      </>
                    ) : (
                      <span className="run-lead">{r.status === "failed" ? "Failed" : "–"}</span>
                    )}
                  </div>
                  <div className="run-d">{runDate(r.createdAt)}</div>
                  <div className="run-go">
                    <Icon name="chevron-right" />
                  </div>
                </Go>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
};

export const Landing = ({ zdr }: { readonly zdr: boolean }) => {
  const [presets, setPresets] = useState<ReadonlyArray<Preset>>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [uploads, setUploads] = useState<ReadonlyArray<Upload>>([]);
  const [filesOpen, setFilesOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [pending, setPending] = useState<ReadonlyArray<File> | null>(null);
  const [keyMenu, setKeyMenu] = useState<{ provider: string; anchor: HTMLElement; then: () => void } | null>(null);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadedPending = useRef(false);
  // Set by the sign-in link page: the files uploaded and presets chosen before sign-in.
  const [draft] = useState(() => JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? "null") as Draft | null);
  const user = currentUser();

  useEffect(() => {
    sessionStorage.removeItem(DRAFT_KEY);
    if (draft === null) return;
    setUploads(
      draft.documents.map((d) => ({
        id: d.documentId,
        name: d.filename,
        format: d.format.toUpperCase(),
        documentId: d.documentId,
        pageCount: d.pageCount,
      })),
    );
  }, [draft]);

  useEffect(() => {
    api.presets().then(
      (all) => {
        setPresets(all);
        const restored = draft?.presetIds.filter((id) => all.some((p) => p.id === id)) ?? [];
        setSelected(new Set(restored.length > 0 ? restored : all.filter((p) => p.default).map((p) => p.id)));
      },
      (e: unknown) => setError(String(e)),
    );
  }, [draft]);

  const groups = useMemo(() => {
    const byProvider = new Map<string, Preset[]>();
    for (const p of presets) byProvider.set(p.provider, [...(byProvider.get(p.provider) ?? []), p]);
    const entries = [...byProvider.entries()].sort(([a], [b]) => providerRank(a) - providerRank(b));
    return {
      included: entries.filter(([, ps]) => ps.some((p) => p.hosted)),
      byok: entries.filter(([, ps]) => !ps.some((p) => p.hosted)),
    };
  }, [presets]);

  const choose = (ids: ReadonlyArray<string>, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const upload = (files: ReadonlyArray<File>) => {
    for (const file of files) {
      const format = (file.name.split(".").pop() ?? "").toUpperCase();
      const id = crypto.randomUUID();
      const patch = (next: Partial<Upload>) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, ...next } : x)));
      setUploads((u) => [...u, { id, name: file.name, format }]);
      countPages(file).then(async (localPages) => {
        if (localPages !== undefined && localPages > MAX_PAGES_PER_RUN) {
          patch({
            localPages,
            error: `${localPages.toLocaleString("en-US")} pages, over the ${MAX_PAGES_PER_RUN.toLocaleString("en-US")}-page limit`,
          });
          return;
        }
        patch(localPages === undefined ? { sent: 0 } : { localPages, sent: 0 });
        await api
          .upload(file, (sent) => patch({ sent }), zdr)
          .then(
            (r) => patch(r),
            (e: unknown) => patch({ error: e instanceof Error ? e.message : String(e) }),
          );
      });
    }
  };

  const expand = async (files: ReadonlyArray<File>) => {
    const out = await Promise.all(
      files.map(async (file) => {
        if (!isZip(file)) return [file];
        const id = crypto.randomUUID();
        setUploads((u) => [...u, { id, name: file.name, format: "ZIP", unzipping: true }]);
        const fail = (error: string) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, unzipping: false, error } : x)));
        try {
          const inside = await unzipDocuments(file);
          if (inside.length === 0) fail("no PDF, DOCX or PPTX files inside");
          else setUploads((u) => u.filter((x) => x.id !== id));
          return inside;
        } catch {
          fail("could not open this .zip");
          return [];
        }
      }),
    );
    return out.flat();
  };

  const add = async (files: FileList | null) => {
    const list = await expand(Array.from(files ?? []));
    if (list.length === 0) return;
    if (currentUser() === null) {
      uploadedPending.current = false;
      setPending(list);
    } else upload(list);
  };

  const ready = uploads.filter((u) => u.documentId !== undefined);
  const reading = uploads.filter((u) => u.documentId === undefined && u.error === undefined).length;
  const failed = uploads.filter((u) => u.error !== undefined).length;
  const pages = uploads.reduce((n, u) => n + (u.error === undefined ? (u.pageCount ?? u.localPages ?? 0) : 0), 0);
  const chosen = presets.filter((p) => selected.has(p.id));
  const missingKey = chosen.some((p) => !p.hosted && !keys[p.provider]);
  const overLimit = pages > MAX_PAGES_PER_RUN;
  const namesKey = uploads
    .filter((u) => u.error === undefined)
    .map((u) => u.name)
    .join("\n");
  const [titleFor, setTitleFor] = useState<{ readonly key: string; readonly title: string | null }>();
  useEffect(() => {
    if (namesKey === "") return;
    let live = true;
    api.title(namesKey.split("\n")).then(
      ({ title }) => live && setTitleFor({ key: namesKey, title }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [namesKey]);
  const suggested = titleFor?.key === ready.map((u) => u.name).join("\n") ? (titleFor.title ?? undefined) : undefined;
  const title = suggested;

  const start = async () => {
    if (currentUser() === null) {
      setPending([]);
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const credentials = Object.fromEntries(
        [...new Set(chosen.filter((p) => !p.hosted).map((p) => p.provider))].map((provider) => [
          provider,
          { [BYOK_KEY[provider] ?? "API_KEY"]: keys[provider] ?? "" },
        ]),
      );
      const { shareId } = await api.createRun({
        documentIds: ready.flatMap((u) => (u.documentId ? [u.documentId] : [])),
        title,
        presetIds: chosen.map((p) => p.id),
        credentials,
        zdr,
      });
      navigate(`/r/${shareId}`);
    } catch (e) {
      setError(String(e));
      setStarting(false);
    }
  };

  const askKey = (provider: string, anchor: HTMLElement, then: () => void) => setKeyMenu({ provider, anchor, then });
  const row = ([provider, ps]: [string, Preset[]]) => (
    <ProviderRow
      key={provider}
      provider={provider}
      presets={ps}
      selected={selected}
      setSelected={choose}
      hasKey={Boolean(keys[provider])}
      askKey={askKey}
    />
  );
  const plural = (n: number, one: string) => `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`;
  const keyless = chosen.find((p) => !p.hosted && !keys[p.provider]);
  /* why Start is grey, or what the run holds once it can start */
  const status =
    reading > 0
      ? `Uploading ${ready.length} of ${ready.length + reading} files…`
      : ready.length === 0
        ? "Add documents to start"
        : chosen.length === 0
          ? "Pick at least one provider"
          : keyless
            ? `Add your ${keyless.provider} API key`
            : `${plural(ready.length, "document")} · ${plural(pages, "page")}`;
  const problem = overLimit
    ? `${pages.toLocaleString("en-US")} pages selected. The limit is ${MAX_PAGES_PER_RUN.toLocaleString("en-US")} per run.`
    : error;

  return (
    <Shell
      topbar={
        <>
          {zdr && (
            <div className="zdr-banner" role="status">
              <strong>ZDR mode</strong>
              <span>Documents and pages are deleted 24 hours after the run. Results stay.</span>
            </div>
          )}
          <SiteBar user={user} />
        </>
      }
      label="Home"
    >
      {pending && (
        <SignIn
          onEmail={async (email, turnstile) => {
            await auth.start(email, [...selected], turnstile);
            // A resend or a new address moves the files on the server; upload them only once.
            if (!uploadedPending.current) upload(pending);
            uploadedPending.current = true;
          }}
          onDone={() => setPending(null)}
          onCancel={() => setPending(null)}
        />
      )}
      <div className="page su-page">
        <div className="su-head">
          <h1 className="su-hero">Compare document parsers on your own documents.</h1>
          <p className="su-lede">
            Every page is rendered to the same image and sent to each provider. A blind judge scores the outputs. The method and
            code are open source.
          </p>
          <div className="su-proof">
            <span>
              <Icon name="check" />
              Blind judging, provider names hidden
            </span>
            <span>
              <Icon name="check" />
              Judge prompt and scoring code are public
            </span>
            <span>
              <Icon name="check" />
              Every run is reproducible on your own hardware
            </span>
            <Go className="su-proof-link" to="/methodology">
              Read the methodology
            </Go>
          </div>
        </div>

        <section className="su-sec">
          <div>
            <div className="su-sec-title">Documents</div>
            <div className="su-sec-meta">
              PDF, DOCX or PPTX, or a .zip of them. Up to {MAX_PAGES_PER_RUN.toLocaleString("en-US")} pages per run.
              {zdr && " Deleted 24 hours after the run. Results stay."}
            </div>
          </div>
          <div className="su-fields">
            <div>
              {
                // biome-ignore lint/a11y/useSemanticElements: the design's dropzone is a div with the button role.
                <div
                  className={`dropzone${over ? " over" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => fileInput.current?.click()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      fileInput.current?.click();
                    }
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setOver(true);
                  }}
                  onDragLeave={() => setOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setOver(false);
                    add(e.dataTransfer.files);
                  }}
                >
                  Drop files here<span className="dz-hint">or click to browse</span>
                </div>
              }
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                accept=".pdf,.docx,.pptx,.zip"
                onChange={(e) => add(e.target.files)}
              />
              {uploads.length > 0 && (
                // biome-ignore lint/a11y/noStaticElementInteractions: more files can be dropped onto the list.
                <div
                  className="set-files"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    add(e.dataTransfer.files);
                  }}
                >
                  <div className="sf-head">
                    <button className="sf-group" type="button" aria-expanded={filesOpen} onClick={() => setFilesOpen(!filesOpen)}>
                      <Icon name="files" />
                      <span className="sf-name">{plural(uploads.length, "document")}</span>
                      <span className="sf-meta">
                        {plural(pages, "page")}
                        {reading > 0 && ` · ${reading} reading`}
                        {failed > 0 && ` · ${failed} failed`}
                      </span>
                      <Icon name="chevron-down" className="sf-chev" />
                    </button>
                    <button
                      className="dl-act sf-clear"
                      type="button"
                      onClick={() => {
                        setUploads([]);
                        setFilesOpen(false);
                      }}
                    >
                      Clear all
                    </button>
                  </div>
                  {filesOpen && (
                    <div className="sf-chips">
                      {uploads.map((u) => (
                        <span key={u.id} className="sf-chip" title={u.error}>
                          <span className="sf-chip-n" style={u.error ? { color: "var(--carmine-600)" } : undefined}>
                            {u.name}
                            {u.error
                              ? ` · ${u.error}`
                              : u.documentId !== undefined
                                ? ""
                                : u.unzipping
                                  ? " · unzipping"
                                  : u.sent === undefined
                                    ? " · counting pages"
                                    : u.sent < 1
                                      ? ` · uploading ${Math.round(u.sent * 100)}%`
                                      : " · reading"}
                          </span>
                          <button
                            className="sf-x"
                            type="button"
                            aria-label={`Remove ${u.name}`}
                            onClick={() => setUploads((list) => list.filter((x) => x.id !== u.id))}
                          >
                            <Icon name="x" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="su-sec">
          <div>
            <div className="su-sec-title">Providers</div>
            <div className="su-sec-meta">Each mode is scored on its own.</div>
          </div>
          <div className="su-fields" id="providers">
            <div className="pv-group">
              <div className="mg-label">Included</div>
              <div className="pv-list">{groups.included.map(row)}</div>
            </div>
            <div className="pv-group">
              <div className="mg-label">Your API key</div>
              <div className="pv-list">{groups.byok.map(row)}</div>
            </div>
          </div>
        </section>

        <section className="su-sec su-run" aria-label="Run summary">
          <div />
          <div className="su-run-in">
            <span className="su-note">
              {reading > 0 && <span className="spin" />}
              {status}
            </span>
            <span className="sp" />
            {problem && <span className="su-run-err">{problem}</span>}
            <button
              className="btn primary"
              type="button"
              disabled={starting || ready.length === 0 || reading > 0 || chosen.length === 0 || missingKey || overLimit}
              onClick={start}
            >
              <span className="btn-label">Start evaluation</span>
              <Icon name="arrow-right" />
            </button>
          </div>
        </section>

        {user && <PreviousRuns presets={presets} />}
        <SiteFoot />
      </div>
      {keyMenu && (
        <KeyMenu
          provider={keyMenu.provider}
          anchor={keyMenu.anchor}
          zdr={zdr}
          onClose={() => setKeyMenu(null)}
          onSave={(key) => {
            setKeys((k) => ({ ...k, [keyMenu.provider]: key }));
            keyMenu.then();
            setKeyMenu(null);
          }}
        />
      )}
    </Shell>
  );
};
