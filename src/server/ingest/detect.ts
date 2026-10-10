/**
 * Document kind detection and filename heuristics. Extension first, then the
 * mime type the browser sent, then magic bytes. Pure functions, no I/O.
 */
import path from 'node:path';
import type { DocumentKind } from '../../shared/enums';
import { parsePartialDate, type PartialDate } from '../../shared/dates';

const EXT_KINDS: Record<string, { kind: DocumentKind; mime: string }> = {
  '.pdf': { kind: 'pdf', mime: 'application/pdf' },
  '.png': { kind: 'image', mime: 'image/png' },
  '.jpg': { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.tif': { kind: 'image', mime: 'image/tiff' },
  '.tiff': { kind: 'image', mime: 'image/tiff' },
  '.webp': { kind: 'image', mime: 'image/webp' },
  '.bmp': { kind: 'image', mime: 'image/bmp' },
  '.gif': { kind: 'image', mime: 'image/gif' },
  '.docx': { kind: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  '.txt': { kind: 'text', mime: 'text/plain' },
  '.text': { kind: 'text', mime: 'text/plain' },
  '.md': { kind: 'text', mime: 'text/markdown' },
  '.markdown': { kind: 'text', mime: 'text/markdown' },
  '.log': { kind: 'text', mime: 'text/plain' },
  '.csv': { kind: 'csv', mime: 'text/csv' },
  '.tsv': { kind: 'csv', mime: 'text/tab-separated-values' },
  '.json': { kind: 'json', mime: 'application/json' },
  '.dcm': { kind: 'dicom', mime: 'application/dicom' },
  '.dicom': { kind: 'dicom', mime: 'application/dicom' },
  '.vtt': { kind: 'audio_transcript', mime: 'text/vtt' },
  '.srt': { kind: 'audio_transcript', mime: 'text/plain' },
};

/**
 * Raster image types that carry no active content. Any other image type the
 * browser names (image/svg+xml above all, which can carry script) is stored
 * as application/octet-stream so it is never served back as markup.
 * TIFF stays: MuPDF needs the type to render it and it cannot run script.
 */
export const SAFE_IMAGE_MIMES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/tiff']);

/** Text types kept as sent; every other text/* (html, xml, javascript, ...) is stored as text/plain. */
const SAFE_TEXT_MIMES: ReadonlySet<string> = new Set(['text/plain', 'text/markdown', 'text/csv', 'text/tab-separated-values', 'text/vtt']);

/**
 * Kind and the mime to store for a browser-supplied type. The stored mime is
 * never active content: html, xml and svg are recorded as text/plain or
 * application/octet-stream, so the original can never be served back to the
 * app's origin as a page that runs script.
 */
function fromMime(mime: string): { kind: DocumentKind; mime: string } | null {
  const m = mime.toLowerCase().split(';')[0].trim();
  if (!m || m === 'application/octet-stream') return null;
  if (m === 'application/pdf') return { kind: 'pdf', mime: m };
  if (m.startsWith('image/')) return { kind: 'image', mime: SAFE_IMAGE_MIMES.has(m) ? m : 'application/octet-stream' };
  if (m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return { kind: 'docx', mime: m };
  if (m === 'text/csv' || m === 'text/tab-separated-values') return { kind: 'csv', mime: m };
  if (m === 'application/json' || m === 'text/json') return { kind: 'json', mime: 'application/json' };
  if (m === 'application/dicom') return { kind: 'dicom', mime: m };
  if (m === 'text/vtt') return { kind: 'audio_transcript', mime: m };
  if (m.startsWith('text/')) return { kind: 'text', mime: SAFE_TEXT_MIMES.has(m) ? m : 'text/plain' };
  return null;
}

/** Sniff the first bytes of a file. */
export function kindFromMagic(head: Buffer): { kind: DocumentKind; mime: string } | null {
  if (head.length >= 5 && head.subarray(0, 5).toString('latin1') === '%PDF-') return { kind: 'pdf', mime: 'application/pdf' };
  if (head.length >= 132 && head.subarray(128, 132).toString('latin1') === 'DICM') return { kind: 'dicom', mime: 'application/dicom' };
  if (head.length >= 8 && head[0] === 0x89 && head.subarray(1, 4).toString('latin1') === 'PNG') return { kind: 'image', mime: 'image/png' };
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: 'image', mime: 'image/jpeg' };
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString('latin1'))) return { kind: 'image', mime: 'image/gif' };
  if (head.length >= 4) {
    const s = head.subarray(0, 4).toString('latin1');
    if (s === 'II*\0' || s === 'MM\0*') return { kind: 'image', mime: 'image/tiff' };
  }
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return { kind: 'image', mime: 'image/webp' };
  if (head.length >= 2 && head[0] === 0x42 && head[1] === 0x4d) return { kind: 'image', mime: 'image/bmp' };
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    return { kind: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }
  return null;
}

