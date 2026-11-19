import { useMemo, useRef } from "react";
import { PanResponder, View } from "react-native";

import { composerResizeLabel, composerSlop } from "./composer-height";
import type { ComposerResizeBarProps } from "./composer-size";

/**
 * The drag bar on the composer's top edge (./composer-height). It lies over
 * the box's top padding and a few px of the gap above it, so it takes no
 * room of its own. Native: PanResponder, a render per move; a tap (under
 * `composerSlop` of movement) changes nothing. The Web has its own
 * (composer-resize.web.tsx: pointer capture, no render while dragging).
 */
export function ComposerResizeBar({ size, color }: ComposerResizeBarProps) {
  const { drag } = size;
  const moved = useRef(false);
  const pan = useMemo(() => {
    const slop = composerSlop();
    const track = (dy: number) => (moved.current ||= Math.abs(dy) >= slop);
    const end = (dy: number) => {
      if (track(dy)) drag.end(dy);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        moved.current = false;
        drag.begin();
      },
      onPanResponderMove: (_, g) => {
        if (track(g.dy)) drag.move(g.dy);
      },
      onPanResponderRelease: (_, g) => end(g.dy),
      onPanResponderTerminate: (_, g) => end(g.dy),
    });
  }, [drag]);
  return (
    <View
      testID="composer-resize"
      role="separator"
      accessibilityLabel={composerResizeLabel()}
      aria-orientation="horizontal"
      aria-valuenow={Math.round(size.height)}
      aria-valuemin={size.min}
      aria-valuemax={size.cap}
      // Upward only: below it is the input, which must take its own taps.
      hitSlop={{ top: 8 }}
      {...pan.panHandlers}
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: -8,
        height: 18,
        zIndex: 1,
        alignItems: "center",
        justifyContent: "flex-end",
        paddingBottom: 3,
      }}
    >
      <View
        style={{
          width: 36,
          height: 4,
          borderRadius: 2,
          backgroundColor: color,
        }}
      />
    </View>
  );
}
