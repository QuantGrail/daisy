import { t as tr } from "./i18n";
import { Text } from "./primitives";
import React, { useMemo } from "react";
import { View, ScrollView } from "react-native";
import MarkdownIt from "markdown-it";
import { useDaisyTheme, type ResolvedDaisyTheme } from "./theme";
import { useOpenUrl } from "./host";
// HTML is disabled. Native Text/Views render the AST; no injected browser HTML.
const parser = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  breaks: true,
});
type Token = ReturnType<typeof parser.parse>[number];
type Ctx = ResolvedDaisyTheme & { openUrl: (url: string) => Promise<void> };
function inline(x: Ctx, tokens: Token[], key = "i"): React.ReactNode[] {
  const { C, font } = x;
  const result: React.ReactNode[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i],
      k = key + i;
    if (["strong_open", "em_open", "s_open", "link_open"].includes(t.type)) {
      const close = t.type.replace("_open", "_close");
      let depth = 1,
        j = i + 1;
      for (; j < tokens.length; j++) {
        if (tokens[j].type === t.type) depth++;
        if (tokens[j].type === close && !--depth) break;
      }
      const children = inline(x, tokens.slice(i + 1, j), k),
        url = String(t.attrGet("href") || "");
      result.push(
        <Text
          key={k}
          style={
            t.type === "strong_open"
              ? { fontWeight: "700" }
              : t.type === "em_open"
                ? { fontStyle: "italic" }
                : t.type === "s_open"
                  ? { textDecorationLine: "line-through" }
                  : { color: C.accent, textDecorationLine: "underline" }
          }
          onPress={
            t.type === "link_open" && /^https?:\/\//i.test(url)
              ? () => void x.openUrl(url).catch(() => {})
              : undefined
          }
        >
          {children}
        </Text>,
      );
      i = j;
    } else if (t.type === "code_inline")
      result.push(
        <Text
          key={k}
          style={{
            fontFamily: font.mono,
            fontSize: 12,
            backgroundColor: C.codeInline,
            color: C.codeInk,
          }}
        >
          {t.content}
        </Text>,
      );
    else if (t.type === "softbreak" || t.type === "hardbreak")
      result.push("\n");
    else if (t.type === "image")
      result.push(
        <Text key={k} style={{ color: C.muted }}>
          {tr("ui-chat.markdown.image", { alt: t.content || tr("ui-chat.markdown.imageAlt") })}
        </Text>,
      );
    else if (t.content) result.push(t.content);
  }
  return result;
}
interface Block {
  token: Token;
  children: Block[];
}
function tree(tokens: Token[]) {
  const root: Block[] = [];
  const stack = [root];
  for (const token of tokens) {
    if (token.nesting === -1) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node = { token, children: [] };
    stack[stack.length - 1].push(node);
    if (token.nesting === 1) stack.push(node.children);
  }
  return root;
}
function render(
  x: Ctx,
  nodes: Block[],
  key = "b",
  inList = false,
): React.ReactNode[] {
  const { C, s, rad } = x;
  return nodes.map(({ token: t, children }, i) => {
    const k = key + i;
    if (t.type === "inline")
      return (
        <Text
          key={k}
          selectable
          style={{ fontSize: 14, lineHeight: 24, color: C.ink }}
        >
          {inline(x, t.children || [])}
        </Text>
      );
    if (t.type === "fence" || t.type === "code_block")
      return (
        <View
          key={k}
          style={{
            backgroundColor: C.code,
            borderRadius: rad(9),
            borderWidth: 1,
            borderColor: C.line,
            marginVertical: 8,
            overflow: "hidden",
          }}
        >
          {t.info ? (
            <View
              style={{
                paddingHorizontal: 13,
                paddingVertical: 6,
                borderBottomWidth: 1,
                borderColor: C.line,
              }}
            >
              <Text style={{ fontSize: 10, color: C.muted }}>{t.info}</Text>
            </View>
          ) : null}
          <ScrollView horizontal contentContainerStyle={{ padding: 13 }}>
            <Text selectable style={s.mono}>
              {t.content.trimEnd()}
            </Text>
          </ScrollView>
        </View>
      );
    if (t.type === "heading_open") {
      const size =
        ({ h1: 23, h2: 19, h3: 16 } as Record<string, number>)[t.tag] || 15;
      return (
        <Text
          key={k}
          selectable
          style={{
            fontSize: size,
            fontWeight: "700",
            lineHeight: size + 10,
            color: C.ink,
            marginTop: 14,
            marginBottom: 6,
          }}
        >
          {inline(
            x,
            children.flatMap((c) => c.token.children || []),
          )}
        </Text>
      );
    }
    if (t.type === "bullet_list_open" || t.type === "ordered_list_open")
      return (
        <View key={k} style={{ marginVertical: 5, gap: 3 }}>
          {children.map((c, j) => (
            <View
              key={j}
              style={{ flexDirection: "row", gap: 9, paddingLeft: 8 }}
            >
              <Text style={{ color: C.ink, lineHeight: 24, minWidth: 13 }}>
                {t.type === "ordered_list_open"
                  ? `${Number(t.attrGet("start") || 1) + j}.`
                  : "•"}
              </Text>
              <View style={{ flex: 1 }}>
                {render(x, c.children, k + j, true)}
              </View>
            </View>
          ))}
        </View>
      );
    if (t.type === "blockquote_open")
      return (
        <View
          key={k}
          style={{
            paddingLeft: 13,
            paddingRight: 10,
            borderLeftWidth: 3,
            borderColor: C.accent,
            backgroundColor: C.soft,
            marginVertical: 8,
          }}
        >
          {render(x, children, k)}
        </View>
      );
    if (t.type === "hr")
      return (
        <View
          key={k}
          style={{ height: 1, backgroundColor: C.line, marginVertical: 14 }}
        />
      );
    if (t.type === "table_open")
      return (
        <ScrollView horizontal key={k} style={{ marginVertical: 8 }}>
          <View
            style={{
              borderWidth: 1,
              borderColor: C.line,
              borderRadius: rad(6),
            }}
          >
            {render(x, children, k)}
          </View>
        </ScrollView>
      );
    if (t.type === "tr_open")
      return (
        <View key={k} style={{ flexDirection: "row" }}>
          {render(x, children, k)}
        </View>
      );
    if (t.type === "th_open" || t.type === "td_open")
      return (
        <View
          key={k}
          style={{
            width: 180,
            padding: 9,
            borderBottomWidth: 1,
            borderRightWidth: 1,
            borderColor: C.line,
            backgroundColor: t.type === "th_open" ? C.bg : C.paper,
          }}
        >
          {render(x, children, k)}
        </View>
      );
    return (
      <View
        key={k}
        style={{
          marginVertical: t.type === "paragraph_open" && !inList ? 5 : 0,
        }}
      >
        {children.length ? (
          render(x, children, k)
        ) : t.content ? (
          <Text selectable style={s.muted}>
            {t.content}
          </Text>
        ) : null}
      </View>
    );
  });
}
export default function Markdown({ children }: { children: string }) {
  const theme = useDaisyTheme(),
    openUrl = useOpenUrl();
  const blocks = useMemo(
    () => tree(parser.parse(children.slice(0, 250000), {})),
    [children],
  );
  const nodes = useMemo(
    () => render({ ...theme, openUrl }, blocks),
    [theme, openUrl, blocks],
  );
  return <View style={{ minWidth: 0 }}>{nodes}</View>;
}
