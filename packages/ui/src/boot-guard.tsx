/**
 * P6-27 (phase-5 re-acceptance P5N-7): the page never stays blank.
 *
 * - `withinBoot`: the first load waits at most `BOOT_LIMIT_MS` for Daisy;
 *   then the page stops waiting and shows its login screen with a message
 *   (the load may still finish later and let the page in).
 * - `BootGuard`: an error while drawing the page (a render exception would
 *   otherwise leave the root empty — a blank page under the title) shows a
 *   visible message, the error's own text and a reload button instead.
 *
 * The words come from the language pack (`ui.app.*`); before a pack is
 * loaded (Daisy never answered) only signs are shown (⚠, ↻), never keys.
 */
import React from "react";
import { Pressable, Text, View } from "react-native";
import { t, uiLanguageLoaded } from "./i18n";
import { defaultDaisyTheme } from "./theme";

// Outside any theme provider (it guards them too): the default look.
const C = defaultDaisyTheme.colors;

/** The most the first load waits for Daisy before it shows the login screen. */
export const BOOT_LIMIT_MS = 8000;

/** `p` within `ms`: "done" (settled — fulfilled or not), or "late". */
export function withinBoot(p: Promise<unknown>, ms = BOOT_LIMIT_MS): Promise<"done" | "late"> {
  return new Promise((ok) => {
    const timer = setTimeout(() => ok("late"), ms);
    p.then(
      () => {
        clearTimeout(timer);
        ok("done");
      },
      () => {
        clearTimeout(timer);
        ok("done");
      },
    );
  });
}

/** A pack's words, or nothing before one is loaded (never a raw key on screen). */
export const packText = (key: string, params?: Record<string, unknown>): string =>
  uiLanguageLoaded() && t.has(key) ? t.dynamic(key, params) : "";

interface GuardState {
  error: Error | null;
}

/**
 * Catches what the page throws while drawing. `reload` (tests) defaults to
 * reloading the page.
 */
export class BootGuard extends React.Component<
  { children?: React.ReactNode; reload?: () => void },
  GuardState
> {
  state: GuardState = { error: null };
  static getDerivedStateFromError(error: unknown): GuardState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
  componentDidCatch(error: unknown) {
    // Kept for whoever opens the console; nothing leaves the page.
    try {
      console.error("Daisy: the page failed to draw", error);
    } catch {}
  }
  private reload = () => {
    if (this.props.reload) return this.props.reload();
    try {
      window.location.reload();
    } catch {}
  };
  render() {
    const e = this.state.error;
    if (!e) return this.props.children ?? null;
    const title = packText("ui.app.crashed");
    const again = packText("ui.app.reload");
    return (
      <View
        testID="boot-crashed"
        style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: C.bg }}
      >
        <Text style={{ fontSize: 16, color: C.ink, marginBottom: 8, textAlign: "center" }}>
          {title ? `⚠ ${title}` : "⚠"}
        </Text>
        <Text selectable style={{ fontSize: 13, color: C.muted, marginBottom: 16, textAlign: "center" }}>
          {e.message || e.name}
        </Text>
        <Pressable
          testID="boot-reload"
          accessibilityRole="button"
          onPress={this.reload}
          style={{ paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8, backgroundColor: C.accent }}
        >
          <Text style={{ color: C.onAccent, fontSize: 14 }}>{again ? `↻ ${again}` : "↻"}</Text>
        </Pressable>
      </View>
    );
  }
}
