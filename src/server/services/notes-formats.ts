/**
 * Reading the user's personal notes out of the files he drops on My notes (2026-10-09): plain text and Markdown, web pages
 * (Apple Notes and other exports as HTML), Word (.docx), PDF, Rich Text (.rtf), spreadsheets of entries (.csv / .tsv),
 * Google Keep from Google Takeout (.json, and its .html twin), Evernote (.enex), pictures of notes, and zip files of any
 * of these. No AI and no writes: every file becomes zero or more NOTE DRAFTS (one per note) or a skip with its reason.
 *
 * - A file that is one note is stored as it is (its bytes, so the existing byte check finds it again). A file that holds
 *   many notes (an .enex, a spreadsheet of entries, a zip) is split; each note is stored as its own text (its title, a
 *   blank line, its words), built the same way every time so importing it again is found as the same bytes.
 * - A web page is stored as its text (never as markup: the app never serves stored HTML back).
 * - The date of a note is its own: a date written as a heading in its first lines, else the date the export recorded
 *   (Keep's created time, Evernote's <created>, a document's created property, a spreadsheet's date column), else a
 *   date in the file name, else the file's own time ("date from the file"). Never the file's time while anything better
 *   exists. PDFs and pictures have their first lines read after their text is stored (services/notes-import.ts).
 * - Google Takeout gives each Keep note twice (.json and .html): the .json is used, the .html skipped as its twin. Notes
 *   Keep had in its trash are skipped. Attachments inside a note (pictures in Evernote, Keep) are left out and counted.
 * - Zip files are read in memory with limits (entries, sizes, nesting); one protected by a password is skipped.
 */
import path from 'node:path';
import zlib from 'node:zlib';
import mammoth from 'mammoth';
import * as PapaNs from 'papaparse';
import { parsePartialDate, todayIso, type DatePrecision } from '../../shared/dates';
import { noteDateText, type NoteDateFrom } from '../../shared/notes';
import { dateFromFilename } from '../ingest/detect';
import { sha256 } from '../util/ids';

const Papa = ((PapaNs as unknown as { default?: typeof PapaNs }).default ?? PapaNs) as typeof PapaNs;

/** A file as it arrives: dropped or chosen in the browser, read from a folder on this computer, or found in a zip. */
export interface NoteSourceFile {
  /** The file name, or the path inside a zip / folder (forward slashes). */
  name: string;
  buffer: Buffer;
  /** The file's own time (milliseconds), when known: the browser's lastModified, a folder file's mtime, a zip entry's time. */
  lastModified?: number | null;
  mime?: string | null;
}

export interface NoteDraft {
  title: string;
  /** What is stored as the document. */
  file: { name: string; mime: string | null; buffer: Buffer };
  format: NoteFormat;
  /** The file (or the path inside a zip) as named. */
  from: string;
  container: string | null;
  index: number | null;
  /** sha256 of the file the note came out of. */
  sourceSha256: string;
  date: { iso: string | null; precision: DatePrecision; text: string | null; from: NoteDateFrom };
  /** The note's words when they were read here (for its first lines); null for a PDF or a picture (read after storing). */
  text: string | null;
  attachmentsLeftOut: number;
}

export interface NoteSkip {
  file: string;
  reason: string;
}

export type NoteFormat = 'text' | 'markdown' | 'html' | 'docx' | 'pdf' | 'rtf' | 'csv' | 'csv_row' | 'keep' | 'enex' | 'image';

