import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Platform, useWindowDimensions, type TextInput } from "react-native";

import {
  COMPOSER_KEY,
  COMPOSER_MIN,
  COMPOSER_STEP,
  composerCap,
  composerDrag,
  composerHeight,
  storedComposerFloor,
} from "./composer-height";
import { readMigrated } from "./storage-keys";

const WEB = Platform.OS === "web";

function load(): number | null {
  if (!WEB) return null;
  try {
    return storedComposerFloor(readMigrated(window.localStorage, COMPOSER_KEY));
  } catch {
    return null;
  }
}

function save(v: number | null) {
  if (!WEB) return;
  try {
    if (v == null) window.localStorage.removeItem(COMPOSER_KEY);
    else window.localStorage.setItem(COMPOSER_KEY, String(Math.round(v)));
  } catch {
    /* private mode: this page only */
  }
}

/** One drag of the bar; `dy` is the pointer's distance from where it began. */
export interface ComposerDrag {
  begin(): void;
  /** While it moves: the height shown now. Web: no React render. */
  move(dy: number): number;
  /** Let go: keep (and remember) the height, which is returned. */
  end(dy: number): number;
  /** Interrupted, not let go: back to the height before it, returned. */
  cancel(): number;
}

export interface ComposerSize {
  height: number;
  min: number;
  cap: number;
  /** A floor is kept (the box was pulled taller than its text). */
  pulled: boolean;
  onContentSizeChange: (e: {
    nativeEvent: { contentSize: { height: number } };
  }) => void;
  drag: ComposerDrag;
  grow(): void;
  shrink(): void;
  reset(): void;
}

/** The drag bar: ./composer-resize (native) and its .web twin. */
export interface ComposerResizeBarProps {
  size: ComposerSize;
  /** The bar at rest. */
  color: string;
  /** Hovered, focused or dragged (Web). */
  accent: string;
}

/**
 * `onLive`: the box changed height without a render (a drag on the Web),
 * e.g. to keep the conversation above pinned to its end.
 */
export function useComposerHeight(
  input: React.RefObject<TextInput | null>,
  text: string,
  onLive?: () => void,
): ComposerSize {
  const { height: wh, width: ww } = useWindowDimensions();
  const cap = composerCap(wh);
  const [content, setContent] = useState(COMPOSER_MIN);
  const [floor, setFloor] = useState<number | null>(load);
  const height = composerHeight(content, floor, cap);
  const live = useRef({ height, cap, content, floor, onLive });
  live.current = { height, cap, content, floor, onLive };
  // Web, while dragging: the height written straight to the textarea. React
  // still holds the height from before the drag, so nothing above re-renders
  // per frame; `end` hands the result to React once.
  const dragged = useRef<number | null>(null);
  const paint = useCallback(
    (h: number) => {
      const el = input.current as unknown as HTMLTextAreaElement | null;
      if (el?.style) el.style.height = `${h}px`;
    },
    [input],
  );
  // A render during a drag (the Agent is streaming) must not undo it.
  useLayoutEffect(() => {
    if (WEB && dragged.current != null) paint(dragged.current);
  });
  // Web: a textarea's scrollHeight never shrinks below its own height, so
  // measure with the height collapsed (classic auto-size), then restore.
  useLayoutEffect(() => {
    if (!WEB) return;
    const el = input.current as unknown as HTMLTextAreaElement | null;
    if (!el?.style) return;
    const prev = el.style.height;
    el.style.height = "0px";
    const h = el.scrollHeight;
    el.style.height = prev;
    setContent(h);
  }, [input, text, ww]);
  const onContentSizeChange = useCallback(
    (e: { nativeEvent: { contentSize: { height: number } } }) => {
      if (!WEB) setContent(e.nativeEvent.contentSize.height);
    },
    [],
  );
  const keep = useCallback((next: number | null) => {
    setFloor(next);
    save(next);
  }, []);
  // Where the drag began: the height shown and the floor kept then.
  const start = useRef<{ height: number; floor: number | null }>({
    height: COMPOSER_MIN,
    floor: null,
  });
  const drag = useMemo<ComposerDrag>(() => {
    const at = (dy: number) =>
      composerDrag(
        start.current.height,
        dy,
        live.current.content,
        live.current.cap,
        start.current.floor,
      );
    return {
      begin() {
        start.current = {
          height: live.current.height,
          floor: live.current.floor,
        };
      },
      move(dy) {
        const next = at(dy);
        if (!WEB) setFloor(next.floor);
        else if (dragged.current !== next.height) {
          dragged.current = next.height;
          paint(next.height);
          live.current.onLive?.();
        }
        return next.height;
      },
      end(dy) {
        const next = at(dy);
        if (WEB) {
          dragged.current = null;
          paint(next.height);
          live.current.onLive?.();
        }
        keep(next.floor);
        return next.height;
      },
      cancel() {
        const h = composerHeight(
          live.current.content,
          start.current.floor,
          live.current.cap,
        );
        if (!WEB) setFloor(start.current.floor);
        else if (dragged.current != null) {
          dragged.current = null;
          paint(h);
          live.current.onLive?.();
        }
        return h;
      },
    };
  }, [keep, paint]);
  const nudge = useCallback(
    (delta: number) =>
      keep(
        composerDrag(
          live.current.height,
          -delta,
          live.current.content,
          live.current.cap,
          live.current.floor,
        ).floor,
      ),
    [keep],
  );
  const grow = useCallback(() => nudge(COMPOSER_STEP), [nudge]);
  const shrink = useCallback(() => nudge(-COMPOSER_STEP), [nudge]);
  const reset = useCallback(() => keep(null), [keep]);
  return {
    height,
    min: COMPOSER_MIN,
    cap,
    pulled: floor != null,
    onContentSizeChange,
    drag,
    grow,
    shrink,
    reset,
  };
}
