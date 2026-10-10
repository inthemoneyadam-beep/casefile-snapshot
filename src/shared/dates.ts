/**
 * Partial-date handling. Medical records disagree and often give only a month
 * or a year, so every date is stored as an ISO string plus its precision and
 * the text as written. Nothing here depends on the browser or Node.
 */
export type DatePrecision = 'day' | 'month' | 'year' | 'unknown';

export interface PartialDate {
  iso: string | null; // YYYY-MM-DD, YYYY-MM, YYYY, or null
  precision: DatePrecision;
  text: string | null;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function valid(y: number, m?: number, d?: number): boolean {
  if (y < 1900 || y > 2100) return false;
  if (m !== undefined && (m < 1 || m > 12)) return false;
  if (d !== undefined) {
    if (d < 1 || d > 31) return false;
    const dim = new Date(Date.UTC(y, (m ?? 1), 0)).getUTCDate();
    if (d > dim) return false;
  }
  return true;
}

/**
 * Parse free text into a partial date. Accepts ISO (2024-03-11, 2024-03,
 * 2024), US numeric (3/11/2024, 03/11/24), and written forms
 * (March 11, 2024; 11 Mar 2024; Mar 2024). Returns precision 'unknown' with
 * iso null when nothing parses. The original text is always preserved.
 */
export function parsePartialDate(input: string | null | undefined): PartialDate {
  const text = (input ?? '').trim();
  if (!text) return { iso: null, precision: 'unknown', text: null };
  let m: RegExpMatchArray | null;

  // ISO full / month / year (month and day may be unpadded: 2024-3-5, 2024-3)
  if ((m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/))) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (valid(y, mo, d)) return { iso: `${y}-${pad(mo)}-${pad(d)}`, precision: 'day', text };
  }
  if ((m = text.match(/^(\d{4})-(\d{1,2})$/))) {
    const y = +m[1], mo = +m[2];
    if (valid(y, mo)) return { iso: `${y}-${pad(mo)}`, precision: 'month', text };
  }
  if ((m = text.match(/^(\d{4})$/))) {
    const y = +m[1];
    if (valid(y)) return { iso: `${y}`, precision: 'year', text };
  }
  // US numeric M/D/YYYY or M/D/YY, also M-D-YYYY
  if ((m = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})$/))) {
    const mo = +m[1], d = +m[2];
    let y = +m[3];
    if (m[3].length === 2) y += y < 50 ? 2000 : 1900;
    if (valid(y, mo, d)) return { iso: `${y}-${pad(mo)}-${pad(d)}`, precision: 'day', text };
  }
  // The same followed by a time, as Epic prints a result or a note ("07/14/30 2215", "7/14/2030 1745",
  // "7/16/2030  9:41 AM", "07/14/2030 22:15 EDT"): the day. A 24-hour HHMM is a time, never a year (2026-10-07 review).
  const stamp = numericDateWithTime(text, true);
  if (stamp) return { ...stamp, text };
  // M/YYYY
  if ((m = text.match(/^(\d{1,2})[\/-](\d{4})$/))) {
    const mo = +m[1], y = +m[2];
    if (valid(y, mo)) return { iso: `${y}-${pad(mo)}`, precision: 'month', text };
  }
  // Month D, YYYY  |  Month YYYY
  if ((m = text.match(/^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/))) {
    const mo = MONTHS[m[1].toLowerCase()];
    const d = +m[2], y = +m[3];
    if (mo && valid(y, mo, d)) return { iso: `${y}-${pad(mo)}-${pad(d)}`, precision: 'day', text };
  }
  if ((m = text.match(/^([A-Za-z]+)\.?,?\s+(\d{4})$/))) {
    const mo = MONTHS[m[1].toLowerCase()];
    const y = +m[2];
    if (mo && valid(y, mo)) return { iso: `${y}-${pad(mo)}`, precision: 'month', text };
  }
  // D Month YYYY
  if ((m = text.match(/^(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{4})$/))) {
    const mo = MONTHS[m[2].toLowerCase()];
    const d = +m[1], y = +m[3];
    if (mo && valid(y, mo, d)) return { iso: `${y}-${pad(mo)}-${pad(d)}`, precision: 'day', text };
  }
  // D-Mon-YYYY / D-MON-YY / D/Mon/YYYY (lab and EHR exports: "11-MAR-2024", "02-Sep-24")
  if ((m = text.match(/^(\d{1,2})[-/ ]([A-Za-z]{3,9})\.?[-/ ](\d{4}|\d{2})$/))) {
    const mo = MONTHS[m[2].toLowerCase()];
    const d = +m[1];
    let y = +m[3];
    if (m[3].length === 2) y += y < 50 ? 2000 : 1900;
    if (mo && valid(y, mo, d)) return { iso: `${y}-${pad(mo)}-${pad(d)}`, precision: 'day', text };
  }
  // Loose: find an ISO date anywhere in the text
  if ((m = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (valid(y, mo, d)) return { iso: `${y}-${pad(mo)}-${pad(d)}`, precision: 'day', text };
  }
  // Loose: a numeric date with its time somewhere in the text ("collected 07/14/30 2045").
  const looseStamp = numericDateWithTime(text, false);
  if (looseStamp) return { ...looseStamp, text };
  // Loose: a bare year somewhere. A four-digit number right after a full numeric date is its time ("07/14/30 2045"),
  // never a year.
  const yearRe = /\b(19\d{2}|20\d{2})\b/g;
  while ((m = yearRe.exec(text))) {
    const before = text.slice(0, m.index);
    if (/\b\d{1,2}[\/-]\d{1,2}[\/-](?:\d{2}|\d{4})[\sT,]+$/.test(before)) continue;
    return { iso: m[1], precision: 'year', text };
  }
  return { iso: null, precision: 'unknown', text };
}

