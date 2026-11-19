import { ACP_COLORS } from "@daisy-ai/contracts";
import React, { createContext, useContext, useMemo } from "react";
import { Platform, StyleSheet } from "react-native";
import { daisyPhaseTone } from "./present";

/** Every colour the UI paints. Defaults reproduce the original Daisy look. */
export interface DaisyColors {
  /** Page / secondary background. */
  bg: string;
  /** Cards, dialogs, chat surface. */
  paper: string;
  /** Primary text. */
  ink: string;
  /** Secondary text. */
  muted: string;
  /** Hints, timestamps, placeholders. */
  faint: string;
  /** Hairline borders and dividers. */
  line: string;
  /** Stronger border (composer at rest). */
  lineStrong: string;
  /** Brand / primary action colour. */
  accent: string;
  /** Text and spinners drawn on `accent`. */
  onAccent: string;
  /** Accent-tinted background (soft buttons, selection, quotes). */
  soft: string;
  /**
   * Keyboard focus ring (web :focus-visible) on every focusable control, so
   * a host can match its own ring (e.g. an indigo brand) instead of the
   * browser's default black outline.
   */
  focusRing: string;
  /** "In progress" colour (activity track). */
  blue: string;
  /** Success: completed status chips. */
  green: string;
  /** Neutral status chips (not started, interrupted). */
  neutral: string;
  red: string;
  /** Error box and danger button background. */
  redSoft: string;
  orange: string;
  /** Tool-authorization card background. */
  orangeSoft: string;
  /** Tool-authorization card border. */
  orangeLine: string;
  /** DaisyApp navigation column. */
  sidebar: string;
  sidebarPressed: string;
  sidebarSelected: string;
  avatar: string;
  /** Modal scrim (8-digit hex with alpha is fine). */
  overlay: string;
  userBubble: string;
  /** Task banner, activity detail panel. */
  surfaceAlt: string;
  /** Composer and expanded picker panels. */
  field: string;
  code: string;
  codeInline: string;
  codeInk: string;
  trackDone: string;
  trackRunning: string;
  terminalBg: string;
  terminalInk: string;
  terminalMuted: string;
  terminalKey: string;
  terminalKeyInk: string;
  /** Wide-screen login hero panel. */
  heroBg: string;
  heroInk: string;
  heroAccent: string;
  heroMuted: string;
  heroLine: string;
  heroChip: string;
  heroFaint: string;
}
export interface DaisyRadius {
  /** Badges (5 by default). */
  sm: number;
  /** Buttons and inputs (9). */
  md: number;
  /** Cards (14). */
  lg: number;
  /** Dialogs (20). */
  xl: number;
}
export interface DaisyTheme {
  colors: DaisyColors;
  /** Accent colour per Agent kind. */
  agents: Record<string, string>;
  /** Anchor radii; every other radius in the UI is interpolated between them. */
  radius: DaisyRadius;
  font: { family?: string; mono: string };
  /** Spacing multiplier for paddings/gaps (1 = original, 0.85 = compact). */
  density: number;
}
export type DaisyThemeInput = {
  colors?: Partial<DaisyColors>;
  agents?: Record<string, string>;
  radius?: Partial<DaisyRadius>;
  font?: Partial<DaisyTheme["font"]>;
  density?: number;
};

const webFont =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

