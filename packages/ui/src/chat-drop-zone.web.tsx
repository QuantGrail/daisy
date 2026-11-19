import React, { useEffect, useRef, useState } from "react";
import { dropKey, type DropNode, type DropTarget } from "./chat-drop.web";
import { dragHasFiles } from "./paste-files";
import { hostConventions } from "./host-conventions";
import { t as tr } from "./i18n";

/**
 * An AI conversation as one drop target (Web): while files are dragged over
 * it an overlay covers the conversation they would go to
 * (「松开即可添加到当前对话」 + its name), and a drop anywhere in it is handed
 * to that conversation's composer as a drop of its own — the composer's
 * upload, limits, error messages and pending row, unchanged. A drop the
 * composer took itself is left alone. Anywhere else in the document a file
 * drop is refused (no navigation to the file). Drags that start in the page
 * (text, links, images, 置顶 rows) are not touched.
 */
interface Shown {
  key: string;
  target: DropTarget;
  ready: boolean;
  rect: { left: number; top: number; width: number; height: number };
}

/** Our own forwarded events (they bubble up to the window too). */
let forwarding = false;
function forward(
  el: Element,
  type: "dragover" | "drop" | "dragleave",
  files: readonly File[],
): boolean {
  if (typeof DataTransfer === "undefined" || typeof DragEvent === "undefined")
    return false;
  let ev: DragEvent;
  try {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    ev = new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      dataTransfer: dt,
    });
  } catch {
    return false;
  }
  forwarding = true;
  try {
    el.dispatchEvent(ev);
  } finally {
    forwarding = false;
  }
  return ev.defaultPrevented;
}
/** During a drag the files cannot be read: a stand-in says "files". */
const probe = () =>
  typeof File === "undefined" ? [] : [new File([""], "probe.txt")];

type Resolve = (
  target: EventTarget | null,
  root: HTMLElement,
) => {
  page: HTMLElement | null;
  box: DropNode | null;
  target: DropTarget;
  composer: Element | null;
};

/**
 * The window listeners and the overlay's state for one drop zone; `root`
 * finds the zone's element from the marker (null: this zone is off).
 */
function useDropZone(
  marker: React.RefObject<HTMLSpanElement | null>,
  root: (marker: HTMLElement) => HTMLElement | null,
  resolveRef: React.RefObject<Resolve>,
  notify: React.RefObject<(message: string) => void>,
) {
  const [shown, setShown] = useState<Shown | null>(null);
  const live = useRef<Shown | null>(null);
  live.current = shown;
  useEffect(() => {
    const m = marker.current;
    const zone = m ? root(m) : null;
    if (typeof document === "undefined" || !zone) return;
    // On the document, not the window: a host's window guard (Daisy
    // App.tsx, a host's own entry) prevents every file drop's default, and
    // must run after us, or `before` below could not tell a composer's no.
    let inside = false; // a drag that started in this document
    let idle: ReturnType<typeof setTimeout> | undefined;
    let lit: Element | null = null; // the composer told about the drag
    const unlight = () => {
      if (lit) forward(lit, "dragleave", []);
      lit = null;
    };
    const hide = () => {
      clearTimeout(idle);
      unlight();
      if (live.current) {
        live.current = null;
        setShown(null);
      }
    };
    const resolve = (t: EventTarget | null) => resolveRef.current(t, zone);
    const onStart = () => {
      inside = true;
    };
    const onEnd = () => {
      inside = false;
      hide();
    };
    const onOver = (e: DragEvent) => {
      if (forwarding || inside || !dragHasFiles(e.dataTransfer)) return;
      // Never let the browser open the file, wherever it is let go.
      e.preventDefault();
      const r = resolve(e.target);
      // Can the composer take files now (not uploading, not 在终端执行…)?
      const ready = !!r.composer && forward(r.composer, "dragover", probe());
      if (r.composer !== lit) {
        unlight();
        if (ready) lit = r.composer;
      }
      if (e.dataTransfer) e.dataTransfer.dropEffect = ready ? "copy" : "none";
      clearTimeout(idle);
      // No dragover for a while (Esc, left the window without a dragleave).
      idle = setTimeout(hide, 800);
      if (!r.page || !r.box || (r.target.kind === "none" && !r.target.hint)) {
        if (live.current) {
          live.current = null;
          setShown(null);
        }
        return;
      }
      const key = dropKey(r.target, ready);
      const box = (r.box as unknown as Element).getBoundingClientRect(),
        at = r.page.getBoundingClientRect();
      const rect = {
        left: box.left - at.left,
        top: box.top - at.top,
        width: box.width,
        height: box.height,
      };
      const was = live.current;
      if (
        was &&
        was.key === key &&
        was.rect.left === rect.left &&
        was.rect.top === rect.top &&
        was.rect.width === rect.width &&
        was.rect.height === rect.height
      )
        return;
      const next = { key, target: r.target, ready, rect };
      live.current = next;
      setShown(next);
    };
    const onLeave = (e: DragEvent) => {
      // Out of the window (no element to go to); inner enter / leave pairs
      // are ignored — the overlay follows dragover only, so it never flickers.
      if (!forwarding && !e.relatedTarget) {
        clearTimeout(idle);
        idle = setTimeout(hide, 60);
      }
    };
    const onDrop = (e: DragEvent) => {
      if (forwarding || inside || !dragHasFiles(e.dataTransfer)) return;
      // Not by defaultPrevented: a host's window guard may have set it.
      const before = e.defaultPrevented;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files || []);
      const r = resolve(e.target);
      hide();
      if (!files.length) return;
      if (r.target.kind === "none") {
        if (r.target.hint) notify.current(r.target.hint);
        return;
      }
      // Let go on the composer itself: it had the drop (took it, or said no).
      const onComposer =
        !!r.composer &&
        e.target instanceof Node &&
        r.composer.contains(e.target);
      if (
        onComposer
          ? !before
          : !r.composer || !forward(r.composer, "drop", files)
      )
        notify.current(tr("ui-chat.drop.blocked"));
    };
    window.addEventListener("dragstart", onStart, true);
    window.addEventListener("dragend", onEnd, true);
    document.addEventListener("dragover", onOver);
    document.addEventListener("dragleave", onLeave);
    document.addEventListener("drop", onDrop);
    return () => {
      hide();
      window.removeEventListener("dragstart", onStart, true);
      window.removeEventListener("dragend", onEnd, true);
      document.removeEventListener("dragover", onOver);
      document.removeEventListener("dragleave", onLeave);
      document.removeEventListener("drop", onDrop);
    };
  }, [marker, root, resolveRef, notify]);
  return shown;
}

