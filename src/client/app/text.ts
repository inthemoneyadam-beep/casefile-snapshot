/**
 * Small word helpers the pages shared by copying (sweep 2026-10-07). Free of React and DOM types.
 */

/** "1 file", "3 files", "2 calls and messages" (with `many` for an irregular plural). */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** An optional form field: its trimmed text, or null when nothing but spaces was typed. */
export function nz(s: string): string | null {
  const t = s.trim();
  return t ? t : null;
}

/** "What Claude noticed" → "what Claude noticed": only the first letter lower-cased, names keep their capital. */
export function lowerFirst(words: string): string {
  return words ? words.charAt(0).toLowerCase() + words.slice(1) : words;
}
