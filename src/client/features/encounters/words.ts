/**
 * Appointments in plain words, and the visits already in the documents.
 *
 * A visit note, a hospital discharge summary or a procedure report added on
 * Documents is a past appointment that has not been added yet; the page
 * offers each one with "Add it", which opens Add an appointment filled in from
 * the document (its title, the kind its type implies, its date, marked done,
 * with the document linked). Nothing is added until the user saves. Pure (no
 * React), so it can be tested.
 */

/** The kind of appointment. */
export const ENCOUNTER_KIND_WORDS: Record<string, string> = {
  visit: 'Visit',
  telehealth: 'Video or phone visit',
  procedure: 'Procedure',
  admission: 'Hospital stay',
  test: 'Test',
  infusion: 'Infusion',
  other: 'Other',
};
export function encounterKindWords(k: string | null | undefined): string {
  return (k && ENCOUNTER_KIND_WORDS[k]) || (k ?? '').replace(/_/g, ' ');
}

/** Where it stands. */
export const ENCOUNTER_STATUS_WORDS: Record<string, string> = { upcoming: 'coming up', completed: 'done', cancelled: 'cancelled' };
export const ENCOUNTER_STATUS_TONE: Record<string, 'warn' | 'ok' | 'ash' | 'info'> = { upcoming: 'info', completed: 'ok', cancelled: 'ash' };
export function encounterStatusWords(s: string | null | undefined): string {
  return (s && ENCOUNTER_STATUS_WORDS[s]) || (s ?? '').replace(/_/g, ' ');
}

/** "today", "tomorrow", "in 14 days", "3 days ago"; null for a date without a day or more than 60 days away (the date says it). */
export function daysFromToday(iso: string | null | undefined, precision: string | null | undefined, today: string): string | null {
  if (!iso || precision !== 'day' || iso.length < 10 || today.length < 10) return null;
  const at = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  const n = Math.round((at(iso) - at(today)) / 86400000);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  if (Math.abs(n) > 60) return null;
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

/** Still marked as coming up though its day has gone by: it needs marking done (or cancelled). */
export function datePassed(e: { status: string; occurredAt: string | null; occurredAtPrecision: string }, today: string): boolean {
  return e.status === 'upcoming' && e.occurredAtPrecision === 'day' && Boolean(e.occurredAt) && (e.occurredAt as string) < today;
}

/** "2 of 5 asked", "3 to ask", "No questions". */
export function questionWords(asked: number, total: number): string {
  if (!total) return 'No questions';
  if (asked === 0) return `${total} to ask`;
  return `${asked} of ${total} asked`;
}

/**
 * Kinds of record in the Records checklist's own words (features/records/words.tsx RECORD_TYPE_WORDS; kept equal by
 * tests/ui-integration-words.test.ts, copied so this file stays free of React).
 */
export const RECORD_TYPE_WORDS: Record<string, string> = {
  clinical_note: 'Clinic note',
  lab: 'Lab report',
  imaging_report: 'Scan report',
  imaging_images: 'Scan images',
  dicom: 'Scan image files',
  pathology: 'Pathology report',
  operative_report: 'Procedure report',
  discharge_summary: 'Discharge summary',
  portal_thread: 'Portal messages',
  billing: 'Bills',
  genetic: 'Genetic test',
  other: 'Other',
};

/** Document types that record a past appointment, and the kind each implies. */
export const VISIT_CATEGORIES: Record<string, string> = { clinical_note: 'visit', discharge_summary: 'admission', operative_report: 'procedure' };

export interface VisitDocLike {
  id: string;
  title: string;
  category: string;
  documentDate: string | null;
}

/** The fields Add an appointment starts with for a document (EncounterDialog `preset`). */
export interface EncounterPreset {
  title: string;
  kind: string;
  status: string;
  occurredAtText: string;
  documentIds: string[];
}

export function encounterPresetFromDocument(d: VisitDocLike, today: string): EncounterPreset {
  const title = d.title.replace(/,\s*(\d{4}(-\d{2}(-\d{2})?)?|[A-Z][a-z]+ \d{4})\s*$/, '').trim() || d.title;
  const past = !d.documentDate || d.documentDate.slice(0, 10) <= today;
  return { title, kind: VISIT_CATEGORIES[d.category] ?? 'visit', status: past ? 'completed' : 'upcoming', occurredAtText: d.documentDate ?? '', documentIds: [d.id] };
}

/** Visit documents not linked to any appointment, newest first. */
export function unlinkedVisitDocuments<D extends VisitDocLike>(docs: readonly D[], encounters: ReadonlyArray<{ documentIds: string[] }>): D[] {
  const linked = new Set(encounters.flatMap((e) => e.documentIds));
  return docs.filter((d) => d.category in VISIT_CATEGORIES && !linked.has(d.id)).sort((a, b) => (b.documentDate ?? '').localeCompare(a.documentDate ?? '') || a.title.localeCompare(b.title));
}
