import React, { useState } from "react";
import {
  View,
  Text as NativeText,
  Platform,
  Pressable,
  TextInput,
  ActivityIndicator,
  type ViewStyle,
} from "react-native";
import {
  defaultDaisyTheme,
  resolveDaisyTheme,
  useDaisyTheme,
  withAlpha,
} from "./theme";
import { defaultDaisyCopy } from "./host";
/** @deprecated Use the theme's `font.family` (useDaisyTheme().font.family). */
export const uiFont = defaultDaisyTheme.font.family;
export function Text(props: React.ComponentProps<typeof NativeText>) {
  const { font } = useDaisyTheme();
  return (
    <NativeText {...props} style={[{ fontFamily: font.family }, props.style]} />
  );
}
/**
 * Default colour tokens. Components read colours from the theme context
 * (useDaisyTheme().C); this object is the default theme's palette.
 */
export const C = defaultDaisyTheme.colors;
/**
 * Default agent names and status labels; hosts override through `copy`.
 * Read on access, so they are in the UI's current language.
 */
export const labels: Record<string, string> = new Proxy(
  {} as Record<string, string>,
  {
    get: (_, k) => (typeof k === "string" ? defaultDaisyCopy.labels[k] : undefined),
    has: (_, k) => typeof k === "string" && k in defaultDaisyCopy.labels,
    ownKeys: () => Object.keys(defaultDaisyCopy.labels),
    getOwnPropertyDescriptor: (_, k) =>
      typeof k === "string" && k in defaultDaisyCopy.labels
        ? { enumerable: true, configurable: true, value: defaultDaisyCopy.labels[k] }
        : undefined,
  },
);
/** Default agent accent colours (theme.agents). */
export const colors: Record<string, string> = defaultDaisyTheme.agents;
export function Button({
  children,
  onPress,
  variant = "primary",
  disabled = false,
  busy = false,
  testID,
  style,
  accessibilityLabel,
}: React.PropsWithChildren<{
  onPress: () => void;
  /** Accessible name when the visible text is only a symbol (e.g. 「＋」). */
  accessibilityLabel?: string;
  /**
   * `outline`: secondary toolbar action (thin border, neutral text) - the
   * same weight as a host's secondary buttons.
   */
  variant?: "primary" | "soft" | "ghost" | "danger" | "outline";
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
  style?: ViewStyle;
}>) {
  const { C, s } = useDaisyTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: disabled || busy }}
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        s.button,
        { minHeight: 44, minWidth: 44 },
        variant === "outline" ? s.outlineButton : null,
        {
          backgroundColor:
            variant === "primary"
              ? C.accent
              : variant === "soft"
                ? C.soft
                : variant === "danger"
                  ? C.redSoft
                  : variant === "outline" && pressed
                    ? C.bg
                    : "transparent",
          opacity: disabled || busy ? 0.5 : pressed ? 0.75 : 1,
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator
          size="small"
          color={variant === "primary" ? C.onAccent : C.accent}
        />
      ) : (
        <Text
          style={{
            fontSize: variant === "outline" ? 12 : 13,
            fontWeight: variant === "outline" ? "500" : "600",
            color:
              variant === "outline"
                ? C.ink
                : variant === "primary"
                  ? C.onAccent
                  : variant === "danger"
                    ? C.red
                    : variant === "soft"
                      ? C.accent
                      : C.ink,
          }}
        >
          {children}
        </Text>
      )}
    </Pressable>
  );
}
export function Field({
  label,
  value,
  onChange,
  placeholder,
  secret = false,
  multiline = false,
  testID,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
  placeholder?: string;
  secret?: boolean;
  multiline?: boolean;
  testID?: string;
  /** The browser's autofill hint (web: the input's `autocomplete`). */
  autoComplete?: "one-time-code" | "off";
}) {
  const [focused, setFocused] = useState(false);
  const { C, s, sp } = useDaisyTheme();
  return (
    <View style={{ gap: sp(7) }}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        testID={testID}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        secureTextEntry={secret}
        {...(autoComplete ? { autoComplete } : {})}
        multiline={multiline}
        autoCapitalize="none"
        placeholder={placeholder}
        placeholderTextColor={C.faint}
        style={[
          s.input,
          { borderColor: focused ? C.focusRing : C.line },
          Platform.OS === "web" ? { outlineStyle: "none" as any } : {},
          multiline && { minHeight: 85, textAlignVertical: "top" },
        ]}
      />
    </View>
  );
}
export function Badge({ text, color }: { text: string; color?: string }) {
  const { C, rad, sp } = useDaisyTheme();
  color ??= C.accent;
  return (
    <View
      style={{
        alignSelf: "flex-start",
        paddingHorizontal: sp(8),
        paddingVertical: sp(4),
        borderRadius: rad(5),
        backgroundColor: withAlpha(color, "13"),
      }}
    >
      <Text style={{ color, fontSize: 11, fontWeight: "600" }}>{text}</Text>
    </View>
  );
}
export function ErrorBox({ text }: { text: string }) {
  const { C, rad, sp } = useDaisyTheme();
  return text ? (
    <View
      accessibilityRole="alert"
      style={{
        padding: sp(12),
        borderRadius: rad(8),
        backgroundColor: C.redSoft,
      }}
    >
      <Text selectable style={{ color: C.red, fontSize: 13, lineHeight: 20 }}>
        {text}
      </Text>
    </View>
  ) : null;
}
/** Default-theme StyleSheet; components use useDaisyTheme().s. */
export const s = resolveDaisyTheme(defaultDaisyTheme).s;