/** The extensions a note may come in (the import's file picker accepts these). */
export const NOTE_EXTENSIONS = ['.txt', '.text', '.md', '.markdown', '.html', '.htm', '.docx', '.pdf', '.rtf', '.csv', '.tsv', '.json', '.enex', '.zip', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.tif', '.tiff', '.bmp'] as const;

export const ZIP_MAX_ENTRIES = 20_000;
export const ZIP_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
export const ZIP_MAX_ENTRY_BYTES = 256 * 1024 * 1024;
/** A zip inside a zip is read; one more level is not. */
export const ZIP_MAX_DEPTH = 2;
/** The most notes one import makes (a larger set is imported in further runs: what is already in is skipped). */
export const NOTES_MAX_PER_IMPORT = 5000;

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.tif', '.tiff', '.bmp']);
const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.bmp': 'image/bmp' };
/** Files an exporter or an operating system adds that are no one's notes. */
const SYSTEM_FILE = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$|\._)/i;

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', middot: '·', deg: '°', micro: 'µ', plusmn: '±', times: '×' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function tidy(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A web page's (or Evernote's, or Keep's) markup as plain text: blocks on their own lines, list items marked, tags gone. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(td|th)\b[^>]*>/gi, ' | ')
    .replace(/<\/li\s*>/gi, '')
    .replace(/<\/(p|div|h[1-6]|tr|blockquote|pre|ul|ol|table|section|article|en-todo|header|footer)\s*>/gi, '\n')
    .replace(/<(p|div|h[1-6]|tr|blockquote|pre|ul|ol|table|section|article)\b[^>]*>/gi, '\n')
    .replace(/<en-todo\b[^>]*checked="true"[^>]*\/?>/gi, '[x] ')
    .replace(/<en-todo\b[^>]*\/?>/gi, '[ ] ')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return tidy(s.replace(/\n \| /g, '\n').replace(/ \| \n/g, '\n'));
}

function htmlTitle(html: string): string | null {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const t = m ? tidy(decodeEntities(m[1].replace(/<[^>]+>/g, ''))) : '';
  return t || null;
}

/** A date an HTML export records: <meta name="created" ...>, an article's published time, a <time datetime>. */
function htmlMetaDate(html: string): string | null {
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  for (const meta of metas) {
    const name = /(?:name|property)\s*=\s*["']([^"']+)["']/i.exec(meta)?.[1]?.toLowerCase() ?? '';
    const content = /content\s*=\s*["']([^"']+)["']/i.exec(meta)?.[1] ?? '';
    if (content && /^(created|date|dc\.date|dcterms\.created|article:published_time|creation[-_]?date)$/.test(name)) return content;
  }
  const t = /<time\b[^>]*datetime\s*=\s*["']([^"']+)["']/i.exec(html);
  return t?.[1] ?? null;
}

/** Plain text of Rich Text (.rtf): paragraphs and tabs kept, fonts, colours, pictures and hidden groups dropped. */
export function rtfToText(rtf: string): { text: string; created: string | null } {
  let out = '';
  let created: string | null = null;
  const info = /\\creatim\s*\\yr(\d{4})\s*\\mo(\d{1,2})\s*\\dy(\d{1,2})/.exec(rtf);
  if (info) created = `${info[1]}-${info[2].padStart(2, '0')}-${info[3].padStart(2, '0')}`;
  const SKIP = /^(fonttbl|colortbl|stylesheet|info|pict|object|header|footer|headerl|headerr|footerl|footerr|themedata|colorschememapping|latentstyles|datastore|xmlnstbl|listtable|listoverridetable|rsidtbl|generator|mmathPr|pgdsctbl)$/;
  const stack: Array<{ skip: boolean; uc: number }> = [];
  let skip = false;
  let uc = 1;
  let pendingSkipChars = 0;
  let i = 0;
  const n = rtf.length;
  while (i < n) {
    const c = rtf[i];
    if (c === '{') {
      stack.push({ skip, uc });
      i++;
      // A destination group: {\*\name ...} is ignorable; a known non-text destination is skipped too.
      if (rtf.startsWith('\\*', i)) skip = true;
      else {
        const w = /^\\([a-zA-Z]+)/.exec(rtf.slice(i, i + 40));
        if (w && SKIP.test(w[1])) skip = true;
      }
      continue;
    }
    if (c === '}') {
      const top = stack.pop();
      skip = top?.skip ?? false;
      uc = top?.uc ?? 1;
      i++;
      continue;
    }
    if (c === '\\') {
      const next = rtf[i + 1];
      if (next === '\\' || next === '{' || next === '}') {
        if (!skip) out += next;
        i += 2;
        continue;
      }
      if (next === "'") {
        const hex = rtf.slice(i + 2, i + 4);
        const code = parseInt(hex, 16);
        if (pendingSkipChars > 0) pendingSkipChars--;
        else if (!skip && Number.isFinite(code)) out += Buffer.from([code]).toString('latin1');
        i += 4;
        continue;
      }
      if (next === '~') {
        if (!skip) out += ' ';
        i += 2;
        continue;
      }
      if (next === '\n' || next === '\r') {
        if (!skip) out += '\n';
        i += 2;
        continue;
      }
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i, i + 60));
      if (!m) {
        i += 2;
        continue;
      }
      i += m[0].length;
      const word = m[1];
      const arg = m[2] !== undefined ? Number(m[2]) : null;
      if (skip) continue;
      if (word === 'par' || word === 'line' || word === 'sect' || word === 'page') out += '\n';
      else if (word === 'tab' || word === 'cell') out += '\t';
      else if (word === 'row') out += '\n';
      else if (word === 'uc' && arg !== null) uc = arg;
      else if (word === 'u' && arg !== null) {
        out += String.fromCodePoint(arg < 0 ? arg + 65536 : arg);
        pendingSkipChars = uc;
      } else if (word === 'emdash') out += '—';
      else if (word === 'endash') out += '–';
      else if (word === 'bullet') out += '•';
      else if (word === 'lquote' || word === 'rquote') out += "'";
      else if (word === 'ldblquote' || word === 'rdblquote') out += '"';
      continue;
    }
    if (c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (pendingSkipChars > 0) {
      pendingSkipChars--;
      i++;
      continue;
    }
    if (!skip) out += c;
    i++;
  }
  return { text: tidy(out), created };
}