/** HHMM (24-hour) or H:MM[:SS] [am|pm], then an optional time-zone word. */
const TIME_PART = String.raw`(?:(\d{3,4})|(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?)(?:\s*[A-Z]{2,4})?`;
const STAMP_WHOLE = new RegExp(String.raw`^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})[\sT,]+${TIME_PART}$`, 'i');
const STAMP_LOOSE = new RegExp(String.raw`(?:^|[^\d\/-])(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})[\sT,]+${TIME_PART}(?![\d:\/])`, 'i');

/**
 * A US numeric date followed by a time of day: the day it names, or null. The time must be a real time (HHMM with
 * hours 0-23 and minutes 0-59, or H:MM with an optional am/pm). `whole` asks the text to be only that.
 */
function numericDateWithTime(text: string, whole: boolean): { iso: string; precision: DatePrecision } | null {
  const m = text.match(whole ? STAMP_WHOLE : STAMP_LOOSE);
  if (!m) return null;
  const mo = +m[1], d = +m[2];
  let y = +m[3];
  if (m[3].length === 2) y += y < 50 ? 2000 : 1900;
  let hh: number, mm: number;
  if (m[4]) {
    const t = m[4].padStart(4, '0');
    hh = +t.slice(0, 2);
    mm = +t.slice(2);
  } else {
    hh = +m[5];
    mm = +m[6];
    if (m[7] && (hh < 1 || hh > 12)) return null;
  }
  if (hh > 23 || mm > 59) return null;
  if (!valid(y, mo, d)) return null;
  return { iso: `${y}-${pad(mo)}-${pad(d)}`, precision: 'day' };
}

const TRAILING_TIME = /[\sT,]+\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:[ap]\.?m\.?)?\s*(?:z|[+-]\d{2}:?\d{2}|[A-Z]{2,5})?$/i;
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(z|[+-]\d{2}:?\d{2})$/i;
const PRECISION_RANK: Record<DatePrecision, number> = { unknown: 0, year: 1, month: 2, day: 3 };

/**
 * A date cell from a spreadsheet or export, read like parsePartialDate but
 * also when a time follows the date ("3/11/2024 2:30 PM", "11-Mar-2024 14:00
 * CST", "2024-03-11T09:30:00Z"). An ISO instant with Z or an offset is moved
 * to this computer's local day, as the calendar import does. The text as
 * written is kept.
 */
