/**
 * A lab value as read (2026-10, "lab values as printed"), and what the Labs page says about it in plain words.
 *
 * The server sends every value with its reading (LabEntry.reading: src/shared/labvalues.ts compactReading): the value
 * as printed ("<3", "Negative", "0.80"), whether it is a measurement or a limit, its own range as printed with the lab
 * that printed it, the flag exactly as printed, the flag worked out from the value and its own range, the dates kept
 * apart (collected, resulted, received), the warnings, and who gives it (its role):
 *   printed       a lab report (a clinical record): its flag and range are the lab's;
 *   unclassified  a document not sorted yet: its flag and range mark its own value, said neutrally;
 *   claimed       a summary, a letter, your own notes: its flag, range and judgement are that document's claim, never
 *                 red, never counted, never a band (rules 11 and 12);
 *   typed         entered by hand or from a spreadsheet.
 * A value is judged only against its OWN range (rule 8): never the test's, never another lab's. A value that printed no
 * range is never marked.
 *
 * An older payload (or a test fixture) carries no reading: readingOf reads one here from the older fields with the same
 * shared parser, so every screen judges every value the same way.
 *
 * Plain TypeScript (no React, no DOM) so tests can import it directly.
 */
import { buildLabReading, compactReading, type LabReadingView, type ReadingDateKind, type ReadingRole } from '@shared/labvalues';
import type { DatePrecision, PartialDate } from '@shared/dates';

export type { LabReadingView, ReadingRole, ReadingDateKind };

