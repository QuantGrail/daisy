/**
 * 标明来源的提示词（D-18，P1-01 从聊天的 collaboration-prompt.ts 抽出）。
 *
 * 外来的内容交给 AI 时，写明它来自谁、该怎么对待：`【来自】` 一行，按来
 * 源区分的 `【怎么处理】` 一行，正文作为外部资料放进 `<external_message>`
 * （主人本人亲自写的话除外）。和群、话题、成员有关的措辞已经去掉；“有副
 * 作用的事先问本人”那句按 D-14 去掉，按自动模式执行。
 *
 * 纯函数：调用方（唤醒投递、以后的 A2A 入口）收集上下文，这里只拼文字。
 *
 * 防注入：别人写的文字一律进带分隔的标签，以 JSON 写出，`<`/`>` 转义
 * （`clean`）；人选的短字段（名字、标题）压成一行、截短、去掉标签和
 * 【】括号（`flat` / `line`），伪造不出新的段落。
 */
import { localTimeZone, zoneName } from "../../../contracts/src/scheduler.ts";
import type { Lang } from "../../../contracts/src/i18n.ts";
import { LEGACY_PROMPT_LANG, promptT } from "../../../contracts/src/prompt-i18n.ts";
import "./lang.ts";
export const clean = (x: string) =>
  x.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
/**
 * One line, at most `n` characters, no tag or 【】 section brackets: for
 * labels Daisy composed (「…」 kept) from already cleaned parts.
 */
export function flat(x: unknown, n = 80) {
  const t = String(x ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[<>]/g, "")
    .replace(/[【】]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}
/**
 * Text people chose (titles, names), for a header line: as `flat`, and
 * 「」『』 become “” so it cannot close the quotes around it.
 */
export function line(x: unknown, n = 80) {
  return flat(
    String(x ?? "")
      .replace(/[「『]/g, "“")
      .replace(/[」』]/g, "”"),
    n,
  );
}
/**
 * 「2026-10-31 14:02 Asia/Shanghai」: in this machine's time zone,
 * named (ADR-154; was Beijing time, unnamed).
 */
export function when(ms: number) {
  if (!ms) return "";
  const tz = localTimeZone(ms);
  const d = new Date(ms + tz.offsetMinutes * 60_000).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)} ${zoneName(tz)}`;
}

/** Who the content is from, seen from the AI it is given to. */
export type Source =
  /** 主人本人。 */
  | { kind: "owner"; name: string }
  /** 主人自己的另一个 AI。 */
  | { kind: "own-ai"; name: string }
  /** 团队里别的人（不是主人）。 */
  | { kind: "member"; name: string }
  /** 别人的 AI。 */
  | { kind: "peer-ai"; name: string; owner: string }
  /** Daisy 自己（系统事件），`name` 是它的说法。 */
  | { kind: "system"; name: string };

/**
 * What the content is: a request (`request`, the default), the answer to
 * the AI's own earlier request (`answer`: handed back as reference
 * material), or its request failed (`failed`).
 */
export type SourceOutcome = "request" | "answer" | "failed";

/** 【来自】's text for `s`, in `lang` (the session's). */
export function sourceLine(s: Source, lang: Lang = LEGACY_PROMPT_LANG): string {
  const t = promptT(lang);
  switch (s.kind) {
    case "owner":
      return t("prompt-source.from.owner", { name: line(s.name, 60) });
    case "own-ai":
      return t("prompt-source.from.ownAi", { name: line(s.name) });
    case "member":
      return t("prompt-source.from.member", { name: line(s.name, 60) });
    case "peer-ai":
      return t("prompt-source.from.peerAi", { owner: line(s.owner || t("prompt-source.from.someone"), 60), name: line(s.name) });
    case "system":
      return line(s.name, 60);
  }
}

export interface SourceHandlingInput {
  source: Source;
  /** The AI's owner (for 「不是你的本人（…）的授权」). */
  ownerName: string;
  /**
   * The AI's own owner, signed in, wrote this text herself: given as her
   * words, not as external content.
   */
  ownerWords?: boolean;
  outcome?: SourceOutcome;
  /** `failed`: the status it ended with (rejected, error, …). */
  failure?: string;
  /** P6-24: the language of the session the text is for (absent: one before P6-24, Chinese). */
  lang?: Lang;
}

/**
 * What the 群聊 prompt said as 「群里所有成员都看得见」, without the 群: the
 * answer leaves this session, so nothing private goes with it.
 */
/** 【怎么处理】's text: by source (a request) or by outcome (answer / failed). */
export function sourceHandling(i: SourceHandlingInput): string {
  const t = promptT(i.lang ?? LEGACY_PROMPT_LANG);
  const owner = line(i.ownerName, 60) || t("prompt-source.owner.fallback");
  const priv = t("prompt-source.private");
  if (i.outcome === "failed")
    return t("prompt-source.handling.failed", {
      status: i.failure ? t("prompt-source.handling.failedStatus", { status: line(i.failure, 30) }) : "",
    });
  if (i.outcome === "answer")
    return (
      (i.ownerWords ? t("prompt-source.handling.answerOwn") : t("prompt-source.handling.answerRef", { owner })) +
      t("prompt-source.handling.answerTail")
    );
  switch (i.source.kind) {
    case "owner":
      return i.ownerWords ? t("prompt-source.handling.ownerWords") : t("prompt-source.handling.ownerAccount", { private: priv });
    case "own-ai":
      return t("prompt-source.handling.ownAi");
    default:
      return t("prompt-source.handling.other", { owner, private: priv });
  }
}

export interface SourcePromptInput extends SourceHandlingInput {
  /** 【事件】's text, when the prompt starts with one. */
  event?: string;
  /** The content itself (someone else's words unless `ownerWords`). */
  text: string;
  sentAt?: number;
  /** Extra fields of the content, shown inside <external_message>. */
  meta?: Record<string, unknown>;
}

/**
 * The whole block an AI gets for content from elsewhere: 【事件】 (when
 * given), 【来自】, the content (the owner's own words plain, anything
 * else as external data), 【怎么处理】.
 */
export function sourcePrompt(i: SourcePromptInput): string {
  const t = promptT(i.lang ?? LEGACY_PROMPT_LANG);
  const body = i.ownerWords
    ? `${t("prompt-source.block.ownerWords", {
        name: line(i.ownerName, 60) || t("prompt-source.owner.fallback"),
        when: i.sentAt ? t("prompt-source.block.when", { when: when(i.sentAt) }) : "",
      })}\n${i.text}\n`
    : `<external_message>\n${clean(
        JSON.stringify({
          ...(i.meta || {}),
          ...(i.sentAt ? { sentAt: new Date(i.sentAt).toISOString() } : {}),
          text: i.text,
        }),
      )}\n</external_message>\n`;
  return (
    (i.event ? `${t("prompt-source.block.event", { event: flat(i.event, 120) })}\n` : "") +
    `${t("prompt-source.block.from", { from: sourceLine(i.source, t.lang) })}\n` +
    body +
    t("prompt-source.block.handling", { handling: sourceHandling(i) })
  );
}
