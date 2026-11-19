/** Line icons (24×24 paths) the workbench draws (P1-01: the chat's icons went with it). */
export const paths = {
  compose:
    "M13 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8 M16 3l5 5 M10 14l1-5L19 1l4 4-8 8-5 1",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
  sidebar: "M3 4h18v16H3z M9 4v16",
} as const;
export type ChatIconName = keyof typeof paths;
