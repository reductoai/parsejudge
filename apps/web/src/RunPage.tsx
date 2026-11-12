import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { api, type CellDone, currentUser, type Preset, type Run } from "./api.ts";
import { Icon } from "./ax/Icon.tsx";
import { ContinueRun } from "./ContinueRun.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { DeleteRun } from "./DeleteRun.tsx";
import { Go, Shell } from "./Nav.tsx";
import { presetTones, shortName } from "./names.ts";
import { Report, SmallSampleNotice } from "./Report.tsx";
import { ShareDialog } from "./Share.tsx";

export const runTitle = (run: Run) => {
  if (run.title) return run.title;
  const names = run.documents.map((d) => d.filename.replace(/\.[^.]+$/, ""));
  if (names.length <= 2) return names.join(" and ");
  return `${names.length} documents`;
};

const elapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Up to 90 tiles, filled left to right by the share done; the next few pulse while the row runs. */
const Tiles = ({ done, of, running }: { readonly done: number; readonly of: number; readonly running: boolean }) => {
  const count = Math.max(1, Math.min(of, 90));
  const per = of / count;
  return (
    <div className="rv-tiles" style={{ "--tiles": count } as CSSProperties}>
      {Array.from({ length: count }, (_, j) => {
        const hi = Math.min(of, Math.round((j + 1) * per));
        const state =
          of > 0 && hi <= done ? "is-done" : running && j * per < done + 3 * per && j * per >= done - per ? "is-run" : undefined;
        return <span key={hi} className={state} />;
      })}
    </div>
  );
};

const Pill = ({ state, label }: { readonly state: "done" | "run" | "wait"; readonly label: string }) =>
  state === "done" ? (
    <span className="rv-pill is-done">
      <Icon name="check" />
      Done
    </span>
  ) : state === "run" ? (
    <span className="rv-pill is-run">
      <span className="spin" />
      {label}
    </span>
  ) : (
    <span className="rv-pill">{label}</span>
  );

