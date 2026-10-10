/**
 * Text keys shared by the server and the browser. normalizeKey moved here from src/server/util/ids.ts (which
 * re-exports it) so the shared lab-value and analyte modules can use the exact same key in both places.
 */
/** Lower-case, strip punctuation, collapse whitespace. For dedup/grouping keys. */
export function normalizeKey(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