/** Heuristic: no NUL bytes and mostly printable in the first chunk. */
export function looksLikeText(head: Buffer): boolean {
  if (!head.length) return false;
  let control = 0;
  for (let i = 0; i < head.length; i++) {
    const b = head[i];
    if (b === 0) return false;
    if (b < 0x09 || (b > 0x0d && b < 0x20)) control++;
  }
  return control / head.length < 0.02;
}

export function detectKind(filename: string, mime: string | null | undefined, head: Buffer): { kind: DocumentKind; mime: string } {
  const ext = path.extname(filename ?? '').toLowerCase();
  const byExt = EXT_KINDS[ext];
  if (byExt) return byExt;
  const given = (mime ?? '').trim();
  const byMime = fromMime(given);
  if (byMime) return byMime;
  const byMagic = kindFromMagic(head);
  if (byMagic) return byMagic;
  if (looksLikeText(head.subarray(0, 4096))) {
    const trimmed = head.toString('utf8').trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return { kind: 'json', mime: 'application/json' };
    return { kind: 'text', mime: 'text/plain' };
  }
  // Unknown binary: never echo the browser's type (it could name active content).
  return { kind: 'other', mime: 'application/octet-stream' };
}

/** Browsers may send a path; keep a sane basename. */
export function cleanFilename(name: string): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f]/g, '').trim();
  return (cleaned || 'document').slice(0, 255);
}

export function titleFromFilename(name: string): string {
  const base = cleanFilename(name);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return (stem.trim() || base).slice(0, 300);
}

const MONTH_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';

function expandYear(y: string): number {
  const n = Number(y);
  if (y.length === 4) return n;
  return n < 50 ? 2000 + n : 1900 + n;
}

/**
 * Find a date inside a filename: 2024-03-11, 2024_03_11, 20240311, 10.4.26,
 * 3-11-2024, 21sep2026, Mar 11 2024, March-2024, or a bare year. Returns the
 * matched text as written so the user can see what was assumed.
 */