export const defaultDaisyTheme: DaisyTheme = {
  colors: {
    bg: "#f6f8f9",
    paper: "#ffffff",
    ink: "#172a33",
    muted: "#71828b",
    faint: "#9aa6ad",
    line: "#e4eaed",
    lineStrong: "#d6e1e3",
    accent: "#137d70",
    onAccent: "#ffffff",
    soft: "#e8f4ef",
    focusRing: "#137d70",
    blue: "#437ad5",
    green: "#2f8a57",
    neutral: "#71828b",
    red: "#bf5056",
    redSoft: "#fff1ef",
    orange: "#ae7430",
    orangeSoft: "#fffaf0",
    orangeLine: "#e6d0a4",
    sidebar: "#f1f5f4",
    sidebarPressed: "#e7eeeb",
    sidebarSelected: "#ffffff",
    avatar: "#dce9e3",
    overlay: "#10232966",
    userBubble: "#eaf1f2",
    surfaceAlt: "#f5f8f8",
    field: "#fcfdfd",
    code: "#f2f5f7",
    codeInline: "#eaf0f3",
    codeInk: "#415669",
    trackDone: "#b1d9cc",
    trackRunning: "#c1d4e9",
    terminalBg: "#10202a",
    terminalInk: "#d7e4ea",
    terminalMuted: "#b6c7cf",
    terminalKey: "#223844",
    terminalKeyInk: "#d5e4e9",
    heroBg: "#133b36",
    heroInk: "#ffffff",
    heroAccent: "#b9dbce",
    heroMuted: "#9fbeb3",
    heroLine: "#3a5b51",
    heroChip: "#d5e7df",
    heroFaint: "#7f9f94",
  },
  // P4-10: every ACP harness's colour from its entry (Kimi #7367b2).
  agents: { claude: "#bb785c", codex: "#4f7eb7", ...ACP_COLORS },
  radius: { sm: 5, md: 9, lg: 14, xl: 20 },
  font: {
    family: Platform.OS === "web" ? webFont : undefined,
    mono: "monospace",
  },
  density: 1,
};

/** Merge a partial theme over the default (or over `base`). */
export function createDaisyTheme(
  input: DaisyThemeInput = {},
  base: DaisyTheme = defaultDaisyTheme,
): DaisyTheme {
  return {
    colors: { ...base.colors, ...input.colors },
    agents: { ...base.agents, ...input.agents },
    radius: { ...base.radius, ...input.radius },
    font: { ...base.font, ...input.font },
    density: input.density ?? base.density,
  };
}

function hex(c: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c.trim());
  if (!m) return null;
  const h =
    m[1].length === 3
      ? m[1]
          .split("")
          .map((x) => x + x)
          .join("")
      : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}
