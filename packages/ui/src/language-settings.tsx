/**
 * P6-20 (ADR-159 §2): Settings → Language. The owner's display language
 * (`PUT /api/settings/language`; no PIN — it lets nobody in), or "follow
 * the system". The choice shows at once here (the pack is reloaded) and
 * on the command line, the API's messages and new sessions' prompts.
 */
import React, { useEffect, useState } from "react";
import { View } from "react-native";
import type { DaisyClient } from "@daisy-ai/client";
import type { LanguageView } from "@daisy-ai/contracts";
import { Badge, Button, ErrorBox, Text } from "./primitives";
import { useDaisyTheme } from "./theme";
import { languageChoices, loadUiLanguage, useT } from "./i18n";

export function LanguageSettings({ client }: { client: DaisyClient }) {
  const { C, s } = useDaisyTheme();
  const t = useT();
  const [view, setView] = useState<LanguageView | null>(null),
    [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    void client
      .language()
      .then(setView)
      .catch((e) => setError(e.message));
  }, [client]);
  const choose = async (value: string | null) => {
    setBusy(value ?? "");
    setError("");
    try {
      const v = await client.setLanguage(value);
      setView(v);
      await loadUiLanguage(client, v.effective);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };
  const nameOf = (lang: string | null) => view?.available.find((a) => a.lang === lang)?.name ?? lang ?? "";
  return (
    <View style={[s.card, { gap: 8 }]} testID="settings-language">
      <View style={[s.row, { flexWrap: "wrap" }]}>
        <Text style={[s.h3, { flex: 1 }]}>{t("ui.settings.language.title")}</Text>
        {view ? <Badge text={nameOf(view.effective)} color={C.muted} /> : null}
      </View>
      {!view ? (
        error ? null : <Text style={s.muted}>{t("ui.common.loading")}</Text>
      ) : (
        <>
          <Text style={[s.muted, { fontSize: 12 }]} testID="language-detail">
            {view.setting
              ? t("ui.settings.language.chosen", { name: nameOf(view.setting) })
              : t("ui.settings.language.following", { name: nameOf(view.system ?? view.effective) })}{" "}
            {t("ui.settings.language.scope")}
          </Text>
          <View style={[s.row, { flexWrap: "wrap", gap: 8 }]}>
            {languageChoices(view).map((c) => {
              const selected = c.value === view.setting;
              return (
                <Button
                  key={c.value ?? "system"}
                  testID={`language-${c.value ?? "system"}`}
                  variant={selected ? "primary" : "outline"}
                  busy={busy === (c.value ?? "")}
                  disabled={busy !== null}
                  onPress={() => void choose(c.value)}
                >
                  {c.value === null ? t("common.language.followSystem") : c.label}
                </Button>
              );
            })}
          </View>
        </>
      )}
      <ErrorBox text={error} />
    </View>
  );
}
