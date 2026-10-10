/**
 * Query-term highlighting for search results. Tokens follow the same rule
 * as the server's `ftsQuery` (letters, numbers, dots and dashes; at least two
 * characters; prefix match), so what is marked is what matched.
 */
import type { ReactNode } from 'react';

export function queryTokens(q: string): string[] {
  const tokens = q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s.-]/gu, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((t) => t.length >= 2);
  return [...new Set(tokens)].sort((a, b) => b.length - a.length);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DATE = /(\d{4}-\d{2}(?:-\d{2})?)/;

/**
 * highlight(), with every date kept whole when the text wraps ("on 2022-04-05." never breaks as "2023-" / "11-02"):
 * the dates sit in a no-wrap span, the words between them are marked as usual.
 */
export function highlightKeepDates(text: string | null | undefined, tokens: string[]): ReactNode {
  if (!text) return null;
  const parts = text.split(DATE);
  if (parts.length === 1) return highlight(text, tokens);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className="nowrap">
        {highlight(part, tokens)}
      </span>
    ) : (
      <span key={i}>{highlight(part, tokens)}</span>
    ),
  );
}

/** Wrap every occurrence of a token in <mark class="hl">. Plain text in, React nodes out. */
export function highlight(text: string | null | undefined, tokens: string[]): ReactNode {
  if (!text) return null;
  if (!tokens.length) return text;
  const re = new RegExp(`(${tokens.map(escapeRegExp).join('|')})`, 'giu');
  const parts = text.split(re);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="hl">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}
