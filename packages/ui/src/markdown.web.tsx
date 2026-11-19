import { t as tr } from "./i18n";
import React, { useMemo } from "react";
import MarkdownIt from "markdown-it";
import { useDaisyTheme, type ResolvedDaisyTheme } from "./theme";
import { useDaisyHost } from "./host";
import { Linking } from "react-native";

/**
 * Web build of ./markdown (chat latency work, 2026-10-30): the same
 * markdown-it tokens and the same look, rendered as plain DOM elements
 * instead of react-native-web Text / View (several times cheaper per
 * message). HTML stays disabled: tokens become React elements, never
 * injected markup. Native keeps ./markdown.tsx.
 */
const parser = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  breaks: true,
});
type Token = ReturnType<typeof parser.parse>[number];
type Ctx = ResolvedDaisyTheme & { openUrl: (url: string) => Promise<void> };
type Css = React.CSSProperties;

/** react-native-web's View / Text boxes, as plain CSS. */
const VIEW: Css = {
  display: "flex",
  flexDirection: "column",
  flexShrink: 0,
  minWidth: 0,
  minHeight: 0,
  position: "relative",
  boxSizing: "border-box",
};
const text = (x: Ctx, style: Css): Css => ({
  margin: 0,
  padding: 0,
  boxSizing: "border-box",
  whiteSpace: "pre-wrap",
  overflowWrap: "break-word",
  fontFamily: x.font.family,
  userSelect: "text",
  ...style,
});

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
        url = String(t.attrGet("href") || ""),
        web = t.type === "link_open" && /^https?:\/\//i.test(url);
      result.push(
        <span
          key={k}
          role={web ? "link" : undefined}
          tabIndex={web ? 0 : undefined}
          onClick={web ? () => void x.openUrl(url).catch(() => {}) : undefined}
          onKeyDown={
            web
              ? (e) => {
                  if (e.key === "Enter") void x.openUrl(url).catch(() => {});
                }
              : undefined
          }
          style={
            t.type === "strong_open"
              ? { fontWeight: 700 }
              : t.type === "em_open"
                ? { fontStyle: "italic" }
                : t.type === "s_open"
                  ? { textDecorationLine: "line-through" }
                  : {
                      color: C.accent,
                      textDecorationLine: "underline",
                      cursor: web ? "pointer" : undefined,
                    }
          }
        >
          {children}
        </span>,
      );
      i = j;
    } else if (t.type === "code_inline")
      result.push(
        <span
          key={k}
          style={{
            fontFamily: font.mono,
            fontSize: 12,
            backgroundColor: C.codeInline,
            color: C.codeInk,
          }}
        >
          {t.content}
        </span>,
      );
    else if (t.type === "softbreak" || t.type === "hardbreak")
      result.push("\n");
    else if (t.type === "image")
      result.push(
        <span key={k} style={{ color: C.muted }}>
          {tr("ui-chat.markdown.image", { alt: t.content || tr("ui-chat.markdown.imageAlt") })}
        </span>,
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
        <div
          key={k}
          dir="auto"
          style={text(x, { fontSize: 14, lineHeight: "24px", color: C.ink })}
        >
          {inline(x, t.children || [])}
        </div>
      );
    if (t.type === "fence" || t.type === "code_block")
      return (
        <div
          key={k}
          style={{
            ...VIEW,
            backgroundColor: C.code,
            borderRadius: rad(9),
            border: `1px solid ${C.line}`,
            marginTop: 8,
            marginBottom: 8,
            overflow: "hidden",
          }}
        >
          {t.info ? (
            <div
              style={{
                ...VIEW,
                padding: "6px 13px",
                borderBottom: `1px solid ${C.line}`,
              }}
            >
              <div style={text(x, { fontSize: 10, color: C.muted })}>
                {t.info}
              </div>
            </div>
          ) : null}
          <div style={{ ...VIEW, overflowX: "auto", padding: 13 }}>
            <div
              style={text(x, {
                fontFamily: s.mono.fontFamily,
                fontSize: s.mono.fontSize,
                lineHeight: `${s.mono.lineHeight}px`,
                color: s.mono.color,
                whiteSpace: "pre",
              })}
            >
              {t.content.trimEnd()}
            </div>
          </div>
        </div>
      );
    if (t.type === "heading_open") {
      const size =
        ({ h1: 23, h2: 19, h3: 16 } as Record<string, number>)[t.tag] || 15;
      return (
        <div
          key={k}
          dir="auto"
          style={text(x, {
            fontSize: size,
            fontWeight: 700,
            lineHeight: `${size + 10}px`,
            color: C.ink,
            marginTop: 14,
            marginBottom: 6,
          })}
        >
          {inline(
            x,
            children.flatMap((c) => c.token.children || []),
          )}
        </div>
      );
    }
    if (t.type === "bullet_list_open" || t.type === "ordered_list_open")
      return (
        <div key={k} style={{ ...VIEW, marginTop: 5, marginBottom: 5, gap: 3 }}>
          {children.map((c, j) => (
            <div
              key={j}
              style={{ ...VIEW, flexDirection: "row", gap: 9, paddingLeft: 8 }}
            >
              <div
                style={text(x, {
                  color: C.ink,
                  lineHeight: "24px",
                  minWidth: 13,
                  fontSize: 14,
                })}
              >
                {t.type === "ordered_list_open"
                  ? `${Number(t.attrGet("start") || 1) + j}.`
                  : "•"}
              </div>
              <div style={{ ...VIEW, flex: 1 }}>
                {render(x, c.children, k + j, true)}
              </div>
            </div>
          ))}
        </div>
      );
    if (t.type === "blockquote_open")
      return (
        <div
          key={k}
          style={{
            ...VIEW,
            paddingLeft: 13,
            paddingRight: 10,
            borderLeft: `3px solid ${C.accent}`,
            backgroundColor: C.soft,
            marginTop: 8,
            marginBottom: 8,
          }}
        >
          {render(x, children, k)}
        </div>
      );
    if (t.type === "hr")
      return (
        <div
          key={k}
          style={{
            ...VIEW,
            height: 1,
            backgroundColor: C.line,
            marginTop: 14,
            marginBottom: 14,
          }}
        />
      );
    if (t.type === "table_open")
      return (
        <div
          key={k}
          style={{ ...VIEW, overflowX: "auto", marginTop: 8, marginBottom: 8 }}
        >
          <div
            style={{
              ...VIEW,
              alignSelf: "flex-start",
              border: `1px solid ${C.line}`,
              borderRadius: rad(6),
            }}
          >
            {render(x, children, k)}
          </div>
        </div>
      );
    if (t.type === "tr_open")
      return (
        <div key={k} style={{ ...VIEW, flexDirection: "row" }}>
          {render(x, children, k)}
        </div>
      );
    if (t.type === "th_open" || t.type === "td_open")
      return (
        <div
          key={k}
          style={{
            ...VIEW,
            width: 180,
            padding: 9,
            borderBottom: `1px solid ${C.line}`,
            borderRight: `1px solid ${C.line}`,
            backgroundColor: t.type === "th_open" ? C.bg : C.paper,
          }}
        >
          {render(x, children, k)}
        </div>
      );
    const margin = t.type === "paragraph_open" && !inList ? 5 : 0;
    return (
      <div key={k} style={{ ...VIEW, marginTop: margin, marginBottom: margin }}>
        {children.length ? (
          render(x, children, k)
        ) : t.content ? (
          <div
            style={text(x, {
              fontSize: s.muted.fontSize,
              lineHeight: `${s.muted.lineHeight}px`,
              color: s.muted.color,
            })}
          >
            {t.content}
          </div>
        ) : null}
      </div>
    );
  });
}
/**
 * Parsed blocks per text and rendered elements per (blocks, theme, link
 * opener), shared by every row showing the text (round 2: the same
 * messages render in hidden panes, again when shown, again after a page
 * of older messages; parsing them each time was a third of a row's cost).
 */
