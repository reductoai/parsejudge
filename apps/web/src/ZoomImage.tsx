import type { Rect } from "@parsejudge/core/boxes";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./ax/Icon.tsx";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 8;
const ZOOM_STEP = 0.25;
const ZOOM_PRESETS = [8, 6, 4, 3, 2, 1.5];

const clamp = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
const FOCUS_MAX_ZOOM = 4;

/** Boxes to outline on the page; a new `at` zooms and scrolls to them again. */
export interface PageFocus {
  readonly rects: ReadonlyArray<Rect>;
  readonly at: number;
}

const bounds = (rects: ReadonlyArray<Rect>): Rect => {
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  return {
    left,
    top,
    width: Math.max(...rects.map((r) => r.left + r.width)) - left,
    height: Math.max(...rects.map((r) => r.top + r.height)) - top,
  };
};

/** − / percent menu / + controls, the same steps and presets as Studio's document viewer. */
export const ZoomControls = ({ zoom, onZoom }: { readonly zoom: number; readonly onZoom: (zoom: number) => void }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("mousedown", down);
    addEventListener("keydown", key);
    return () => {
      removeEventListener("mousedown", down);
      removeEventListener("keydown", key);
    };
  }, [open]);
  const pick = (next: number) => {
    onZoom(next);
    setOpen(false);
  };
  return (
    <div ref={ref} className="zoom-ctl">
      <div className="seg">
        <button type="button" aria-label="Zoom out" disabled={zoom <= MIN_ZOOM} onClick={() => onZoom(zoom - ZOOM_STEP)}>
          <Icon name="minus" />
        </button>
        <button type="button" className="zoom-pct" aria-label="Zoom presets" aria-expanded={open} onClick={() => setOpen(!open)}>
          {Math.round(zoom * 100)}%
        </button>
        <button type="button" aria-label="Zoom in" disabled={zoom >= MAX_ZOOM} onClick={() => onZoom(zoom + ZOOM_STEP)}>
          <Icon name="plus" />
        </button>
      </div>
      {open && (
        <div className="popover menu zoom-menu">
          {ZOOM_PRESETS.map((preset) => (
            <button key={preset} type="button" className="menu-row" onClick={() => pick(preset)}>
              {Math.round(preset * 100)}%{Math.abs(zoom - preset) < 0.001 && " ✓"}
            </button>
          ))}
          <button type="button" className="menu-row" onClick={() => pick(1)}>
            Reset
          </button>
        </div>
      )}
    </div>
  );
};

/** Zoom state for one viewport; `anchor` is the viewport point that stays fixed while zooming (default: its center). */
export const useZoom = () => {
  const viewport = useRef<HTMLDivElement>(null);
  const [zoom, setZoomState] = useState(1);
  const zoomRef = useRef(1);
  const pending = useRef<{ x: number; y: number; ratio: number; at: { x: number; y: number } } | null>(null);

  const setZoom = useCallback((target: number, anchor?: { x: number; y: number }) => {
    const el = viewport.current;
    const next = clamp(Math.round(target * 100) / 100);
    if (next === zoomRef.current) return;
    if (el !== null) {
      const at = anchor ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 };
      pending.current = { x: el.scrollLeft + at.x, y: el.scrollTop + at.y, ratio: next / zoomRef.current, at };
    }
    zoomRef.current = next;
    setZoomState(next);
  }, []);

  useLayoutEffect(() => {
    const el = viewport.current;
    const p = pending.current;
    if (el === null || p === null || zoom <= 0) return;
    pending.current = null;
    el.scrollLeft = p.x * p.ratio - p.at.x;
    el.scrollTop = p.y * p.ratio - p.at.y;
  }, [zoom]);

  return useMemo(() => ({ viewport, zoom, zoomRef, setZoom }), [zoom, setZoom]);
};

/** An image in a scrollable viewport: zoom from the controls or by pinching, drag to pan. `focus` outlines boxes and zooms to them. */
export const ZoomImage = ({
  src,
  alt,
  state: { viewport, zoom, zoomRef, setZoom },
  focus = null,
}: {
  readonly src: string;
  readonly alt: string;
  readonly state: ReturnType<typeof useZoom>;
  readonly focus?: PageFocus | null;
}) => {
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const pannable = zoom > 1;

  // Ctrl/⌘ + wheel and trackpad pinch (which browsers report as ctrl + wheel) zoom around the cursor.
  useEffect(() => {
    const el = viewport.current;
    if (el === null) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setZoom(zoomRef.current * Math.exp(-e.deltaY * 0.01), { x: e.clientX - r.left, y: e.clientY - r.top });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [viewport, zoomRef, setZoom]);

  useEffect(() => {
    const el = viewport.current;
    if (el === null || src === "") return;
    el.scrollTo({ left: 0, top: 0 });
  }, [src, viewport]);

  // Zoom until the boxes fill about half the viewport, then center them once the new zoom is laid out.
  useEffect(() => {
    const el = viewport.current;
    const img = el?.querySelector("img");
    if (el === null || img == null || focus === null || focus.rects.length === 0) return;
    const box = bounds(focus.rects);
    const aspect = img.naturalWidth > 0 ? img.naturalHeight / img.naturalWidth : 1.3;
    const fit = Math.min(0.6 / box.width, (0.5 * el.clientHeight) / (box.height * el.clientWidth * aspect));
    setZoom(Math.min(FOCUS_MAX_ZOOM, Math.max(1, fit)));
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const view = el.getBoundingClientRect();
        const page = img.getBoundingClientRect();
        el.scrollTo({
          left: el.scrollLeft + page.left - view.left + (box.left + box.width / 2) * page.width - el.clientWidth / 2,
          top: el.scrollTop + page.top - view.top + (box.top + box.height / 2) * page.height - el.clientHeight / 2,
          behavior: "smooth",
        });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [focus, viewport, setZoom]);

  return (
    <div
      ref={viewport}
      className={`zoom-view${pannable ? " pannable" : ""}${dragging ? " dragging" : ""}`}
      onPointerDown={(e) => {
        const el = viewport.current;
        if (!pannable || el === null || e.pointerType !== "mouse" || e.button !== 0) return;
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        const el = viewport.current;
        const d = drag.current;
        if (el === null || d === null) return;
        el.scrollLeft = d.left - (e.clientX - d.x);
        el.scrollTop = d.top - (e.clientY - d.y);
      }}
      onPointerUp={() => {
        drag.current = null;
        setDragging(false);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
      }}
    >
      <div className="zoom-page" style={{ width: `${zoom * 100}%` }}>
        <img src={src} alt={alt} draggable={false} />
        {focus?.rects.map((r) => (
          <div
            key={`${r.left},${r.top}`}
            className="source-box"
            style={{
              left: `calc(${r.left * 100}% - 2px)`,
              top: `calc(${r.top * 100}% - 2px)`,
              width: `calc(${r.width * 100}% + 4px)`,
              height: `calc(${r.height * 100}% + 4px)`,
            }}
          />
        ))}
      </div>
    </div>
  );
};