export function dateFromFilename(filename: string): PartialDate | null {
  const base = titleFromFilename(filename);
  let m: RegExpMatchArray | null;
  const tryIso = (y: number, mo: number, d: number, text: string): PartialDate | null => {
    const p = parsePartialDate(`${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    return p.iso ? { ...p, text } : null;
  };
  // 2024-03-11 / 2024_03_11 / 2024.03.11
  if ((m = base.match(/(?<!\d)(\d{4})[-_.](\d{1,2})[-_.](\d{1,2})(?!\d)/))) {
    const r = tryIso(+m[1], +m[2], +m[3], m[0]);
    if (r) return r;
  }
  // 20240311
  if ((m = base.match(/(?<!\d)((?:19|20)\d{2})(\d{2})(\d{2})(?!\d)/))) {
    const r = tryIso(+m[1], +m[2], +m[3], m[0]);
    if (r) return r;
  }
  // 10.4.26 / 3-11-2024 / 03_11_24 (US month first, as parsePartialDate does)
  if ((m = base.match(/(?<!\d)(\d{1,2})[-_.](\d{1,2})[-_.](\d{4}|\d{2})(?!\d)/))) {
    const r = tryIso(expandYear(m[3]), +m[1], +m[2], m[0]);
    if (r) return r;
    const swapped = tryIso(expandYear(m[3]), +m[2], +m[1], m[0]);
    if (swapped) return swapped;
  }
  // 21sep2026 / 21 Sep 2026 / 21-sep-26
  if ((m = base.match(new RegExp(`(?<![a-z\\d])(\\d{1,2})[ _.-]?${MONTH_RE}[ _.-]?(\\d{4}|\\d{2})(?!\\d)`, 'i')))) {
    const p = parsePartialDate(`${m[1]} ${m[2]} ${expandYear(m[3])}`);
    if (p.iso) return { ...p, text: m[0] };
  }
  // Mar 11 2024 / March_11_2024 / Mar-11-24
  if ((m = base.match(new RegExp(`(?<![a-z\\d])${MONTH_RE}[ _.-]?(\\d{1,2})(?:st|nd|rd|th)?[ _.,-]+(\\d{4}|\\d{2})(?!\\d)`, 'i')))) {
    const p = parsePartialDate(`${m[1]} ${m[2]} ${expandYear(m[3])}`);
    if (p.iso) return { ...p, text: m[0] };
  }
  // Mar 2024 / March-2024
  if ((m = base.match(new RegExp(`(?<![a-z\\d])${MONTH_RE}[ _.-]?((?:19|20)\\d{2})(?!\\d)`, 'i')))) {
    const p = parsePartialDate(`${m[1]} ${m[2]}`);
    if (p.iso) return { ...p, text: m[0] };
  }
  // 2024-03 (month)
  if ((m = base.match(/(?<!\d)((?:19|20)\d{2})[-_.](\d{1,2})(?![\d-_.])/))) {
    const p = parsePartialDate(`${m[1]}-${m[2].padStart(2, '0')}`);
    if (p.iso) return { ...p, text: m[0] };
  }
  // Bare year, but not camera-style names (IMG_2020, DSC2019).
  if (!/^(img|dsc|image|pxl|scan|screenshot)[ _-]?\d/i.test(base) && (m = base.match(/(?<!\d)((?:19[5-9]|20[0-4])\d)(?!\d)/))) {
    return { iso: m[1], precision: 'year', text: m[0] };
  }
  return null;
}

/**
 * Where a document's date came from, kept in `metadataJson.dateSource`:
 * a guess from the file name, the file's own header (DICOM StudyDate), the
 * model (classification or extraction), or the user. Only a missing date or a
 * file-name guess may be replaced by a better source; a date the user set is
 * final.
 */
export type DateSource = 'filename' | 'text' | 'dicom' | 'ai' | 'user';
const DATE_SOURCES: ReadonlySet<string> = new Set<DateSource>(['filename', 'text', 'dicom', 'ai', 'user']);

export interface DatedDocument {
  filename: string;
  metadataJson: string | null;
  documentDate: string | null;
  documentDateText: string | null;
}

function metaOf(json: string | null): Record<string, unknown> {
  try {
    const v = JSON.parse(json || '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The recorded date source, or for rows written before it was recorded: a
 * date whose text is exactly what `dateFromFilename` reads from the file name
 * counts as a file-name guess. Null when there is no date or it is unknown.
 */
export function documentDateSource(doc: DatedDocument): DateSource | null {
  const recorded = metaOf(doc.metadataJson).dateSource;
  if (typeof recorded === 'string' && DATE_SOURCES.has(recorded)) return recorded as DateSource;
  if (!doc.documentDate && !doc.documentDateText) return null;
  const guess = dateFromFilename(doc.filename);
  if (guess && guess.text === doc.documentDateText && guess.iso === doc.documentDate) return 'filename';
  return null;
}

/** True while the document has no date, or only one guessed from its file name. */
export function mayReplaceDocumentDate(doc: DatedDocument): boolean {
  if (!doc.documentDate) return documentDateSource(doc) !== 'user';
  return documentDateSource(doc) === 'filename';
}
