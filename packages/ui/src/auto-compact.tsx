import { shownName } from "@daisy-ai/contracts";
import React, { useCallback, useEffect, useState } from "react";
import { TextInput, View } from "react-native";
import type { AutoCompactStatus, DaisyClient } from "@daisy-ai/client";
import type { Profile } from "@daisy-ai/contracts";
import { Button, ErrorBox, Text } from "./primitives";
import { useDaisyTheme } from "./theme";
import { autoCompactView } from "./present";
import { useT } from "./i18n";

/**
 * 自动压缩阈值 of one AI identity: one value
 * per identity, for all its conversations; Claude: Claude Code's own
 * compaction window (--autocompact), shown with the trigger point Claude
 * reports back. Online processes restart with a new value once idle;
 * 立即重启 applies it now after a confirmation naming what it interrupts.
 * Shared by Daisy's identity settings and the App's settings.
 */
export function AutoCompactSetting({
  client,
  profile,
  onSaved,
}: {
  client: DaisyClient;
  profile: Pick<Profile, "id" | "agent" | "label">;
  onSaved?: (tokens: number | null) => void;
}) {
  const { C, s, rad } = useDaisyTheme();
  const t = useT();
  const [status, setStatus] = useState<AutoCompactStatus | null>(null),
    [missing, setMissing] = useState(""),
    [draft, setDraft] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirm, setConfirm] = useState(false);
  const load = useCallback(
    () =>
      client
        .autoCompact(profile.id)
        .then((r) => {
          setStatus(r);
          setMissing("");
        })
        .catch((e: any) =>
          setMissing(
            e?.status === 404
              ? t("ui-trace.autoCompact.serverOld")
              : e?.message || t("ui-trace.autoCompact.readFailed"),
          ),
        ),
    [client, profile.id, t],
  );
  const v = status ? autoCompactView(status) : null;
  useEffect(() => {
    void load();
    // Faster while a restart is on its way.
    const timer = setInterval(() => void load(), v?.settling ? 2500 : 15_000);
    return () => clearInterval(timer);
  }, [load, v?.settling]);
  if (missing && !status)
    return (
      <View testID={`auto-compact-${profile.id}`} style={{ gap: 4 }}>
        <Text style={s.label}>{t("ui-trace.autoCompact.title")}</Text>
        <Text style={{ fontSize: 12, color: C.faint }}>{missing}</Text>
      </View>
    );
  if (!status || !v) return null;
  const text = draft ?? (status.tokens ? String(status.tokens / 1000) : "");
  const save = async (tokens: number | null) => {
    setBusy(true);
    setError("");
    try {
      const r = await client.setAutoCompact(profile.id, tokens);
      setStatus(r.autoCompact);
      setDraft(null);
      onSaved?.(tokens);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const parsed = text.trim() === "" ? null : Number(text.trim());
  const invalid =
    parsed !== null && (!Number.isFinite(parsed) || parsed <= 0)
      ? t("ui-trace.autoCompact.invalid")
      : "";
  const tokens = parsed === null ? null : Math.round(parsed * 1000);
  const changed = tokens !== status.tokens;
  return (
    <View testID={`auto-compact-${profile.id}`} style={{ gap: 8 }}>
      <Text style={s.label}>{t("ui-trace.autoCompact.title")}</Text>
      <Text style={{ fontSize: 12, color: C.muted }}>{v.explain}</Text>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          opacity: v.configurable ? 1 : 0.5,
        }}
      >
        <TextInput
          testID={`auto-compact-input-${profile.id}`}
          accessibilityLabel={t("ui-trace.autoCompact.inputA11y", { profile: shownName("profile", profile, t) })}
          editable={v.configurable && !busy}
          value={text}
          onChangeText={setDraft}
          placeholder={t("ui-trace.autoCompact.placeholder")}
          placeholderTextColor={C.faint}
          keyboardType="numeric"
          style={{
            width: 130,
            borderWidth: 1,
            borderColor: C.line,
            borderRadius: rad(6),
            paddingHorizontal: 8,
            paddingVertical: 5,
            color: C.ink,
            backgroundColor: C.paper,
            fontSize: 13,
          }}
        />
        <Text style={{ fontSize: 12, color: C.muted }}>K tokens</Text>
        <Button
          testID={`auto-compact-save-${profile.id}`}
          variant="soft"
          disabled={!v.configurable || !changed || !!invalid}
          busy={busy}
          onPress={() => void save(tokens)}
        >
          {t("ui-trace.autoCompact.save")}
        </Button>
        {status.tokens !== null && v.configurable ? (
          <Button
            variant="ghost"
            disabled={busy}
            onPress={() => void save(null)}
          >
            {t("ui-trace.autoCompact.reset")}
          </Button>
        ) : null}
      </View>
      {!v.configurable ? (
        <Text style={{ fontSize: 12, color: C.faint }}>{v.disabledReason}</Text>
      ) : null}
      {invalid ? (
        <Text style={{ fontSize: 12, color: C.red }}>{invalid}</Text>
      ) : null}
      <Text
        testID={`auto-compact-trigger-${profile.id}`}
        style={{ fontSize: 12, color: C.ink }}
      >
        {v.trigger}
      </Text>
      {v.lines.map((l, i) => (
        <Text
          key={i}
          style={{
            fontSize: 12,
            color: l.tone === "wait" ? C.orange || C.muted : C.muted,
          }}
        >
          {l.text}
        </Text>
      ))}
      {v.restartable ? (
        confirm ? (
          <View
            testID={`auto-compact-confirm-${profile.id}`}
            style={{
              gap: 6,
              padding: 10,
              borderRadius: rad(8),
              borderWidth: 1,
              borderColor: C.line,
            }}
          >
            <Text style={{ fontSize: 12, color: C.ink }}>{v.confirmText}</Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button
                testID={`auto-compact-restart-yes-${profile.id}`}
                variant="danger"
                busy={busy}
                onPress={() =>
                  void (async () => {
                    setBusy(true);
                    setError("");
                    try {
                      setStatus(await client.restartForAutoCompact(profile.id));
                      setConfirm(false);
                    } catch (e: any) {
                      setError(e.message);
                    } finally {
                      setBusy(false);
                    }
                  })()
                }
              >
                {t("ui-trace.autoCompact.restartConfirm")}
              </Button>
              <Button variant="ghost" onPress={() => setConfirm(false)}>
                {t("ui-trace.autoCompact.cancel")}
              </Button>
            </View>
          </View>
        ) : (
          <View style={{ alignSelf: "flex-start" }}>
            <Button
              testID={`auto-compact-restart-${profile.id}`}
              variant="outline"
              onPress={() => setConfirm(true)}
            >
              {t("ui-trace.autoCompact.restart")}
            </Button>
          </View>
        )
      ) : null}
      <ErrorBox text={error} />
    </View>
  );
}
