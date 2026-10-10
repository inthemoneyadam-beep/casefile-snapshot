/**
 * The wrong-patient guard (2026-10-09): someone with the same surname and date of birth, such as a twin, can
 * have records sent in the patient's place. Pure: no database, no DOM, so the server, the browser and the tests share it.
 *
 * - `myIdentity`: Patient details from Settings as the check reads them: the first names the patient goes by (his own and
 *   "Other first names I go by"), his surname, his date of birth, his record numbers (each with the health system that
 *   gave it) and "Someone often confused with me". Nothing can be compared until the name and the date of birth are set.
 * - `findIdentities`: the LABELLED patient fields printed on one page ("Patient:", "Patient Name:", "Name:" beside a
 *   date of birth, "DOB:", "Date of Birth:", "MRN:", the Epic running header "MRN: ..., DOB: ..., Legal Sex: ..." with
 *   the name above it). Other people's names are left out: providers, guarantors, emergency contacts, family history,
 *   "cc:", signatures, a subscriber or a parent.
 * - `judgeDocument`: every page's fields against the user's. A different first name (or initial), a different surname, a
 *   different date of birth, a different record number from a health system on his list, or the first name of someone
 *   often confused with him: the page conflicts and the document is held back as "May be someone else's record". The
 *   same surname and date of birth with a different first name conflicts. A date of birth alone never confirms; a
 *   matching first initial is consistent but does not confirm ("Patient not confirmed on document").
 */
import { normalizeKey } from './text';

/** Bumped when the scan's rules change (the once-at-unlock sweep runs again). */
export const PATIENT_CHECK_VERSION = 1;

/** The words the user asked for. */
export const HELD_WORDS = "May be someone else's record";
export const NOT_CONFIRMED_WORDS = 'Patient not confirmed on document';
export const WRONG_PATIENT_REASON = 'wrong patient';

// ---------------------------------------------------------------------------
// The patient's identity
// ---------------------------------------------------------------------------

export interface RecordNumber {
  number: string;
  /** The health system or facility that gave it, as the user typed it (may be empty). */
  system: string;
}

export interface IdentitySettings {
  name: string;
  dob: string;
  otherFirstNames: readonly string[];
  confusedWith: readonly string[];
  recordNumbers: readonly RecordNumber[];
}

export interface DayOfBirth {
  y: number;
  m: number;
  d: number;
  /** Printed with a two-digit year ("1/2/70"): only the last two digits of the year are compared. */
  twoDigitYear: boolean;
  /** Printed as numbers with the day and month in either order ("02/01/1970"): read month first, may be day first. */
  numeric?: boolean;
}

export interface MyIdentity {
  /** Normalised first names (letters only, lower case). */
  firstNames: string[];
  /** Normalised surname words. */
  surnames: string[];
  dob: DayOfBirth | null;
  numbers: Array<{ key: string; number: string; system: string }>;
  confusedWith: Array<{ key: string; label: string }>;
  /** What Patient details still lack before anything can be compared. */
  missing: Array<'name' | 'dob'>;
}

/** Letters only, lower case, accents folded. */
export function nameKey(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]/g, '');
}

/** Letters and digits only, upper case, leading zeros dropped ("000-123 45" = "12345"). */
export function numberKey(s: string): string {
  return (s ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^0+(?=.)/, '');
}

/**
 * A record number printed with its first characters hidden ("****4567", "XXX-XX-4567", "•••4567"): the keyed digits and
 * letters after the hiding (null when nothing is hidden).
 */
export function maskedTail(s: string): string | null {
  const v = (s ?? '').trim();
  const m = v.match(/^[^A-Za-z0-9*•●]*(?:(?:[*•●]|[xX](?=[xX*•●\-\s]))[\s\-.]*){2,}(.*)$/);
  if (!m) return null;
  return numberKey(m[1].replace(/[*•●]/g, ''));
}

const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'sir', 'madam']);
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'md', 'do', 'phd', 'rn', 'np', 'pa', 'dds', 'esq', 'mba', 'msc', 'bsn', 'aprn', 'pac', 'facp']);
/** Words a printed "name" can hold that are never a person's name. */
const NOT_NAMES = new Set([
  'self', 'same', 'see', 'above', 'below', 'unknown', 'none', 'na', 'not', 'available', 'on', 'file', 'patient', 'patients', 'pt',
  'inpatient', 'outpatient', 'emergency', 'visit', 'follow', 'up', 'results', 'result', 'report', 'lab', 'labs', 'test', 'tests',
  'the', 'and', 'of', 'for', 'with', 'to', 'from', 'at', 'in', 'your', 'my', 'his', 'her', 'their', 'portal', 'message', 'note',
  'letter', 'information', 'record', 'records', 'chart', 'name', 'male', 'female', 'legal', 'sex', 'confidential', 'page',
  'printed', 'continued', 'summary', 'history', 'appointment', 'clinic', 'hospital', 'health', 'medical', 'center', 'department',
  'plan', 'phone', 'call', 'telephone', 'address', 'date', 'birth', 'dob', 'mrn', 'account', 'request', 'requested', 'refill',
  // Words of a note that follow "Patient:" in prose, in Title Case too ("Patient: Tolerated Procedure Well"; review 2026-10-09).
  'tolerated', 'procedure', 'well', 'doing', 'denies', 'reports', 'states', 'seen', 'stable', 'alert', 'oriented', 'awake',
  'resting', 'comfortable', 'ambulatory', 'discharged', 'admitted', 'declined', 'refused', 'presents', 'presented', 'improved',
  'improving', 'unchanged', 'condition', 'status', 'education', 'instructions', 'understanding', 'verbalized', 'verbalizes',
  'agrees', 'consented', 'identified', 'verified', 'identity', 'tolerating', 'complains', 'returns', 'arrived', 'transferred',
]);

export interface ParsedName {
  /** The first given name, normalised ("pat"); a single letter when only an initial is printed. */
  first: string;
  firstIsInitial: boolean;
  /** Its first part when it is hyphenated ("mary" of "Mary-Jane"); else the same as `first`. */
  firstPart: string;
  /** The surname's words, normalised. */
  surname: string[];
  /** Read the other way round ("EXAMPLE PAT" printed surname first, without a comma); null for "Last, First". */
  reversed: { first: string; firstIsInitial: boolean; firstPart: string; surname: string[] } | null;
  /** As printed (trimmed, at most 80 characters). */
  printed: string;
}

