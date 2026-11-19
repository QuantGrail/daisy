import React, { useState } from "react";
import { Platform } from "react-native";
import {useDaisyTheme} from "./theme";
import { readMigrated } from "./storage-keys";
import { useT } from "./i18n";
/** Web reading preference: fluid by default; capped by the containing pane. */
export function useReadingWidth(key: string) {
  const {C} = useDaisyTheme();
  const t = useT();
  const [value, setValue] = useState(() => {
    try {
      const v = Number(readMigrated(globalThis.localStorage, key));
      return v >= 600 && v <= 2400 ? v : 0;
    } catch {
      return 0;
    }
  });
  const change = (v: number) => {
    setValue(v);
    try {
      globalThis.localStorage?.setItem(key, String(v));
    } catch {
      /* private browser */
    }
  };
  const control =
    Platform.OS !== "web" ? null : (
      <div
        style={{
          color: C.ink,
        display: "flex",
          gap: 10,
          alignItems: "center",
          flexWrap: "wrap",
          fontSize: 12,
          padding: "4px 16px",
        }}
      >
        <span>{t("ui-queue.readingWidth.title")}</span>
        <button onClick={() => change(0)}>{t("ui-queue.readingWidth.fluid")}</button>
        <button onClick={() => change(900)}>{t("ui-queue.readingWidth.medium")}</button>
        <input
          aria-label={t("ui-queue.readingWidth.slider")}
          type="range"
          min="600"
          max="2400"
          step="20"
          value={value || 2400}
          onChange={(e) => change(Number(e.target.value))}
        />
        <span>{value ? `${value}px` : t("ui-queue.readingWidth.window")}</span>
      </div>
    );
  return { maxWidth: value || undefined, control };
}
