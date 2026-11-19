/**
 * P5-03: a QR code drawn with plain Views (web and native alike, no SVG):
 * each row's dark runs are one View each. `toqr` encodes (error
 * correction M); the quiet zone is four modules of background.
 */
import React, { useMemo } from "react";
import { View } from "react-native";
import { toQR } from "toqr";
import { t } from "./i18n";

export function QrCode({
  value,
  size = 200,
  dark = "#000",
  light = "#fff",
  testID,
}: {
  value: string;
  size?: number;
  dark?: string;
  light?: string;
  testID?: string;
}) {
  const { n, runs } = useMemo(() => {
    const m = toQR(value);
    const n = Math.round(Math.sqrt(m.length));
    const runs: { y: number; x: number; w: number }[] = [];
    for (let y = 0; y < n; y++) {
      let x = 0;
      while (x < n) {
        if (!m[y * n + x]) {
          x++;
          continue;
        }
        const start = x;
        while (x < n && m[y * n + x]) x++;
        runs.push({ y, x: start, w: x - start });
      }
    }
    return { n, runs };
  }, [value]);
  const quiet = 4;
  const cell = size / (n + quiet * 2);
  return (
    <View
      testID={testID}
      accessibilityRole="image"
      accessibilityLabel={t("ui-chat.qr.label")}
      style={{ width: size, height: size, backgroundColor: light, position: "relative" }}
    >
      {runs.map((r, i) => (
        <View
          key={i}
          style={{
            position: "absolute",
            left: (r.x + quiet) * cell,
            top: (r.y + quiet) * cell,
            width: r.w * cell + 0.5,
            height: cell + 0.5,
            backgroundColor: dark,
          }}
        />
      ))}
    </View>
  );
}