/** The load state while a run is in flight: live counts from the run's event socket, and Continue for the owner. */
const Progress = ({
  run,
  presets,
  onDone,
}: {
  readonly run: Run;
  readonly presets: ReadonlyArray<Preset>;
  readonly onDone: () => void;
}) => {
  const [cells, setCells] = useState<ReadonlyMap<string, CellDone>>(new Map());
  const [judged, setJudged] = useState(0);
  const [startedPresets, setStartedPresets] = useState<ReadonlySet<string>>(new Set());
  const [now, setNow] = useState(Date.now());
  const pages = run.documents.reduce((n, d) => n + d.pages.length, 0);

  useEffect(() => {
    const key = (c: CellDone) => `${c.presetId}:${c.pageId}`;
    return api.events(run.id, (event) => {
      if (event.type === "progress") {
        setCells(new Map(event.cells.map((c) => [key(c), c])));
        setStartedPresets(new Set(event.started ?? []));
        setJudged(event.done);
      } else if (event.type === "parse_started") setStartedPresets((s) => new Set(s).add(event.presetId));
      else if (event.type === "parse_done") setCells((m) => new Map(m).set(key(event), event));
      else if (event.type === "page_done") setJudged(event.done);
      else onDone();
    });
  }, [run.id, onDone]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const all = [...cells.values()];
  const total = pages * run.presetIds.length;
  const judgeDone = pages > 0 && judged === pages;
  const pct = total === 0 ? 0 : Math.floor(((all.length + judged) / (total + pages)) * 100);
  const user = currentUser();
  const tones = presetTones(run.presetIds);
  const fm = (n: number) => n.toLocaleString("en-US");

  return (
    <div className="page rv-page">
      <SmallSampleNotice pages={pages} />
      <div className="rv-head">
        <h1>{runTitle(run)}</h1>
        <div className="rv-pct" aria-live="polite">
          {pct}
          <span className="rv-u">%</span>
        </div>
      </div>
      <div className="rv-prog">
        <div className="rv-bar">
          <span style={{ width: `${pct}%` }} />
        </div>
        <div className="rv-line">
          <span className="rv-state">
            <span className="spin" />
            {pages === 0 ? "Preparing pages" : judgeDone ? "Summarizing" : "Running"}
          </span>
          <span>{elapsed(now - run.createdAt)}</span>
          <span className="sp" />
          <span>
            {fm(all.length)} of {fm(total)} parses · {fm(judged)} of {fm(pages)} pages judged
          </span>
        </div>
      </div>

      <div className="rv-board">
        {run.presetIds.map((id) => {
          const preset = presets.find((p) => p.id === id);
          const mine = all.filter((c) => c.presetId === id);
          const failed = mine.filter((c) => !c.ok).length;
          const finished = pages > 0 && mine.length === pages;
          const running = !finished && (mine.length > 0 || startedPresets.has(id));
          return (
            <div key={id} className={`rv-row s-${tones.get(id) ?? "ink"}`}>
              <div className="rv-name">
                <span className="n">{preset ? shortName(preset.provider) : id}</span>
                {preset && <span className="m">{preset.mode}</span>}
                {failed > 0 && <span className="m rv-bad">{failed} failed</span>}
              </div>
              <Tiles done={mine.length} of={pages} running={running} />
              <div className="rv-done">
                {fm(mine.length)}
                <span className="of">/{fm(pages)}</span>
              </div>
              <div className="rv-st">
                <Pill state={finished ? "done" : running ? "run" : "wait"} label={running ? "Parsing" : "Queued"} />
              </div>
            </div>
          );
        })}
        <div className="rv-row is-judge">
          <div className="rv-name">
            <span className="n">Judge</span>
            <span className="m">{run.judgeModel.replace(/^.*\//, "")}</span>
          </div>
          <Tiles done={judged} of={pages} running={judged > 0 && !judgeDone} />
          <div className="rv-done">
            {fm(judged)}
            <span className="of">/{fm(pages)}</span>
          </div>
          <div className="rv-st">
            <Pill state={judgeDone ? "done" : judged > 0 ? "run" : "wait"} label={judged > 0 ? "Judging" : "Waiting"} />
          </div>
        </div>
      </div>

      <div className="rv-foot">
        <span>Safe to close this tab.{user && ` We'll email ${user} when the report is ready.`}</span>
        <div className="lp-acts">
          {run.owned && pages > 0 && <ContinueRun runId={run.id} skip={pages - judged} onDone={onDone} />}
          <CopyButton text={`${location.origin}/r/${run.shareId}`} label="Copy link" icon="link" />
        </div>
      </div>
    </div>
  );
};

export const RunPage = ({ shareId }: { readonly shareId: string }) => {
  const [run, setRun] = useState<Run | null>(null);
  const [presets, setPresets] = useState<Awaited<ReturnType<typeof api.presets>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [reveal, setReveal] = useState("");
  const waited = useRef(false);

  const load = useCallback(() => {
    api
      .shared(shareId)
      .then(setRun, (e: unknown) =>
        setError(String(e).includes("404") ? "This run was deleted or the link is wrong." : String(e)),
      );
  }, [shareId]);

  useEffect(() => {
    load();
    api.presets().then(setPresets, () => {});
  }, [load]);

  const finished = run !== null && (run.status === "succeeded" || run.status === "failed") && run.summary !== null;
  const live = run !== null && !finished && run.status !== "failed";
  if (live) waited.current = true;
  /* a run that finishes while open: the load state fades out, then the report rises in */
  useEffect(() => {
    if (!finished || !waited.current) return;
    setReveal("is-pre");
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setReveal("is-in")));
    const timer = setTimeout(() => setReveal(""), 700);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [finished]);

  const title = run ? runTitle(run) : "";
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);
  const topbar = (
    <div className="topbar">
      <nav className="crumb tb-crumb" aria-label="Breadcrumb">
        <Go to="/">Parse Judge</Go>
        <span className="sep">/</span>
        <span className="cur">{title}</span>
      </nav>
      {run && (
        <div className="topbar-actions">
          {run.owned && finished && <DeleteRun runId={run.id} dataDeleted={run.dataDeletedAt !== null} />}
          <button className="btn" type="button" onClick={() => setSharing(true)}>
            <Icon name="link" />
            <span className="btn-label">Share</span>
          </button>
        </div>
      )}
    </div>
  );
  return (
    <Shell topbar={topbar} label="Evaluation report">
      {error && (
        <div className="empty-state">
          <div className="es-title">{error}</div>
        </div>
      )}
      {run?.status === "failed" && run.summary === null && (
        <div className="empty-state">
          <div className="es-title">This run failed: {run.error ?? "unknown error"}</div>
        </div>
      )}
      {run && finished && <Report run={run} presets={presets} title={title} reveal={reveal} />}
      {run && live && <Progress run={run} presets={presets} onDone={load} />}
      {run && sharing && (
        <ShareDialog
          runId={run.id}
          shareId={run.shareId}
          visibility={run.visibility}
          shareContent={run.shareContent}
          owned={run.owned}
          onClose={() => setSharing(false)}
          onChange={(c) => {
            setRun({ ...run, ...c });
            if (c.shareId !== run.shareId) history.replaceState(null, "", `/r/${c.shareId}`);
          }}
        />
      )}
    </Shell>
  );
};
