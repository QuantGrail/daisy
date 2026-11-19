import React from "react";
import { paths, type ChatIconName } from "./chat-icon-paths";
export type { ChatIconName } from "./chat-icon-paths";
export function ChatIcon({
  name,
  size = 20,
  color = "currentColor",
}: {
  name: ChatIconName;
  size?: number;
  color?: string;
}) {
  return React.createElement(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: color,
      strokeWidth: name === "more" ? 3 : 1.65,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true,
      style: { flexShrink: 0 },
    },
    React.createElement("path", { d: paths[name] }),
  );
}