/** An instant (ms since 1970, or an ISO instant) as the day it was on this computer. */
function localDay(ms: number): string {
  return todayIso(new Date(ms));
}

/** "20240302T101503Z" (Evernote), an ISO instant or a plain date, as a day. */
function exportDay(raw: string | null | undefined): string | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  const ev = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(t);
  if (ev) {
    const ms = Date.UTC(+ev[1], +ev[2] - 1, +ev[3], +ev[4], +ev[5], +ev[6]);
    return localDay(ms);
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t)) {
    const ms = Date.parse(t);
    if (Number.isFinite(ms)) return localDay(ms);
  }
  const pd = parsePartialDate(t.replace(/,?\s+\d{1,2}:\d{2}(:\d{2})?\s*([ap]\.?m\.?)?.*$/i, ''));
  return pd.iso;
}

type DateInfo = NoteDraft['date'];

/** The note's date: its own heading, else what the export recorded, else the file name, else the file's time. */
export function resolveNoteDate(input: { text: string | null; exportDate?: string | null; filename: string; lastModified?: number | null }): DateInfo {
  if (input.text) {
    const t = noteDateText(input.text);
    if (t) {
      const pd = parsePartialDate(t);
      if (pd.iso) return { iso: pd.iso, precision: pd.precision, text: t, from: 'content' };
    }
  }
  if (input.exportDate) {
    const day = exportDay(input.exportDate);
    if (day) {
      const pd = parsePartialDate(day);
      if (pd.iso) return { iso: pd.iso, precision: pd.precision, text: day, from: 'export' };
    }
  }
  const fromName = dateFromFilename(input.filename);
  if (fromName?.iso) return { iso: fromName.iso, precision: fromName.precision, text: fromName.text, from: 'filename' };
  if (input.lastModified && Number.isFinite(input.lastModified) && input.lastModified > 0) {
    const day = localDay(input.lastModified);
    return { iso: day, precision: 'day', text: day, from: 'file' };
  }
  return { iso: null, precision: 'unknown', text: null, from: 'none' };
}

/** A short title from a note's words: its first line, without Markdown marks, cut at 80 characters. */
function titleFromText(text: string): string | null {
  const line = text
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').replace(/^[-*]\s+/, '').trim())
    .find(Boolean);
  if (!line) return null;
  return line.length > 80 ? `${line.slice(0, 77).trimEnd()}…` : line;
}

function stem(name: string): string {
  const base = name.split('/').pop() ?? name;
  const ext = path.extname(base);
  return (ext ? base.slice(0, -ext.length) : base).trim() || base;
}

