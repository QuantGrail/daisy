import React, { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import type { DaisyClient } from "@daisy-ai/client";
import type { Session, SessionPublic } from "@daisy-ai/contracts";
import { Dialog } from "./index";
import { Button, Field, Text } from "./primitives";
import { useDaisyTheme } from "./theme";
import { SessionPromptSection } from "./prompt-layers";
import { PinCancelled, usePin } from "./pin";
import { useT } from "./i18n";

/**
 * 会话设置: name, how Daisy wakes join a running turn, the session's own
 * prompt additions, archive / delete. Opened from the AI conversation
 * header (DaisySessionView). P4-06: 公开 agent — make it callable by
 * others (PIN), with what that means said first (会串话). Its range,
 * 问与办 settings and call approvals are P4-12's pages.
 */
export function SessionSettingsDialog({
  client,
  sessionId,
  session,
  onClose,
  onArchive,
  onDelete,
  onRenamed,
}: {
  client: DaisyClient;
  sessionId: string;
  session?: Session;
  onClose: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onRenamed?: (title: string) => void;
}) {
  const { C, s } = useDaisyTheme();
  const t = useT();
  return (
    <Dialog title={t("ui-settings.session.title")} onClose={onClose}>
      <SessionBasicsPanel
        client={client}
        sessionId={sessionId}
        session={session}
        onRenamed={onRenamed}
      />
      {/* P4-06 (ADR-125): public agent or private. */}
      <PublicAgentSection client={client} sessionId={sessionId} />
      {/* This session's own prompt additions, and what it really gets. */}
      <SessionPromptSection
        client={client}
        sessionId={sessionId}
        session={session}
      />
      <View style={{ height: 1, backgroundColor: C.line }} />
      <View style={[s.row, { gap: 8, justifyContent: "flex-end" }]}>
        <Button
          variant="outline"
          testID="session-settings-archive"
          onPress={onArchive}
        >
          {session?.archived ? t("ui-settings.session.unarchive") : t("ui-settings.session.archive")}
        </Button>
        <Button
          variant="danger"
          testID="session-settings-delete"
          onPress={onDelete}
        >
          {t("ui-settings.session.delete")}
        </Button>
      </View>
    </Dialog>
  );
}

/** The body of 会话设置: its name and how Daisy wakes join a running turn. */
export function SessionBasicsPanel({
  client,
  sessionId,
  session,
  onRenamed,
  showName = true,
}: {
  client: DaisyClient;
  sessionId: string;
  session?: Session;
  onRenamed?: (title: string) => void;
  showName?: boolean;
}) {
  const { C, s } = useDaisyTheme();
  const t = useT();
  const [title, setTitle] = useState(session?.title || ""),
    [busy, setBusy] = useState(""),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    // Daisy wakes go into a running turn by themselves (on
    // unless turned off).
    [wakeOff, setWakeOff] = useState(
      session?.settings?.autoAppendWakes === false,
    );
  const run = (key: string, f: () => Promise<void>, done: string) => {
    setBusy(key);
    setError("");
    setNotice("");
    f()
      .then(() => setNotice(done))
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(""));
  };
  return (
    <View style={{ gap: 12 }} testID="session-settings">
      {showName ? (
        <View style={{ gap: 8 }}>
          <Field
            label={t("ui-settings.session.name")}
            value={title}
            onChange={setTitle}
            testID="session-settings-title"
          />
          <View style={[s.row, { justifyContent: "flex-end" }]}>
            <Button
              variant="soft"
              testID="session-settings-rename"
              busy={busy === "title"}
              disabled={!title.trim() || title.trim() === session?.title}
              onPress={() =>
                run(
                  "title",
                  async () => {
                    await client.request(`/sessions/${sessionId}`, "PATCH", {
                      title: title.trim(),
                    });
                    onRenamed?.(title.trim());
                  },
                  t("ui-settings.session.renamed"),
                )
              }
            >
              {t("ui-settings.session.saveName")}
            </Button>
          </View>
        </View>
      ) : null}
      {session && ["claude", "codex"].includes(session.agent) ? (
        <View style={{ gap: 6 }} testID="session-settings-auto-append">
          <Text style={s.label}>{t("ui-settings.session.wake.title")}</Text>
          <Text style={[s.muted, { fontSize: 12 }]}>
            {wakeOff ? t("ui-settings.session.wake.off") : t("ui-settings.session.wake.on")}
          </Text>
          <View style={[s.row, { justifyContent: "flex-end" }]}>
            <Button
              variant="soft"
              testID="session-settings-auto-append-toggle"
              busy={busy === "wake"}
              onPress={() =>
                run(
                  "wake",
                  async () => {
                    await client.request(`/sessions/${sessionId}`, "PATCH", {
                      settings: { autoAppendWakes: wakeOff },
                    });
                    setWakeOff(!wakeOff);
                  },
                  wakeOff ? t("ui-settings.session.wake.turnedOn") : t("ui-settings.session.wake.turnedOff"),
                )
              }
            >
              {wakeOff ? t("ui-settings.session.wake.turnOn") : t("ui-settings.session.wake.turnOff")}
            </Button>
          </View>
        </View>
      ) : null}
      {notice ? (
        <Text style={{ fontSize: 12, color: C.accent }}>{notice}</Text>
      ) : null}
      {error ? (
        <Text style={{ fontSize: 12, color: C.red }}>{error}</Text>
      ) : null}
    </View>
  );
}