/** The fields an older payload carries; every one optional so lab rows, chart rows, points and summaries pass. */
export interface ReadingSource {
  reading?: LabReadingView | null;
  valueNum?: number | null;
  valueText?: string | null;
  /** LabSeriesRow / OrganisedPoint: the value as shown. */
  value?: string | null;
  unit?: string | null;
  refLow?: number | null;
  refHigh?: number | null;
  refText?: string | null;
  /** LabSeriesRow / OrganisedPoint: the range as shown. */
  ref?: string | null;
  flag?: string | null;
  flagDerived?: boolean | null;
  documentId?: string | null;
  date?: string | null;
  datePrecision?: string | null;
  dateText?: string | null;
  labName?: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const LEGACY = new WeakMap<object, LabReadingView>();

/**
 * The value's reading: the one the server sent, else one read here from the older fields. A flag the older payload
 * marks as worked out (flagDerived) was not printed: it is read as "not recorded" and worked out again from the range.
 * Without a document the value is yours (typed); with one, or when the payload does not say, the lab's (printed).
 */
export function readingOf(e: ReadingSource): LabReadingView {
  if (e.reading) return e.reading;
  const hit = LEGACY.get(e);
  if (hit) return hit;
  const date: PartialDate | null = str(e.date) ? { iso: e.date!, precision: ((e.datePrecision as DatePrecision | null) ?? 'day') as DatePrecision, text: e.dateText ?? null } : null;
  const role: ReadingRole = e.documentId === null ? 'typed' : 'printed';
  const r = buildLabReading({
    // A chart or list row's `value` is the value as shown; a stored entry has only valueText.
    value: { shown: str(e.value) ?? str(e.valueText), raw: null, storedNumber: typeof e.valueNum === 'number' && Number.isFinite(e.valueNum) ? e.valueNum : null, userEdited: false },
    unit: { shown: str(e.unit), raw: null },
    range: { shown: str(e.ref) ?? str(e.refText), raw: null, storedLow: e.refLow ?? null, storedHigh: e.refHigh ?? null },
    flag: { shown: e.flagDerived ? null : str(e.flag), raw: null },
    quote: null,
    role,
    dates: { collected: null, resulted: null, unknownKind: date, document: null },
    labName: str(e.labName),
    claim: null,
  });
  const view = compactReading(r);
  LEGACY.set(e, view);
  return view;
}

// ---------------------------------------------------------------------------
// Words for the value's detail (LabDetail key facts)
// ---------------------------------------------------------------------------

/** "Flag on the report" / "Flag on this document" / "Flag in this document" / "Flag you entered". */
export function flagLabel(role: ReadingRole): string {
  switch (role) {
    case 'printed':
      return 'Flag on the report';
    case 'unclassified':
      return 'Flag on this document';
    case 'claimed':
      return 'Flag in this document';
    default:
      return 'Flag you entered';
  }
}

/** The flag as printed, in words: "H", "HH (critical)", "None printed", "Not recorded", "\"Pos\" (not understood)". */
export function flagWords(v: LabReadingView): string {
  if (v.role === 'typed') {
    if (v.flagState === 'no_flag_printed') return 'None printed';
    if (v.flagState === 'not_recorded') return 'Not entered';
  }
  return v.flagShown;
}

/** The muted line under a claimed flag. */
export const CLAIM_FLAG_NOTE = "this document's claim, not the lab's";

export interface ByRange {
  /** high, low, in range, or null when it cannot be said. */
  verdict: 'H' | 'L' | 'N' | null;
  /** "High: above 98–108 mmol/L" / "In range" / "Cannot tell: below 3 could be above or below 2" / "No range printed with this value". */
  words: string;
}

/** The value against its own range, worked out by the app ("By its range"). A summary's own range is said as its claim. */
export function byRangeWords(v: LabReadingView): ByRange {
  const range = v.computedAgainst ?? v.rangeShown;
  const unit = rangeUnitSuffix(v, range);
  const claim = v.role === 'claimed' ? ', by the range this document gives' : '';
  // "above 98-108 mmol/L"; a one-sided range reads "above the limit <50 pg/mL", never "above <50"; a bound from a stored
  // number already says so ("above upper limit 50 mmol/L", never "the limit upper limit 50").
  const what = v.rangeKind === 'interval' || /^(?:upper|lower) limit\b/.test(range ?? '') ? `${range}${unit}` : `the limit ${range}${unit}`;
  if (v.computed === 'H') return { verdict: 'H', words: `High: above ${what}${claim}` };
  if (v.computed === 'L') return { verdict: 'L', words: `Low: below ${what}${claim}` };
  if (v.computed === 'N') return { verdict: 'N', words: `In range${claim ? `${claim} (${range}${unit})` : ''}` };
  if (v.rangeStatus === 'none') return { verdict: null, words: 'No range printed with this value' };
  const reason = (v.computedReason ?? '').trim();
  if (!reason) return { verdict: null, words: 'Cannot tell' };
  return { verdict: null, words: `Cannot tell: ${reason}` };
}

/** The value's own range in words for its detail: what it is and whose; null when none is printed (the caller says so). */
export interface RangeFact {
  /** The range as shown, with its unit (data: the mono). */
  shown: string;
  /** Words after it, in the sans ("as given in this document" for a summary's own range). */
  suffix?: string | null;
  /** One muted line: who printed it, or why it is not read as numbers. */
  note: string | null;
}

/**
 * The value's unit after a range shown in words or numbers (" mg/dL"), only when the range itself prints no unit and is
 * read as numbers: a range printed in its own unit ("0.15-0.45 g/L") is never relabelled with the value's (rule 5), and
 * a range kept as printed ("see comment") gets no unit.
 */
export function rangeUnitSuffix(v: Pick<LabReadingView, 'unit' | 'rangeStatus' | 'rangeKind' | 'rangeUnit'>, range: string | null | undefined): string {
  if (!v.unit || !range || v.rangeStatus !== 'parsed' || v.rangeKind === 'text' || v.rangeUnit) return '';
  return range.toLowerCase().includes(v.unit.toLowerCase()) ? '' : ` ${v.unit}`;
}

export function rangeFact(v: LabReadingView): RangeFact | null {
  if (v.rangeStatus === 'none' || !v.rangeShown) return null;
  const shown = `${v.rangeShown}${rangeUnitSuffix(v, v.rangeShown)}`;
  if (v.role === 'claimed') return { shown, suffix: 'as given in this document', note: "not the lab's range" };
  const notes: string[] = [];
  // The range already reads "(not read as numbers)": the note says why, once.
  if (v.rangeStatus === 'unparsed') notes.push(v.rangeReason ?? 'kept as printed');
  if (v.role === 'typed') notes.push(v.rangeFromNumbersOnly ? 'entered as numbers' : 'entered with the value');
  else if (v.rangeFromNumbersOnly) notes.push('only the numbers are on record, not the range as printed');
  else if (v.role === 'unclassified') notes.push(v.lab ? `printed in this document by ${v.lab}` : 'printed in this document; lab not named');
  else notes.push(v.lab ? `printed by ${v.lab}` : 'lab not named');
  return { shown, note: notes.join('; ') };
}

/** "A limit, not a measurement: the test reads below 3." Null for anything that is not a limit. */
export function limitLine(v: LabReadingView): string | null {
  if (v.kind !== 'censored' || !v.limit) return null;
  return `A limit, not a measurement: the test reads ${v.limit}.`;
}

/** What the value is, when that needs saying: a limit, only a number on record, your own value over what was printed. */
export function valueNotes(v: LabReadingView): string[] {
  const out: string[] = [];
  const limit = limitLine(v);
  if (limit) out.push(limit);
  if (v.kind === 'range') out.push('Printed as a range of values, not one measurement.');
  if (v.valueFrom === 'number_only') out.push('Only the number is on record, not the text as printed.');
  if (v.valueFrom === 'quote') out.push(v.valueReadAs ? `Read from the page itself, which prints the sign; Claude read it as "${v.valueReadAs.trim()}".` : 'Read from the page itself, which prints the sign.');
  return out;
}

/**
 * Your own value (typed, or changed by hand) over a different text as printed: "As printed: …". Never for a value the
 * app read (its text as printed is the value itself, or the page's own text when the page's sign was followed: never
 * Claude's transcription called "printed").
 */
export function asPrinted(v: LabReadingView): string | null {
  if (v.valueFrom !== 'user') return null;
  return v.valueRaw && v.valueRaw.trim() !== v.valueShown.trim() ? v.valueRaw.trim() : null;
}

/** The value fact's label: "Your value" when you changed what was printed, else "Value". */
export function valueLabel(v: LabReadingView): string {
  return v.valueFrom === 'user' && asPrinted(v) ? 'Your value' : 'Value';
}

/** The muted line under a date whose kind the document does not say. */
export const DATE_KIND_UNKNOWN = 'The document does not say whether this is when the sample was taken or when the result came back.';

/** The date rows of a value's detail: Collected / Resulted / Received, or "Date" with the muted line when its kind is not printed. */
export interface DateFact {
  label: 'Collected' | 'Resulted' | 'Received' | 'Date';
  date: PartialDate;
  note: string | null;
}

export function dateFacts(v: LabReadingView, fallback?: PartialDate | null): DateFact[] {
  const out: DateFact[] = [];
  if (v.collected?.iso || v.collected?.text) out.push({ label: 'Collected', date: v.collected, note: null });
  else if (v.dateKind === 'unknown' && fallback && (fallback.iso || fallback.text)) out.push({ label: 'Date', date: fallback, note: DATE_KIND_UNKNOWN });
  if (v.resulted?.iso || v.resulted?.text) out.push({ label: 'Resulted', date: v.resulted, note: out.length ? null : 'No collection date is printed.' });
  if (v.received?.iso || v.received?.text) out.push({ label: 'Received', date: v.received, note: 'When the lab received the sample; never used as the date of the value.' });
  return out;
}

/** "Collected", "Resulted" or "Date": a list's or a pane's one date label, never a sentence on every row (E4). */
export function dateLabel(kind: ReadingDateKind | null | undefined): string {
  return kind === 'collected' ? 'Collected' : kind === 'resulted' ? 'Resulted' : 'Date';
}