/** Blend `a` toward `b` by `t` (0 = a, 1 = b). Non-hex input returns `a`. */
export function mixColor(a: string, b: string, t: number) {
  const x = hex(a),
    y = hex(b);
  if (!x || !y) return a;
  return (
    "#" +
    x
      .map((v, i) =>
        Math.round(v + (y[i] - v) * t)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}
/**
 * Append an alpha byte (two hex digits) to a hex colour, as the original
 * `color + "16"` tints did. Theme colours used for tints must be #rgb/#rrggbb;
 * anything else yields a transparent tint rather than an opaque block.
 */
export function withAlpha(color: string, alpha: string) {
  const rgb = hex(color);
  return rgb
    ? "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("") + alpha
    : "transparent";
}

/** The handful of brand tokens most design systems already define. */
export interface DaisyBrandTokens {
  background: string;
  surface: string;
  text: string;
  mutedText: string;
  faintText?: string;
  border: string;
  primary: string;
  primarySoft?: string;
  onPrimary?: string;
  /** Secondary fill (code blocks, table headers). */
  subtle?: string;
  info?: string;
  danger?: string;
  warning?: string;
  /** Completed status chips; defaults to a green. */
  success?: string;
  /** Not-started / interrupted status chips; defaults to `mutedText`. */
  neutral?: string;
  /** Keyboard focus ring colour; defaults to `primary`. */
  focusRing?: string;
  /** Button/input radius; other radii scale from it. */
  radius?: number;
  /** Card radius, if the design system defines it separately. */
  cardRadius?: number;
  fontFamily?: string;
  monoFontFamily?: string;
  density?: number;
  agents?: Record<string, string>;
}
/** Derive a complete Daisy theme from a host design system's core tokens. */
export function daisyThemeFromTokens(t: DaisyBrandTokens): DaisyTheme {
  const d = defaultDaisyTheme,
    red = t.danger || d.colors.red,
    orange = t.warning || d.colors.orange,
    blue = t.info || d.colors.blue,
    soft = t.primarySoft || mixColor(t.primary, t.surface, 0.9),
    subtle = t.subtle || mixColor(t.background, t.border, 0.5),
    md = t.radius ?? d.radius.md,
    lg = t.cardRadius ?? Math.round((md * d.radius.lg) / d.radius.md);
  return createDaisyTheme({
    colors: {
      bg: t.background,
      paper: t.surface,
      ink: t.text,
      muted: t.mutedText,
      faint: t.faintText || mixColor(t.mutedText, t.surface, 0.35),
      line: t.border,
      lineStrong: mixColor(t.border, t.mutedText, 0.15),
      accent: t.primary,
      onAccent: t.onPrimary || "#ffffff",
      soft,
      focusRing: t.focusRing || t.primary,
      blue,
      green: t.success || "#16a34a",
      neutral: t.neutral || t.mutedText,
      red,
      redSoft: mixColor(red, t.surface, 0.93),
      orange,
      orangeSoft: mixColor(orange, t.surface, 0.95),
      orangeLine: mixColor(orange, t.surface, 0.6),
      sidebar: t.background,
      sidebarPressed: subtle,
      sidebarSelected: t.surface,
      avatar: soft,
      overlay: withAlpha(t.text, "66"),
      userBubble: soft,
      surfaceAlt: mixColor(t.background, t.surface, 0.4),
      field: t.surface,
      code: t.background,
      codeInline: subtle,
      codeInk: mixColor(t.text, t.mutedText, 0.4),
      trackDone: mixColor(t.primary, t.surface, 0.6),
      trackRunning: mixColor(blue, t.surface, 0.65),
      heroBg: mixColor(t.primary, "#000000", 0.45),
      heroAccent: mixColor(t.primary, "#ffffff", 0.7),
      heroMuted: mixColor(t.primary, "#ffffff", 0.55),
      heroLine: mixColor(t.primary, "#000000", 0.2),
      heroChip: mixColor(t.primary, "#ffffff", 0.8),
      heroFaint: mixColor(t.primary, "#ffffff", 0.35),
    },
    agents: t.agents,
    radius: {
      sm: Math.max(2, Math.round((md * d.radius.sm) / d.radius.md)),
      md,
      lg,
      xl: Math.max(lg, Math.round((lg * d.radius.xl) / d.radius.lg)),
    },
    font: {
      ...(t.fontFamily ? { family: t.fontFamily } : {}),
      ...(t.monoFontFamily ? { mono: t.monoFontFamily } : {}),
    },
    density: t.density,
  });
}

function makeStyles(
  t: DaisyTheme,
  rad: (n: number) => number,
  sp: (n: number) => number,
) {
  const C = t.colors;
  return StyleSheet.create({
    button: {
      paddingHorizontal: sp(15),
      paddingVertical: sp(11),
      borderRadius: rad(9),
      alignItems: "center",
      justifyContent: "center",
      flexDirection: "row",
      gap: 8,
    },
    outlineButton: {
      borderWidth: 1,
      borderColor: C.line,
      paddingHorizontal: sp(11),
      paddingVertical: sp(6),
      borderRadius: rad(7),
    },
    label: { fontSize: 12, fontWeight: "600", color: C.muted },
    input: {
      fontFamily: t.font.family,
      borderWidth: 1,
      borderColor: C.line,
      borderRadius: rad(9),
      paddingHorizontal: sp(12),
      paddingVertical: sp(11),
      fontSize: 14,
      color: C.ink,
      backgroundColor: C.paper,
    },
    row: { flexDirection: "row", alignItems: "center", gap: 10 },
    title: {
      fontSize: 25,
      color: C.ink,
      fontWeight: "700",
      letterSpacing: -0.6,
    },
    muted: { fontSize: 13, lineHeight: 21, color: C.muted },
    card: {
      backgroundColor: C.paper,
      borderWidth: 1,
      borderColor: C.line,
      borderRadius: rad(14),
      padding: sp(20),
      gap: sp(12),
    },
    mono: {
      fontFamily: t.font.mono,
      fontSize: 12,
      lineHeight: 19,
      color: C.ink,
    },
    h3: { fontSize: 16, fontWeight: "600", color: C.ink },
  });
}
export type DaisyStyles = ReturnType<typeof makeStyles>;

/** A theme plus the derived helpers components use while rendering. */
export interface ResolvedDaisyTheme extends DaisyTheme {
  /** Colour tokens (short alias kept from the original `C` constant). */
  C: DaisyColors;
  /** Shared StyleSheet computed for this theme. */
  s: DaisyStyles;
  /**
   * Map an original radius (px) onto this theme's radius scale. Exact
   * identity for the default theme; otherwise interpolated between anchors.
   */
  rad: (px: number) => number;
  /** Scale an original spacing value by `density`. */
  sp: (px: number) => number;
}
export function resolveDaisyTheme(theme: DaisyTheme): ResolvedDaisyTheme {
  const d = defaultDaisyTheme.radius,
    anchors: [number, number][] = [
      [0, 0],
      [d.sm, theme.radius.sm],
      [d.md, theme.radius.md],
      [d.lg, theme.radius.lg],
      [d.xl, theme.radius.xl],
    ];
  const rad = (px: number) => {
    for (let i = 1; i < anchors.length; i++) {
      const [x0, y0] = anchors[i - 1],
        [x1, y1] = anchors[i];
      if (px <= x1) return y0 + ((px - x0) * (y1 - y0)) / (x1 - x0);
    }
    return (px * theme.radius.xl) / d.xl;
  };
  const sp = (px: number) =>
    theme.density === 1 ? px : Math.round(px * theme.density);
  return { ...theme, C: theme.colors, s: makeStyles(theme, rad, sp), rad, sp };
}

const resolvedDefault = resolveDaisyTheme(defaultDaisyTheme);
const ThemeContext = createContext<ResolvedDaisyTheme>(resolvedDefault);

/**
 * Provide a theme to every Daisy component below. `value` may be partial; it
 * is merged over the enclosing theme (or the default). Keep `value` stable
 * (module constant or useMemo) to avoid recomputing styles.
 */
export function DaisyThemeProvider({
  value,
  children,
}: {
  value?: DaisyThemeInput | DaisyTheme;
  children: React.ReactNode;
}) {
  const parent = useContext(ThemeContext);
  const resolved = useMemo(
    () =>
      value ? resolveDaisyTheme(createDaisyTheme(value, parent)) : parent,
    [value, parent],
  );
  return (
    <ThemeContext.Provider value={resolved}>{children}</ThemeContext.Provider>
  );
}
/** Current theme with `C` (colours), `s` (styles), `rad` and `sp` helpers. */
export function useDaisyTheme() {
  return useContext(ThemeContext);
}

const focusRules = new Set<string>();
/**
 * Web only: props for a container whose focusable descendants (buttons,
 * links, pressables - not text fields, which show focus by their border)
 * draw the theme's `focusRing` on :focus-visible instead of the browser's
 * default outline. Put it on every root Daisy renders, including modal
 * content (portals leave the parent tree). Native: no-op.
 */
export function useDaisyFocusScope(): { dataSet?: Record<string, string> } {
  const { C } = useDaisyTheme();
  const key = C.focusRing.replace(/[^0-9a-zA-Z]/g, "").toLowerCase();
  if (Platform.OS !== "web" || typeof document === "undefined" || !key)
    return {};
  if (!focusRules.has(key) && /^#[0-9a-f]{3,8}$/i.test(C.focusRing)) {
    focusRules.add(key);
    const el = document.createElement("style");
    el.setAttribute("data-daisy-focus-ring", key);
    el.textContent =
      `[data-daisy-focus="${key}"] :focus-visible:not(input):not(textarea),` +
      `[data-daisy-focus="${key}"]:focus-visible{outline:2px solid ${C.focusRing}!important;outline-offset:2px!important;}` +
      `[data-daisy-focus="${key}"] :focus:not(:focus-visible){outline:none;}`;
    document.head.appendChild(el);
  }
  return { dataSet: { daisyFocus: key } };
}

/**
 * Status chip colour for a lifecycle phase, from theme tokens: completed =
 * green (success), not started / interrupted = neutral, failed = red,
 * waiting for tool authorization = orange (warning), queued / running =
 * accent. Use it for every status chip so lists, headers and toolbars agree.
 */
export function daisyPhaseColor(colors: DaisyColors, phase: string) {
  switch (daisyPhaseTone(phase)) {
    case "success":
      return colors.green;
    case "neutral":
      return colors.neutral;
    case "danger":
      return colors.red;
    case "warning":
      return colors.orange;
    default:
      return colors.accent;
  }
}
