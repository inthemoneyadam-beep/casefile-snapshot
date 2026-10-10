/**
 * Likely copies. Exact byte copies are refused at upload (sha256); this finds
 * the near copies: the same report downloaded twice (a different print stamp,
 * page footer or link), scanned twice, or saved from two portals.
 *
 * When: once per document, right after its page text is written (the ingest
 * job, in the background), and for documents read before this existed once
 * after each unlock (signatures only for those that have none, a few at a
 * time, never throwing). Never during search, never on a count.
 *
 * How: the text of every page, lower-cased, with what says it is a print
 * stamp or page furniture taken out ("Printed on ...", "Generated ...",
 * "Page 2 of 5", links, a line holding only a time, a fax header or the
 * browser's own print header at the top of a page, copyright lines; never a
 * line holding a field label such as "Collected": see copyTokens); five-word shingles; a
 * 64-value MinHash kept in documents.metadata_json.textSignature with the
 * word count and the count and hash of the distinct numbers (values, dates).
 * No schema change. A document is compared with live documents of 0.8 to
 * 1.25 times its length whose MinHash agrees on at least 80 %; the closest
 * few are read again and compared exactly: a likely copy when at least 90 %
 * of the shingles are the same AND the numbers are nearly the same: at most
 * 6 differ, and only times and long reference numbers (7 digits or more: an
 * order, accession or fax number) may; a different date (in any form, and
 * every date as many times in both), measured value, ratio or titer, or short
 * number means another document. So do
 * version words ("corrected", "amended", "preliminary", "final", ...) that
 * appear a different number of times: an amended report is never offered as
 * a copy of the first one. And the newer one may not hold a passage of 4
 * words or more that the older lacks (a new reply printed into a thread, an
 * added page): setting it aside would hide that. Two lab reports from one
 * template with other values or dates are therefore never flagged.
 * Documents under 40 words (an image without text) and DICOM headers are
 * skipped.
 *
 * Flag: only the newer of the two (later created_at) is marked, as a likely
 * copy of the older: metadata.possibleCopyOf. Nothing is deleted, held or
 * skipped: the copy is read, sorted and filed like any document. The flag is
 * read only while the older document is live (services/documents.ts), so
 * deleting the original clears it and restoring it brings it back.
 *
 * Answers (the document page): Set this copy aside (the ordinary soft delete,
 * after showing again the original's details the user had merged into the
 * copy's and taking back what Claude filed only from it that the user has not
 * worked on; allergies, what another document also stands on, and a call or
 * appointment the original has none of its own for stay; the original is
 * filed again only when something was taken back; Restore files the copy
 * again) and Keep both (metadata.copyDecision, never flagged again for that
 * pair).
 */
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { onLockChange } from '../auth';
import { conflict, notFound } from '../util/errors';
import { normalizeKey, nowIso, parseJson } from '../util/ids';
import { deleteDocument, getDocument, onDocumentDeletedOrRestored, type DocumentDetail } from './documents';
import * as filing from './filing';
import { READ_STATUSES, autoFileAfterClassification, autoFileAfterExtraction, listFilings, rejectFiling, type Filing } from './filing';
import { supersedeFact } from './facts';
import { linkEncounter, readTriage } from './inbox';
import { passSetAsideSql } from './reconcile';
import { updateRecord } from './records';
import {
  bodyHashOf, COPY_TIME_TOLERANCE_MIN, minutesBetween, normalizeForHash, parseContainedIn, parseSegmentDetail,
  type ContainedInEntry, type ParsedMessage,
} from '../../shared/schemas/segments';

/**
 * 3: a line is a print stamp only when it says so (a print or download word, a fax header, the browser's own header
 * and footer, a copyright line), never a line holding a field label; every date must be the same in both documents,
 * each as many times; a titer (1:40) is a value. (2: dates with dashes and 5-6 digit numbers may not differ, a copy
 * holds no passage the original lacks.) Documents signed under an earlier version are signed again after unlock, and
 * an old flag that no longer holds is cleared then.
 */
export const SIGNATURE_VERSION = 3;
/** Values in a MinHash signature. */
export const MINHASH_SIZE = 64;
/** Words in a shingle. */
export const SHINGLE_WORDS = 5;
/** Documents with fewer words (after stamps are taken out) are not compared. */
export const MIN_WORDS = 40;
/** Shared shingles (exact Jaccard) for a likely copy. */
export const SIMILARITY_MIN = 0.9;
/** The MinHash estimate a candidate needs before it is read again (well below SIMILARITY_MIN: the estimate is rough). */
export const PREFILTER_MIN = 0.8;
/** Candidates are 0.8 to 1.25 times the document's length in words. */
export const WORD_RATIO_MIN = 0.8;
export const WORD_RATIO_MAX = 1.25;
/** The most distinct numbers (values, dates) that may differ between two copies. */
export const NUMBERS_DIFFER_MAX = 6;
/** A passage of this many words in the newer document that the older one lacks makes them two documents. */
export const NEW_PASSAGE_WORDS = 4;
/** Candidates read again per check, closest first. */
const EXACT_CANDIDATES_MAX = 8;
/** decided_by of the placements a set-aside copy took back. */
export const SET_ASIDE_BY = 'set aside as a copy';

export interface TextSignature {
  v: number;
  words: number;
  /** Base64 of MINHASH_SIZE little-endian uint32 values; absent when skipped. */
  minhash?: string;
  /** The distinct numbers: how many, and a hash of the sorted set. */
  numbers?: { count: number; hash: string };
  /** Why the document is not compared. */
  skip?: 'short' | 'scan images';
  at: string;
}

export interface PossibleCopyOf {
  documentId: string;
  /** The older document's title when the flag was written (the API shows the current one). */
  title: string;
  /** Shared shingles, 0..1. */
  similarity: number;
  /** Distinct numbers found in only one of the two. */
  numbersDiffer: number;
  at: string;
}

export interface CopyDecision {
  keep: true;
  by: string | null;
  at: string;
  /** The document the last Keep both was about. */
  documentId: string;
  /** Every document the user kept this one beside: never flagged again for these pairs. */
  keptWith: string[];
}

