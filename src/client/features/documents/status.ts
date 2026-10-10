/**
 * Where a document stands, in one plain phrase, worked out from what it holds
 * rather than from a job's state alone: a document whose details are listed
 * never says "Details not pulled out yet" beside them, and a document read only
 * in part says so before it says how many details were found (2026-10-07: a
 * 1,840-page export with details from pp.1-48 read "287 details found" as if it
 * were finished).
 *
 * Plain TypeScript (no React, no DOM) so tests can import it directly.
 */
import { coverageOf, coverageStatusWords } from './coverage';

/** File kinds in plain words (the Kind filter on Documents, the File column of Deleted documents). */
export const KIND_WORDS: Record<string, string> = {
  pdf: 'PDF',
  image: 'Photo or scan',
  docx: 'Word',
  text: 'Text',
  csv: 'Spreadsheet (CSV)',
  json: 'Data (JSON)',
  dicom: 'Scan images (DICOM)',
  audio_transcript: 'Call transcript',
  other: 'Other',
};

export interface DocumentStatusInput {
  textStatus: string;
  extractionStatus: string;
  factsCount?: number | null;
  /** The document row's metadata (its coverage says which pages were read). */
  metadataJson?: string | null;
}

export interface DocumentStatus {
  words: string;
  /** Claude is working on it right now. */
  busy: boolean;
  /** Something did not work. */
  bad: boolean;
  /** Ready and holding details: nothing to say in a list. */
  quiet: boolean;
  /** Only part of its pages were read (the rest waits, or could not be read). */
  partial: boolean;
  /** "287 details found" when it holds details; null otherwise. */
  found: string | null;
}

export function documentStatus(d: DocumentStatusInput): DocumentStatus {
  const n = typeof d.factsCount === 'number' && d.factsCount > 0 ? d.factsCount : 0;
  const found = n ? `${n.toLocaleString('en-US')} detail${n === 1 ? '' : 's'} found` : null;
  const base = { busy: false, bad: false, quiet: false, partial: false, found };
  if (d.textStatus === 'pending' || d.textStatus === 'extracting') return { ...base, words: 'Reading the pages…', busy: true };
  if (d.textStatus === 'ocr_needed') return { ...base, words: 'Scanned pages: needs a closer read' };
  if (d.textStatus === 'ocr_running') return { ...base, words: 'Reading the scanned pages…', busy: true };
  if (d.textStatus === 'failed') return { ...base, words: 'Could not be read', bad: true };
  const cov = coverageOf(d);
  const covWords = coverageStatusWords(d.extractionStatus, cov);
  if (d.extractionStatus === 'queued' || d.extractionStatus === 'running') {
    return { ...base, words: covWords ? `${covWords}…` : found ? `${found}; pulling out more…` : 'Pulling out the details…', busy: true };
  }
  // Partial and failed come before "N details found": details from part of a document never read as a finished one.
  if (d.extractionStatus === 'partial') return { ...base, words: covWords ?? (found ? `Partly read: ${found}` : 'Partly read'), partial: true };
  if (d.extractionStatus === 'failed') return { ...base, words: covWords ?? (found ? `Stopped part way: ${found}` : 'Details could not be pulled out'), bad: true, partial: Boolean(found || covWords) };
  if (covWords) return { ...base, words: covWords, partial: true };
  if (found) return { ...base, words: found, quiet: true };
  if (d.extractionStatus === 'done') return { ...base, words: 'No details found', quiet: true };
  return { ...base, words: 'Details not pulled out yet', quiet: true };
}
