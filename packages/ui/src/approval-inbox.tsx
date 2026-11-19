/**
 * 审批合并: the approvals that are not call cards — harness
 * permission prompts (also answerable on their conversation's card, D-39),
 * auto-mode interceptions, and what my AI asks me. DaisyApp shows this
 * list in its own 「审批」 panel (call cards come back with stage 4). One
 * click on an option decides.
 */
import React, { useCallback, useEffect, useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import type { DaisyClient } from "@daisy-ai/client";
import { api, type DaisyApproval } from "@daisy-ai/contracts";
import { Button, Text } from "./primitives";
import { useDaisyTheme } from "./theme";
import { useT } from "./i18n";

const KINDS = new Set(["permission", "interception", "owner"]);
const show = (v: unknown) => {
  if (v === undefined || v === null) return "";
  const raw = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return raw.length > 1500 ? raw.slice(0, 1500) + "…" : raw;
};

export function DaisyApprovalCard({
  client,
  approval: a,
  onDecided,
}: {
  client: DaisyClient;
  approval: DaisyApproval;
  onDecided: (next: DaisyApproval) => void;
}) {
  const { C, s } = useDaisyTheme();
  const t = useT();
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [note, setNote] = useState("");
  const decide = (key: string) => {
    setBusy(key);
    setError("");
    client
      .respondApproval(a.id, key, note)
      .then(onDecided)
      .catch(async (e) => {
        // D-39: answered first elsewhere (its conversation's card, another
        // tab) — not the user's error; show the card as decided.
        if ((e as any)?.status === 409) {
          const next = await client
            .call(api.approvals.show, { params: { aid: a.id } })
            .catch(() => null);
          if (next && next.status !== "pending") return onDecided(next);
        }
        setError((e as Error).message);
      })
      .finally(() => setBusy(""));
  };
  const x = a as any;
  return (
    <View
      testID={`daisy-approval-${a.id}`}
      style={{
        gap: 8,
        padding: 12,
        borderWidth: 1,
        borderColor: C.line,
        borderRadius: 10,
        backgroundColor: C.paper,
      }}
    >
      <Text style={{ color: C.ink, fontWeight: "600" }}>{a.title}</Text>
      {a.kind === "owner" ? (
        <>
          <Text selectable style={{ color: C.ink }}>
            {x.question}
          </Text>
          {x.detail ? (
            <Text selectable style={[s.muted, { fontSize: 12 }]}>
              {x.detail}
            </Text>
          ) : null}
          {x.askedBy ? (
            <Text style={[s.muted, { fontSize: 12 }]}>
              {t("ui-inbox.approval.askedBy", {
                name:
                  x.askedBy.kind === "text"
                    ? t("ui-inbox.approval.askedByText", { name: x.askedBy.name })
                    : x.askedBy.name,
              })}
            </Text>
          ) : null}
        </>
      ) : (
        <>
          {x.reason ? (
            <Text selectable style={[s.muted, { fontSize: 12 }]}>
              {a.kind === "interception"
                ? t("ui-inbox.approval.interceptReason", { reason: x.reason })
                : t("ui-inbox.approval.reason", { reason: x.reason })}
            </Text>
          ) : null}
          {show(x.input) ? (
            <ScrollView style={{ maxHeight: 160 }} nestedScrollEnabled>
              <Text selectable style={s.mono}>
                {show(x.input)}
              </Text>
            </ScrollView>
          ) : null}
        </>
      )}
      {a.status === "pending" ? (
        <>
          {a.kind !== "permission" ? (
            <TextInput
              accessibilityLabel={t("ui-inbox.approval.noteLabel")}
              placeholder={t("ui-inbox.approval.notePlaceholder")}
              value={note}
              onChangeText={setNote}
              style={s.input}
            />
          ) : null}
          <View style={[s.row, { flexWrap: "wrap", gap: 8 }]}>
            {a.options.map((o) => (
              <Button
                key={o.key}
                testID={`daisy-approval-option-${o.key}`}
                variant={
                  o.tone === "danger"
                    ? "ghost"
                    : o.tone === "primary"
                      ? "primary"
                      : "soft"
                }
                busy={busy === o.key}
                disabled={!!busy}
                onPress={() => decide(o.key)}
              >
                {o.label}
              </Button>
            ))}
          </View>
        </>
      ) : (
        <Text style={[s.muted, { fontSize: 12 }]}>
          {a.status === "expired"
            ? t("ui-inbox.approval.expired")
            : a.decision
              ? t("ui-inbox.approval.decidedAs", { option: a.decision.label })
              : t("ui-inbox.approval.decided")}
        </Text>
      )}
      {error ? (
        <Text style={{ color: C.red, fontSize: 12 }}>{error}</Text>
      ) : null}
    </View>
  );
}

/** My pending permission prompts, interceptions and AI→owner approvals. */
export function DaisyApprovalList({
  client,
  empty,
}: {
  client: DaisyClient;
  empty?: React.ReactNode;
}) {
  const { s } = useDaisyTheme();
  const t = useT();
  const [items, setItems] = useState<DaisyApproval[] | null>(null),
    [error, setError] = useState("");
  const load = useCallback(
    () =>
      client
        .request<{ items: DaisyApproval[] }>("/approvals?status=pending")
        .then((r) => {
          setItems(r.items.filter((x) => KINDS.has(x.kind)));
          setError("");
        })
        // An older control plane has no unified list: nothing to show.
        .catch((e) =>
          (e as any)?.status === 404
            ? setItems([])
            : setError((e as Error).message),
        ),
    [client],
  );
  useEffect(() => {
    void load();
    // Permission prompts arrive with the conversation: a slow poll while
    // this list is open.
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);
  if (error) return <Text style={[s.muted, { fontSize: 12 }]}>{error}</Text>;
  if (!items) return null;
  if (!items.length) return <>{empty ?? null}</>;
  return (
    <View style={{ gap: 10 }} testID="daisy-approval-list">
      <Text style={s.label}>{t("ui-inbox.approval.listTitle", { count: items.length })}</Text>
      {items.map((a) => (
        <DaisyApprovalCard
          key={a.id}
          client={client}
          approval={a}
          onDecided={() => void load()}
        />
      ))}
    </View>
  );
}