export interface CopyCheckResult {
  documentId: string;
  /** Not compared (too short, DICOM, no text). */
  skipped: string | null;
  /** The older document this one is now a likely copy of. */
  copyOf: string | null;
  /** Newer documents now marked as likely copies of this one. */
  flagged: string[];
  /** Candidates read again. */
  compared: number;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const MONTH = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?`;
const DATE = String.raw`(?:\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{1,4}|${MONTH}[\s\-]+\d{1,2}(?:st|nd|rd|th)?,?[\s\-]+\d{2,4}|\d{1,2}(?:st|nd|rd|th)?[\s\-]+${MONTH},?[\s\-]+\d{2,4})`;
const TIME = String.raw`(?:\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\s*(?:[ap]\.?m\.?)?(?:\s*(?:z|utc|gmt|[ecmp][sd]t|bst|cet|cest)\b)?)`;
/** A date and a time, in either order ("10/1/26, 9:12 AM", "2026-10-04T15:45", "Oct 4, 2026 at 3:45 PM", "14:32 05/10/2026"). */
const DATE_TIME = String.raw`(?:${DATE}(?:[\s,]+(?:at\s+)?|t)${TIME}|${TIME}[\s,]+${DATE})`;
/** The words of a print or download stamp ("Printed", "Print date", "Generated", "Downloaded", "Retrieved", "Accessed", "Run date"). */
const STAMP_WORDS = String.raw`(?:printed|print date|print time|date printed|time printed|report generated|generated|date generated|retrieved|date retrieved|downloaded|date downloaded|exported|accessed|date accessed|run date|run time)`;
/** A line that says it is a print stamp: it starts with the word (see isStampLine). */
const STAMP_LINE = new RegExp(String.raw`^[^\p{L}\p{N}]*${STAMP_WORDS}\b`, 'iu');
/** The most words, besides its date and time, on a line that says it is a stamp ("Printed on 10/01/2026 09:12 AM by portal user"). */
const STAMP_LINE_WORDS_MAX = 10;
/**
 * A stamp inside a longer line: the word, then the date or time it gives ("MyChart - Printed on 7/15/2030 2:58 PM",
 * "Pat Example | Printed 10/01/2026 09:12 | Page 1 of 3"). Only at the start of the line or after a separator (a wide
 * gap, a bar, a dash between spaces): "Port accessed on 03/12/2024" is the document's own.
 */
const STAMP_FRAGMENT = new RegExp(String.raw`\b(?<=^[^\p{L}\p{N}]*|\s\s|\t|[|•·]\s*|\s[-–—]\s)${STAMP_WORDS}\b(?:\s*(?:on|at|by|date|time|:|-))*\s*(?:${DATE_TIME}|${DATE}|${TIME})`, 'giu');
const HAS_STAMP_FRAGMENT = new RegExp(STAMP_FRAGMENT.source, 'iu');
/** A line holding only a time (no date): dropped wherever it is, since times may differ between copies. */
const TIME_ONLY = new RegExp(String.raw`^[^\p{L}\p{N}]*${TIME}[^\p{L}\p{N}]*$`, 'iu');
/** A titer or ratio on its own ("1:40"): a value, never a time. */
const TITER_ONLY = /^[^\p{L}\p{N}]*1:\d+[^\p{L}\p{N}]*$/u;
/** A line holding only a date and a time: the document's own (a message's date, a sample's collection time): its date is kept, only the time goes. */
const DATE_TIME_ONLY = new RegExp(String.raw`^[^\p{L}\p{N}]*${DATE_TIME}[^\p{L}\p{N}]*$`, 'iu');
const HAS_DATE_TIME = new RegExp(DATE_TIME, 'iu');
const HAS_DATE_OR_TIME = new RegExp(String.raw`${DATE}|${TIME}`, 'iu');
const DATES_AND_TIMES = new RegExp(String.raw`${DATE_TIME}|${DATE}|${TIME}`, 'giu');
/** The time of a date-and-time line kept for its date (the T of an ISO stamp goes with it). */
const TIMES = new RegExp(String.raw`(?:(?<=\d)t)?${TIME}`, 'giu');
/** The browser's own print header at the top of a page: m/d/yy, h:mm AM/PM ("10/1/26, 9:12 AM"), as Chrome and Edge print it. */
const BROWSER_DATE_TIME = /^[^\p{L}\p{N}]*\d{1,2}\/\d{1,2}\/\d{2},\s*\d{1,2}:\d{2}(?::\d{2})?\s*[ap]\.?m\.?(?![\p{L}\p{N}])/iu;
/** The most words of page title after the browser's date and time ("10/1/26, 9:12 AM    MyChart - Visit Notes"). */
const HEADER_WORDS_MAX = 8;
/** What follows the date and time of a browser's print header: a wide gap or a separator, as the browser sets the title apart. */
const HEADER_GAP = /^(?:\s{2,}|\t|\s*[|•·]\s*|\s+[-–—]\s+)/u;
/** A fax word, for a fax header at the top of a page ("10/05/2026 14:32 FAX 5551234567 EXAMPLE CLINIC PAGE 01/01"). */
const FAX_WORD = /\b(?:e-?)?fax(?:ed)?\b|\brightfax\b/iu;
/** The page marker a fax machine prints: zero-padded ("P.001/003", "PAGE 01/01", "001/003"). */
const FAX_PAGE = /\bp(?:age|g)?\.?\s*0\d{1,2}(?:\s*\/\s*0?\d{1,3})?\b|\b0\d{2}\s*\/\s*0\d{2}\b/iu;
/** A page counter on its own ("1/1", "2 / 3"), as a browser prints beside the link at the foot of a page. Only at a page's top or bottom. */
const PAGE_COUNTER = /^[^\p{L}\p{N}]*(\d{1,3})\s*\/\s*(\d{1,3})[^\p{L}\p{N}]*$/u;
/**
 * A copyright or licence line ("© 2025 Epic Systems", "Copyright 1999-2026", "All rights reserved", "MyChart licensed
 * from Epic Systems Corporation 1999 - 2026"). A bare "(c) 2024" is not: it is as often item (c) of a list.
 */
const COPYRIGHT = /©|\bcopyright\b|\ball rights reserved\b/iu;
const LICENSED = /\blicensed from\b/iu;
const YEAR = /\b(?:19|20)\d{2}\b/u;
const URL = /\b(?:https?:\/\/|www\.|file:\/\/)\S+/giu;
/** "Page 2 of 5", "Page 2", "pg 2", "p. 2/5": page numbers may differ between copies. */
const PAGE_FRAGMENT = /\b(?:(?:page|pg)\.?\s*\d+(?:\s*(?:of|\/)\s*\d+)?|p\.?\s*\d+\s*(?:of|\/)\s*\d+)\b/giu;
const DASH_PAGE = /^\s*[-–—]\s*\d+\s*[-–—]\s*$/u;
const TOKEN = /[\p{L}\p{N}]+(?:['’.,:\/\-][\p{L}\p{N}]+)*/gu;
const NUMBER = /\d+(?:[.,:\/\-]\d+)*/g;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
/** Longer lines are never dropped whole: a page extracted as one long line keeps its words. */
const SHORT_LINE = 160;
/** The most stamps read at the top of a page (a fax header over a browser header, say). */
const TOP_STAMPS_MAX = 3;
/**
 * Field labels. A line that uses one as a label (followed by a colon, or by the date, time or number it labels:
 * "Collected: 03/12/2024 09:15", "Accession MB24-0001234", "Infusion 3 of 5   03/12/2024") is the document's own,
 * never a stamp; so is the line after a line that is only a label ("Collected" / "03/12/2024 09:15", as table cells
 * come out of a PDF). A title that merely holds the word ("MyChart - Visit Notes") is not a label.
 */
const LABEL = String.raw`(?:date of service|dos|collected|collection|drawn|received|reported|resulted|accession(?:ed)?|acc|specimen|service|visit|admitted|admission|discharged|discharge|study|signed|infusion|session|performed|verified|dictated|transcribed|ordered|sent|appointment|encounter|procedure)`;
const LABEL_WORD = new RegExp(String.raw`\b${LABEL}\b`, 'iu');
const LABEL_USE = new RegExp(String.raw`\b${LABEL}\b(?:\s*(?:date|time|date\/time|dt|on|at|no\.?|number|#))*\s*(?::|#|\d|${MONTH}\s*\d)`, 'iu');
/** The most words of a line that is only a label ("Date of service", "Specimen collected"), and its longest length. */
const LABEL_LINE_WORDS_MAX = 4;
const LABEL_LINE_CHARS_MAX = 60;

/** The line uses a field label for a value (see LABEL). */
function holdsLabel(line: string): boolean {
  return LABEL_USE.test(line);
}

/** The line is only a label, its value on the next line ("Collected", "Date of service", "Results:"). */
function isLabelOnly(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/:\s*$/u.test(t)) return true;
  if (t.length > LABEL_LINE_CHARS_MAX || /\d/u.test(t)) return false;
  return (t.match(TOKEN) ?? []).length <= LABEL_LINE_WORDS_MAX && LABEL_WORD.test(t);
}

/** A line that says it is a print stamp: the stamp word first, a date or a time, and few other words. */
function isStampLine(line: string): boolean {
  if (!STAMP_LINE.test(line) || !HAS_DATE_OR_TIME.test(line)) return false;
  return (line.replace(DATES_AND_TIMES, ' ').match(TOKEN) ?? []).length <= STAMP_LINE_WORDS_MAX;
}

/**
 * Nothing worth comparing, wherever it is: a lone time, a line that says it is a print stamp, a "- 2 -" page number,
 * a copyright or licence line, or a line left empty once links, page numbers and stamp fragments are out. A guarded
 * line (it holds a field label, or follows a line that is only one) is never a stamp.
 */
function isFurniture(line: string, stripped: string, guarded: boolean): boolean {
  if (line.length <= SHORT_LINE) {
    if (TIME_ONLY.test(line) && !TITER_ONLY.test(line)) return true;
    if (!guarded && (isStampLine(line) || DASH_PAGE.test(line) || COPYRIGHT.test(line) || (LICENSED.test(line) && YEAR.test(line)))) return true;
  }
  return !LETTER_OR_DIGIT.test(stripped);
}

function isPageCounter(line: string): boolean {
  const m = line.length <= SHORT_LINE ? PAGE_COUNTER.exec(line) : null;
  return Boolean(m && Number(m[1]) >= 1 && Number(m[1]) <= Number(m[2]));
}

/**
 * At the top of a page only, the stamps that say what they are: a fax header (a date and a time with a fax word or a
 * fax machine's zero-padded page marker) and the browser's print header (m/d/yy, h:mm AM/PM, alone or with a short
 * page title after a wide gap). A date and a time in any other form ("03/12/2024 09:15   CSF panel") is the
 * document's own.
 */
function isTopStamp(line: string): boolean {
  if (line.length > SHORT_LINE) return false;
  if (HAS_DATE_TIME.test(line) && (FAX_WORD.test(line) || FAX_PAGE.test(line))) return true;
  const m = BROWSER_DATE_TIME.exec(line);
  if (!m) return false;
  const after = line.slice(m[0].length);
  const rest = after.replace(PAGE_FRAGMENT, ' ').match(TOKEN) ?? [];
  return !rest.length || (HEADER_GAP.test(after) && rest.length <= HEADER_WORDS_MAX);
}

interface CopyLine {
  /** Lower-cased, links taken out. */
  text: string;
  /** Holds a field label, or follows a line that is only a label: never a stamp. */
  guarded: boolean;
  /** The text without page numbers and (unless guarded) stamp fragments. */
  stripped: string;
  /** Dropped wherever it is. */
  furniture: boolean;
}

/**
 * Words of the pages in order, lower-cased, with print stamps, page furniture and links taken out.
 *
 * A line is a stamp only when it says so: a print or download word with its date ("Printed on ...", "Generated ...",
 * "Downloaded ...", "Accessed ...", "Run date ..."), a fax header at the top of a page, the browser's own header and
 * footer (its m/d/yy, h:mm AM/PM date with the page title at the top; the link and the "1/1" counter), "Page n of m",
 * or a copyright line. Never a line holding a field label or under a line that is only a label. Every other date is
 * the document's own and is kept (on a line holding only a date and a time, only the time goes), so two documents
 * whose dates differ are two documents.
 */
export function copyTokens(pages: string[]): string[] {
  let previous = '';
  const doc: CopyLine[][] = pages.map((page) =>
    page
      .normalize('NFKC')
      .toLowerCase()
      .split(/\r?\n/)
      .map((raw) => {
        const text = raw.replace(URL, ' ');
        // The guard matters only where a stamp can be: a short line, or one with a stamp fragment in it.
        const fragment = HAS_STAMP_FRAGMENT.test(text);
        const guarded = (text.length <= SHORT_LINE || fragment) && (holdsLabel(text) || isLabelOnly(previous));
        if (LETTER_OR_DIGIT.test(text)) previous = text;
        const stripped = (fragment && !guarded ? text.replace(STAMP_FRAGMENT, ' ') : text).replace(PAGE_FRAGMENT, ' ');
        return { text, guarded, stripped, furniture: isFurniture(text, stripped, guarded) };
      }),
  );
  const out: string[] = [];
  for (const lines of doc) {
    const drop = lines.map((l) => l.furniture);
    const n = lines.length;
    // The top of the page: page counters and the stamps that say what they are, until the first line with words.
    let top = 0;
    let stamps = 0;
    for (; top < n; top++) {
      if (drop[top]) continue;
      const l = lines[top];
      if (!l.guarded && isPageCounter(l.text)) drop[top] = true;
      else if (!l.guarded && stamps < TOP_STAMPS_MAX && isTopStamp(l.text)) {
        drop[top] = true;
        stamps++;
      } else break;
    }
    // The bottom: page counters (beside the link, which is already out), never reaching the first line with words.
    for (let i = n - 1; i > top; i--) {
      if (drop[i]) continue;
      if (!lines[i].guarded && isPageCounter(lines[i].text)) drop[i] = true;
      else break;
    }
    for (let i = 0; i < n; i++) {
      if (drop[i]) continue;
      let line = lines[i].stripped;
      // A date and a time on a line of their own: the date is the document's own; only the time goes.
      if (lines[i].text.length <= SHORT_LINE && DATE_TIME_ONLY.test(lines[i].text)) line = line.replace(TIMES, ' ');
      const m = line.match(TOKEN);
      if (m) for (const t of m) out.push(t);
    }
  }
  return out;
}

const MONTH_WORD = new RegExp(`^${MONTH}$`, 'iu');
const AM_PM = /^[ap]\.?m\.?$/iu;

/**
 * The distinct numbers among the words: values, dates, times, ranges. A day written beside a month name ("March 12",
 * "12 March") is kept as a date ("d:mar 12"), so two letters that differ only in the day are told apart. A titer or
 * ratio such as 1:40 (no AM or PM after it) is kept as a value ("r:1:40"), never read as a time.
 */
export function copyNumbers(tokens: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!/\d/.test(t)) continue;
    if (/^\d{1,2}$/.test(t) && Number(t) >= 1 && Number(t) <= 31) {
      const month = MONTH_WORD.test(tokens[i - 1] ?? '') ? tokens[i - 1] : MONTH_WORD.test(tokens[i + 1] ?? '') ? tokens[i + 1] : null;
      if (month) {
        out.add(`d:${month.slice(0, 3)} ${Number(t)}`);
        continue;
      }
    }
    if (/^1:\d+$/.test(t) && !AM_PM.test(tokens[i + 1] ?? '')) {
      out.add(`r:${t}`);
      continue;
    }
    const m = t.match(NUMBER);
    if (m) for (const n of m) out.add(n);
  }
  return out;
}