/** A file name safe to store: the title, cut, with the extension. */
function storedName(title: string, ext: string): string {
  const clean = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'note';
  return `${clean}${ext}`;
}

/** The text stored for a note split out of a larger file: its title, a blank line, its words. Always the same bytes for the same note. */
export function noteText(title: string | null, body: string): string {
  const b = body.trim();
  const t = (title ?? '').trim();
  const first = b.split('\n')[0].trim();
  return t && first !== t ? `${t}\n\n${b}\n` : `${b}\n`;
}

function decodeUtf8(buffer: Buffer): string {
  let s: string;
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) s = buffer.subarray(2).toString('utf16le');
  else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) s = Buffer.from(buffer.subarray(2)).swap16().toString('utf16le');
  else s = buffer.toString('utf8');
  return s.replace(/^﻿/, '');
}

// ---------------------------------------------------------------------------
// Zip files (read in memory; never written to disk)
// ---------------------------------------------------------------------------

export interface ZipEntry {
  name: string;
  data: Buffer;
  /** The entry's time (ms), from its DOS date and time read as this computer's local time. */
  mtime: number | null;
}

export class ZipError extends Error {}

function dosTime(time: number, date: number): number | null {
  const y = ((date >> 9) & 0x7f) + 1980;
  const mo = (date >> 5) & 0x0f;
  const d = date & 0x1f;
  if (!mo || !d) return null;
  return new Date(y, mo - 1, d, (time >> 11) & 0x1f, (time >> 5) & 0x3f, (time & 0x1f) * 2).getTime();
}

/** The entries of a zip file (folders left out), with limits on their number and size. Throws ZipError in words. */
export function readZip(buffer: Buffer, limits = { maxEntries: ZIP_MAX_ENTRIES, maxTotal: ZIP_MAX_TOTAL_BYTES, maxEntry: ZIP_MAX_ENTRY_BYTES }): { entries: ZipEntry[]; skipped: NoteSkip[] } {
  const minEocd = 22;
  if (buffer.length < minEocd) throw new ZipError('not a zip file');
  let eocd = -1;
  for (let i = buffer.length - minEocd; i >= Math.max(0, buffer.length - minEocd - 65535); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('not a zip file (or a damaged one)');
  let count = buffer.readUInt16LE(eocd + 10);
  let cdSize = buffer.readUInt32LE(eocd + 12);
  let cdOffset = buffer.readUInt32LE(eocd + 16);
  // Zip64: the end record points at a larger one.
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && buffer.readUInt32LE(loc) === 0x07064b50) {
      const z64 = Number(buffer.readBigUInt64LE(loc + 8));
      if (z64 >= 0 && z64 + 56 <= buffer.length && buffer.readUInt32LE(z64) === 0x06064b50) {
        count = Number(buffer.readBigUInt64LE(z64 + 32));
        cdSize = Number(buffer.readBigUInt64LE(z64 + 40));
        cdOffset = Number(buffer.readBigUInt64LE(z64 + 48));
      }
    }
  }
  if (count > limits.maxEntries) throw new ZipError(`it holds ${count} files; at most ${limits.maxEntries} are read from one zip`);
  if (cdOffset + cdSize > buffer.length) throw new ZipError('the zip file is cut short');
  const entries: ZipEntry[] = [];
  const skipped: NoteSkip[] = [];
  let total = 0;
  let p = cdOffset;
  for (let k = 0; k < count; k++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50) throw new ZipError('the zip file is damaged');
    const flags = buffer.readUInt16LE(p + 8);
    const method = buffer.readUInt16LE(p + 10);
    const time = buffer.readUInt16LE(p + 12);
    const date = buffer.readUInt16LE(p + 14);
    let compSize = buffer.readUInt32LE(p + 20);
    let size = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    let local = buffer.readUInt32LE(p + 42);
    const rawName = buffer.subarray(p + 46, p + 46 + nameLen);
    const name = (flags & 0x800 ? rawName.toString('utf8') : rawName.toString('latin1')).replace(/\\/g, '/');
    // Zip64 sizes and offset in the extra field.
    if (size === 0xffffffff || compSize === 0xffffffff || local === 0xffffffff) {
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = buffer.readUInt16LE(e);
        const len = buffer.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (size === 0xffffffff) {
            size = Number(buffer.readBigUInt64LE(q));
            q += 8;
          }
          if (compSize === 0xffffffff) {
            compSize = Number(buffer.readBigUInt64LE(q));
            q += 8;
          }
          if (local === 0xffffffff) local = Number(buffer.readBigUInt64LE(q));
          break;
        }
        e += 4 + len;
      }
    }
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 0x1) {
      skipped.push({ file: name, reason: 'protected by a password' });
      continue;
    }
    if (method !== 0 && method !== 8) {
      skipped.push({ file: name, reason: 'packed in a way this cannot read' });
      continue;
    }
    if (size > limits.maxEntry) {
      skipped.push({ file: name, reason: `larger than ${Math.round(limits.maxEntry / 1048576)} MB` });
      continue;
    }
    total += size;
    if (total > limits.maxTotal) throw new ZipError(`it unpacks to more than ${Math.round(limits.maxTotal / 1048576)} MB`);
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) {
      skipped.push({ file: name, reason: 'damaged inside the zip' });
      continue;
    }
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + compSize);
    let data: Buffer;
    try {
      data = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, size || limits.maxEntry) });
    } catch {
      skipped.push({ file: name, reason: 'damaged inside the zip' });
      continue;
    }
    entries.push({ name, data, mtime: dosTime(time, date) });
  }
  return { entries, skipped };
}

