import type { TextStyle } from "react-native";
import { useDaisyTheme } from "./theme";
/** Chat type scale, shared by the conversation, list and composer. */
export const chatType: Record<string, TextStyle> = {
  title: {
    fontSize: 23,
    lineHeight: 30,
    fontWeight: "600",
    letterSpacing: -0.6,
  },
  heading: { fontSize: 16, lineHeight: 23, fontWeight: "600" },
  body: { fontSize: 15, lineHeight: 23 },
  preview: { fontSize: 13, lineHeight: 20 },
  meta: { fontSize: 11, lineHeight: 16 },
  label: { fontSize: 12, lineHeight: 18, fontWeight: "500" },
};
// Chat-specific visual roles. Shared by the conversation, list and composer.
export const chatTokens = {
  canvas: "#EEF1F5",
  surface: "#FFFFFF",
  text: "#202938",
  secondary: "#526078",
  subtle: "#56647A",
  line: "#E9ECF1",
  field: "#F2F4F7",
  selected: "#EEF0FC",
  hover: "#F7F8FA",
  own: "#E1E7FF",
  avatar: [
    ["#E4EBFB", "#4966AA"],
    ["#EEE8F7", "#8865A6"],
    ["#E4F0EC", "#4D8270"],
    ["#F8ECDD", "#A67A42"],
  ],
  aiBg: "#ECE9FA",
  aiInk: "#6F5CA5",
  warningBg: "#FFF4E5",
  warning: "#93611F",
} as const;

const darkChat = {
  canvas: "#161A22",
  surface: "#1E2430",
  text: "#E5EAF3",
  secondary: "#B2BBCB",
  subtle: "#99A5B9",
  line: "#303847",
  field: "#272F3D",
  selected: "#303652",
  hover: "#232A37",
  own: "#303D61",
  avatar: [
    ["#2D3E60", "#BCCDF2"],
    ["#453956", "#D6BFEF"],
    ["#294B43", "#AFE0D0"],
    ["#514233", "#E7C696"],
  ],
  aiBg: "#3C3356",
  aiInk: "#D1BDF3",
  warningBg: "#4A3826",
  warning: "#EDD0A1",
} as const;

export function useChatTokens() {
  const { C } = useDaisyTheme();
  const hex = C.ink.replace("#", "");
  return (hex.length === 6 ? parseInt(hex.slice(0, 2), 16) > 170 : false)
    ? darkChat
    : chatTokens;
}
