import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { View } from "react-native";
import { DaisyError, type DaisyClient } from "@daisy-ai/client";
import type { Session } from "@daisy-ai/contracts";
import { DaisyChat, type DaisyChatActivity } from "./chat";
import { clearDraft } from "./drafts";
import { Dialog } from "./index";
import { Button, Text } from "./primitives";
import type { DaisyHostAdapters } from "./host";
import { useDaisyTheme } from "./theme";
import { useT } from "./i18n";
import { SessionSettingsDialog } from "./session-settings";

/**
 * One Agent conversation pane: the full DaisyChat with its 归档 / 删除
 * actions, the delete confirmation and the host's side panel, so an AI
 * conversation behaves identically wherever it is opened.
 */
/** The conversation re-renders only when its own inputs change. */
const KeptChat = React.memo(DaisyChat);
export function DaisySessionView({
  client,
  sessionId,
  session,
  adapters,
  aside,
  active = true,
  onNavigate,
  onSessionChange,
  onArchiveChanged,
  onDeleted,
  onError,
}: {
  client: DaisyClient;
  sessionId: string;
  /** The list's copy of the session (archived flag, status for the dialog). */
  session?: Session;
  adapters?: DaisyHostAdapters;
  /** Host panel beside the conversation; omit or return null for none. */
  aside?: React.ReactNode;
  /**
   * Shown (default). A host keeping this view rendered while hidden passes
   * false: the conversation keeps its last state, opens no connection and
   * re-renders nothing when shown again (chat latency work, round 2).
   */
  active?: boolean;
  /** The conversation moved on to another session (e.g. a fork). */
  onNavigate: (sessionId: string) => void;
  onSessionChange?: (session: Session) => void;
  onArchiveChanged: (sessionId: string, archived: boolean) => void;
  onDeleted: (sessionId: string) => void;
  onError: (message: string) => void;
}) {
  const { C, s } = useDaisyTheme();
  const t = useT();
  const [deleting, setDeleting] = useState<Session | null>(null),
    [settingsOpen, setSettingsOpen] = useState(false);
  // Shown / hidden, read by the conversation without re-rendering it.
  const shown = useRef(active),
    listeners = useRef(new Set<() => void>());
  const activity = useMemo<DaisyChatActivity>(
    () => ({
      get: () => shown.current,
      subscribe: (fn) => {
        listeners.current.add(fn);
        return () => {
          listeners.current.delete(fn);
        };
      },
    }),
    [],
  );
  // Layout effect: listeners (scroll to the end) run before the frame that
  // shows the conversation.
  useLayoutEffect(() => {
    if (shown.current === active) return;
    shown.current = active;
    for (const fn of [...listeners.current]) fn();
  }, [active]);
  const latest = useRef({
    session,
    onNavigate,
    onSessionChange,
    onArchiveChanged,
    onError,
  });
  latest.current = {
    session,
    onNavigate,
    onSessionChange,
    onArchiveChanged,
    onError,
  };
  const toggleArchive = useCallback(() => {
    // As before the extraction: works on a deep link too,
    // before the list has loaded (then it archives).
    const archived = !latest.current.session?.archived;
    void client
      .request(`/sessions/${sessionId}`, "PATCH", { archived })
      .then(() => latest.current.onArchiveChanged(sessionId, archived))
      .catch((e) => latest.current.onError(e.message));
  }, [client, sessionId]);
  const navigate = useCallback(
    (id: string) => latest.current.onNavigate(id),
    [],
  );
  const sessionChanged = useCallback(
    (x: Session) => latest.current.onSessionChange?.(x),
    [],
  );
  const archived = !!session?.archived;
  const headerActions = useMemo(
    () => (
      <>
        <Button
          testID="session-settings-open"
          variant="outline"
          accessibilityLabel={t("ui-app.session.settings")}
          onPress={() => setSettingsOpen(true)}
        >
          {t("ui-app.session.settings")}
        </Button>
        <Button
          testID="session-archive"
          variant="outline"
          onPress={toggleArchive}
        >
          {archived ? t("ui-app.session.restore") : t("ui-app.session.archive")}
        </Button>
        <Button
          testID="session-delete"
          variant="outline"
          onPress={() =>
            latest.current.session && setDeleting(latest.current.session)
          }
        >
          {t("ui-app.session.delete")}
        </Button>
      </>
    ),
    [archived, toggleArchive, t],
  );
  return (
    <View style={{ flex: 1, flexDirection: "row", minHeight: 0 }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <KeptChat
          key={sessionId}
          client={client}
          sessionId={sessionId}
          adapters={adapters}
          activity={activity}
          onNavigate={navigate}
          onSessionChange={sessionChanged}
          headerActions={headerActions}
        />
      </View>
      {aside ? (
        <View
          testID="session-aside"
          style={{
            width: 340,
            borderLeftWidth: 1,
            borderColor: C.line,
            backgroundColor: C.sidebar,
          }}
        >
          {aside}
        </View>
      ) : null}
      {settingsOpen ? (
        <SessionSettingsDialog
          client={client}
          sessionId={sessionId}
          session={session}
          onClose={() => setSettingsOpen(false)}
          onArchive={() => {
            setSettingsOpen(false);
            toggleArchive();
          }}
          onDelete={() => {
            setSettingsOpen(false);
            if (session) setDeleting(session);
          }}
          onRenamed={(title) =>
            session && onSessionChange?.({ ...session, title })
          }
        />
      ) : null}
      {deleting ? (
        <SessionDeleteDialog
          client={client}
          session={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={onDeleted}
          onError={onError}
        />
      ) : null}
    </View>
  );
}

/**
 * 删除这个会话？ — the one delete confirmation of an AI conversation: the
 * pane's 「删除」 (and 会话设置) open this same dialog. It stops the running turn (process group killed on the
 * runner) and purges every row of the conversation; already gone (404)
 * counts as deleted.
 */
export function SessionDeleteDialog({
  client,
  session,
  onClose,
  onDeleted,
  onError,
}: {
  client: DaisyClient;
  session: Session;
  onClose: () => void;
  onDeleted: (sessionId: string) => void;
  onError: (message: string) => void;
}) {
  const { C, s } = useDaisyTheme();
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={t("ui-app.session.deleteTitle")}
      onClose={() => (busy ? undefined : onClose())}
    >
      <Text style={{ color: C.ink }}>{session.title}</Text>
      <Text style={s.muted} testID="session-delete-words">
        {["queued", "running", "waiting"].includes(session.status)
          ? t("ui-app.session.deleteRunning")
          : t("ui-app.session.deleteIdle")}
      </Text>
      <View style={[s.row, { justifyContent: "flex-end" }]}>
        <Button variant="ghost" onPress={onClose} disabled={busy}>
          {t("ui-app.session.cancel")}
        </Button>
        <Button
          testID="session-delete-confirm"
          busy={busy}
          onPress={() => {
            setBusy(true);
            const target = session;
            void client
              .deleteSession(target.id)
              .catch((e) => {
                if (!(e instanceof DaisyError && e.status === 404)) throw e;
              })
              .then(() => {
                clearDraft(target.id);
                onClose();
                onDeleted(target.id);
              })
              .catch((e) => onError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          {t("ui-app.session.delete")}
        </Button>
      </View>
    </Dialog>
  );
}