function isZip(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
}

function zipHas(buffer: Buffer, entryName: string): boolean {
  try {
    return readZip(buffer).entries.some((e) => e.name === entryName);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// One format at a time
// ---------------------------------------------------------------------------

interface Ctx {
  container: string | null;
  out: NoteDraft[];
  skipped: NoteSkip[];
}

function push(ctx: Ctx, d: Omit<NoteDraft, 'container'> & { container?: string | null }): void {
  ctx.out.push({ ...d, container: d.container ?? ctx.container });
}

/** A Google Keep note from Takeout (.json): its title, text or checklist, created time, labels; trashed notes skipped. */
export function readKeepJson(raw: string): { title: string | null; text: string; created: string | null; trashed: boolean; attachments: number } | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const k = o as Record<string, unknown>;
  const looksKeep = ('textContent' in k || 'listContent' in k) && ('createdTimestampUsec' in k || 'userEditedTimestampUsec' in k || 'isTrashed' in k);
  if (!looksKeep) return null;
  const title = typeof k.title === 'string' && k.title.trim() ? k.title.trim() : null;
  let text = typeof k.textContent === 'string' ? k.textContent : '';
  if (Array.isArray(k.listContent)) {
    const items = (k.listContent as Array<Record<string, unknown>>).map((it) => `${it.isChecked ? '[x]' : '[ ]'} ${String(it.text ?? '').trim()}`);
    text = [text, ...items].filter((s) => s.trim()).join('\n');
  }
  const usec = Number(k.createdTimestampUsec ?? k.userEditedTimestampUsec);
  const created = Number.isFinite(usec) && usec > 0 ? new Date(Math.floor(usec / 1000)).toISOString() : null;
  const labels = Array.isArray(k.labels) ? (k.labels as Array<Record<string, unknown>>).map((l) => String(l.name ?? '').trim()).filter(Boolean) : [];
  if (labels.length) text = `${text.trim()}\n\nLabels: ${labels.join(', ')}`;
  return { title, text: tidy(text), created, trashed: k.isTrashed === true, attachments: Array.isArray(k.attachments) ? k.attachments.length : 0 };
}

/** A Google Keep note exported as HTML (Takeout's twin of the .json, or on its own). */
export function readKeepHtml(html: string): { title: string | null; text: string; created: string | null; trashed: boolean } | null {
  if (!/class\s*=\s*["']note\b/i.test(html) || !/class\s*=\s*["']heading["']/i.test(html)) return null;
  const heading = /<div class=["']heading["'][^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1];
  const title = /<div class=["']title["'][^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1];
  const content = /<div class=["']content["'][^>]*>([\s\S]*?)<\/div>\s*(?:<div class=["'](?:labels|attachments|annotations|chips)["']|<\/div>\s*<\/body>|<\/body>|$)/i.exec(html)?.[1] ?? '';
  const trashed = /class=["']trashed["']/i.test(html);
  const t = title ? tidy(decodeEntities(title.replace(/<[^>]+>/g, ''))) : null;
  return { title: t || null, text: htmlToText(content || html), created: heading ? tidy(decodeEntities(heading.replace(/<[^>]+>/g, ''))) : null, trashed };
}

/** The notes of an Evernote export (.enex): title, created time, words (ENML as text), attachments counted. */
export function readEnex(xml: string): Array<{ title: string | null; text: string; created: string | null; attachments: number }> {
  const out: Array<{ title: string | null; text: string; created: string | null; attachments: number }> = [];
  for (const m of xml.matchAll(/<note>([\s\S]*?)<\/note>/g)) {
    const body = m[1];
    const title = /<title>([\s\S]*?)<\/title>/.exec(body)?.[1];
    let content = /<content>([\s\S]*?)<\/content>/.exec(body)?.[1] ?? '';
    const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(content);
    content = cdata ? cdata[1] : decodeEntities(content);
    const created = /<created>([^<]+)<\/created>/.exec(body)?.[1] ?? null;
    out.push({ title: title ? tidy(decodeEntities(title)) || null : null, text: htmlToText(content.replace(/<\?xml[\s\S]*?\?>/, '').replace(/<!DOCTYPE[\s\S]*?>/i, '')), created, attachments: (body.match(/<resource>/g) ?? []).length });
  }
  return out;
}

/** Spreadsheet columns that hold the entry's words, its date and its title. */
const TEXT_COL = /^(note|notes|text|body|content|entry|journal|journal entry|description|memo|comment|comments|details|what happened)$/i;
const DATE_COL = /^(date|day|created|created at|created on|timestamp|time|when|entry date|full_date|date created)$/i;
const TITLE_COL = /^(title|subject|heading|name|topic)$/i;

/** One note per row of a spreadsheet of entries (a journal app's export), or null when it has no column of words. */
export function readCsvEntries(raw: string, tab: boolean): Array<{ title: string | null; text: string; date: string | null; row: number }> | null {
  const parsed = Papa.parse<string[]>(raw.replace(/^﻿/, ''), { delimiter: tab ? '\t' : '', skipEmptyLines: 'greedy' });
  const rows = (parsed.data as unknown[]).filter((r): r is string[] => Array.isArray(r));
  if (rows.length < 2) return null;
  const header = rows[0].map((h) => String(h ?? '').trim());
  const textCol = header.findIndex((h) => TEXT_COL.test(h));
  if (textCol < 0) return null;
  const dateCol = header.findIndex((h) => DATE_COL.test(h));
  const titleCol = header.findIndex((h) => TITLE_COL.test(h));
  const out: Array<{ title: string | null; text: string; date: string | null; row: number }> = [];
  rows.slice(1).forEach((r, i) => {
    const text = String(r[textCol] ?? '').trim();
    if (!text) return;
    out.push({ title: titleCol >= 0 ? String(r[titleCol] ?? '').trim() || null : null, text, date: dateCol >= 0 ? String(r[dateCol] ?? '').trim() || null : null, row: i + 2 });
  });
  return out;
}

/** A PDF's own creation date (its Info dictionary), as a day, or null. */
export function pdfCreationDate(buffer: Buffer): string | null {
  const scan = (b: Buffer) => /\/CreationDate\s*\(D:(\d{4})(\d{2})?(\d{2})?/.exec(b.toString('latin1'));
  const m = scan(buffer.subarray(Math.max(0, buffer.length - 262144))) ?? scan(buffer.subarray(0, 262144));
  if (!m) return null;
  const y = m[1];
  if (!m[2]) return y;
  if (!m[3]) return `${y}-${m[2]}`;
  return `${y}-${m[2]}-${m[3]}`;
}

/** A Word document's created date (docProps/core.xml), or null. */
export function docxCreated(buffer: Buffer): string | null {
  try {
    const core = readZip(buffer).entries.find((e) => e.name === 'docProps/core.xml');
    if (!core) return null;
    return /<dcterms:created[^>]*>([^<]+)<\/dcterms:created>/.exec(core.data.toString('utf8'))?.[1] ?? null;
  } catch {
    return null;
  }
}

async function docxText(buffer: Buffer): Promise<string> {
  try {
    const r = await mammoth.extractRawText({ buffer });
    return tidy(r.value ?? '');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

function textDraft(ctx: Ctx, f: NoteSourceFile, sha: string, format: NoteFormat, title: string | null, body: string, exportDate: string | null, index: number | null, from: string, attachments = 0): void {
  const text = noteText(title, body);
  const name = storedName(title ?? stem(from), '.txt');
  push(ctx, {
    title: title ?? titleFromText(body) ?? stem(from),
    file: { name, mime: 'text/plain', buffer: Buffer.from(text, 'utf8') },
    format,
    from,
    index,
    sourceSha256: sha,
    date: resolveNoteDate({ text: body, exportDate, filename: index === null ? from : '', lastModified: f.lastModified }),
    text,
    attachmentsLeftOut: attachments,
  });
}

async function readOne(ctx: Ctx, f: NoteSourceFile, depth: number, siblings: ReadonlySet<string>): Promise<void> {
  const name = f.name.replace(/\\/g, '/');
  if (SYSTEM_FILE.test(name)) return;
  if (!f.buffer.length) {
    ctx.skipped.push({ file: name, reason: 'empty file' });
    return;
  }
  const ext = path.extname(name).toLowerCase();
  const sha = sha256(f.buffer);
  const asIs = (format: NoteFormat, mime: string | null, text: string | null, exportDate: string | null, title?: string | null) =>
    push(ctx, {
      title: title || stem(name),
      file: { name: name.split('/').pop() || name, mime, buffer: f.buffer },
      format,
      from: name,
      index: null,
      sourceSha256: sha,
      date: resolveNoteDate({ text, exportDate, filename: name, lastModified: f.lastModified }),
      text,
      attachmentsLeftOut: 0,
    });

  if (ext === '.zip' || (!ext && isZip(f.buffer) && !zipHas(f.buffer, 'word/document.xml'))) {
    if (depth >= ZIP_MAX_DEPTH) {
      ctx.skipped.push({ file: name, reason: 'a zip inside a zip inside a zip; unpack it first' });
      return;
    }
    let z: ReturnType<typeof readZip>;
    try {
      z = readZip(f.buffer);
    } catch (err) {
      ctx.skipped.push({ file: name, reason: err instanceof ZipError ? err.message : 'not a zip file (or a damaged one)' });
      return;
    }
    for (const s of z.skipped) ctx.skipped.push({ file: `${name}/${s.file}`, reason: s.reason });
    const inner: Ctx = { container: name, out: ctx.out, skipped: ctx.skipped };
    const names = new Set(z.entries.map((e) => e.name));
    for (const e of z.entries) await readOne(inner, { name: e.name, buffer: e.data, lastModified: e.mtime }, depth + 1, names);
    return;
  }
  if (ext === '.json') {
    const keep = readKeepJson(decodeUtf8(f.buffer));
    if (!keep) {
      ctx.skipped.push({ file: name, reason: 'not a Google Keep note' });
      return;
    }
    if (keep.trashed) {
      ctx.skipped.push({ file: name, reason: "in Keep's trash" });
      return;
    }
    if (!keep.text.trim() && !keep.title) {
      ctx.skipped.push({ file: name, reason: 'an empty note' });
      return;
    }
    textDraft(ctx, f, sha, 'keep', keep.title, keep.text, keep.created, null, name, keep.attachments);
    return;
  }
  if (ext === '.html' || ext === '.htm') {
    const html = decodeUtf8(f.buffer);
    const keep = readKeepHtml(html);
    if (keep) {
      const twin = `${name.slice(0, -ext.length)}.json`;
      if (siblings.has(twin)) {
        ctx.skipped.push({ file: name, reason: `the same Keep note as ${twin.split('/').pop()}` });
        return;
      }
      if (keep.trashed) {
        ctx.skipped.push({ file: name, reason: "in Keep's trash" });
        return;
      }
      textDraft(ctx, f, sha, 'keep', keep.title, keep.text, keep.created, null, name);
      return;
    }
    const text = htmlToText(html);
    if (!text.trim()) {
      ctx.skipped.push({ file: name, reason: 'no words in it' });
      return;
    }
    const title = htmlTitle(html);
    textDraft(ctx, f, sha, 'html', title && title.toLowerCase() !== 'untitled' ? title : null, text, htmlMetaDate(html), null, name);
    return;
  }
  if (ext === '.enex') {
    const notes = readEnex(decodeUtf8(f.buffer));
    if (!notes.length) {
      ctx.skipped.push({ file: name, reason: 'no notes in it' });
      return;
    }
    const inner: Ctx = { container: name, out: ctx.out, skipped: ctx.skipped };
    notes.forEach((n, i) => {
      if (!n.text.trim() && !n.title) {
        ctx.skipped.push({ file: `${name} (note ${i + 1})`, reason: 'an empty note' });
        return;
      }
      textDraft(inner, f, sha, 'enex', n.title, n.text, n.created, i + 1, `${name} (note ${i + 1})`, n.attachments);
    });
    return;
  }
  if (ext === '.csv' || ext === '.tsv') {
    const raw = decodeUtf8(f.buffer);
    const rows = readCsvEntries(raw, ext === '.tsv');
    if (rows && rows.length) {
      const inner: Ctx = { container: name, out: ctx.out, skipped: ctx.skipped };
      for (const r of rows) textDraft(inner, f, sha, 'csv_row', r.title, r.text, r.date, r.row, `${name} (row ${r.row})`);
      return;
    }
    asIs('csv', ext === '.tsv' ? 'text/tab-separated-values' : 'text/csv', null, null);
    return;
  }
  if (ext === '.txt' || ext === '.text') {
    const text = tidy(decodeUtf8(f.buffer));
    if (!text) {
      ctx.skipped.push({ file: name, reason: 'no words in it' });
      return;
    }
    asIs('text', 'text/plain', text, null);
    return;
  }
  if (ext === '.md' || ext === '.markdown') {
    const text = tidy(decodeUtf8(f.buffer));
    if (!text) {
      ctx.skipped.push({ file: name, reason: 'no words in it' });
      return;
    }
    asIs('markdown', 'text/markdown', text, null);
    return;
  }
  if (ext === '.rtf') {
    const r = rtfToText(f.buffer.toString('latin1'));
    if (!r.text) {
      ctx.skipped.push({ file: name, reason: 'no words in it' });
      return;
    }
    textDraft(ctx, f, sha, 'rtf', null, r.text, r.created, null, name);
    return;
  }
  if (ext === '.docx') {
    const text = await docxText(f.buffer);
    asIs('docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', text || null, docxCreated(f.buffer));
    return;
  }
  if (ext === '.pdf' || (f.buffer.length >= 5 && f.buffer.subarray(0, 5).toString('latin1') === '%PDF-')) {
    asIs('pdf', 'application/pdf', null, pdfCreationDate(f.buffer));
    return;
  }
  if (IMAGE_EXT.has(ext)) {
    asIs('image', IMAGE_MIME[ext] ?? null, null, null);
    return;
  }
  ctx.skipped.push({ file: name, reason: ext ? `not a kind of note this reads (${ext})` : 'not a kind of note this reads (no extension)' });
}

/**
 * Every note in the files given, in order, with the files that held none (and why). Never throws for one bad file:
 * it is skipped with its reason.
 */
export async function readNoteFiles(files: readonly NoteSourceFile[]): Promise<{ drafts: NoteDraft[]; skipped: NoteSkip[] }> {
  const ctx: Ctx = { container: null, out: [], skipped: [] };
  const names = new Set(files.map((f) => f.name.replace(/\\/g, '/')));
  for (const f of files) {
    try {
      await readOne(ctx, f, 0, names);
    } catch (err) {
      ctx.skipped.push({ file: f.name, reason: `could not be read: ${err instanceof Error ? err.message.slice(0, 200) : 'error'}` });
    }
  }
  return { drafts: ctx.out, skipped: ctx.skipped };
}