/** A numeric date inside a word (03/12/2024, 2024-03-12, 12.03.2024; the date part of 2024-03-12t09:15): the same separator twice. */
const NUMERIC_DATE = /(?<![\d.,\/\-])\d{1,4}([\/.\-])\d{1,2}\1\d{1,4}(?![\d]|[.,\/\-]\d)/g;
/** Eight digits that read as a date (20240312). */
const COMPACT_DATE = /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/;
/** A date with the month's name between dashes (12-mar-2024, mar-12-2024). */
const DASH_MONTH_DATE = new RegExp(String.raw`^(?:\d{1,2}-${MONTH}-\d{2,4}|${MONTH}-\d{1,2}-\d{2,4})$`, 'iu');
const DAY = /^(\d{1,2})(?:st|nd|rd|th)?$/;
/** A date run together with the month's name (12MAR2024, 1nov24). */
const RUN_MONTH_DATE = new RegExp(String.raw`^\d{1,2}${MONTH}\d{2,4}$`, 'iu');
/** Eight digits that read as a US or day-first date (03122024, 12032024). */
const EIGHT_DIGIT_DATE = /^(?:(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])|(?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2]))(?:19|20)\d{2}$/;
const FOUR_DIGIT_YEAR = /^(?:19|20)\d{2}$/;

/**
 * Every date among the words, each time it appears, sorted: numeric dates in any form, eight-digit dates, and a day
 * beside a month's name (with its year when one follows: "mar 12 2024"). Two copies have the very same list.
 */
export function copyDates(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // A month and a year with no day ("March 2024"): a date too, so two letters for March and April differ.
    if (MONTH_WORD.test(t) && FOUR_DIGIT_YEAR.test(tokens[i + 1] ?? '') && !DAY.test(tokens[i - 1] ?? '')) out.push(`${t.slice(0, 3)} ${tokens[i + 1]}`);
    if (!/\d/.test(t)) continue;
    const numeric = t.match(NUMERIC_DATE);
    if (numeric) {
      out.push(...numeric);
      continue;
    }
    if (COMPACT_DATE.test(t) || DASH_MONTH_DATE.test(t) || RUN_MONTH_DATE.test(t) || EIGHT_DIGIT_DATE.test(t)) {
      out.push(t);
      continue;
    }
    const day = DAY.exec(t);
    if (!day || Number(day[1]) < 1 || Number(day[1]) > 31) continue;
    const before = MONTH_WORD.test(tokens[i - 1] ?? '');
    const month = before ? tokens[i - 1] : MONTH_WORD.test(tokens[i + 1] ?? '') ? tokens[i + 1] : null;
    if (!month) continue;
    const year = tokens[before ? i + 1 : i + 2];
    out.push(`${month.slice(0, 3)} ${Number(day[1])}${year && FOUR_DIGIT_YEAR.test(year) ? ` ${year}` : ''}`);
  }
  return out.sort();
}

/** The same dates, each as many times. */
export function sameDates(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The fewest digits of a reference number (fax, phone, order, accession) that two copies may differ in. */
export const REFERENCE_DIGITS_MIN = 7;

/**
 * A number two copies of one document may differ in (a stamp the filters missed): a time, or a long reference such
 * as an order, accession, fax or phone number (7 digits or more). A date in any form (2024-03-12, 12-03-2024,
 * 20240312), a measured value (a decimal, or a whole number of up to 6 digits such as a cell count of 12500), a ratio
 * or titer (120/80, 1:40) may not: two documents that differ there are two documents.
 */
export function mayDifferInACopy(token: string): boolean {
  if (token.startsWith('d:') || token.startsWith('r:')) return false;
  // A time kept in the text (not on a print stamp line, which is dropped) is the document's own: an appointment moved
  // to another hour, a second draw. Two copies give the same times.
  if (/^\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?$/.test(token)) return false;
  // A date written with dashes is a date, never a reference number.
  if (/^(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2}-\d{2,4})$/.test(token)) return false;
  if (/^\d+$/.test(token)) {
    // Eight digits that read as a date (20240312) count as a date.
    if (/^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/.test(token) || EIGHT_DIGIT_DATE.test(token)) return false;
    return token.length >= REFERENCE_DIGITS_MIN;
  }
  if (/^\d+(?:-\d+)+$/.test(token)) return token.replace(/\D/g, '').length >= REFERENCE_DIGITS_MIN;
  return false;
}

/** Words that mark another version of a report; two copies use each of them the same number of times. */
// Result, negation, side and specimen words count the same way: a serum "negative" and a CSF "positive" on one
// template, or a left-arm and a right-arm culture, are two documents.
const VERSION_WORDS = new Set(['positive', 'negative', 'detected', 'reactive', 'nonreactive', 'normal', 'abnormal', 'present', 'absent', 'not', 'no', 'left', 'right', 'bilateral', 'serum', 'plasma', 'csf', 'cerebrospinal', 'blood', 'urine', 'high', 'low', 'elevated', 'equivocal', 'indeterminate', 'borderline', 'amended', 'amendment', 'corrected', 'correction', 'addendum', 'revised', 'revision', 'preliminary', 'final', 'updated', 'supplemental', 'supplementary', 'interim', 'partial', 'cancelled', 'canceled', 'draft', 'redacted']);

