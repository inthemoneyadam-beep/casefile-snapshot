/**
 * My notes and the two-stage reconciler, in the app's words. Plain TypeScript (no React), so tests can read it.
 */
import type { TagTone } from '../../ui/StatusTag';
import { NOTE_DATE_FROM_WORDS, STANDING_WORDS, type NoteDateFrom, type Standing } from '@shared/notes';

export const MY_NOTES = 'My notes';

export const STANDING_TONE: Record<Standing, TagTone> = { agrees: 'ok', differs: 'bad', waiting: 'warn', nothing: 'neutral' };

export function standingWords(s: Standing): string {
  return STANDING_WORDS[s];
}

/** "date from the file" etc., only where it says something (a note's own heading is the plain case). */
export function dateFromWords(from: NoteDateFrom | null | undefined): string | null {
  if (!from || from === 'content') return null;
  return NOTE_DATE_FROM_WORDS[from];
}

/** Where a note stands with Claude's reading, in words. */
export function readWords(n: { textStatus: string; extractionStatus: string }): string {
  if (['pending', 'extracting', 'ocr_needed', 'ocr_running'].includes(n.textStatus)) return 'getting the text';
  if (n.textStatus === 'failed') return 'could not get its text';
  switch (n.extractionStatus) {
    case 'done':
      return 'read';
    case 'partial':
      return 'partly read';
    case 'queued':
    case 'running':
      return 'being read';
    case 'failed':
      return 'could not be read';
    default:
      return 'not read yet';
  }
}

export const READ_TONE: Record<string, TagTone> = { read: 'ok', 'partly read': 'warn', 'being read': 'info', 'could not be read': 'bad', 'could not get its text': 'bad', 'not read yet': 'neutral', 'getting the text': 'info' };

/** "3 notes", "1 note". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The kinds of file the import takes (the file picker's accept list). */
export const NOTE_ACCEPT = '.txt,.text,.md,.markdown,.html,.htm,.docx,.pdf,.rtf,.csv,.tsv,.json,.enex,.zip,.png,.jpg,.jpeg,.gif,.webp,.tif,.tiff,.bmp';

/** The import's result in one or two plain sentences. */
export function importWords(r: { added: number; duplicates: number; skippedTotal: number }): string {
  const bits = [`${plural(r.added, 'note')} added`];
  if (r.duplicates) bits.push(`${r.duplicates} already in`);
  if (r.skippedTotal) bits.push(`${r.skippedTotal} skipped`);
  return `${bits.join(', ')}.`;
}
