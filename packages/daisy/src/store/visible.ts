// a resident's visible items (P1-00: moved from store.ts).
/**
 * a resident's conversation view — what its private chat shows
 * (`residentVisible`): people's words (kind user), its `say`, and the
 * state notices (paused, resumed …). One SQL text for the partial index
 * `items_visible` and the queries, so SQLite matches them.
 */
export const VISIBLE_ITEM_SQL =
  "(json_extract(data,'$.kind')='user' OR json_extract(data,'$.category')='say' OR (id>='resident-state:' AND id<'resident-state;'))";
/**
 * newest visible items first (`older`: before a rowid). Planned as
 * `SEARCH items USING INDEX items_visible` — no scan, no temp B-tree
 * (tests/resident-visible-paging.test.ts checks the plan).
 */
export const visibleItemsSql = (older: boolean) =>
  `SELECT data FROM items WHERE session_id=?${older ? " AND rowid<?" : ""} AND ${VISIBLE_ITEM_SQL} ORDER BY rowid DESC LIMIT ?`;
/** visible items per conversation page: default / most. */
export const VISIBLE_PAGE_DEFAULT = 20;
export const VISIBLE_PAGE_MAX = 100;