function Overlay({ shown }: { shown: Shown | null }) {
  const t = shown?.target;
  if (!shown || !t) return null;
  // P4-13: the host's stylesheet names (host-conventions.ts).
  const P = hostConventions().dropClassPrefix;
  return (
    <div
      className={`${P}-overlay${t.kind === "none" || !shown.ready ? " is-off" : ""}`}
      data-testid="chat-drop-overlay"
      data-drop-target={t.kind}
      role="status"
      aria-live="polite"
      style={shown.rect}
    >
      <div className={`${P}-card`}>
        {t.kind === "none" ? (
          <div className={`${P}-title`}>{t.hint}</div>
        ) : shown.ready ? (
          <>
            <div className={`${P}-title`}>{tr("ui-chat.drop.release")}</div>
            <div className={`${P}-name`}>{t.title}</div>
            {t.note ? <div className={`${P}-note`}>{t.note}</div> : null}
            <div className={`${P}-note`}>{tr("ui-chat.drop.limits")}</div>
          </>
        ) : (
          <>
            <div className={`${P}-title`}>{tr("ui-chat.drop.blocked")}</div>
            <div className={`${P}-name`}>{t.title}</div>
          </>
        )}
      </div>
    </div>
  );
}

/** An AI conversation's view takes the files dropped anywhere on it. */
const sessionRoot = (m: HTMLElement) => m.parentElement;

/**
 * An AI conversation (chat.tsx; the Daisy app's 「chat」 page): the whole
 * view takes the files for its composer.
 */
export function SessionDropZone({
  title,
  onError,
}: {
  title: string;
  onError: (message: string) => void;
}) {
  const marker = useRef<HTMLSpanElement>(null);
  const resolveRef = useRef<Resolve>(null as unknown as Resolve);
  resolveRef.current = (target, root) => ({
    page: root,
    box:
      target instanceof Node && root.contains(target)
        ? (root as unknown as DropNode)
        : null,
    target: { kind: "session", title: title || tr("ui-chat.drop.untitled") },
    composer: root.querySelector(SESSION_INPUT),
  });
  const notify = useRef(onError);
  notify.current = onError;
  const shown = useDropZone(marker, sessionRoot, resolveRef, notify);
  return (
    <>
      <span ref={marker} hidden />
      <Overlay shown={shown} />
    </>
  );
}
const SESSION_INPUT = '[data-testid="composer"]';
