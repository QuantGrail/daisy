import React, { useEffect, useRef, useState } from "react";
import { View, ScrollView, Pressable } from "react-native";
import type { DirectoryListing, Workspace } from "@daisy-ai/contracts";
import type { DaisyClient } from "@daisy-ai/client";
import { Text, Field, Button, ErrorBox } from "./primitives";
import { useDaisyTheme } from "./theme";
import { useT } from "./i18n";
export function WorkspacePicker({
  client,
  nodeId,
  nodeLabel,
  path,
  onChange,
  recent,
  disabled = false,
}: {
  client: DaisyClient;
  nodeId: string;
  nodeLabel: string;
  path: string;
  onChange: (path: string) => void;
  recent: Workspace[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [listing, setListing] = useState<DirectoryListing | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [hidden, setHidden] = useState(false);
  const { C, s, rad, sp } = useDaisyTheme();
  const t = useT();
  const sequence = useRef(0),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      sequence.current++;
    };
  }, []);
  useEffect(() => {
    sequence.current++;
    setListing(null);
    setError("");
    setOpen(false);
    setBusy(false);
  }, [nodeId]);
  const browse = async (target: string, offset = 0, showHidden = hidden) => {
    if (!nodeId) return;
    const version = ++sequence.current;
    setBusy(true);
    setError("");
    try {
      const next = await client.browseDirectories(
        nodeId,
        target,
        offset,
        showHidden,
      );
      if (!alive.current || version !== sequence.current) return;
      setListing((previous) =>
        offset && previous?.path === next.path
          ? { ...next, entries: [...previous.entries, ...next.entries] }
          : next,
      );
      onChange(next.path);
    } catch (e: any) {
      if (alive.current && version === sequence.current) setError(e.message);
    } finally {
      if (alive.current && version === sequence.current) setBusy(false);
    }
  };
  return (
    <View style={{ gap: 10 }} testID="workspace-picker">
      <Text style={s.label}>{t("ui-app.workspace.title")}</Text>
      <Text style={s.muted}>
        {t("ui-app.workspace.where", { node: nodeLabel || t("ui-app.workspace.pickProfileFirst") })}
      </Text>
      <Pressable
        testID="workspace-toggle"
        disabled={!nodeId || disabled}
        accessibilityRole="button"
        accessibilityLabel={t("ui-app.workspace.browse")}
        onPress={() => {
          const next = !open;
          setOpen(next);
          if (next) void browse(path);
        }}
        style={[s.input, s.row, { justifyContent: "space-between" }]}
      >
        <Text style={{ color: C.ink, flex: 1, fontSize: 13 }} numberOfLines={2}>
          ▱ {path || "~"}{" "}
        </Text>
        <Text style={{ color: C.muted }}>{open ? "▴" : "▾"}</Text>
      </Pressable>
      {open ? (
        <View
          style={{
            borderWidth: 1,
            borderColor: C.line,
            borderRadius: rad(12),
            padding: sp(12),
            gap: sp(10),
            backgroundColor: C.field,
          }}
        >
          <Field
            label={t("ui-app.workspace.pathLabel")}
            value={path}
            onChange={(value) => {
              sequence.current++;
              setBusy(false);
              onChange(value);
              setError("");
            }}
            placeholder={t("ui-app.workspace.pathPlaceholder")}
            testID="workspace-path"
          />
          <View style={[s.row, { flexWrap: "wrap" }]}>
            <Button
              variant="soft"
              busy={busy}
              disabled={disabled}
              onPress={() => void browse(path)}
            >
              {t("ui-app.workspace.open")}
            </Button>
            <Button
              variant="ghost"
              disabled={busy || disabled}
              onPress={() => void browse("~")}
            >
              {t("ui-app.workspace.home")}
            </Button>
            <Button
              variant="ghost"
              disabled={busy || disabled || !listing?.parent}
              onPress={() => void browse(listing!.parent!)}
            >
              {t("ui-app.workspace.up")}
            </Button>
            <Button
              variant="ghost"
              disabled={busy || disabled}
              onPress={() => {
                setHidden(!hidden);
                void browse(listing?.path || path, 0, !hidden);
              }}
            >
              {hidden ? t("ui-app.workspace.hideHidden") : t("ui-app.workspace.showHidden")}
            </Button>
          </View>
          <ErrorBox text={error} />
          {listing ? (
            <>
              <Text
                selectable
                style={[s.mono, { fontSize: 11, color: C.muted }]}
              >
                {t("ui-app.workspace.browsing", { path: listing.path })}
              </Text>
              <ScrollView
                style={{ maxHeight: 210 }}
                nestedScrollEnabled
                keyboardShouldPersistTaps="handled"
              >
                {listing.entries.map((entry) => (
                  <Pressable
                    key={entry.name}
                    disabled={busy || disabled}
                    accessibilityRole="button"
                    accessibilityLabel={t("ui-app.workspace.openEntry", { name: entry.name })}
                    onPress={() => void browse(entry.path)}
                    style={[
                      s.row,
                      {
                        paddingVertical: 11,
                        borderBottomWidth: 1,
                        borderColor: C.line,
                      },
                    ]}
                  >
                    <Text style={{ color: C.accent }}>▱</Text>
                    <Text style={{ fontSize: 13, color: C.ink, flex: 1 }}>
                      {entry.name}
                      {entry.symlink ? " ↗" : ""}
                    </Text>
                    <Text style={{ color: C.muted }}>›</Text>
                  </Pressable>
                ))}
                {!listing.entries.length && !busy ? (
                  <Text style={[s.muted, { padding: 10 }]}>
                    {t("ui-app.workspace.empty")}
                  </Text>
                ) : null}
                {listing.nextOffset !== null ? (
                  <Button
                    busy={busy}
                    variant="ghost"
                    onPress={() =>
                      void browse(listing.path, listing.nextOffset!)
                    }
                  >
                    {t("ui-app.workspace.more")}
                  </Button>
                ) : null}
              </ScrollView>
            </>
          ) : null}
          {recent.length ? (
            <View style={{ gap: 6 }}>
              <Text style={s.label}>{t("ui-app.workspace.recent")}</Text>
              {recent.slice(-8).map((w) => (
                <Pressable
                  key={w.id}
                  disabled={busy || disabled}
                  onPress={() => void browse(w.path)}
                >
                  <Text
                    numberOfLines={1}
                    style={{
                      fontSize: 12,
                      color: C.accent,
                      paddingVertical: 5,
                    }}
                  >
                    {w.path}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          <Text style={s.muted}>
            {t("ui-app.workspace.typeNew")}
          </Text>
          <Button
            variant="soft"
            disabled={disabled || busy}
            onPress={() => setOpen(false)}
          >
            {t("ui-app.workspace.use")}
          </Button>
        </View>
      ) : null}
      {!open ? (
        <Text style={{ fontSize: 11, lineHeight: 18, color: C.muted }}>
          {t("ui-app.workspace.hint")}
        </Text>
      ) : null}
    </View>
  );
}