const parsed = new Map<string, ReturnType<typeof tree>>();
const rendered = new WeakMap<
  object,
  { key: unknown[]; nodes: React.ReactNode }
>();
function blocksOf(text: string) {
  let b = parsed.get(text);
  if (b) return b;
  b = tree(parser.parse(text.slice(0, 250000), {}));
  if (parsed.size > 3000) parsed.delete(parsed.keys().next().value!);
  parsed.set(text, b);
  return b;
}
/** One link opener per host adapter (shared by all rows). */
const openers = new Map<unknown, (url: string) => Promise<void>>();
function openerFor(impl?: (url: string) => unknown) {
  let f = openers.get(impl);
  if (!f) {
    f = async (url: string) => {
      await (impl ? impl(url) : Linking.openURL(url));
    };
    openers.set(impl, f);
  }
  return f;
}
export default function Markdown({ children }: { children: string }) {
  const theme = useDaisyTheme(),
    openUrl = openerFor(useDaisyHost().adapters.openUrl);
  const blocks = blocksOf(children);
  const nodes = useMemo(() => {
    const hit = rendered.get(blocks as object);
    if (hit && hit.key[0] === theme && hit.key[1] === openUrl) return hit.nodes;
    const out = render({ ...theme, openUrl }, blocks);
    rendered.set(blocks as object, { key: [theme, openUrl], nodes: out });
    return out;
  }, [theme, openUrl, blocks]);
  return <div style={VIEW}>{nodes}</div>;
}
