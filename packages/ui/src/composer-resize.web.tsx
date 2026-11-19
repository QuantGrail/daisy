import React, { useEffect, useRef } from "react";
import "./resizable.web.css";
import "./composer-resize.web.css";
import { t } from "./i18n";
import {
  composerResizeLabel,
  composerKeyAction,
  composerSlop,
} from "./composer-height";
import type { ComposerResizeBarProps } from "./composer-size";

// Geometry is inline so the bar works in a host page that ships no CSS; the
// stylesheet only adds the hover / focus / dragging look and the page cursor.
// An 18 px hit area over the box's top padding and 7 px of the gap above it.
const BAR: React.CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  top: -8,
  height: 18,
  boxSizing: "border-box",
  paddingBottom: 3,
  display: "flex",
  alignItems: "flex-end",
  justifyContent: "center",
  cursor: "ns-resize",
  touchAction: "none",
  outline: "none",
  zIndex: 1,
};
const PILL: React.CSSProperties = {
  width: "var(--composer-bar-width, 36px)",
  height: 4,
  borderRadius: 2,
  pointerEvents: "none",
  transition: "background-color 120ms ease, width 120ms ease",
};

/**
 * The composer's drag bar on the Web (native: composer-resize.tsx — on the
 * Web "./composer-resize" resolves to this file, so nothing is imported from
 * it; ./resizable.web has the pane handles this follows). The pointer is
 * captured; moves are applied once per frame straight to the textarea
 * (`size.drag.move`, no React render), and React gets the result once, when
 * the bar is let go. Meanwhile the page shows ns-resize and selects nothing.
 * A press that does not move is a click and changes nothing; a double click
 * (or Home) goes back to automatic height; ↑ / ↓ step. Only a release keeps
 * the new height: pointerup, or a mouse seen moving with no button down (its
 * pointerup went elsewhere — a context menu, another window). Anything else
 * that ends the drag (pointercancel, lost capture, the window losing focus,
 * the bar unmounting) puts the height back.
 */
export function ComposerResizeBar({
  size,
  color,
  accent,
}: ComposerResizeBarProps) {
  // Set while a drag is live: ends it and puts the height back. Runs when
  // the bar unmounts mid-drag — <html> must not keep `daisy-resizing`.
  const abort = useRef<(() => void) | null>(null);
  useEffect(() => () => abort.current?.(), []);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (abort.current) {
      // A second finger is not a new drag; a new primary press means the
      // last drag never saw its end.
      if (!e.isPrimary) return;
      abort.current();
    }
    e.preventDefault();
    const el = e.currentTarget;
    const { drag } = size;
    const id = e.pointerId;
    const mouse = e.pointerType === "mouse";
    const slop = composerSlop(e.pointerType);
    el.setPointerCapture(id);
    const y0 = e.clientY;
    let dy = 0;
    let moved = false;
    let frame = 0;
    let live = true;
    const root = document.documentElement;
    root.classList.add("daisy-resizing", "daisy-resizing-row");
    el.classList.add("is-dragging");
    drag.begin();
    const shown = (h: number) =>
      el.setAttribute("aria-valuenow", String(Math.round(h)));
    const paint = () => {
      frame = 0;
      shown(drag.move(dy));
    };
    const track = (ev: PointerEvent) => {
      const d = ev.clientY - y0;
      if (!moved && Math.abs(d) < slop) return;
      moved = true;
      dy = d;
    };
    // `keep`: let go (the height stays) or interrupted (it goes back). A
    // press that never moved is a click either way: nothing was changed.
    const finish = (keep: boolean) => {
      if (!live) return;
      live = false;
      abort.current = null;
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", cancel);
      el.removeEventListener("lostpointercapture", cancel);
      window.removeEventListener("blur", blur);
      if (frame) cancelAnimationFrame(frame);
      if (el.hasPointerCapture?.(id)) el.releasePointerCapture(id);
      root.classList.remove("daisy-resizing", "daisy-resizing-row");
      el.classList.remove("is-dragging");
      if (moved) shown(keep ? drag.end(dy) : drag.cancel());
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      if (mouse && ev.buttons === 0) return finish(true);
      track(ev);
      if (moved && !frame) frame = requestAnimationFrame(paint);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      track(ev);
      finish(true);
    };
    const cancel = (ev: PointerEvent) => {
      if (ev.pointerId === id) finish(false);
    };
    const blur = () => finish(false);
    abort.current = blur;
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", cancel);
    el.addEventListener("lostpointercapture", cancel);
    window.addEventListener("blur", blur);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const action = composerKeyAction(e.key);
    if (!action) return;
    e.preventDefault();
    size[action]();
  };
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={composerResizeLabel()}
      aria-valuenow={Math.round(size.height)}
      aria-valuemin={size.min}
      aria-valuemax={size.cap}
      tabIndex={0}
      title={t("ui-chat.composer.resizeTitle")}
      data-testid="composer-resize"
      className="daisy-composer-resize"
      style={{ ...BAR, "--composer-bar-accent": accent } as React.CSSProperties}
      onPointerDown={onPointerDown}
      onDoubleClick={() => size.reset()}
      onKeyDown={onKeyDown}
    >
      <span
        style={{ ...PILL, background: `var(--composer-bar-now, ${color})` }}
      />
    </div>
  );
}