export function versionWords(tokens: string[]): string {
  const counts = new Map<string, number>();
  for (const t of tokens) if (VERSION_WORDS.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([w, n]) => `${w}:${n}`).join(' ');
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function fmix32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The hash of the five-word shingle starting at each word, in order. */
export function shingleSequence(tokens: string[]): Uint32Array {
  const n = tokens.length;
  const th = new Uint32Array(n);
  for (let i = 0; i < n; i++) th[i] = fnv1a(tokens[i]);
  const out = new Uint32Array(Math.max(0, n - SHINGLE_WORDS + 1));
  for (let i = 0; i + SHINGLE_WORDS <= n; i++) {
    let h = 0x9747b28c;
    for (let j = 0; j < SHINGLE_WORDS; j++) h = Math.imul(((h << 5) | (h >>> 27)) ^ th[i + j], 0x9e3779b1);
    out[i] = fmix32(h);
  }
  return out;
}

/** Hashes of the distinct five-word shingles. */
export function shingleSet(tokens: string[]): Set<number> {
  return new Set(shingleSequence(tokens));
}

/**
 * The longest passage of the newer text that the older one does not have: the longest run of its words that no
 * five-word shingle shared with the older text covers. A word or two (a remnant of a stamp, a scanning slip) is the
 * same document; a sentence (a new reply in a portal thread, an added page) is not.
 */
export function longestNewPassage(newer: Uint32Array, wordCount: number, older: Set<number>): number {
  const covered = new Uint8Array(wordCount);
  for (let i = 0; i < newer.length; i++) if (older.has(newer[i])) covered.fill(1, i, Math.min(wordCount, i + SHINGLE_WORDS));
  let best = 0;
  let run = 0;
  for (let i = 0; i < wordCount; i++) {
    run = covered[i] ? 0 : run + 1;
    if (run > best) best = run;
  }
  return best;
}

/** Fixed seeds, one per MinHash value (a signature must mean the same thing on every run). */
const SEEDS: Uint32Array = (() => {
  const s = new Uint32Array(MINHASH_SIZE);
  let x = 0x2545f491;
  for (let i = 0; i < MINHASH_SIZE; i++) {
    x = (x + 0x9e3779b9) >>> 0;
    s[i] = fmix32(x);
  }
  return s;
})();

export function minhashOf(shingles: Set<number>): Uint32Array {
  const mins = new Uint32Array(MINHASH_SIZE).fill(0xffffffff);
  for (const x of shingles) {
    for (let i = 0; i < MINHASH_SIZE; i++) {
      const v = fmix32(x ^ SEEDS[i]);
      if (v < mins[i]) mins[i] = v;
    }
  }
  return mins;
}

function encodeMinhash(m: Uint32Array): string {
  const b = Buffer.alloc(MINHASH_SIZE * 4);
  for (let i = 0; i < MINHASH_SIZE; i++) b.writeUInt32LE(m[i], i * 4);
  return b.toString('base64');
}

function decodeMinhash(s: unknown): Uint32Array | null {
  if (typeof s !== 'string') return null;
  const b = Buffer.from(s, 'base64');
  if (b.length !== MINHASH_SIZE * 4) return null;
  const out = new Uint32Array(MINHASH_SIZE);
  for (let i = 0; i < MINHASH_SIZE; i++) out[i] = b.readUInt32LE(i * 4);
  return out;
}

/** The MinHash estimate of the share of shingles two documents have in common. */
export function estimateSimilarity(a: Uint32Array, b: Uint32Array): number {
  let same = 0;
  for (let i = 0; i < MINHASH_SIZE; i++) if (a[i] === b[i]) same++;
  return same / MINHASH_SIZE;
}

/** Exact share of shingles in common (Jaccard). */
export function jaccard(a: Set<number>, b: Set<number>): number {
  if (!a.size && !b.size) return 1;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let both = 0;
  for (const x of small) if (large.has(x)) both++;
  return both / (a.size + b.size - both);
}

/** The distinct numbers only one of the two has. */
export function differingNumbers(a: Set<string>, b: Set<string>): string[] {
  const out: string[] = [];
  for (const x of a) if (!b.has(x)) out.push(x);
  for (const x of b) if (!a.has(x)) out.push(x);
  return out;
}

/** The numbers of two texts are nearly the same: at most NUMBERS_DIFFER_MAX differ, each a time or a long reference. */
export function numbersNearlySame(a: Set<string>, b: Set<string>): { ok: boolean; differ: number } {
  const diff = differingNumbers(a, b);
  return { ok: diff.length <= NUMBERS_DIFFER_MAX && diff.every(mayDifferInACopy), differ: diff.length };
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

interface DocText {
  tokens: string[];
  sequence: Uint32Array;
  shingles: Set<number>;
  numbers: Set<string>;
  /** Every date, each time it appears, sorted (copyDates). */
  dates: string[];
  versions: string;
}

function readDocText(documentId: string): DocText {
  const pages = db()
    .select({ text: schema.documentPages.text })
    .from(schema.documentPages)
    .where(eq(schema.documentPages.documentId, documentId))
    .orderBy(schema.documentPages.pageNumber)
    .all()
    .map((p) => p.text ?? '');
  const tokens = copyTokens(pages);
  const sequence = shingleSequence(tokens);
  return { tokens, sequence, shingles: new Set(sequence), numbers: copyNumbers(tokens), dates: copyDates(tokens), versions: versionWords(tokens) };
}

function signatureOf(kind: string, text: DocText): TextSignature {
  const at = nowIso();
  if (kind === 'dicom') return { v: SIGNATURE_VERSION, words: text.tokens.length, skip: 'scan images', at };
  if (text.tokens.length < MIN_WORDS) return { v: SIGNATURE_VERSION, words: text.tokens.length, skip: 'short', at };
  const nums = [...text.numbers].sort();
  return {
    v: SIGNATURE_VERSION,
    words: text.tokens.length,
    minhash: encodeMinhash(minhashOf(text.shingles)),
    numbers: { count: nums.length, hash: fnv1a(nums.join('|')).toString(16) },
    at,
  };
}

type Meta = Record<string, unknown>;

/**
 * Read-modify-write of one document's metadata in one synchronous transaction. updated_at is left alone (these are
 * the app's own notes, not an edit, and the reconciliation model is keyed on it) unless `touch` says the user decided.
 */
function patchMeta(documentId: string, fn: (meta: Meta) => boolean, opts: { touch?: boolean } = {}): void {
  db().transaction((tx) => {
    const row = tx.select({ metadataJson: schema.documents.metadataJson }).from(schema.documents).where(eq(schema.documents.id, documentId)).get();
    if (!row) return;
    const meta = parseJson<Meta>(row.metadataJson, {});
    if (!fn(meta)) return;
    tx.update(schema.documents)
      .set({ metadataJson: JSON.stringify(meta), ...(opts.touch ? { updatedAt: nowIso() } : {}) })
      .where(eq(schema.documents.id, documentId))
      .run();
  });
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** The documents the user kept this one beside (Keep both). */
function keptWith(meta: Meta): string[] {
  return stringList((meta.copyDecision as Partial<CopyDecision> | undefined)?.keptWith);
}

/** The live document's stored flag, if any. */
function storedFlag(meta: Meta): PossibleCopyOf | null {
  const p = meta.possibleCopyOf as Partial<PossibleCopyOf> | undefined;
  return p && typeof p.documentId === 'string' ? (p as PossibleCopyOf) : null;
}

function isLive(documentId: string): boolean {
  return Boolean(db().select({ id: schema.documents.id }).from(schema.documents).where(and(eq(schema.documents.id, documentId), isNull(schema.documents.deletedAt))).get());
}

/** created_at, then id: which of two documents is the newer (a folder import can add two in the same millisecond). */
function newer(a: { id: string; createdAt: string }, b: { id: string; createdAt: string }): boolean {
  return a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id);
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

interface CandidateRow {
  id: string;
  title: string;
  createdAt: string;
  minhash: string | null;
  numbersCount: number | null;
  keptWith: string | null;
}

/**
 * Compare one document with the others and write the flags that follow: its own (the best older match, or none) and
 * those of newer documents that look like copies of it. The document's signature is computed from its pages when it
 * is missing, of an older version, or `recompute` is set (new page text). Synchronous; throws only on a database
 * error (see checkCopiesQuietly).
 */
export function checkForCopies(documentId: string, opts: { recompute?: boolean } = {}): CopyCheckResult {
  const d = db();
  const out: CopyCheckResult = { documentId, skipped: null, copyOf: null, flagged: [], compared: 0 };
  const doc = d
    .select({ id: schema.documents.id, title: schema.documents.title, kind: schema.documents.kind, createdAt: schema.documents.createdAt, metadataJson: schema.documents.metadataJson, deletedAt: schema.documents.deletedAt })
    .from(schema.documents)
    .where(eq(schema.documents.id, documentId))
    .get();
  if (!doc || doc.deletedAt) return { ...out, skipped: 'document not found' };
  const meta = parseJson<Meta>(doc.metadataJson, {});
  const texts = new Map<string, DocText>();
  let sig = meta.textSignature as TextSignature | undefined;
  if (opts.recompute || !sig || sig.v !== SIGNATURE_VERSION) {
    const text = readDocText(documentId);
    texts.set(documentId, text);
    sig = signatureOf(doc.kind, text);
    const stored = sig;
    patchMeta(documentId, (m) => {
      m.textSignature = stored;
      return true;
    });
  }
  const mine = decodeMinhash(sig.minhash);
  if (sig.skip || !mine || !sig.numbers) {
    // Not compared any more (re-read as an empty scan, say): it is no copy of anything.
    patchMeta(documentId, (m) => (m.possibleCopyOf ? (delete m.possibleCopyOf, true) : false));
    return { ...out, skipped: sig.skip ?? 'no text' };
  }
  const lo = Math.ceil(sig.words * WORD_RATIO_MIN);
  const hi = Math.floor(sig.words * WORD_RATIO_MAX);
  const m = schema.documents.metadataJson;
  const rows = d.all<CandidateRow>(sql`
    select id, title, created_at as createdAt,
      json_extract(metadata_json, '$.textSignature.minhash') as minhash,
      json_extract(metadata_json, '$.textSignature.numbers.count') as numbersCount,
      json_extract(metadata_json, '$.copyDecision.keptWith') as keptWith
    from documents
    where deleted_at is null and id <> ${documentId}
      and instr(${m}, '"textSignature"') > 0 and json_valid(${m})
      and json_extract(${m}, '$.textSignature.v') = ${SIGNATURE_VERSION}
      and json_extract(${m}, '$.textSignature.words') between ${lo} and ${hi}
      and json_extract(${m}, '$.textSignature.minhash') is not null`);
  const myKept = keptWith(meta);
  const self = { id: doc.id, createdAt: doc.createdAt };
  const candidates: Array<CandidateRow & { estimate: number; iAmNewer: boolean }> = [];
  for (const r of rows) {
    const iAmNewer = newer(self, r);
    // A pair the user kept is never compared again (the decision sits on the newer of the two).
    if (iAmNewer ? myKept.includes(r.id) : stringList(parseJson<unknown>(r.keptWith, [])).includes(documentId)) continue;
    const theirs = decodeMinhash(r.minhash);
    if (!theirs) continue;
    // A set of numbers that differs in size by more than the limit cannot be within it.
    if (Math.abs((r.numbersCount ?? 0) - sig.numbers.count) > NUMBERS_DIFFER_MAX) continue;
    const estimate = estimateSimilarity(mine, theirs);
    if (estimate >= PREFILTER_MIN) candidates.push({ ...r, estimate, iAmNewer });
  }
  candidates.sort((a, b) => b.estimate - a.estimate || a.createdAt.localeCompare(b.createdAt));
  const textOf = (id: string): DocText => {
    let t = texts.get(id);
    if (!t) {
      t = readDocText(id);
      texts.set(id, t);
    }
    return t;
  };
  let best: { row: CandidateRow; similarity: number; differ: number } | null = null;
  const newerMatches: Array<{ row: CandidateRow; similarity: number; differ: number }> = [];
  for (const c of candidates.slice(0, EXACT_CANDIDATES_MAX)) {
    const iAmNewer = c.iAmNewer;
    out.compared++;
    const a = textOf(documentId);
    const b = textOf(c.id);
    const similarity = jaccard(a.shingles, b.shingles);
    if (similarity < SIMILARITY_MIN) continue;
    if (a.versions !== b.versions) continue;
    // Words found in only one of the two (a drug left off a newer list, another name): more than two makes two documents.
    {
      const wa = new Set(a.tokens.filter((t) => !/\d/.test(t)));
      const wb = new Set(b.tokens.filter((t) => !/\d/.test(t)));
      let only = 0;
      for (const w of wa) if (!wb.has(w)) only++;
      for (const w of wb) if (!wa.has(w)) only++;
      if (only > 2) continue;
    }
    const nums = numbersNearlySame(a.numbers, b.numbers);
    if (!nums.ok) continue;
    // Every date the same, each as many times: a date that differs or appears once more makes two documents.
    if (!sameDates(a.dates, b.dates)) continue;
    // The newer one may not say anything the older one does not (a new reply, an added page): setting it aside would hide that.
    const [newerText, olderText] = iAmNewer ? [a, b] : [b, a];
    if (longestNewPassage(newerText.sequence, newerText.tokens.length, olderText.shingles) >= NEW_PASSAGE_WORDS) continue;
    const differ = nums.differ;
    if (iAmNewer) {
      if (!best || similarity > best.similarity || (similarity === best.similarity && newer(best.row, c))) best = { row: c, similarity, differ };
    } else newerMatches.push({ row: c, similarity, differ });
  }
  const at = nowIso();
  const round = (x: number) => Math.round(x * 1000) / 1000;
  // Its own flag: the closest older document, or none.
  patchMeta(documentId, (mm) => {
    const cur = storedFlag(mm);
    if (!best) {
      if (!cur) return false;
      delete mm.possibleCopyOf;
      return true;
    }
    if (cur && cur.documentId === best.row.id && cur.similarity === round(best.similarity) && cur.numbersDiffer === best.differ) return false;
    mm.possibleCopyOf = { documentId: best.row.id, title: best.row.title, similarity: round(best.similarity), numbersDiffer: best.differ, at } satisfies PossibleCopyOf;
    return true;
  });
  out.copyOf = best?.row.id ?? null;
  // Newer documents that look like copies of this one: marked unless they already point at a closer live original.
  for (const nm of newerMatches) {
    let wrote = false;
    patchMeta(nm.row.id, (mm) => {
      const cur = storedFlag(mm);
      const keep = cur && cur.documentId !== documentId && isLive(cur.documentId) && cur.similarity >= round(nm.similarity);
      if (keep) return false;
      if (cur && cur.documentId === documentId && cur.similarity === round(nm.similarity) && cur.numbersDiffer === nm.differ) return false;
      mm.possibleCopyOf = { documentId, title: doc.title, similarity: round(nm.similarity), numbersDiffer: nm.differ, at } satisfies PossibleCopyOf;
      wrote = true;
      return true;
    });
    if (wrote) out.flagged.push(nm.row.id);
  }
  // New text: a copy flagged against the old text that no longer matches looks again (for another original, or none).
  if (opts.recompute) {
    const matched = new Set(newerMatches.map((x) => x.row.id));
    for (const p of documentsPointingAt(documentId)) if (!matched.has(p)) checkForCopies(p);
  }
  return out;
}

/** Live documents flagged as a likely copy of this one. */
function documentsPointingAt(documentId: string): string[] {
  const m = schema.documents.metadataJson;
  return db()
    .all<{ id: string }>(sql`
      select id from documents
      where deleted_at is null and id <> ${documentId} and instr(${m}, ${documentId}) > 0 and json_valid(${m})
        and json_extract(${m}, '$.possibleCopyOf.documentId') = ${documentId}`)
    .map((r) => r.id);
}

/** checkForCopies for the ingest job and the hooks: never throws, never fails the caller. */
export function checkCopiesQuietly(documentId: string, opts: { recompute?: boolean } = {}): CopyCheckResult | null {
  try {
    return checkForCopies(documentId, opts);
  } catch (err) {
    console.warn(`[copies] could not compare ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Documents read before this existed
// ---------------------------------------------------------------------------

/** Live documents with page text and no signature of this version, oldest first. */
function unsignedDocuments(limit: number, skip: Set<string>): string[] {
  const m = schema.documents.metadataJson;
  return db()
    .all<{ id: string }>(sql`
      select id from documents
      where deleted_at is null and text_status in ('extracted', 'ocr_done') and page_count >= 1
        and coalesce((case when json_valid(${m}) then json_extract(${m}, '$.textSignature.v') end), 0) <> ${SIGNATURE_VERSION}
      order by created_at, id
      limit ${limit + skip.size}`)
    .map((r) => r.id)
    .filter((id) => !skip.has(id))
    .slice(0, limit);
}

/**
 * Give up to `limit` documents that have none a signature, each compared with the documents signed before it (so
 * every pair is compared once, when the later of the two is signed). Never throws.
 */
export function backfillCopySignatures(limit = 25, skip: Set<string> = new Set()): { signed: number; flagged: number; left: boolean } {
  let signed = 0;
  let flagged = 0;
  let ids: string[] = [];
  try {
    ids = unsignedDocuments(limit, skip);
  } catch (err) {
    console.warn(`[copies] could not list documents to compare: ${err instanceof Error ? err.message : String(err)}`);
    return { signed, flagged, left: false };
  }
  for (const id of ids) {
    skip.add(id);
    const r = checkCopiesQuietly(id);
    if (!r) continue;
    signed++;
    flagged += r.flagged.length + (r.copyOf ? 1 : 0);
  }
  return { signed, flagged, left: ids.length === limit };
}

/** The most documents one unlock signs. */
const BACKFILL_MAX = 20_000;

/** All of them, a few at a time, yielding between batches; stops when the case is locked. Never throws. */
export async function backfillAllCopySignatures(batch = 10): Promise<{ signed: number; flagged: number }> {
  const skip = new Set<string>();
  let signed = 0;
  let flagged = 0;
  while (signed < BACKFILL_MAX) {
    try {
      db();
    } catch {
      break; // locked
    }
    const r = backfillCopySignatures(batch, skip);
    signed += r.signed;
    flagged += r.flagged;
    if (!r.left) break;
    await new Promise((res) => setTimeout(res, 5));
  }
  return { signed, flagged };
}

let backfillTimer: ReturnType<typeof setTimeout> | null = null;
onLockChange((unlocked) => {
  if (backfillTimer) clearTimeout(backfillTimer);
  backfillTimer = null;
  if (!unlocked) return;
  // After the sorting and the reconciliation pass that follow each unlock.
  backfillTimer = setTimeout(() => {
    backfillTimer = null;
    void backfillAllCopySignatures()
      .then((r) => {
        if (r.signed) console.log(`[copies] compared ${r.signed} document${r.signed === 1 ? '' : 's'} read earlier; ${r.flagged} likely ${r.flagged === 1 ? 'copy' : 'copies'}`);
      })
      .catch(() => undefined);
  }, 30_000);
  backfillTimer.unref?.();
});

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

function liveDocumentOr404(id: string) {
  const row = db().select().from(schema.documents).where(and(eq(schema.documents.id, id), isNull(schema.documents.deletedAt))).get();
  if (!row) throw notFound('document not found');
  return row;
}

/** Keep both: the flag goes, and the pair is never flagged again. Returns the document as GET /:id does. */
export function keepBothCopies(documentId: string, by: string | null): DocumentDetail {
  const current = getDocument(documentId);
  const flag = current.likelyCopyOf;
  if (!flag) throw conflict('this document is not marked as a likely copy');
  // A decision of the user's: the row changes like any edit.
  patchMeta(
    documentId,
    (m) => {
      const kept = [...new Set([...keptWith(m), flag.documentId])];
      m.copyDecision = { keep: true, by, at: nowIso(), documentId: flag.documentId, keptWith: kept } satisfies CopyDecision;
      delete m.possibleCopyOf;
      return true;
    },
    { touch: true },
  );
  return getDocument(documentId);
}

export interface SetAsideResult {
  ok: true;
  factsDeleted: number;
  /** Placements Claude made only from the copy that were taken back. */
  takenBack: number;
  /** Placements left standing: keptWorkedOn + keptAllergies + keptShared. */
  kept: number;
  /** Left alone because the user has worked on what they made. */
  keptWorkedOn: number;
  /** Allergies filed from the copy: they always stay (a missing allergy can hurt, an extra one cannot). */
  keptAllergies: number;
  /**
   * What another live document (the original or another) also stands on, and a call or appointment the original has
   * none of its own for (it stays, now on the original).
   */
  keptShared: number;
  /** Details on the copy that carry the user's answers, notes or edits: they go to Deleted documents with it, and Restore brings them back. */
  checkedDetails: number;
  /**
   * Details of the original (or another live document, or typed by hand) that the user had merged into one of the
   * copy's details: shown again, as pending (their notes and edits stay). Restore merges them again if untouched since.
   */
  unmerged: number;
  /** Placements filing the original again made (what only the copy had placed). Only when something was taken back. */
  refiled: number;
  /** What filing the original again placed, in its own words ("Added a medication: ibuprofen"). */
  refiledItems: string[];
}

/** One detail Set this copy aside showed again: the copy's detail it had been merged into, and when it was shown again. */
interface Unmerged {
  factId: string;
  into: string;
  at: string;
}

// ---------------------------------------------------------------------------
// What other documents stand on (read only; Set this copy aside never takes these back)
// ---------------------------------------------------------------------------

/** Live documents other than `copyId` with a placement of their own on this item that still stands. */
function otherPlacementsOn(targetType: string, targetId: string, copyId: string): string[] {
  return db()
    .all<{ documentId: string }>(sql`
      select distinct f.document_id as documentId
      from filings f join documents d on d.id = f.document_id and d.deleted_at is null
      where f.target_type = ${targetType} and f.target_id = ${targetId} and f.document_id <> ${copyId}
        and f.status in ('pending', 'confirmed', 'approved')`)
    .map((r) => r.documentId);
}

/** Of these document ids, the live ones other than `copyId`. */
function liveOthers(ids: Array<string | null | undefined>, copyId: string): string[] {
  const want = [...new Set(ids.filter((x): x is string => typeof x === 'string' && x !== copyId))];
  if (!want.length) return [];
  return db().select({ id: schema.documents.id }).from(schema.documents).where(and(inArray(schema.documents.id, want), isNull(schema.documents.deletedAt))).all().map((r) => r.id);
}

function cleanName(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Live medication details of every live document but the copy, by the key filing matches medications on (the name
 * as normalizeKey reads it): which documents still say each drug. Details the user marked wrong, and details set
 * aside, do not count (as for filing).
 */
function medicationDetailKeys(copyId: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const rows = db().all<{ documentId: string; statement: string; attributesJson: string }>(sql`
    select f.source_document_id as documentId, f.statement as statement, f.attributes_json as attributesJson
    from facts f join documents d on d.id = f.source_document_id and d.deleted_at is null
    where f.type = 'medication' and f.deleted_at is null and f.status not in ('disputed', 'superseded') and f.source_document_id <> ${copyId}`);
  for (const r of rows) {
    const key = normalizeKey(cleanName(parseJson<{ name?: unknown }>(r.attributesJson, {}).name) ?? r.statement);
    if (key) (out.get(key) ?? out.set(key, new Set()).get(key)!).add(r.documentId);
  }
  return out;
}

/**
 * Who else stands on a medication: `placed` (another live document's own placement on it, a live history line made
 * from its details, or the detail the medication was made from) and `detailOnly` (live documents that say the drug
 * in a detail of their own that nothing on the medication comes from: the copy's line is the only line for it).
 */
function medicationStanding(medicationId: string, copyId: string, keys: () => Map<string, Set<string>>): { placed: string[]; detailOnly: string[] } {
  const med = db().select({ name: schema.medications.name, genericName: schema.medications.genericName, sourceFactId: schema.medications.sourceFactId }).from(schema.medications).where(eq(schema.medications.id, medicationId)).get();
  if (!med) return { placed: [], detailOnly: [] };
  const lineDocs = db()
    .all<{ documentId: string | null }>(sql`
      select f.source_document_id as documentId
      from medication_events me join facts f on f.id = me.source_fact_id and f.deleted_at is null
      where me.medication_id = ${medicationId} and me.deleted_at is null`)
    .map((r) => r.documentId);
  const madeFrom = med.sourceFactId ? db().select({ documentId: schema.facts.sourceDocumentId }).from(schema.facts).where(and(eq(schema.facts.id, med.sourceFactId), isNull(schema.facts.deletedAt))).get()?.documentId : null;
  const placed = new Set([...otherPlacementsOn('medication', medicationId, copyId), ...liveOthers([...lineDocs, madeFrom], copyId)]);
  const k = keys();
  const saying = new Set<string>();
  for (const name of [med.name, med.genericName]) {
    const key = normalizeKey(name);
    if (key) for (const id of k.get(key) ?? []) saying.add(id);
  }
  return { placed: [...placed], detailOnly: [...saying].filter((id) => !placed.has(id)) };
}

/** Live documents other than the copy that stand on a records-checklist row: their own placement, their classification naming the row, or the row holding them. */
function recordStanding(rowId: string, copyId: string): { standing: string[]; rowDocumentId: string | null } {
  const row = db().select({ documentId: schema.recordsInventory.documentId }).from(schema.recordsInventory).where(eq(schema.recordsInventory.id, rowId)).get();
  const named = db()
    .all<{ id: string; metadataJson: string }>(sql`
      select id, metadata_json as metadataJson from documents
      where deleted_at is null and id <> ${copyId} and instr(metadata_json, ${rowId}) > 0`)
    .filter((d) => (readTriage(d)?.suggested_links?.inventory_row_ids ?? []).includes(rowId))
    .map((d) => d.id);
  const standing = [...new Set([...otherPlacementsOn('record', rowId, copyId), ...named, ...liveOthers([row?.documentId], copyId)])];
  return { standing, rowDocumentId: row?.documentId ?? null };
}

/** Details on the document that carry the user's answers, notes or edits (confirmed, marked wrong, not sure, a note, an edit, typed by hand, another occasion). */
function checkedDetailsOn(documentId: string): number {
  const r = db().get<{ n: number }>(sql`
    select count(*) as n from facts
    where source_document_id = ${documentId} and deleted_at is null and (
      status in ('confirmed', 'disputed') or verdict_basis = 'unsure' or trim(coalesce(verdict_note, '')) <> '' or origin = 'manual'
      or (json_valid(attributes_json) and (json_extract(attributes_json, '$._userEdited') = 1 or json_extract(attributes_json, '$._reconcileSeparate') = 1)))`);
  return Number(r?.n ?? 0);
}

/**
 * Why Set this copy aside leaves a placement standing: an allergy (always), what another live document also stands
 * on ('shared'), or a call or appointment the original has none of its own for ('only': it stays, now on the original).
 */
type KeepReason = 'allergy' | 'shared' | 'only';

type StandingOn = (p: { documentId: string | null; targetType: string; targetId: string; action: string; detail?: Record<string, unknown> | null }) => string[];

/**
 * filing.ts's own view of the other live documents that stand on what a placement made (otherDocumentsStandingOn,
 * read-only), when this build has it; [] otherwise. Joined with mustStay's own checks, so either one keeping an item
 * keeps it: setting a copy aside never removes what another document still says.
 */
function filingStandingOn(f: Filing): string[] {
  try {
    const fn = (filing as unknown as Record<string, unknown>).otherDocumentsStandingOn;
    if (typeof fn !== 'function') return [];
    const ids = (fn as StandingOn)({ documentId: f.documentId, targetType: f.targetType, targetId: f.targetId, action: f.action, detail: f.detail });
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** The original and the other live likely copies of it (never this copy): where a call or an appointment of its own would come from. */
function copyFamily(copyId: string, originalId: string): string[] {
  return liveOthers([originalId, ...documentsPointingAt(originalId)], copyId);
}

/** Whether a live call or message other than `exceptId` was made from one of these documents. */
function hasOwnCommunication(documentIds: string[], exceptId: string): boolean {
  if (!documentIds.length) return false;
  const c = schema.communications;
  return Boolean(db().select({ id: c.id }).from(c).where(and(inArray(c.documentId, documentIds), isNull(c.deletedAt), ne(c.id, exceptId))).get());
}

/** Whether one of these documents is attached to a live appointment other than `exceptId`. */
function hasOwnEncounter(documentIds: string[], exceptId: string): boolean {
  if (!documentIds.length) return false;
  const want = new Set(documentIds);
  const near = sql.join(
    documentIds.map((id) => sql`instr(document_ids_json, ${id}) > 0`),
    sql` or `,
  );
  return db()
    .all<{ json: string }>(sql`select document_ids_json as json from encounters where deleted_at is null and id <> ${exceptId} and (${near})`)
    .some((r) => stringList(parseJson<unknown>(r.json, [])).some((id) => want.has(id)));
}

/**
 * Whether Set this copy aside must leave this placement of the copy standing, and why. An allergy always stays (a
 * missing allergy can hurt, an extra one cannot). Anything another live document (the original or any other) also
 * stands on stays: a medication it has a placement, a history line or a detail of its own on; a call or an
 * appointment it is filed with; a records-checklist row it fulfils (the row is then pointed at that document instead
 * of the copy). A call or an appointment the copy made stays too when the original (and every other copy of it) has
 * no live call or appointment of its own (never filed, or the user deleted its entry and kept this one): the call is
 * then pointed at the original, and the original attached to the appointment, so it never hangs on a document in
 * Deleted documents and filing the original never makes a second one. A history line or an appointment link of the
 * copy's own goes (the item it sits on stays), except a history line that is the only line for a detail another
 * document still says.
 */
function mustStay(f: Filing, copyId: string, originalId: string, keys: () => Map<string, Set<string>>, opts: { repoint?: boolean } = {}): KeepReason | null {
  if (f.targetType === 'intolerance') return 'allergy';
  const elsewhere = filingStandingOn(f).filter((id) => id !== copyId);
  if (f.targetType === 'medication') {
    const s = medicationStanding(f.targetId, copyId, keys);
    if (f.action === 'created') return s.placed.length || s.detailOnly.length || elsewhere.length ? 'shared' : null;
    return s.detailOnly.length || elsewhere.length ? 'shared' : null;
  }
  if (f.targetType === 'communication' && f.action === 'created') {
    const c = db().select({ documentId: schema.communications.documentId }).from(schema.communications).where(eq(schema.communications.id, f.targetId)).get();
    if (otherPlacementsOn('communication', f.targetId, copyId).length || liveOthers([c?.documentId], copyId).length || elsewhere.length) return 'shared';
    const family = copyFamily(copyId, originalId);
    // The original has a live call of its own for it: the copy's entry is the double, and goes.
    if (hasOwnCommunication(family, f.targetId)) return null;
    if (opts.repoint !== false && c?.documentId === copyId && family.includes(originalId)) {
      db()
        .update(schema.communications)
        .set({ documentId: originalId, updatedAt: nowIso() })
        .where(and(eq(schema.communications.id, f.targetId), eq(schema.communications.documentId, copyId)))
        .run();
    }
    return 'only';
  }
  if (f.targetType === 'encounter' && f.action === 'created') {
    const e = db().select({ documentIdsJson: schema.encounters.documentIdsJson }).from(schema.encounters).where(eq(schema.encounters.id, f.targetId)).get();
    if (otherPlacementsOn('encounter', f.targetId, copyId).length || liveOthers(stringList(parseJson<unknown>(e?.documentIdsJson, [])), copyId).length || elsewhere.length) return 'shared';
    const family = copyFamily(copyId, originalId);
    // The original is attached to a live appointment of its own: the copy's is the double, and goes.
    if (hasOwnEncounter(family, f.targetId)) return null;
    if (opts.repoint !== false && e && family.includes(originalId)) linkEncounter(f.targetId, originalId, []);
    return 'only';
  }
  if (f.targetType === 'record' && f.action === 'linked') {
    const own = recordStanding(f.targetId, copyId);
    const standing = [...new Set([...own.standing, ...elsewhere])];
    const rowDocumentId = own.rowDocumentId;
    if (!standing.length) return null;
    // Received with the copy: the row now holds the document that stays (the original first).
    if (opts.repoint !== false && rowDocumentId === copyId) {
      try {
        updateRecord(f.targetId, { documentId: standing.includes(originalId) ? originalId : standing[0] });
      } catch (err) {
        console.warn(`[copies] could not point the records row ${f.targetId} at the original: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return 'shared';
  }
  return elsewhere.length ? 'shared' : null;
}

/**
 * The user's merges into the copy's details, undone before the copy goes: a live detail of another live document (or
 * one typed by hand) that the user merged into, or replaced with, one of the copy's live details (status superseded,
 * superseded_by_id the copy's detail) is shown again, as pending (status unverified, superseded_by_id null, no check;
 * its note and edits stay). The clinical-record pass's own set-asides are left to the pass, which the delete runs.
 */
function unmergeFromCopy(copyId: string): Unmerged[] {
  const rows = db().all<{ id: string; keeper: string }>(sql`
    select f.id as id, f.superseded_by_id as keeper
    from facts f join facts k on k.id = f.superseded_by_id
    where k.source_document_id = ${copyId} and k.deleted_at is null and k.status <> 'superseded'
      and f.deleted_at is null and f.status = 'superseded'
      and (f.source_document_id is null
           or (f.source_document_id <> ${copyId} and exists (select 1 from documents dd where dd.id = f.source_document_id and dd.deleted_at is null)))
      and not ${passSetAsideSql(sql.raw('f.id'))}`);
  if (!rows.length) return [];
  const at = nowIso();
  const ids = rows.map((r) => r.id);
  db().transaction((tx) => {
    for (let i = 0; i < ids.length; i += 400) {
      tx.update(schema.facts)
        .set({ status: 'unverified', supersededById: null, verdictBasis: null, verdictAt: null, updatedAt: at })
        .where(and(inArray(schema.facts.id, ids.slice(i, i + 400)), eq(schema.facts.status, 'superseded')))
        .run();
    }
  });
  return rows.map((r) => ({ factId: r.id, into: r.keeper, at }));
}

/**
 * After a restore of the copy: the details Set this copy aside showed again are merged into the copy's details again
 * (the user's own answer stands), each only while nothing has changed it since (still pending, untouched) and the
 * copy's detail is back. Never throws.
 */
function remergeAfterRestore(list: unknown): number {
  let n = 0;
  for (const u of Array.isArray(list) ? (list as Array<Partial<Unmerged>>) : []) {
    try {
      if (typeof u.factId !== 'string' || typeof u.into !== 'string' || typeof u.at !== 'string') continue;
      const f = db().select({ status: schema.facts.status, supersededById: schema.facts.supersededById, verdictAt: schema.facts.verdictAt, updatedAt: schema.facts.updatedAt, deletedAt: schema.facts.deletedAt }).from(schema.facts).where(eq(schema.facts.id, u.factId)).get();
      const k = db().select({ status: schema.facts.status, deletedAt: schema.facts.deletedAt }).from(schema.facts).where(eq(schema.facts.id, u.into)).get();
      if (!f || f.deletedAt || f.status !== 'unverified' || f.supersededById || f.verdictAt || f.updatedAt !== u.at) continue;
      if (!k || k.deletedAt || k.status === 'superseded') continue;
      supersedeFact(u.factId, u.into);
      n++;
    } catch (err) {
      console.warn(`[copies] could not merge a detail again after a restore: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return n;
}

/**
 * Set this copy aside. First the details of the original (or another live document) that the user had merged into
 * the copy's details are shown again (unmergeFromCopy). Then what Claude filed only from the copy, and the user has
 * not worked on, is taken back (Undo, status `undone`, so a restore may file it again); allergies, what another live
 * document also stands on, and a call or appointment the original has none of its own for stay (see mustStay). Then
 * the ordinary soft delete (the copy and its details go to Deleted documents; the original file stays). Only when
 * something was taken back is the original filed again, so anything only the copy had placed is placed from the
 * original (filing it again otherwise could only bring back what the user removed); the result says what it placed.
 * The result counts the details on the copy that carry the user's answers or notes: they go to Deleted documents with
 * it and come back on Restore. Only for a document marked as a likely copy.
 */
export function setAsideCopy(documentId: string, by: string | null): SetAsideResult {
  liveDocumentOr404(documentId);
  const flag = getDocument(documentId).likelyCopyOf;
  if (!flag) throw conflict('this document is not marked as a likely copy; Delete removes it');
  const checkedDetails = checkedDetailsOn(documentId);
  // Before anything else, so the original's details count below as what the original says.
  const unmerged = unmergeFromCopy(documentId);
  const placements = listFilings({ documentId });
  const takenBackIds: string[] = [];
  let keptWorkedOn = 0;
  let keptAllergies = 0;
  let keptShared = 0;
  let keys: Map<string, Set<string>> | null = null;
  const detailKeys = () => (keys ??= medicationDetailKeys(documentId));
  for (const f of placements) {
    const onClaudesWord = f.status === 'pending' || (f.status === 'confirmed' && f.decidedBy === 'automatic');
    if (!f.undoable) {
      // It stays either way. An allergy is counted as one (a never-give entry always reads as worked on); when another
      // document also stands on it (an appointment the original was attached to since reads as changed), that is the
      // reason given, not the user's work. A call or appointment of the user's is still pointed at the original when
      // the original has none of its own.
      if (onClaudesWord && f.workedOn && !f.targetGone) {
        if (f.targetType === 'intolerance') keptAllergies++;
        else if (mustStay(f, documentId, flag.documentId, detailKeys, { repoint: f.targetType === 'communication' || f.targetType === 'encounter' }) === 'shared') keptShared++;
        else keptWorkedOn++;
      }
      continue;
    }
    const stay = mustStay(f, documentId, flag.documentId, detailKeys);
    if (stay === 'allergy') {
      keptAllergies++;
      continue;
    }
    if (stay) {
      keptShared++;
      continue;
    }
    try {
      rejectFiling(f.id, SET_ASIDE_BY, { status: 'undone', guardWork: true });
      takenBackIds.push(f.id);
    } catch {
      // Worked on in the meantime, or refused for another reason: it stays, the user changes it on its own page.
      keptWorkedOn++;
    }
  }
  patchMeta(documentId, (m) => {
    m.copySetAside = { at: nowIso(), by, of: flag.documentId, filingIds: takenBackIds, checkedDetails, unmerged };
    return true;
  });
  const r = deleteDocument(documentId);
  // Anything only the copy had placed is placed from the original now; only when something was taken back (each never
  // throws, and does nothing twice).
  const refiledItems: string[] = [];
  if (takenBackIds.length) {
    const original = db().select({ extractionStatus: schema.documents.extractionStatus }).from(schema.documents).where(and(eq(schema.documents.id, flag.documentId), isNull(schema.documents.deletedAt))).get();
    if (original) {
      if (READ_STATUSES.has(original.extractionStatus)) for (const c of autoFileAfterExtraction(flag.documentId).created) refiledItems.push(c.summary);
    }
  }
  return {
    ok: true,
    factsDeleted: r.factsDeleted,
    takenBack: takenBackIds.length,
    kept: keptWorkedOn + keptAllergies + keptShared,
    keptWorkedOn,
    keptAllergies,
    keptShared,
    checkedDetails,
    unmerged: unmerged.length,
    refiled: refiledItems.length,
    refiledItems,
  };
}

/**
 * After a delete: copies that pointed at the deleted document look for another original (the next copy of the same
 * report stays flagged). After a restore: a copy that was set aside gets back the merges the set-aside undid (if
 * untouched since) and is filed again (the placements it took back had status `undone`, which filing may make again),
 * and the document is compared again.
 */
function afterDeleteOrRestore(documentId: string, event: 'deleted' | 'restored'): void {
  if (event === 'deleted') {
    for (const p of documentsPointingAt(documentId)) checkCopiesQuietly(p);
    return;
  }
  const row = db().select({ metadataJson: schema.documents.metadataJson, extractionStatus: schema.documents.extractionStatus }).from(schema.documents).where(eq(schema.documents.id, documentId)).get();
  if (!row) return;
  const setAside = parseJson<Meta>(row.metadataJson, {}).copySetAside as { restoredAt?: string; unmerged?: unknown } | undefined;
  if (setAside && !setAside.restoredAt) {
    remergeAfterRestore(setAside.unmerged);
    autoFileAfterClassification(documentId);
    if (READ_STATUSES.has(row.extractionStatus)) autoFileAfterExtraction(documentId);
    patchMeta(documentId, (mm) => {
      const s = mm.copySetAside as Record<string, unknown> | undefined;
      if (!s) return false;
      s.restoredAt = nowIso();
      return true;
    });
  }
  checkCopiesQuietly(documentId);
}
onDocumentDeletedOrRestored(afterDeleteOrRestore);

// ---------------------------------------------------------------------------
// Copies inside a large export (2026-10-07)
// ---------------------------------------------------------------------------
//
// A filed message or report is never compared with a whole 1,840-page export (the length window above rules it out).
// Instead, after an export is cut into segments (and after a small document is read):
// - a filed MESSAGE is a copy of a message the export prints when the export's message body appears whole in the filed
//   document (the same body hash once normalised), its subject is there too, and a time printed with it is within
//   COPY_TIME_TOLERANCE_MIN minutes of the message's "Sent" stamp (composed 8:14, sent 8:15);
// - a filed REPORT is a copy of a segment when their copy signatures agree as for two documents (90% of shingles).
// The filed document gets `metadata_json.containedIn` (export, segment, pages, similarity) and the segment
// `detail.copyOf`. Nothing is set aside, merged or deleted: both stay, each with its own trust; the communications side
// links the two copies of a message into one row.

/** A filed document this small (pages) may be a copy of a passage of an export. */
export const CONTAINED_MAX_PAGES = 5;
/** The shortest message body (normalised characters) matched by containment: shorter ones are too common. */
export const CONTAINED_BODY_MIN = 80;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Dates and times printed in a text (a filed record's stamp), for matching within minutes. Pure. */
export function filedStamps(text: string): { dates: string[]; times: string[] } {
  const dates = new Set<string>();
  const times = new Set<string>();
  const pad = (n: number) => String(n).padStart(2, '0');
  for (const m of text.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi)) {
    const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    const d = Number(m[2]);
    if (mo >= 1 && d >= 1 && d <= 31) dates.add(`${m[3]}-${pad(mo)}-${pad(d)}`);
  }
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) dates.add(`${m[1]}-${m[2]}-${m[3]}`);
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/g)) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (Number(m[1]) >= 1 && Number(m[1]) <= 12) dates.add(`${y}-${pad(Number(m[1]))}-${pad(Number(m[2]))}`);
  }
  for (const m of text.matchAll(/\b(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\b\.?/gi)) {
    let h = Number(m[1]);
    const pm = m[3].toLowerCase() === 'p';
    if (h < 1 || h > 12) continue;
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
    times.add(`${pad(h)}:${m[2]}`);
  }
  return { dates: [...dates].slice(0, 40), times: [...times].slice(0, 60) };
}

/** How a filed message matched a message printed in an export. */
export interface FiledMessageMatch {
  message: ParsedMessage;
  minutesApart: number;
  bodyHash: string;
}

/**
 * The export message a filed document is a copy of, or null. Its body must appear whole in the filed text (the same
 * body hash once normalised), its subject too, and a printed date and time within COPY_TIME_TOLERANCE_MIN minutes of
 * its "Sent" stamp. Pure.
 */
export function matchFiledMessage(filedText: string, messages: readonly ParsedMessage[]): FiledMessageMatch | null {
  const hay = normalizeForHash(filedText);
  const stamps = filedStamps(filedText);
  let best: FiledMessageMatch | null = null;
  for (const m of messages) {
    const body = normalizeForHash(m.body);
    if (body.length < CONTAINED_BODY_MIN || !hay.includes(body)) continue;
    if (m.subject && !hay.includes(normalizeForHash(m.subject))) continue;
    let apart: number | null = null;
    for (const d of stamps.dates) {
      for (const t of stamps.times) {
        const diff = minutesBetween({ date: d, time: t }, { date: m.sentDate, time: m.sentTime });
        if (diff !== null && Math.abs(diff) <= COPY_TIME_TOLERANCE_MIN && (apart === null || Math.abs(diff) < Math.abs(apart))) apart = diff;
      }
    }
    if (apart === null) continue;
    if (!best || Math.abs(apart) < Math.abs(best.minutesApart)) best = { message: m, minutesApart: apart, bodyHash: bodyHashOf(m.body) };
  }
  return best;
}

/** A passage's copy signature (`detail.signature`): words and a MinHash, as for documents. */
export function passageSignature(text: string): { v: number; words: number; minhash: string } | null {
  const tokens = copyTokens([text]);
  if (tokens.length < MIN_WORDS) return null;
  return { v: SIGNATURE_VERSION, words: tokens.length, minhash: encodeMinhash(minhashOf(shingleSet(tokens))) };
}

interface SmallDoc {
  id: string;
  text: string;
  words: number;
  minhash: Uint32Array | null;
}

/** Live documents of at most CONTAINED_MAX_PAGES pages with text, other than `exceptIds` and other exports. */
function smallDocuments(exceptIds: ReadonlySet<string>, onlyId?: string): SmallDoc[] {
  const m = schema.documents.metadataJson;
  const rows = db().all<{ id: string; metadataJson: string }>(sql`
    select id, metadata_json as metadataJson from documents
    where deleted_at is null and page_count between 1 and ${CONTAINED_MAX_PAGES} and text_status in ('extracted', 'ocr_done')
      and (case when json_valid(${m}) then json_extract(${m}, '$.export') end) is null
      ${onlyId ? sql`and id = ${onlyId}` : sql``}`);
  const out: SmallDoc[] = [];
  for (const r of rows) {
    if (exceptIds.has(r.id)) continue;
    const pages = db().select({ text: schema.documentPages.text }).from(schema.documentPages).where(eq(schema.documentPages.documentId, r.id)).orderBy(schema.documentPages.pageNumber).all();
    const sig = parseJson<Meta>(r.metadataJson, {}).textSignature as TextSignature | undefined;
    out.push({ id: r.id, text: pages.map((p) => p.text).join('\n'), words: sig?.words ?? 0, minhash: decodeMinhash(sig?.minhash) });
  }
  return out;
}

/** Live documents cut as exports (Epic layout recorded). */
function exportDocuments(exceptId?: string): string[] {
  const m = schema.documents.metadataJson;
  return db()
    .all<{ id: string }>(sql`
      select id from documents
      where deleted_at is null and id <> ${exceptId ?? ''} and instr(${m}, '"export"') > 0 and json_valid(${m})
        and json_extract(${m}, '$.export.system') is not null`)
    .map((r) => r.id);
}

function recordContainedIn(filedId: string, entry: ContainedInEntry): boolean {
  let wrote = false;
  patchMeta(filedId, (mm) => {
    const list = parseContainedIn(mm);
    const i = list.findIndex((e) => e.documentId === entry.documentId && e.segmentId === entry.segmentId);
    if (i >= 0 && list[i].similarity === entry.similarity && list[i].pages[0] === entry.pages[0] && list[i].pages[1] === entry.pages[1]) return false;
    if (i >= 0) list[i] = entry;
    else list.push(entry);
    mm.containedIn = list.slice(0, 50);
    wrote = true;
    return true;
  });
  return wrote;
}

/** Parts never compared as a filed report: messages (matched one by one above), identity pages and lists. */
const NOT_A_REPORT_KINDS = new Set(['messages', 'appointment_request', 'facesheet', 'boilerplate', 'visit_info', 'vitals', 'flowsheets', 'mar', 'orders']);

export interface SegmentCopiesResult {
  /** Filed documents newly linked as copies of a passage of an export. */
  linked: Array<{ filedDocumentId: string; exportDocumentId: string; segmentId: string; pages: [number, number]; kind: 'message' | 'passage'; minutesApart: number | null }>;
  compared: number;
}

/**
 * Looks for filed documents held inside an export: when `documentId` is an export, every small document is compared
 * with its messages and passages; when it is a small document, it is compared with every export. Writes containedIn
 * and copyOf; never sets anything aside.
 */
export async function checkSegmentCopies(documentId: string): Promise<SegmentCopiesResult> {
  const out: SegmentCopiesResult = { linked: [], compared: 0 };
  const seg = await import('./segments');
  const isExport = Boolean(seg.readSegmentationMeta(documentId)?.layout === 'epic');
  const exports = isExport ? [documentId] : exportDocuments(documentId);
  if (!exports.length) return out;
  const small = isExport ? smallDocuments(new Set([documentId])) : smallDocuments(new Set(), documentId);
  if (!small.length) return out;
  const at = nowIso();
  // Each small document's shingles, worked out once: it is compared with every part of every export.
  const smallShingles = new Map<string, Set<number>>();
  for (const exportId of exports) {
    const live = seg.listSegments(exportId);
    // Messages: body found whole in the filed text, subject too, sent within minutes of a printed time.
    for (const s of live.filter((x) => x.kind === 'messages' || x.kind === 'appointment_request')) {
      const parsed = seg.parseSegmentContent(exportId, s.id);
      if (!parsed.messages.length) continue;
      for (const d of small) {
        out.compared++;
        const m = matchFiledMessage(d.text, parsed.messages);
        if (!m) continue;
        const entry: ContainedInEntry = { documentId: exportId, segmentId: s.id, pages: m.message.pages, similarity: 1, at };
        if (recordContainedIn(d.id, entry)) out.linked.push({ filedDocumentId: d.id, exportDocumentId: exportId, segmentId: s.id, pages: m.message.pages, kind: 'message', minutesApart: m.minutesApart });
        seg.updateSegment(s.id, { detail: { copyOf: { documentId: d.id, similarity: 1, at } } });
      }
    }
    // Reports: a passage whose signature agrees with a small document's as two copies would.
    const withSig = small.filter((d) => d.minhash && d.words >= MIN_WORDS);
    if (!withSig.length) continue;
    const lo = Math.min(...withSig.map((d) => d.words)) * WORD_RATIO_MIN;
    const hi = Math.max(...withSig.map((d) => d.words)) * WORD_RATIO_MAX;
    for (const s of live) {
      if (s.status === 'skipped' || s.status === 'no_text') continue;
      if (NOT_A_REPORT_KINDS.has(s.kind)) continue;
      const detail = parseSegmentDetail(s.detailJson);
      const approxWords = Number((detail as Record<string, unknown>).chars ?? 0) / 6;
      if (approxWords && (approxWords < lo * 0.5 || approxWords > hi * 2)) continue;
      // The part's text is read only when its signature is not stored yet, or for an exact comparison (sweep
      // 2026-10-07): filing one small document no longer reads every part of a 2,000-page export.
      let text: string | null = null;
      const partText = (): string => (text ??= seg.segmentPageTexts(exportId, s).map((p) => p.text).join('\n'));
      const sig = detail.signature?.v === SIGNATURE_VERSION ? detail.signature : passageSignature(partText());
      if (!sig) continue;
      if (!detail.signature) seg.updateSegment(s.id, { detail: { signature: sig } });
      const mine = decodeMinhash(sig.minhash);
      if (!mine) continue;
      let a: Set<number> | null = null;
      for (const d of withSig) {
        if (d.words < sig.words * WORD_RATIO_MIN || d.words > sig.words * WORD_RATIO_MAX) continue;
        if (estimateSimilarity(mine, d.minhash!) < PREFILTER_MIN) continue;
        out.compared++;
        a ??= shingleSet(copyTokens([partText()]));
        let b = smallShingles.get(d.id);
        if (!b) {
          b = shingleSet(copyTokens([d.text]));
          smallShingles.set(d.id, b);
        }
        const similarity = Math.round(jaccard(a, b) * 1000) / 1000;
        if (similarity < SIMILARITY_MIN) continue;
        const entry: ContainedInEntry = { documentId: exportId, segmentId: s.id, pages: [s.pageStart, s.pageEnd], similarity, at };
        if (recordContainedIn(d.id, entry)) out.linked.push({ filedDocumentId: d.id, exportDocumentId: exportId, segmentId: s.id, pages: [s.pageStart, s.pageEnd], kind: 'passage', minutesApart: null });
        seg.updateSegment(s.id, { detail: { copyOf: { documentId: d.id, similarity, at } } });
      }
    }
  }
  return out;
}

/** checkSegmentCopies for the segmentation and the ingest job: never throws. */
export async function checkSegmentCopiesQuietly(documentId: string): Promise<SegmentCopiesResult | null> {
  try {
    return await checkSegmentCopies(documentId);
  } catch (err) {
    console.warn(`[copies] could not look inside exports for ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