/**
 * P4-06 (总纲 5.2 「把会话设为公开时，界面要让主人清楚这一点」, ADR-125):
 * 公开 agent. The state is read without the PIN; making it public asks
 * the owner to read what it means (会串话) and confirm, then the PIN.
 * Taking it back also takes the PIN (5.11: one row).
 */
export function PublicAgentSection({
  client,
  sessionId,
}: {
  client: DaisyClient;
  sessionId: string;
}) {
  const { C, s } = useDaisyTheme();
  const t = useT();
  const pin = usePin();
  const [st, setSt] = useState<SessionPublic | null>(null),
    [confirming, setConfirming] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setSt(await client.sessionPublic(sessionId));
    } catch (e: any) {
      setError(e.message);
    }
  }, [client, sessionId]);
  useEffect(() => {
    void load();
  }, [load]);
  const change = async (on: boolean) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const g = await pin.grant(
        on ? t("ui-settings.public.pinOn") : t("ui-settings.public.pinOff"),
      );
      const r = await client.setSessionPublic(sessionId, on, g);
      setSt(r);
      setConfirming(false);
      setNotice(
        on
          ? t("ui-settings.public.madePublic")
          : r.stopped
            ? t("ui-settings.public.madePrivateStopped", { count: r.stopped })
            : t("ui-settings.public.madePrivate"),
      );
    } catch (e: any) {
      if (!(e instanceof PinCancelled)) {
        if (e.code === "pin_required") pin.forget();
        setError(e.message);
      }
    } finally {
      setBusy(false);
    }
  };
  if (!st) return error ? <Text style={{ fontSize: 12, color: C.red }}>{error}</Text> : null;
  return (
    <View style={{ gap: 6 }} testID="session-settings-public">
      <Text style={s.label}>{t("ui-settings.public.title")}</Text>
      <Text style={[s.muted, { fontSize: 12 }]} testID="session-settings-public-state">
        {st.public ? t("ui-settings.public.statePublic") : t("ui-settings.public.statePrivate")}
      </Text>
      {st.public || confirming ? (
        <View
          style={{ borderLeftWidth: 3, borderLeftColor: C.red, paddingLeft: 8 }}
          testID="session-settings-public-crosstalk"
        >
          <Text style={{ fontSize: 12, color: C.ink }}>{st.crossTalk}</Text>
        </View>
      ) : null}
      {!st.public && st.blocked ? (
        <Text style={{ fontSize: 12, color: C.red }} testID="session-settings-public-blocked">
          {t("ui-settings.public.blocked", { reason: st.blocked })}
        </Text>
      ) : null}
      <View style={[s.row, { gap: 8, justifyContent: "flex-end" }]}>
        {st.public ? (
          <Button
            variant="outline"
            testID="session-settings-public-off"
            busy={busy}
            onPress={() => void change(false)}
          >
            {t("ui-settings.public.makePrivate")}
          </Button>
        ) : confirming ? (
          <>
            <Button variant="outline" onPress={() => setConfirming(false)} disabled={busy}>
              {t("ui-settings.public.cancel")}
            </Button>
            <Button
              variant="danger"
              testID="session-settings-public-confirm"
              busy={busy}
              onPress={() => void change(true)}
            >
              {t("ui-settings.public.confirm")}
            </Button>
          </>
        ) : (
          <Button
            variant="soft"
            testID="session-settings-public-on"
            disabled={!!st.blocked}
            onPress={() => setConfirming(true)}
          >
            {t("ui-settings.public.makePublic")}
          </Button>
        )}
      </View>
      {notice ? <Text style={{ fontSize: 12, color: C.accent }}>{notice}</Text> : null}
      {error ? <Text style={{ fontSize: 12, color: C.red }}>{error}</Text> : null}
    </View>
  );
}
