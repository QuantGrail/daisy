/**
 * Files dropped anywhere on an AI conversation (Web, 2026-11-05:
 * 「优化这个图片拖拽体验」): a file let go over the conversation goes
 * to its composer — not only when it lands on the composer itself — and a
 * file let go anywhere else never makes the browser open it (and leave the
 * page). chat-drop-zone.web.tsx wires the window events and the overlay.
 */

/** What an element exposes here (an Element in the browser). */
export interface DropNode {
  closest(selector: string): DropNode | null;
  contains(other: DropNode | null): boolean;
  readonly parentElement: DropNode | null;
}

export type DropTarget =
  | {
      kind: "session";
      /** Shown in the overlay: 「松开即可添加到当前对话」 + this. */
      title: string;
      /** A second line, when there is one. */
      note?: string;
    }
  | { kind: "none"; hint: string | null };

/** One key per distinct overlay (re-rendered only when it changes). */
export const dropKey = (t: DropTarget, ready: boolean) =>
  t.kind === "none"
    ? `none:${t.hint ?? ""}`
    : `${t.kind}:${t.title}:${t.note ?? ""}:${ready ? 1 : 0}`;
