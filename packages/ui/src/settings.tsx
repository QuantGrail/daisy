/**
 * 设置 (P1-08, 5.10 stage 1): PIN, harness 登录（身份档）, 工作目录,
 * 入口面与口令, 设备 (P5-03), 开机自启, 更新与重启; P4-12: 对外 (agents and their range,
 * 问与办, call cards, grants, contacts and the whitelist, tokens for
 * third-party clients, what my AIs called) — plus the prompt additions that
 * were here (P6-01: the phone test client went with the Expo native app). No
 * machine table any more (one Daisy, one machine: D-01, P1-03).
 */
import { Text } from "./primitives";
import React, { useEffect } from "react";
import { View, ScrollView } from "react-native";
import { DaisyClient, type Catalog } from "@daisy-ai/client";
import type { User } from "@daisy-ai/contracts";
import { useDaisyTheme } from "./theme";
import { MyPromptPanel } from "./prompt-layers";
import { PinSettings } from "./pin";
import { HarnessIdentities } from "./identities";
import { AccessSettings } from "./access-settings";
import { DeviceSettings } from "./device-settings";
import { SharingSettings } from "./sharing";
import {
  AutostartSettings,
  UpdateSettings,
  WorkspaceSettings,
} from "./machine-settings";
import { LanguageSettings } from "./language-settings";
import { loadUiLanguage, uiLanguageLoaded, useT } from "./i18n";
export function Settings({
  client,
  catalog,
  user,
  onRefresh,
  hideNodeSettings = false,
  hideDeveloperInfo = false,
  hostName,
  top,
  bottom,
  hideWorkspaces = false,
}: {
  client: DaisyClient;
  catalog: Catalog;
  user: User | null;
  onRefresh: () => Promise<void>;
  /**
   * The host manages this machine itself (branding hideNodeSettings): no
   * 入口面与口令 / 开机自启 / 更新与重启 blocks.
   */
  hideNodeSettings?: boolean;
  /** Hide the developer integration note (branding hideDeveloperInfo). */
  hideDeveloperInfo?: boolean;
  /** The embedding product, e.g. "the host UI" (branding hostName). */
  hostName?: string;
  /** Host content at the top, e.g. the host's own service switch. */
  top?: React.ReactNode;
  /** Hide 工作目录 (the host picks directories itself). */
  hideWorkspaces?: boolean;
  /** Host content at the bottom (e.g. defaults for new chats). */
  bottom?: React.ReactNode;
}) {
  const { C, s, sp } = useDaisyTheme();
  const t = useT();
  // P6-20: an embedding host that did not load the language pack gets it here.
  useEffect(() => {
    if (!uiLanguageLoaded()) void loadUiLanguage(client);
  }, [client]);
  return (
    <ScrollView
      testID="settings"
      contentContainerStyle={{
        padding: sp(26),
        gap: sp(22),
        maxWidth: 1000,
        width: "100%",
        alignSelf: "center",
      }}
    >
      <View style={{ gap: 8 }}>
        <Text style={s.title}>{t("ui.settings.title")}</Text>
        <Text style={s.muted}>
          {hideNodeSettings && hostName
            ? t("ui.settings.introHosted", { host: hostName })
            : t("ui.settings.intro")}
        </Text>
      </View>
      {top}
      <PinSettings client={client} />
      {/* P6-20 (ADR-159): the owner's display language. */}
      <LanguageSettings client={client} />
      <HarnessIdentities client={client} catalog={catalog} onRefresh={onRefresh} />
      {hideWorkspaces ? null : (
        <WorkspaceSettings client={client} catalog={catalog} onRefresh={onRefresh} />
      )}
      {/* P4-12 (5.10): 三种 agent 与开放范围、问与办、待批准的调用、互认的名片与白名单、令牌、我的 AI 调用了谁. */}
      <SharingSettings client={client} catalog={catalog} />
      {hideNodeSettings ? null : (
        <>
          <AccessSettings client={client} />
          {/* P5-03 (ADR-142): 设备 — paired devices, pairing codes, revoking. */}
          <DeviceSettings client={client} />
          <AutostartSettings client={client} />
          <UpdateSettings client={client} catalog={catalog} />
        </>
      )}
      {/* My own additions to my sessions' prompt. */}
      {user ? <MyPromptPanel client={client} user={user} /> : null}
      {bottom}
      {!hideDeveloperInfo ? (
        <View style={[s.card, { backgroundColor: C.soft, borderWidth: 0 }]}>
          <Text style={s.h3}>{t("ui.settings.embed.title")}</Text>
          <Text style={s.muted}>{t("ui.settings.embed.body")}</Text>
        </View>
      ) : null}
    </ScrollView>
  );
}
