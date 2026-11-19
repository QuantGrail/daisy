import React from "react";
import Svg, { Path } from "react-native-svg";
import type { ColorValue } from "react-native";
import { paths, type ChatIconName } from "./chat-icon-paths";
export type { ChatIconName } from "./chat-icon-paths";
export function ChatIcon({
  name,
  size = 20,
  color = "currentColor",
}: {
  name: ChatIconName;
  size?: number;
  color?: ColorValue;
}) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={name === "more" ? 3 : 1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d={paths[name]} />
    </Svg>
  );
}