export function readDateCell(raw: string | null | undefined): PartialDate {
  const t = (raw ?? '').trim();
  if (!t) return parsePartialDate(t);
  const inst = t.match(ISO_INSTANT);
  if (inst) {
    const d = new Date(t.replace(' ', 'T'));
    if (!Number.isNaN(d.getTime())) return { iso: todayIso(d), precision: 'day', text: t };
  }
  const pd = parsePartialDate(t);
  if (pd.precision === 'day') return pd;
  const stripped = t.replace(TRAILING_TIME, '').trim();
  if (stripped && stripped !== t) {
    const again = parsePartialDate(stripped);
    if (again.iso && PRECISION_RANK[again.precision] > PRECISION_RANK[pd.precision]) return { ...again, text: t };
  }
  return pd;
}

/**
 * True when the text as written clearly names a day or a month (a month
 * name, or numbers with two separators) although it was read coarser. Used to
 * refuse a row instead of silently storing a full date at year precision.
 */
export function writtenFinerThanRead(raw: string | null | undefined, read: PartialDate): boolean {
  const t = (raw ?? '').trim();
  if (!t || read.precision === 'day') return false;
  const hasMonthName = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i.test(t);
  const hasDayNumbers = /\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/.test(t);
  if (read.precision === 'year') return hasMonthName || hasDayNumbers;
  if (read.precision === 'month') return hasDayNumbers;
  return hasMonthName || hasDayNumbers;
}

/** Sort key so partial dates sort sensibly: year-only sorts before the January of that year. */
export function dateSortKey(iso: string | null | undefined): string {
  if (!iso) return '9999-99-99';
  if (iso.length === 4) return `${iso}-00-00`;
  if (iso.length === 7) return `${iso}-00`;
  return iso.slice(0, 10);
}

/** Human display at the stored precision. */
export function formatPartialDate(iso: string | null | undefined, precision?: DatePrecision | null): string {
  if (!iso) return '—';
  const p = precision ?? (iso.length === 4 ? 'year' : iso.length === 7 ? 'month' : 'day');
  const [y, m, d] = iso.split('-');
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (p === 'year' || !m) return y;
  if (p === 'month' || !d) return `${monthNames[+m - 1]} ${y}`;
  return `${y}-${m}-${d}`;
}

/** Today as YYYY-MM-DD in local time. */
export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Whole days between two ISO day strings (b - a). */
export function daysBetween(a: string, b: string): number {
  const da = new Date(`${a.slice(0, 10)}T00:00:00Z`).getTime();
  const db = new Date(`${b.slice(0, 10)}T00:00:00Z`).getTime();
  return Math.round((db - da) / 86400000);
}

/**
 * Is a due date (at its stored precision) past on `today` (YYYY-MM-DD)? A
 * partial date is past only once its whole month or year has ended: on
 * 2026-10-05, '2026-10' and '2026' are not past, '2026-09' and '2025' are.
 * Plain string order would call '2026-10' < '2026-10-05' past, because a
 * prefix sorts first, so `today` is cut to the due date's length. The SQL
 * twin is `due < substr(today, 1, length(due))`.
 */
export function isPastDue(due: string | null | undefined, today: string): boolean {
  return Boolean(due && due < today.slice(0, due.length));
}

/** Last day covered by a partial date: '2025' -> 2025-12-31, '2025-02' -> 2025-02-28, a day stays itself. */
export function periodEnd(iso: string): string {
  if (iso.length === 4) return `${iso}-12-31`;
  if (iso.length === 7) {
    const [y, m] = iso.split('-').map(Number);
    return `${iso}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
  }
  return iso.slice(0, 10);
}

/**
 * Whole days a due date has been past on `today`, counted from the end of its
 * stated period (a month-dated promise is 1 day overdue on the 1st of the next
 * month). 0 or less means not past due.
 */
export function daysPastDue(due: string, today: string): number {
  return daysBetween(periodEnd(due), today);
}

/**
 * Do two partial dates agree, allowing for precision? A year-only date agrees
 * with any day in that year. Two day-precision dates agree within `toleranceDays`.
 */
export function datesAgree(a: string | null, b: string | null, toleranceDays = 0): boolean {
  if (!a || !b) return true;
  const short = a.length < b.length ? a : b;
  const long = a.length < b.length ? b : a;
  if (short.length < 10) return long.startsWith(short);
  if (toleranceDays === 0) return a === b;
  return Math.abs(daysBetween(a, b)) <= toleranceDays;
}