function words(value: string): string[] {
  return value
    .split(/[\s]+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

function cleanWord(w: string): string {
  return w.replace(/^[^A-Za-zÀ-ɏ]+|[^A-Za-zÀ-ɏ.'’-]+$/g, '').replace(/\.$/, '');
}

function isNameWord(w: string): boolean {
  return /^[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ'’.-]*$/.test(w);
}

function firstOf(word: string): { first: string; firstIsInitial: boolean; firstPart: string } {
  // "Mary-Jane" is read whole and by its first part (firstMatches).
  const key = nameKey(word);
  return { first: key, firstIsInitial: key.length === 1, firstPart: nameKey(word.split(/[-'’]/)[0] ?? '') };
}

function surnameWords(ws: string[]): string[] {
  return ws.flatMap((w) => w.split(/[-'’]/)).map(nameKey).filter((k) => k.length > 0);
}

/**
 * A person's name as printed: "EXAMPLE, PAT QUINN", "Pat Q. Example", "Mr. Pat Example Jr.", "EXAMPLE^PAT" (DICOM).
 * Null when the value is not a name (digits, one word, words that are never a name, too long).
 */
export function parsePersonName(value: string): ParsedName | null {
  let v = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!v) return null;
  // DICOM writes LAST^FIRST^MIDDLE.
  if (v.includes('^')) v = v.replace('^', ', ').replace(/\^/g, ' ');
  // Whatever follows the name on the same line: an age or a date, a bracket, a semicolon, a dash between words.
  v = v.split(/[(\[;|]| - | – /)[0];
  const digit = v.search(/\d/);
  if (digit >= 0) v = v.slice(0, digit);
  v = v.replace(/[,\s]+$/, '').trim();
  if (!v || v.length > 80 || /[@/\\:]/.test(v)) return null;
  const printed = v.slice(0, 80);
  const strip = (ws: string[]) => ws.map(cleanWord).filter((w) => w && !TITLES.has(nameKey(w)) && !SUFFIXES.has(nameKey(w)));
  const comma = v.indexOf(',');
  if (comma > 0) {
    const last = strip(words(v.slice(0, comma)));
    const given = strip(words(v.slice(comma + 1).replace(/,/g, ' ')));
    if (!last.length || !given.length || last.length > 4 || given.length > 4) return null;
    if (![...last, ...given].every(isNameWord)) return null;
    if ([...last, ...given].some((w) => NOT_NAMES.has(nameKey(w)))) return null;
    return { ...firstOf(given[0]), surname: surnameWords(last), reversed: null, printed };
  }
  const ws = strip(words(v));
  if (ws.length < 2 || ws.length > 5) return null;
  if (!ws.every(isNameWord)) return null;
  if (ws.some((w) => NOT_NAMES.has(nameKey(w)))) return null;
  return {
    ...firstOf(ws[0]),
    surname: surnameWords([ws[ws.length - 1]]),
    reversed: { ...firstOf(ws[1]), surname: surnameWords([ws[0]]) },
    printed,
  };
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function validDay(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * The first date of birth in a printed value: 1/2/1970, 01-02-70, 1970-01-02, Jan 2, 1970, 2 January 1970, 02-JAN-1970.
 * US order (month first) for numeric dates. Null when none is there.
 */
export function parseDob(value: string): DayOfBirth | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  let m: RegExpMatchArray | null;
  if ((m = v.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/))) {
    const y = +m[1], mo = +m[2], d = +m[3];
    return y >= 1880 && y <= 2100 && validDay(y, mo, d) ? { y, m: mo, d, twoDigitYear: false } : null;
  }
  if ((m = v.match(/(?:^|[^\d])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?![\d])/))) {
    const mo = +m[1], d = +m[2];
    const two = m[3].length === 2;
    const y = two ? 1900 + +m[3] : +m[3];
    return (two || (y >= 1880 && y <= 2100)) && validDay(two ? 2000 : y, mo, d) ? { y, m: mo, d, twoDigitYear: two, numeric: true } : null;
  }
  if ((m = v.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/))) {
    const mo = MONTHS[m[1].toLowerCase()];
    const d = +m[2], y = +m[3];
    return mo && validDay(y, mo, d) ? { y, m: mo, d, twoDigitYear: false } : null;
  }
  if ((m = v.match(/\b(\d{1,2})[\s-]([A-Za-z]{3,9})\.?[\s-,]+(\d{4}|\d{2})\b/))) {
    const mo = MONTHS[m[2].toLowerCase()];
    const d = +m[1];
    const two = m[3].length === 2;
    const y = two ? 1900 + +m[3] : +m[3];
    return mo && validDay(two ? 2000 : y, mo, d) ? { y, m: mo, d, twoDigitYear: two } : null;
  }
  return null;
}

/** Two dates of birth are the same day (a two-digit year compares its last two digits). */
export function sameDob(a: DayOfBirth, b: DayOfBirth): boolean {
  if (a.m !== b.m || a.d !== b.d) return false;
  if (a.twoDigitYear || b.twoDigitYear) return a.y % 100 === b.y % 100;
  return a.y === b.y;
}

/**
 * A date printed as numbers that is the patient's date of birth read day first ("02/01/1970" for 2 January 1970): not another
 * date of birth (review 2026-10-09; a letter from abroad, or a form filled in day first). Never confirms.
 */
export function sameDobDayFirst(printed: DayOfBirth, mine: DayOfBirth): boolean {
  if (!printed.numeric || printed.m === printed.d || printed.m > 12 || printed.d > 12) return false;
  return sameDob({ ...printed, m: printed.d, d: printed.m }, mine);
}

/** "Example Health System" -> ["example"]: the words that tell one health system from another. */
const SYSTEM_STOP = new Set([
  'the', 'of', 'and', 'at', 'health', 'healthcare', 'system', 'systems', 'hospital', 'hospitals', 'medical', 'medicine', 'center',
  'centre', 'centers', 'clinic', 'clinics', 'university', 'regional', 'memorial', 'inc', 'llc', 'group', 'care', 'services', 'network',
  'saint', 'st', 'community', 'general', 'county', 'physicians', 'associates', 'partners', 'department', 'lab', 'labs', 'laboratory',
  'laboratories', 'mychart', 'portal',
]);

function systemWords(s: string): string[] {
  return normalizeKey(s)
    .split(' ')
    .map((w) => w.replace(/s$/, ''))
    .filter((w) => w.length >= 3 && !SYSTEM_STOP.has(w));
}

/** The same health system: the telling words of one are all in the other (or both read the same when neither has any). */
export function sameSystem(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeKey(a ?? '');
  const y = normalizeKey(b ?? '');
  if (!x || !y) return false;
  const wa = systemWords(x);
  const wb = systemWords(y);
  if (!wa.length || !wb.length) return x === y;
  return wa.every((w) => wb.includes(w)) || wb.every((w) => wa.includes(w));
}

/** The middle names of a name as typed ("Pat Quinn Example", "Example, Pat Quinn" -> ["quinn"]), normalised. */
function middleNames(name: string): string[] {
  const v = name.replace(/\s+/g, ' ').trim();
  const keep = (ws: string[]) => ws.map(cleanWord).filter((w) => w && !TITLES.has(nameKey(w)) && !SUFFIXES.has(nameKey(w)));
  const comma = v.indexOf(',');
  const given = comma > 0 ? keep(words(v.slice(comma + 1).replace(/,/g, ' '))).slice(1) : keep(words(v)).slice(1, -1);
  return given.map(nameKey).filter((k) => k.length >= 2);
}

export function myIdentity(s: IdentitySettings): MyIdentity {
  const missing: Array<'name' | 'dob'> = [];
  const parsed = parsePersonName(s.name ?? '');
  // "Pat Example" or "Example, Pat"; a single word cannot be read as first name and surname.
  if (!parsed || parsed.firstIsInitial) missing.push('name');
  const dob = parseDob(s.dob ?? '');
  if (!dob || dob.twoDigitYear) missing.push('dob');
  const firstNames = new Set<string>();
  if (parsed && !parsed.firstIsInitial) firstNames.add(parsed.first);
  for (const n of s.otherFirstNames ?? []) {
    const k = nameKey(n);
    if (k.length >= 2) firstNames.add(k);
  }
  const confused = new Map<string, string>();
  for (const n of s.confusedWith ?? []) {
    const k = nameKey(n.split(/\s+/)[0] ?? '');
    if (k.length >= 2 && !firstNames.has(k)) confused.set(k, n.trim().split(/\s+/)[0]);
  }
  // His middle names: a record that prints one as the first name ("Example, Quinn") is his (review 2026-10-09), unless it
  // is also the name of someone often confused with him.
  for (const k of middleNames(s.name ?? '')) if (k.length >= 2 && !confused.has(k)) firstNames.add(k);
  return {
    firstNames: [...firstNames],
    surnames: parsed ? parsed.surname : [],
    dob: dob && !dob.twoDigitYear ? dob : null,
    numbers: (s.recordNumbers ?? []).map((r) => ({ key: numberKey(r.number), number: r.number.trim(), system: (r.system ?? '').trim() })).filter((r) => r.key.length >= 3),
    confusedWith: [...confused].map(([key, label]) => ({ key, label })),
    missing,
  };
}

/** A short fingerprint of Patient details as the check reads them (the sweep runs again when it changes). */
export function identitySignature(s: IdentitySettings): string {
  const me = myIdentity(s);
  const text = JSON.stringify([me.firstNames.slice().sort(), me.surnames, me.dob, me.numbers.map((n) => [n.key, normalizeKey(n.system)]).sort(), me.confusedWith.map((c) => c.key).sort()]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${PATIENT_CHECK_VERSION}:${h.toString(16).padStart(8, '0')}`;
}

// ---------------------------------------------------------------------------
// The labelled fields on a page
// ---------------------------------------------------------------------------

export type FieldKind = 'name' | 'dob' | 'mrn';

/** One identity field printed on a page. */
export interface FoundField {
  page: number;
  kind: FieldKind;
  /** The value as printed (at most 80 characters). */
  value: string;
  /** How it was found: a label ("Patient:"), the Epic running header, or Claude's sorting (a second opinion). */
  source: 'label' | 'banner' | 'sorting';
}

export interface PageLines {
  page: number;
  /** The page in reading order, one row per line; " | " between the cells of a row. */
  lines: string[];
}

/** Labels that introduce the patient's name. `weak` ones count only beside a date of birth (same line, or the next). */
const NAME_LABELS: Array<{ re: string; weak: boolean }> = [
  { re: "patient(?:'s)?\\s+(?:full\\s+|legal\\s+)?name", weak: false },
  { re: 'name\\s+of\\s+patient', weak: false },
  { re: 'pt\\.?\\s+name', weak: false },
  { re: 'patient\\s+legal\\s+name', weak: false },
  { re: 'legal\\s+name', weak: false },
  { re: 'patient', weak: false },
  { re: 'name', weak: true },
  { re: 'pt', weak: true },
  { re: 're', weak: true },
  { re: 'regarding', weak: true },
  // "RE: Records Request for: Pat Example DOB 1/2/1970": the patient follows "for:" (real chart print, 2026-10-09).
  { re: 'for', weak: true },
];
const DOB_LABELS = ['date\\s+of\\s+birth', 'birth\\s*date', 'd\\.?o\\.?b\\.?', 'dob'];
const MRN_LABELS = ['medical\\s+record\\s+(?:number|no\\.?|#)', 'med(?:ical)?\\.?\\s+rec(?:ord)?\\.?\\s*(?:#|no\\.?|number)', 'mrn\\s*#?', 'mr\\s*#', 'mr\\s+number', 'hospital\\s+number'];
/** Labels that only end the value before them. */
const OTHER_LABELS = [
  'legal\\s+sex',
  'patient\\s+class',
  'date\\s+of\\s+service',
  'visit\\s+date',
  'admit\\s+date',
  'account\\s*#',
  'acct\\s*#',
  // "Patient Name: Pat Example Admission Date: 1/2/2024": the word before "Date:" belongs to that label, not to the
  // name (real chart print, 2026-10-09: "Admission" was read as a surname).
  '(?:admission|admit|discharge|visit|service|encounter|appointment|appt|procedure|surgery|collection|order|report|referral|exam|arrival|transfer|result|print|scan)\\s+(?:date|time|type|status)',
];

interface Label {
  kind: FieldKind | 'other';
  weak: boolean;
  start: number;
  end: number;
  /** The label as printed, normalised ("guarantor", "patient name"). */
  word: string;
}

const LABEL_ALTS: Array<{ kind: FieldKind | 'other'; weak: boolean; re: string }> = [
  ...OTHER_LABELS.map((re) => ({ kind: 'other' as const, weak: false, re })),
  ...MRN_LABELS.map((re) => ({ kind: 'mrn' as const, weak: false, re })),
  ...DOB_LABELS.map((re) => ({ kind: 'dob' as const, weak: false, re })),
  ...NAME_LABELS.map((l) => ({ kind: 'name' as const, weak: l.weak, re: l.re })),
];
/** Any known label, then ":" (or "#", or for a date of birth or a record number a space before digits); else any single word and ":". */
const LABEL_RE = new RegExp(
  `(?<![A-Za-z])(?:${LABEL_ALTS.map((a, i) => `(?<l${i}>${a.re})`).join('|')}|(?<other>[A-Za-z][A-Za-z.'/]*))(?<sep>\\s*:|\\s*#\\s*:?|(?=\\s+\\d))`,
  'gi',
);

function labelsIn(cell: string): Label[] {
  const out: Label[] = [];
  LABEL_RE.lastIndex = 0;
  for (const m of cell.matchAll(LABEL_RE)) {
    const g = m.groups ?? {};
    const sep = g.sep ?? '';
    let idx = -1;
    for (let i = 0; i < LABEL_ALTS.length; i++) if (g[`l${i}`] !== undefined) idx = i;
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (idx < 0) {
      if (!sep.includes(':')) continue;
      out.push({ kind: 'other', weak: false, start, end, word: normalizeKey(g.other ?? '') });
      continue;
    }
    const alt = LABEL_ALTS[idx];
    // A name needs its colon; a date of birth or a record number may be printed without one ("DOB 1/2/1970").
    if (alt.kind === 'name' && !sep.includes(':')) continue;
    out.push({ kind: alt.kind, weak: alt.weak, start, end, word: normalizeKey(m[0].slice(0, m[0].length - sep.length)) });
  }
  return out;
}

/** Words before a label that make it someone else's ("Guarantor Name:", "Emergency Contact Name:"). */
const OTHER_PERSON = new Set([
  'guarantor', 'contact', 'emergency', 'provider', 'physician', 'doctor', 'facility', 'insured', 'subscriber', 'policyholder',
  'policy', 'holder', 'father', 'mother', 'spouse', 'parent', 'guardian', 'pharmacy', 'test', 'drug', 'medication', 'product',
  'referring', 'ordering', 'attending', 'kin', 'responsible', 'party', 'caregiver', 'user', 'employer', 'school', 'clinic',
  'hospital', 'practice', 'lab', 'laboratory', 'company', 'plan', 'group', 'sender', 'recipient', 'author', 'location',
  'device', 'specimen', 'account', 'business', 'organization', 'department', 'unit', 'study', 'procedure', 'form', 'file',
  'document', 'family', 'relative', 'sibling', 'brother', 'sister', 'son', 'daughter', 'husband', 'wife', 'partner', 'donor',
  'witness', 'interpreter', 'nurse', 'therapist', 'pcp', 'consultant', 'surgeon', 'anesthesiologist', 'radiologist', 'resident',
  'fellow', 'assistant', 'scribe', 'representative', 'agent', 'proxy', 'payer', 'payor', 'insurance', 'carrier', 'member',
]);

/**
 * Of those, the words that name a place or a thing, not a person ("Location:", "Department:", "Test Name:"): such a label
 * is not a patient field, but the rest of its line may still be the patient's (review 2026-10-09: "Department: X
 * Patient: Y" read Y as nobody's).
 */
const THING_WORDS = new Set([
  'facility', 'pharmacy', 'test', 'drug', 'medication', 'product', 'school', 'clinic', 'hospital', 'practice', 'lab', 'laboratory',
  'company', 'location', 'device', 'specimen', 'business', 'organization', 'department', 'unit', 'study', 'procedure', 'form',
  'file', 'document',
]);

function someoneElsesWord(w: string): boolean {
  return OTHER_PERSON.has(w) && !THING_WORDS.has(w);
}

/** Lower-case words a printed surname may carry ("de la Cruz", "van der Berg"). */
const NAME_PARTICLES = new Set(['de', 'del', 'della', 'der', 'den', 'di', 'da', 'dos', 'das', 'du', 'la', 'le', 'van', 'von', 'bin', 'ibn', 'al', 'el', 'ter', 'ten', 'y']);

/**
 * A name in a patient field is printed with capitals ("EXAMPLE, PAT", "Pat Example", "d'Angelo"); a value in lower case
 * is prose ("Patient: doing well post op"), never read from the page as someone's name (review 2026-10-09). Claude's
 * sorting reading is taken as it gives it.
 */
export function printedAsName(printed: string): boolean {
  const ws = printed
    .split(/[\s,^]+/)
    .map((w) => w.replace(/^[^A-Za-zÀ-ɏ]+|[^A-Za-zÀ-ɏ]+$/g, ''))
    .filter(Boolean);
  return ws.length > 0 && ws.every((w) => /[A-ZÀ-ÖØ-Þ]/.test(w) || NAME_PARTICLES.has(w.toLowerCase()));
}

/** A heading that opens someone else's block (until the next heading). */
const OTHER_SECTION = /^(?:guarantor|emergency\s+contacts?|contacts?|next\s+of\s+kin|family\s+(?:medical\s+)?history|family|insurance|coverage|subscriber|insured|policy\s*holder|care\s+team|providers?|treatment\s+team|referring|cc|copies\s+to|signed|electronically\s+signed|authori[sz]ed|responsible\s+party|parent|guardian|mother|father|spouse|social\s+history|relationships?)\b/i;
/** A heading that opens the patient's own block. */
const PATIENT_SECTION = /^(?:patient(?:\s+(?:information|demographics|details|identification|info))?|demographics|identification)$/i;
/** Lines that only ever name someone else. */
const SKIP_LINE = /^\s*(?:b?cc)\s*:|\b(?:electronically\s+)?(?:signed|dictated|transcribed|authenticated|reviewed|verified|performed|ordered|resulted|collected|entered|cosigned|co-signed|attested|released|approved|read)\s+by\b|\belectronically\s+signed\b/i;

/** How many lines someone else's block lasts at most (a guarantor or contact block is a few lines). */
const OTHER_BLOCK_LINES = 12;

function headingOf(line: string): string | null {
  const t = line.replace(/\s*\|\s*/g, ' ').trim().replace(/:$/, '').trim();
  // A name printed in capitals ("EXAMPLE, PAT") is never a heading.
  if (!t || t.length > 40 || /\d/.test(t) || t.includes(':') || t.includes(',') || t.split(/\s+/).length > 4) return null;
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length < 2) return null;
  const allCaps = letters === letters.toUpperCase() && letters.length >= 4;
  if (allCaps || line.trim().endsWith(':') || OTHER_SECTION.test(t) || PATIENT_SECTION.test(t)) return t;
  return null;
}

/** The Epic running header's patient line: "MRN: 1234567, DOB: 1/2/1970, Legal Sex: X". */
const EPIC_BANNER = /\bMRN:\s*[\w-]+,\s*DOB:\s*\d{1,2}\/\d{1,2}\/\d{2,4},\s*(?:Legal\s+)?Sex:/i;
/** "Last, First Middle" as the Epic header prints the patient's name. */
const LAST_FIRST = /^[A-Za-zÀ-ɏ'’-]+(?:\s[A-Za-zÀ-ɏ'’-]+){0,3},\s*[A-Za-zÀ-ɏ'’-]+(?:\s[A-Za-zÀ-ɏ.'’-]+){0,3}$/;

function cellsOf(line: string): string[] {
  return line.split(/\s+\|\s+|\t+|\s{3,}/).map((c) => c.trim()).filter(Boolean);
}

/** The value of a label: the rest of its cell up to the next label; when that is empty, the next cell or line. */
function valueAt(cells: string[], ci: number, labels: Label[], li: number, next: () => string | null): string {
  const cell = cells[ci];
  const own = cell.slice(labels[li].end, li + 1 < labels.length ? labels[li + 1].start : undefined).trim().replace(/^[:#\s]+/, '');
  if (own) return own;
  if (li + 1 < labels.length) return '';
  const after = ci + 1 < cells.length ? cells[ci + 1] : next();
  if (!after) return '';
  const lab = labelsIn(after);
  if (lab.length && lab[0].start === 0) return '';
  return lab.length ? after.slice(0, lab[0].start).trim() : after.trim();
}

function shortValue(v: string): string {
  return v.replace(/\s+/g, ' ').trim().replace(/[,;.]+$/, '').slice(0, 80);
}

/**
 * The labelled patient fields of one page (no AI). Someone else's blocks and lines are skipped; a weak name label
 * ("Name:", "Re:") counts only with a date of birth on the same line or the line before or after it.
 */
export function findIdentities(page: PageLines): FoundField[] {
  const out: FoundField[] = [];
  const lines = page.lines.map((l) => l ?? '');
  const lineLabels = lines.map((l) => cellsOf(l).map(labelsIn));
  const hasDob = (i: number) => i >= 0 && i < lines.length && lineLabels[i].some((ls) => ls.some((x) => x.kind === 'dob'));
  /** Someone else's block: from its heading for at most OTHER_BLOCK_LINES lines, or to the next heading. */
  let otherUntil = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = headingOf(line);
    if (heading) otherUntil = OTHER_SECTION.test(heading) && !PATIENT_SECTION.test(heading) ? i + OTHER_BLOCK_LINES : -1;
    const other = i <= otherUntil;
    if (SKIP_LINE.test(line)) continue;
    const cells = cellsOf(line);
    // The Epic running header: the name is the last cell of the row above (or the nearest "Last, First" line above).
    if (EPIC_BANNER.test(line)) {
      for (let k = i - 1; k >= Math.max(0, i - 3); k--) {
        const above = cellsOf(lines[k]);
        const cand = above[above.length - 1] ?? '';
        if (LAST_FIRST.test(cand)) {
          out.push({ page: page.page, kind: 'name', value: shortValue(cand), source: 'banner' });
          break;
        }
      }
    }
    if (other) continue;
    // From someone else's label on ("Guarantor:", "Guarantor Name:", "Mother:"), the rest of the line is theirs.
    let theirs = false;
    for (let ci = 0; ci < cells.length && !theirs; ci++) {
      const labels = lineLabels[i][ci];
      for (let li = 0; li < labels.length && !theirs; li++) {
        const lab = labels[li];
        if (lab.kind === 'other') {
          if (lab.word.split(' ').some(someoneElsesWord)) theirs = true;
          continue;
        }
        // "Guarantor Name:", "Mother's DOB:": the rest of the line is theirs.
        const before = normalizeKey(cells[ci].slice(Math.max(0, lab.start - 40), lab.start)).split(' ').slice(-3);
        if (before.some(someoneElsesWord)) {
          theirs = true;
          continue;
        }
        // "Test Name:", "Facility Name:" (one space apart): only this label is not his. A place printed before the label and
        // set apart from it ("Location: Clinic B  Patient:") is not part of it (review 2026-10-09).
        const lead = cells[ci].slice(Math.max(0, lab.start - 40), lab.start).match(/((?:[A-Za-zÀ-ɏ'’.-]+ ){1,3})$/);
        if (lead && normalizeKey(lead[1]).split(' ').some((w) => THING_WORDS.has(w))) continue;
        if (lab.kind === 'name' && lab.weak && !(hasDob(i) || hasDob(i + 1) || hasDob(i - 1))) continue;
        // A weak label followed by another name label on the same line ("RE: Records Request for: Pat Example DOB …"): the
        // later one is the patient; the words after "RE:" are the subject.
        if (lab.kind === 'name' && lab.weak && (labels.slice(li + 1).some((x) => x.kind === 'name') || lineLabels[i].slice(ci + 1).some((ls) => ls.some((x) => x.kind === 'name')))) continue;
        const value = shortValue(valueAt(cells, ci, labels, li, () => (i + 1 < lines.length ? (cellsOf(lines[i + 1])[0] ?? null) : null)));
        if (!value) continue;
        if (lab.kind === 'name') {
          const parsed = parsePersonName(value);
          if (!parsed || !printedAsName(parsed.printed)) continue;
        }
        if (lab.kind === 'dob' && !parseDob(value)) continue;
        if (lab.kind === 'mrn') {
          const key = numberKey(value.split(/\s/)[0] ?? '');
          if (key.length < 4 || (key.match(/\d/g) ?? []).length < 3) continue;
          out.push({ page: page.page, kind: 'mrn', value: value.split(/\s/)[0].replace(/[,;.]+$/, ''), source: 'label' });
          continue;
        }
        out.push({ page: page.page, kind: lab.kind, value, source: 'label' });
      }
    }
  }
  // One of each value per page.
  const seen = new Set<string>();
  return out.filter((f) => {
    const k = `${f.kind}:${f.kind === 'mrn' ? numberKey(f.value) : f.kind === 'dob' ? JSON.stringify(parseDob(f.value)) : normalizeKey(f.value)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Judging
// ---------------------------------------------------------------------------

export type IdentityReason = 'first_name' | 'surname' | 'dob' | 'mrn' | 'confused_with';

export interface FieldJudgement {
  reasons: IdentityReason[];
  /** The name of someone often confused with the patient, as he typed it, when the page names them. */
  confusedWith: string | null;
  /** A full first name of the user's (and his surname, when printed), or one of his record numbers. */
  confirms: boolean;
  /** Consistent but not confirming. */
  weak: 'initial_only' | 'dob_only' | null;
  /** A record number from a health system not on the patient's list (offered after "It's mine"). */
  newNumber: boolean;
}

function firstMatches(r: { first: string; firstPart: string }, me: MyIdentity): boolean {
  return me.firstNames.includes(r.first) || (r.firstPart.length >= 2 && me.firstNames.includes(r.firstPart));
}

/**
 * One letter added, dropped, changed or two swapped, in words of five letters or more: how a scan misreads a surname
 * ("EXAMPIE" for "EXAMPLE"). Never used for first names: a twin's can differ by one letter.
 */
export function oneLetterApart(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

function surnameMatches(surname: string[], me: MyIdentity): boolean {
  if (!surname.length || !me.surnames.length) return true;
  return surname.some((w) => w.length >= 2 && me.surnames.some((s) => oneLetterApart(s, w)));
}

function judgeNameReading(r: { first: string; firstIsInitial: boolean; firstPart: string; surname: string[] }, me: MyIdentity): FieldJudgement {
  const base: FieldJudgement = { reasons: [], confusedWith: null, confirms: false, weak: null, newNumber: false };
  const twin = r.firstIsInitial ? undefined : me.confusedWith.find((c) => c.key === r.first || c.key === r.firstPart);
  if (twin) return { ...base, reasons: ['confused_with'], confusedWith: twin.label };
  const surnameOk = surnameMatches(r.surname, me);
  if (r.firstIsInitial) {
    const ok = me.firstNames.some((f) => f[0] === r.first);
    if (!ok) return { ...base, reasons: surnameOk ? ['first_name'] : ['first_name', 'surname'] };
    return surnameOk ? { ...base, weak: 'initial_only' } : { ...base, reasons: ['surname'] };
  }
  if (!firstMatches(r, me)) return { ...base, reasons: surnameOk ? ['first_name'] : ['first_name', 'surname'] };
  return surnameOk ? { ...base, confirms: true } : { ...base, reasons: ['surname'] };
}

/** One printed name against the user's. A name printed surname first without a comma is read both ways; the kinder reading wins. */
export function judgeName(value: string, me: MyIdentity): FieldJudgement | null {
  const p = parsePersonName(value);
  if (!p) return null;
  const a = judgeNameReading(p, me);
  if (!a.reasons.length || !p.reversed) return a;
  const b = judgeNameReading(p.reversed, me);
  // The reading as printed holds unless the other one is clean (a twin's name is never excused this way); a twin's
  // name in either reading is said as such.
  if (a.reasons.includes('confused_with')) return a;
  if (!b.reasons.length || b.reasons.includes('confused_with')) return b;
  return a;
}

export function judgeField(f: Pick<FoundField, 'kind' | 'value'>, me: MyIdentity, system: string | null): FieldJudgement | null {
  const none: FieldJudgement = { reasons: [], confusedWith: null, confirms: false, weak: null, newNumber: false };
  if (f.kind === 'name') return judgeName(f.value, me);
  if (f.kind === 'dob') {
    const dob = parseDob(f.value);
    if (!dob || !me.dob) return null;
    return sameDob(dob, me.dob) || sameDobDayFirst(dob, me.dob) ? { ...none, weak: 'dob_only' } : { ...none, reasons: ['dob'] };
  }
  // A number printed with its first digits hidden ("****4567", "XXX-XX-4567", as portals print it): its visible end is
  // compared with the end of the patient's numbers; it never confirms and is never offered for his list (review 2026-10-09).
  const masked = maskedTail(f.value);
  if (masked !== null) {
    if (masked.length < 3) return null;
    if (me.numbers.some((n) => n.key.endsWith(masked))) return none;
    if (system && me.numbers.some((n) => n.system && sameSystem(n.system, system))) return { ...none, reasons: ['mrn'] };
    return none;
  }
  const key = numberKey(f.value);
  if (key.length < 3) return null;
  if (me.numbers.some((n) => n.key === key)) return { ...none, confirms: true };
  if (system && me.numbers.some((n) => n.system && sameSystem(n.system, system))) return { ...none, reasons: ['mrn'] };
  return { ...none, newNumber: true };
}

/** What one page holds, judged. */
export interface PageFinding {
  page: number;
  name: string | null;
  dob: string | null;
  mrn: string | null;
  reasons: IdentityReason[];
  confusedWith: string | null;
  confirms: boolean;
  weak: Array<'initial_only' | 'dob_only'>;
  newNumbers: string[];
  source: FoundField['source'];
}

export function judgePage(page: number, fields: readonly FoundField[], me: MyIdentity, system: string | null): PageFinding | null {
  if (!fields.length) return null;
  const out: PageFinding = { page, name: null, dob: null, mrn: null, reasons: [], confusedWith: null, confirms: false, weak: [], newNumbers: [], source: fields[0].source };
  for (const f of fields) {
    const j = judgeField(f, me, system);
    const slot = f.kind === 'name' ? 'name' : f.kind === 'dob' ? 'dob' : 'mrn';
    // The value shown is the one that conflicts, else the first one found.
    if (j?.reasons.length || out[slot] === null) out[slot] = f.value;
    if (!j) continue;
    for (const r of j.reasons) if (!out.reasons.includes(r)) out.reasons.push(r);
    if (j.confusedWith) out.confusedWith = j.confusedWith;
    if (j.confirms) out.confirms = true;
    if (j.weak && !out.weak.includes(j.weak)) out.weak.push(j.weak);
    if (j.newNumber) out.newNumbers.push(f.value);
  }
  return out;
}

export type CheckResult = 'confirmed' | 'unconfirmed' | 'conflict';
export type UnconfirmedWhy = 'no_details' | 'no_identity' | 'initial_only' | 'dob_only' | 'number_only';

export interface DocumentVerdict {
  result: CheckResult;
  why: UnconfirmedWhy | null;
  pagesScanned: number;
  /** Pages whose printed patient is someone else, in order. */
  conflictPages: number[];
  /** The first conflicting pages, judged (at most 12). */
  conflicts: PageFinding[];
  /** Pages that confirm the patient (at most 12). */
  confirmedPages: number[];
  /** Fields found in all. */
  seen: number;
  /** Record numbers printed on it from health systems not on the patient's list (at most 5). */
  newNumbers: Array<{ number: string; page: number }>;
}

/** Every page judged; nothing can be compared until Patient details hold a name and a date of birth. */
export function judgeDocument(pages: Iterable<PageLines>, me: MyIdentity, system: string | null): DocumentVerdict {
  const v: DocumentVerdict = { result: 'unconfirmed', why: null, pagesScanned: 0, conflictPages: [], conflicts: [], confirmedPages: [], seen: 0, newNumbers: [] };
  if (me.missing.length) {
    v.why = 'no_details';
    return v;
  }
  const weak = new Set<string>();
  let numbersOnly = false;
  for (const p of pages) {
    v.pagesScanned++;
    const fields = findIdentities(p);
    v.seen += fields.length;
    const f = judgePage(p.page, fields, me, system);
    if (!f) continue;
    if (f.reasons.length) {
      v.conflictPages.push(p.page);
      if (v.conflicts.length < 12) v.conflicts.push(f);
    } else if (f.confirms) {
      if (v.confirmedPages.length < 12) v.confirmedPages.push(p.page);
    }
    for (const w of f.weak) weak.add(w);
    if (f.newNumbers.length && !f.name && !f.dob) numbersOnly = true;
    // A number printed on a page that names someone else is theirs: never offered for the patient's list.
    if (!f.reasons.length) for (const n of f.newNumbers) if (v.newNumbers.length < 5 && !v.newNumbers.some((x) => numberKey(x.number) === numberKey(n))) v.newNumbers.push({ number: n, page: p.page });
  }
  if (v.conflictPages.length) v.result = 'conflict';
  else if (v.confirmedPages.length) v.result = 'confirmed';
  else v.why = weak.has('initial_only') ? 'initial_only' : weak.has('dob_only') ? 'dob_only' : numbersOnly || v.newNumbers.length ? 'number_only' : 'no_identity';
  return v;
}

// ---------------------------------------------------------------------------
// What is stored on the document (metadata_json.patientCheck)
// ---------------------------------------------------------------------------

export type PatientCheckState = 'clear' | 'quarantined' | 'mine' | 'not_mine';
export type PatientCheckTrigger = 'ingest' | 'segmentation' | 'unlock' | 'details' | 'sorting' | 'user';

/** Claude's sorting step's reading of the patient: a second opinion, kept with its quote and whether it was found. */
export interface SortingOpinion {
  at: string;
  name: string | null;
  dob: string | null;
  mrn: string | null;
  page: number | null;
  quote: string | null;
  verified: boolean;
  reasons: IdentityReason[];
  confusedWith: string | null;
  confirms: boolean;
}

export interface PatientCheck {
  v: number;
  at: string;
  by: PatientCheckTrigger;
  /** identitySignature of the Patient details it was judged against. */
  details: string;
  result: CheckResult;
  why: UnconfirmedWhy | null;
  pagesScanned: number;
  conflictPages: number[];
  conflicts: PageFinding[];
  confirmedPages: number[];
  newNumbers: Array<{ number: string; page: number }>;
  /** The health system the document comes from, when known (for record numbers). */
  system: string | null;
  sorting: SortingOpinion | null;
  state: PatientCheckState;
  /** Found by a sweep of documents already in the case that would have held back most of them: not held (see the sweep). */
  unheld?: boolean;
  /** While held back: when, by what, the pages, and what the upload was going to do next. */
  quarantine: { at: string; by: PatientCheckTrigger; pages: number[]; resume: { sort: boolean; read: boolean } } | null;
  /** The user's answer. */
  decision: { kind: 'mine' | 'not_mine'; at: string; by: string | null; pages: number[] } | null;
  /**
   * What Claude had placed from it (medications, visits, calls), taken back when it was held back or said not to be
   * The user's; `kept`: allergies and items the user worked on since, which stay (review 2026-10-09).
   */
  takenBack?: { filingIds: string[]; kept: number };
  /**
   * The patient's own notes (a document of the patient tier; My notes, 2026-10-09): notes rarely print a patient's name, so
   * "Patient not confirmed on document" is never said of them. Set when the check is read for display, never stored.
   */
  ownNotes?: boolean;
}

/** metadata_json.patientCheck read without throwing; null when the document was never checked. */
export function readPatientCheck(meta: unknown): PatientCheck | null {
  const raw = meta && typeof meta === 'object' ? (meta as Record<string, unknown>).patientCheck : undefined;
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Partial<PatientCheck>;
  if (typeof c.state !== 'string' || typeof c.result !== 'string') return null;
  return {
    v: Number(c.v) || 0,
    at: String(c.at ?? ''),
    by: (c.by ?? 'ingest') as PatientCheckTrigger,
    details: String(c.details ?? ''),
    result: c.result as CheckResult,
    why: (c.why ?? null) as UnconfirmedWhy | null,
    pagesScanned: Number(c.pagesScanned) || 0,
    conflictPages: Array.isArray(c.conflictPages) ? c.conflictPages.filter((n) => Number.isInteger(n)) : [],
    conflicts: Array.isArray(c.conflicts) ? c.conflicts : [],
    confirmedPages: Array.isArray(c.confirmedPages) ? c.confirmedPages : [],
    newNumbers: Array.isArray(c.newNumbers) ? c.newNumbers : [],
    system: typeof c.system === 'string' ? c.system : null,
    sorting: c.sorting && typeof c.sorting === 'object' ? c.sorting : null,
    state: c.state as PatientCheckState,
    ...(c.unheld ? { unheld: true } : {}),
    quarantine: c.quarantine && typeof c.quarantine === 'object' ? c.quarantine : null,
    decision: c.decision && typeof c.decision === 'object' ? c.decision : null,
    ...(c.takenBack && typeof c.takenBack === 'object' && Array.isArray(c.takenBack.filingIds)
      ? { takenBack: { filingIds: c.takenBack.filingIds.filter((x): x is string => typeof x === 'string'), kept: Number(c.takenBack.kept) || 0 } }
      : {}),
  };
}

/** The same from a metadata_json string. */
export function patientCheckOf(metadataJson: string | null | undefined): PatientCheck | null {
  if (!metadataJson || !metadataJson.includes('"patientCheck"')) return null;
  try {
    return readPatientCheck(JSON.parse(metadataJson));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** [3,4,5,9] -> "p.3-5 and p.9"; more than four runs end "and N more pages". */
export function pagesWords(pages: readonly number[]): string {
  const sorted = [...new Set(pages)].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
  const runs: Array<[number, number]> = [];
  for (const n of sorted) {
    const last = runs[runs.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  const shown = runs.slice(0, 4).map(([a, b]) => (a === b ? `p.${a}` : `p.${a}-${b}`));
  const rest = runs.slice(4).reduce((n, [a, b]) => n + (b - a + 1), 0);
  if (rest) shown.push(`${rest} more page${rest === 1 ? '' : 's'}`);
  return shown.length <= 1 ? (shown[0] ?? '') : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

const REASON_WORDS: Record<IdentityReason, string> = {
  first_name: 'another first name',
  surname: 'another surname',
  dob: 'another date of birth',
  mrn: 'another record number from the same place',
  confused_with: 'the name of someone often confused with you',
};

/** "p.212-219 look like someone else's: another first name." (or "This looks like Lee's record ...") */
export function heldWords(c: Pick<PatientCheck, 'conflictPages' | 'conflicts' | 'sorting'>): string {
  const reasons = new Set<IdentityReason>();
  let twin: string | null = null;
  for (const f of c.conflicts) {
    for (const r of f.reasons) reasons.add(r);
    if (f.confusedWith) twin = f.confusedWith;
  }
  const pages = [...c.conflictPages];
  if (c.sorting && c.sorting.verified && c.sorting.reasons.length) {
    for (const r of c.sorting.reasons) reasons.add(r);
    if (c.sorting.confusedWith) twin = c.sorting.confusedWith;
    if (c.sorting.page && !pages.includes(c.sorting.page)) pages.push(c.sorting.page);
  }
  const why = [...reasons].filter((r) => r !== 'confused_with').map((r) => REASON_WORDS[r]);
  const where = pages.length ? `${pagesWords(pages)} ${pages.length === 1 ? 'looks' : 'look'} like someone else's` : "Claude's sorting read someone else's name";
  const lead = twin ? `This looks like ${twin}'s record. ` : '';
  return `${lead}${where}${why.length ? `: ${why.join(', ')}` : ''}.`;
}

const WHY_WORDS: Record<UnconfirmedWhy, string> = {
  no_details: 'Add your name and date of birth in Settings, Patient details, so documents can be checked.',
  no_identity: 'No patient name or date of birth is printed on it.',
  initial_only: 'Only a first initial is printed.',
  dob_only: 'Only the date of birth is printed.',
  number_only: 'Only a record number from a place not on your list is printed.',
};

/**
 * One line for the upload record and the document's page. The patient's own notes (`ownNotes`, on the check or given) are
 * never "Patient not confirmed on document": nothing is said of them unless they are held back or someone else's.
 */
export function checkWords(c: PatientCheck | null, opts: { ownNotes?: boolean } = {}): { tone: 'held' | 'mine' | 'not_mine' | 'unconfirmed' | 'confirmed' | null; text: string } {
  if (!c) return { tone: null, text: '' };
  if ((opts.ownNotes || c.ownNotes) && c.state === 'clear' && c.result !== 'confirmed' && !c.unheld) return { tone: null, text: '' };
  if (c.state === 'quarantined') return { tone: 'held', text: `${HELD_WORDS}. ${heldWords(c)}` };
  if (c.state === 'not_mine') return { tone: 'not_mine', text: 'Not my record (wrong patient).' };
  if (c.state === 'mine' && c.decision?.kind === 'mine') return { tone: 'mine', text: 'You said this is yours.' };
  if (c.result === 'confirmed') return { tone: 'confirmed', text: 'Patient confirmed on document: your name is printed on it.' };
  if (c.unheld) return { tone: 'unconfirmed', text: `${NOT_CONFIRMED_WORDS}. ${heldWords(c)}` };
  return { tone: 'unconfirmed', text: `${NOT_CONFIRMED_WORDS}. ${WHY_WORDS[c.why ?? 'no_identity']}` };
}
