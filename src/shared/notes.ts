/**
 * My notes and the reconciler in two stages (2026-10-09): a tab for subjective information only, and a reconciler
 * for records against records, then records against the patient's own notes once the records agree (medication
 * timelines above all).
 *
 * The shapes the server (services/notes.ts, services/med-timeline.ts, routes/notes.ts) returns and the client renders,
 * and the pure rules of the medication timeline, so they can be tested without a database:
 *
 * - A drug's timeline is drawn from its medication details, one LANE per source: each clinical record and each of
 *   the patient's own notes, with the start, stop and dose each states, as stated (a start only when one is written).
 * - Stage 1, "Records vs records": two records that give a different start (or stop, or a different dose for the same
 *   day) disagree. The user settles it: "This record is right" (on one), "Both happened" (two courses, two doses), or
 *   "This record is wrong" (on one). Nothing else changes a record.
 * - Stage 2, "Records vs my notes": once no records-vs-records disagreement is open for a drug, each start, stop and
 *   dose his notes give is set against the records' settled timeline: agrees, differs, or nothing to compare. He
 *   answers a difference: "My notes are right" (his version wins on the timeline, marked "per my notes"; the record
 *   stays as written and is marked), "The records are right", "Both are true" (his version is added beside the
 *   record's, as another course or dose), or "Not the same thing" (left out of the comparison).
 * - The settled timeline (records' settled values, his answers applied) is what Medications and its history chart show
 *   for a drug he answered, each value with who said it; nothing is written over a record or the medication row.
 *
 * Answers live on the details themselves (`attributes_json._timeline`, private keys), so they follow the detail and
 * are reversible; the status, note and fields of a detail are never touched. Pure: no database, no Node APIs.
 */
import { datesAgree, formatPartialDate } from './dates';

// ---------------------------------------------------------------------------
// Words and enums
// ---------------------------------------------------------------------------

/** The views of the My notes page. */
export const NOTE_VIEWS = ['notes', 'meds', 'symptoms', 'events'] as const;
export type NoteView = (typeof NOTE_VIEWS)[number];
export const NOTE_VIEW_WORDS: Record<NoteView, string> = { notes: 'All notes', meds: 'Medications', symptoms: 'Symptoms and effects', events: 'Events' };

/** How an entry from the patient's notes stands against the records. */
export const STANDINGS = ['agrees', 'differs', 'waiting', 'nothing'] as const;
export type Standing = (typeof STANDINGS)[number];
export const STANDING_WORDS: Record<Standing, string> = {
  agrees: 'agrees',
  differs: 'differs',
  waiting: 'records disagree first',
  nothing: 'nothing to compare',
};

/** Stage 1 answers (on a records-vs-records disagreement). */
export const RECORDS_ANSWERS = ['right', 'both', 'wrong'] as const;
export type RecordsAnswer = (typeof RECORDS_ANSWERS)[number];
export const RECORDS_ANSWER_WORDS: Record<RecordsAnswer, string> = { right: 'This record is right', both: 'Both happened', wrong: 'This record is wrong' };

/** Stage 2 answers (on a records-vs-my-notes difference). */
export const NOTES_ANSWERS = ['notes_right', 'records_right', 'both', 'not_same'] as const;
export type NotesAnswer = (typeof NOTES_ANSWERS)[number];
export const NOTES_ANSWER_WORDS: Record<NotesAnswer, string> = {
  notes_right: 'My notes are right',
  records_right: 'The records are right',
  both: 'Both are true',
  not_same: 'Not the same thing',
};
/** The keys on the Reconciliation page (stage 2). */
export const NOTES_ANSWER_KEYS: Record<NotesAnswer, string> = { notes_right: 'n', records_right: 'r', both: 'b', not_same: 'x' };

export const POINT_KINDS = ['start', 'stop', 'dose'] as const;
export type PointKind = (typeof POINT_KINDS)[number];
export const POINT_KIND_WORDS: Record<PointKind, string> = { start: 'Start', stop: 'Stop', dose: 'Dose' };

export type LaneTier = 'record' | 'note';

/** The words for who said a value: "per my notes", "per <record>". */
export const PER_MY_NOTES = 'per my notes';
/** The clinician's words for the same (rule in the Ask prompt). */
export const PER_PATIENT_NOTES = "per the patient's notes";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One answer as stored in `attributes_json._timeline[kind]` of a detail. */
export interface TimelineAnswer {
  /** Shared by every point one answer wrote ("Both happened" marks a point in each group). */
  id: string;
  stage: 1 | 2;
  answer: RecordsAnswer | NotesAnswer;
  by: string | null;
  at: string;
}

/** A start, stop or dose one source states for a drug. */
export interface TimelinePoint {
  /** `${factId}:${kind}` */
  id: string;
  factId: string;
  kind: PointKind;
  /** The date as stated (partial ISO), or null (a dose with no date is listed, never compared). */
  date: string | null;
  precision: string;
  dateText: string | null;
  /** The dose as stated ("60 mg"), or null. */
  dose: string | null;
  documentId: string;
  documentTitle: string;
  documentDate: string | null;
  tier: LaneTier;
  page: number | null;
  citationId: string | null;
  quote: string | null;
  verified: boolean;
  statement: string;
  answer: TimelineAnswer | null;
}

/** One source's row in a drug's chart. */
export interface TimelineLane {
  documentId: string;
  title: string;
  tier: LaneTier;
  documentDate: string | null;
  points: TimelinePoint[];
}

/** A records-vs-records disagreement on one drug (stage 1). */
export interface RecordsDisagreement {
  /** `${drugKey}|start`, `${drugKey}|stop`, `${drugKey}|dose|${date}` */
  key: string;
  kind: PointKind;
  /** For a dose: the day the doses were given for. */
  date: string | null;
  /** Each version, with the record points that give it. A point the user said is wrong stays in its group, marked. */
  groups: Array<{ says: string; date: string | null; dose: string | null; points: TimelinePoint[] }>;
  /** Waiting for the user. */
  open: boolean;
  /** How it was settled: a record chosen, both happened, or the records he said are wrong left one version. */
  how: 'chosen' | 'both' | 'wrong' | null;
}

/** A value of the settled timeline, with who said it. */
export interface SettledPoint {
  kind: PointKind;
  date: string | null;
  precision: string;
  dateText: string | null;
  dose: string | null;
  by: 'record' | 'notes';
  /** "per my notes", "per Neurology note, 2024-03-02", "per Neurology note and 2 more". */
  who: string;
  factIds: string[];
  documentIds: string[];
  /** When the patient's notes won: what the records said (kept as written). */
  recordsSaid: { date: string | null; dose: string | null; who: string } | null;
  /** The user answered something that made this value (a choice, both, his notes). */
  answered: boolean;
}

/** One start, stop or dose from the patient's notes set against the records (stage 2). */
export interface NotesComparison {
  /** `med:${drugKey}:${factId}:${kind}` */
  key: string;
  point: TimelinePoint;
  standing: Standing;
  /** What the records' settled timeline gives for it ("2024-04-02 per Neurology note"), or null. */
  recordsSay: string | null;
  /** The record points it was compared with (first one opens its page). */
  recordPoints: TimelinePoint[];
  answer: TimelineAnswer | null;
}

export interface DrugTimeline {
  /** The drug key (medicationKey of the name). */
  key: string;
  /** The name most details use. */
  name: string;
  lanes: TimelineLane[];
  disagreements: RecordsDisagreement[];
  /** No records-vs-records disagreement is open: stage 2 may compare his notes. */
  recordsSettled: boolean;
  notes: NotesComparison[];
  settled: { starts: SettledPoint[]; stops: SettledPoint[]; doses: SettledPoint[] };
  /** The user answered something on this drug (stage 1 or 2): Medications shows the settled timeline. */
  answered: boolean;
}

/** A drug in the list of the Medications tab (stage 1). */
export interface DrugSummary {
  key: string;
  name: string;
  records: number;
  notes: number;
  /** Open records-vs-records disagreements. */
  open: number;
  /** Differences with his notes waiting for an answer (only once the records are settled). */
  notesToAnswer: number;
  answered: boolean;
  /** "started 2024-03-02 per Neurology note; stopped ..." */
  settledWords: string;
}

/** A row of stage 2 ("Records vs my notes"): a medication point or another detail compared with the records. */
export interface NotesItem {
  key: string;
  topic: 'medication' | 'lab_result' | 'imaging_result' | 'vital' | 'procedure' | 'event';
  /** The drug or the test, scan, procedure or event. */
  subject: string;
  /** "Start", "Stop", "Dose", "Lab value", ... */
  what: string;
  state: 'answer' | 'waiting' | 'answered';
  standing: Standing;
  notes: { says: string; factId: string; documentId: string | null; documentTitle: string | null; page: number | null; citationId: string | null; quote: string | null; date: string | null; precision: string; dateText: string | null };
  records: { says: string; factId: string | null; documentId: string | null; documentTitle: string | null; page: number | null; citationId: string | null } | null;
  answer: { answer: NotesAnswer; by: string | null; at: string } | null;
  /** For a medication point: the drug's key (opens its timeline). */
  drugKey: string | null;
  /** For another detail: the Reconciliation event it belongs to. */
  eventKey: string | null;
}

export interface NotesCounts {
  /** Stage 1, Medications: open records-vs-records disagreements. */
  medsOpen: number;
  /** Stage 2. */
  toAnswer: number;
  waiting: number;
  answered: number;
}

/** A note on My notes (All notes). */
export interface NoteDocItem {
  id: string;
  title: string;
  date: string | null;
  precision: string;
  dateText: string | null;
  /** Where its date came from (imported notes; null for a note added another way). */
  dateFrom: NoteDateFrom | null;
  format: string | null;
  imported: boolean;
  details: number;
  textStatus: string;
  extractionStatus: string;
  agrees: number;
  differs: number;
  likelyCopyOf: { documentId: string; title: string } | null;
  createdAt: string;
}

export interface NoteEntry {
  factId: string;
  type: string;
  kind: string;
  subject: string;
  statement: string;
  quote: string | null;
  page: number | null;
  citationId: string | null;
  verified: boolean;
  date: string | null;
  precision: string;
  dateText: string | null;
  documentId: string;
  documentTitle: string;
  documentDate: string | null;
  standing: Standing;
  /** One plain line: what the records say, or why there is nothing to compare. */
  standingWhy: string | null;
  /** His answer in words, when he gave one. */
  answer: string | null;
  drugKey: string | null;
  eventKey: string | null;
}

export interface NoteDrugItem {
  key: string;
  name: string;
  entries: number;
  /** "started, stopped, dose, effect, side effects" */
  says: string;
  standing: Standing;
  toAnswer: number;
}

// ---------------------------------------------------------------------------
// Doses
// ---------------------------------------------------------------------------

const UNIT_WORDS: Array<[RegExp, string]> = [
  [/^(mg|milligrams?)$/, 'mg'],
  [/^(mcg|ug|µg|micrograms?)$/, 'mcg'],
  [/^(g|grams?|gm)$/, 'g'],
  [/^(ml|milliliters?|millilitres?|cc)$/, 'ml'],
  [/^(units?|u|iu)$/, 'unit'],
  [/^(tabs?|tablets?|pills?)$/, 'tablet'],
  [/^(caps?|capsules?)$/, 'capsule'],
  [/^(drops?|gtts?)$/, 'drop'],
  [/^(puffs?)$/, 'puff'],
  [/^(mg\/kg)$/, 'mg/kg'],
  [/^(mg\/ml)$/, 'mg/ml'],
  [/^(g\/kg)$/, 'g/kg'],
];

/** A dose read into a number and a unit, or null when it does not read as one ("taper", "as directed"). */
export function readDose(dose: string | null | undefined, unit?: string | null): { num: number; unit: string } | null {
  const text = `${dose ?? ''} ${unit && !(dose ?? '').toLowerCase().includes(unit.toLowerCase()) ? unit : ''}`.trim().toLowerCase();
  if (!text) return null;
  const m = /(\d[\d,]*(?:\.\d+)?|\.\d+)\s*([a-zµ]+(?:\/[a-z]+)?)/.exec(text);
  if (!m) return null;
  const num = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(num)) return null;
  const word = m[2];
  for (const [re, u] of UNIT_WORDS) if (re.test(word)) return { num, unit: u };
  return null;
}

/** The dose as shown: the stated dose with its unit when the unit was given apart ("60" + "mg" = "60 mg"). */
export function doseText(dose: string | null | undefined, unit?: string | null): string | null {
  const d = (dose ?? '').trim();
  if (!d) return null;
  const u = (unit ?? '').trim();
  return u && !d.toLowerCase().includes(u.toLowerCase()) ? `${d} ${u}` : d;
}

/** Two doses are the same when they read as the same number and unit, or (neither reads) the same words. */
export function sameDose(a: string | null, b: string | null): boolean {
  const x = readDose(a);
  const y = readDose(b);
  if (x && y) return x.unit === y.unit && Math.abs(x.num - y.num) < 1e-9;
  return (a ?? '').trim().toLowerCase().replace(/\s+/g, ' ') === (b ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Two doses can be compared: both read as a number in one unit. Others ("taper" against "60 mg") are never said to differ. */
export function comparableDoses(a: string | null, b: string | null): boolean {
  const x = readDose(a);
  const y = readDose(b);
  return Boolean(x && y && x.unit === y.unit);
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** Two stated dates are the same at the coarser of their precisions (2024-03 agrees with 2024-03-15). Null never agrees. */
export function sameWhen(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return datesAgree(a, b, 0);
}

function precisionRank(iso: string): number {
  return iso.length;
}

interface Cluster {
  date: string;
  precision: string;
  dateText: string | null;
  points: TimelinePoint[];
}

/** Points grouped by the date they give: the most precise first, a coarser date joining the first group it agrees with. */
export function clusterByDate(points: readonly TimelinePoint[]): Cluster[] {
  const dated = points.filter((p) => p.date);
  const sorted = [...dated].sort((a, b) => precisionRank(b.date!) - precisionRank(a.date!) || a.date!.localeCompare(b.date!));
  const out: Cluster[] = [];
  for (const p of sorted) {
    const c = out.find((x) => sameWhen(x.date, p.date));
    if (c) c.points.push(p);
    else out.push({ date: p.date!, precision: p.precision, dateText: p.dateText, points: [p] });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** "2024-03-02", "Mar 2024", "2024" */
export function whenWords(iso: string | null | undefined, precision?: string | null): string {
  if (!iso) return 'no date';
  return formatPartialDate(iso, (precision as 'day' | 'month' | 'year' | 'unknown' | null) ?? null);
}

/** "per Neurology note", "per Neurology note and 2 more" (records) or "per my notes". */
export function whoWords(points: readonly TimelinePoint[]): string {
  if (!points.length) return '';
  if (points.every((p) => p.tier === 'note')) return PER_MY_NOTES;
  const titles = [...new Set(points.filter((p) => p.tier === 'record').map((p) => p.documentTitle))];
  if (!titles.length) return PER_MY_NOTES;
  return `per ${titles[0]}${titles.length > 1 ? ` and ${titles.length - 1} more` : ''}`;
}

// ---------------------------------------------------------------------------
// The timeline of one drug
// ---------------------------------------------------------------------------

const answerOf = (p: TimelinePoint): string | null => p.answer?.answer ?? null;

function settledFrom(c: Cluster, kind: PointKind, answered: boolean, dose: string | null = null): SettledPoint {
  const best = c.points.find((p) => p.date === c.date) ?? c.points[0];
  return {
    kind,
    date: c.date,
    precision: best?.precision ?? c.precision,
    dateText: best?.dateText ?? c.dateText,
    dose: dose ?? best?.dose ?? null,
    by: 'record',
    who: whoWords(c.points),
    factIds: [...new Set(c.points.map((p) => p.factId))],
    documentIds: [...new Set(c.points.map((p) => p.documentId))],
    recordsSaid: null,
    answered,
  };
}

interface KindResult {
  disagreement: RecordsDisagreement | null;
  settled: SettledPoint[];
}

/** Stage 1 for a start or a stop: the record points' dates, the user's answers applied. */
function settleDates(drugKey: string, kind: 'start' | 'stop', recordPoints: readonly TimelinePoint[]): KindResult {
  const all = recordPoints.filter((p) => p.kind === kind && p.date);
  const clustersAll = clusterByDate(all);
  const live = all.filter((p) => answerOf(p) !== 'wrong');
  const clusters = clusterByDate(live);
  const chosen = live.find((p) => answerOf(p) === 'right') ?? null;
  const hasBoth = (c: Cluster) => c.points.some((p) => answerOf(p) === 'both');
  let open = false;
  let how: RecordsDisagreement['how'] = null;
  let settled: SettledPoint[] = [];
  if (clusters.length <= 1) {
    settled = clusters.map((c) => settledFrom(c, kind, all.some((p) => answerOf(p) === 'wrong') || Boolean(chosen)));
    if (clustersAll.length > 1) how = all.some((p) => answerOf(p) === 'wrong') ? 'wrong' : chosen ? 'chosen' : null;
  } else if (chosen) {
    how = 'chosen';
    settled = clusters.filter((c) => c.points.includes(chosen) || hasBoth(c)).map((c) => settledFrom(c, kind, true));
  } else if (clusters.every(hasBoth)) {
    how = 'both';
    settled = clusters.map((c) => settledFrom(c, kind, true));
  } else {
    open = true;
  }
  const disagreement: RecordsDisagreement | null =
    clustersAll.length > 1
      ? {
          key: `${drugKey}|${kind}`,
          kind,
          date: null,
          groups: clustersAll.map((c) => ({ says: whenWords(c.date, c.precision), date: c.date, dose: null, points: c.points })),
          open,
          how: open ? null : how,
        }
      : null;
  return { disagreement, settled };
}

/** Doses grouped by what they say (the same dose read alike). */
function doseGroups(points: readonly TimelinePoint[]): Array<{ dose: string; points: TimelinePoint[] }> {
  const out: Array<{ dose: string; points: TimelinePoint[] }> = [];
  for (const p of points) {
    if (!p.dose) continue;
    const g = out.find((x) => sameDose(x.dose, p.dose));
    if (g) g.points.push(p);
    else out.push({ dose: p.dose, points: [p] });
  }
  return out;
}

/** Stage 1 for doses: per day the records give doses for, two doses that read differently (same unit) disagree. */
function settleDoses(drugKey: string, recordPoints: readonly TimelinePoint[]): { disagreements: RecordsDisagreement[]; settled: SettledPoint[] } {
  const all = recordPoints.filter((p) => p.kind === 'dose' && p.date && p.dose);
  const disagreements: RecordsDisagreement[] = [];
  const settled: SettledPoint[] = [];
  for (const day of clusterByDate(all)) {
    const groupsAll = doseGroups(day.points);
    const live = day.points.filter((p) => answerOf(p) !== 'wrong');
    const groups = doseGroups(live);
    // Only doses in one unit can be said to differ; "taper" beside "60 mg" is not a disagreement.
    const comparable = groupsAll.length > 1 && groupsAll.some((a, i) => groupsAll.some((b, j) => i < j && comparableDoses(a.dose, b.dose)));
    const chosen = live.find((p) => answerOf(p) === 'right') ?? null;
    const hasBoth = (g: { points: TimelinePoint[] }) => g.points.some((p) => answerOf(p) === 'both');
    let open = false;
    let how: RecordsDisagreement['how'] = null;
    let keep: Array<{ dose: string; points: TimelinePoint[] }> = [];
    if (!comparable || groups.length <= 1) {
      keep = groups;
      if (comparable && groupsAll.length > 1) how = all.some((p) => answerOf(p) === 'wrong') ? 'wrong' : chosen ? 'chosen' : null;
    } else if (chosen) {
      how = 'chosen';
      keep = groups.filter((g) => g.points.includes(chosen) || hasBoth(g));
    } else if (groups.every(hasBoth)) {
      how = 'both';
      keep = groups;
    } else {
      open = true;
    }
    for (const g of keep) settled.push(settledFrom({ date: day.date, precision: day.precision, dateText: day.dateText, points: g.points }, 'dose', how !== null, g.dose));
    if (comparable) {
      disagreements.push({
        key: `${drugKey}|dose|${day.date}`,
        kind: 'dose',
        date: day.date,
        groups: groupsAll.map((g) => ({ says: g.dose, date: day.date, dose: g.dose, points: g.points })),
        open,
        how: open ? null : how,
      });
    }
  }
  return { disagreements, settled };
}

function noteSays(p: TimelinePoint): string {
  if (p.kind === 'dose') return `${p.dose ?? 'a dose'}${p.date ? ` on ${whenWords(p.date, p.precision)}` : ''}`;
  return whenWords(p.date, p.precision);
}

function settledSays(s: SettledPoint): string {
  return s.kind === 'dose' ? `${s.dose ?? 'a dose'} on ${whenWords(s.date, s.precision)} ${s.who}` : `${whenWords(s.date, s.precision)} ${s.who}`;
}

function pointsOf(s: SettledPoint, records: readonly TimelinePoint[]): TimelinePoint[] {
  return records.filter((p) => s.factIds.includes(p.factId) && p.kind === s.kind);
}

/** Days between two partial dates (their first day), for "the nearest" course. */
function gapDays(a: string, b: string): number {
  const pad = (s: string) => (s.length === 4 ? `${s}-01-01` : s.length === 7 ? `${s}-01` : s.slice(0, 10));
  return Math.abs(new Date(`${pad(a)}T00:00:00Z`).getTime() - new Date(`${pad(b)}T00:00:00Z`).getTime()) / 86400000;
}

/**
 * The whole timeline of one drug from its points (records' and notes'), with the user's answers applied: the stage 1
 * disagreements, the records' settled timeline, his notes set against it, and the settled timeline after his answers.
 */
export function buildDrugTimeline(key: string, name: string, points: readonly TimelinePoint[]): DrugTimeline {
  const records = points.filter((p) => p.tier === 'record');
  const notePoints = points.filter((p) => p.tier === 'note');
  const start = settleDates(key, 'start', records);
  const stop = settleDates(key, 'stop', records);
  const doses = settleDoses(key, records);
  const disagreements = [start.disagreement, stop.disagreement, ...doses.disagreements].filter((d): d is RecordsDisagreement => d !== null);
  const recordsSettled = disagreements.every((d) => !d.open);
  const settledRecords: Record<PointKind, SettledPoint[]> = { start: start.settled, stop: stop.settled, dose: doses.settled };

  // Stage 2: each start, stop and dose of his notes against the records' settled timeline.
  const kindOpen = (p: TimelinePoint): boolean =>
    p.kind === 'dose' ? doses.disagreements.some((d) => d.open && sameWhen(d.date, p.date)) : Boolean((p.kind === 'start' ? start : stop).disagreement?.open);
  const notes: NotesComparison[] = [];
  for (const p of notePoints) {
    if (p.kind !== 'dose' && !p.date) continue;
    if (p.kind === 'dose' && !p.dose) continue;
    const base = { key: `med:${key}:${p.factId}:${p.kind}`, point: p, answer: p.answer && p.answer.stage === 2 ? p.answer : null };
    // Nothing new is asked while the records disagree anywhere on the drug. An answer he already gave keeps applying
    // where the records of its own start, stop or day are still settled (review 2026-10-09: a new record disagreeing
    // on the stop used to put the records' start back on Medications as "settled", over his "My notes are right").
    if (!recordsSettled && (!base.answer || kindOpen(p))) {
      notes.push({ ...base, standing: 'waiting', recordsSay: null, recordPoints: [] });
      continue;
    }
    const s = settledRecords[p.kind];
    if (p.kind === 'dose') {
      const sameDay = s.filter((x) => sameWhen(x.date, p.date));
      if (!p.date || !sameDay.length) {
        notes.push({ ...base, standing: 'nothing', recordsSay: null, recordPoints: [] });
        continue;
      }
      const agree = sameDay.filter((x) => sameDose(x.dose, p.dose));
      const differ = sameDay.filter((x) => !sameDose(x.dose, p.dose) && comparableDoses(x.dose, p.dose));
      const used = agree.length ? agree : differ;
      notes.push({
        ...base,
        standing: agree.length ? 'agrees' : differ.length ? 'differs' : 'nothing',
        recordsSay: used.length ? used.map(settledSays).join('; ') : null,
        recordPoints: used.flatMap((x) => pointsOf(x, records)),
      });
      continue;
    }
    if (!s.length) {
      notes.push({ ...base, standing: 'nothing', recordsSay: null, recordPoints: [] });
      continue;
    }
    const agree = s.filter((x) => sameWhen(x.date, p.date));
    const used = agree.length ? agree : s;
    notes.push({ ...base, standing: agree.length ? 'agrees' : 'differs', recordsSay: used.map(settledSays).join('; '), recordPoints: used.flatMap((x) => pointsOf(x, records)) });
  }

  // The settled timeline: the records' settled values, then his answers ("My notes are right" replaces the nearest of
  // the values it was compared with; "Both are true" adds his beside them).
  const settled: Record<PointKind, SettledPoint[]> = { start: [...settledRecords.start], stop: [...settledRecords.stop], dose: [...settledRecords.dose] };
  for (const c of notes) {
    if (c.standing !== 'differs' || !c.answer) continue;
    const p = c.point;
    const mine: SettledPoint = {
      kind: p.kind,
      date: p.date,
      precision: p.precision,
      dateText: p.dateText,
      dose: p.dose,
      by: 'notes',
      who: PER_MY_NOTES,
      factIds: [p.factId],
      documentIds: [p.documentId],
      recordsSaid: null,
      answered: true,
    };
    const list = settled[p.kind];
    if (c.answer.answer === 'notes_right') {
      const candidates = list.filter((x) => x.by === 'record' && (p.kind !== 'dose' || sameWhen(x.date, p.date)));
      const nearest = candidates.length && p.date ? [...candidates].sort((a, b) => gapDays(a.date ?? p.date!, p.date!) - gapDays(b.date ?? p.date!, p.date!))[0] : null;
      if (nearest) {
        list.splice(list.indexOf(nearest), 1);
        mine.recordsSaid = { date: nearest.date, dose: nearest.dose, who: nearest.who };
      }
      list.push(mine);
    } else if (c.answer.answer === 'both') {
      list.push(mine);
    }
  }
  for (const k of POINT_KINDS) settled[k].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));

  const answered = points.some((p) => p.answer !== null);
  const lanes = new Map<string, TimelineLane>();
  for (const p of points) {
    const lane = lanes.get(p.documentId) ?? { documentId: p.documentId, title: p.documentTitle, tier: p.tier, documentDate: p.documentDate, points: [] };
    lane.points.push(p);
    lanes.set(p.documentId, lane);
  }
  const laneList = [...lanes.values()].sort((a, b) => (a.tier === b.tier ? (a.documentDate ?? '').localeCompare(b.documentDate ?? '') || a.title.localeCompare(b.title) : a.tier === 'record' ? -1 : 1));
  for (const l of laneList) l.points.sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || POINT_KINDS.indexOf(a.kind) - POINT_KINDS.indexOf(b.kind));
  return { key, name, lanes: laneList, disagreements, recordsSettled, notes, settled: { starts: settled.start, stops: settled.stop, doses: settled.dose }, answered };
}

/** "started 2024-03-02 per my notes; stopped 2024-05 per Neurology note" (empty when nothing is settled). */
export function settledWords(t: Pick<DrugTimeline, 'settled'>): string {
  const bits: string[] = [];
  for (const s of t.settled.starts) bits.push(`started ${whenWords(s.date, s.precision)} ${s.who}`);
  for (const s of t.settled.stops) bits.push(`stopped ${whenWords(s.date, s.precision)} ${s.who}`);
  return bits.join('; ');
}

// ---------------------------------------------------------------------------
// The settled timeline on a medication row (Medications and its history chart)
// ---------------------------------------------------------------------------

/** What Medications shows for a row whose drug the user answered: the settled start and stop with who said them. */
export interface MedicationSettled {
  drugKey: string;
  start: { date: string; precision: string; dateText: string | null; who: string; by: 'record' | 'notes'; recordsSaid: SettledPoint['recordsSaid'] } | null;
  stop: { date: string; precision: string; dateText: string | null; who: string; by: 'record' | 'notes'; recordsSaid: SettledPoint['recordsSaid'] } | null;
  /** Starts and stops of other courses ("Both happened", "Both are true"), drawn as marks. */
  extra: Array<{ kind: 'start' | 'stop'; date: string; precision: string; who: string; factId: string | null }>;
  /** One line: "start per my notes (the records say 2024-04-02); stop per Neurology note". */
  words: string;
}

function pick(list: SettledPoint[], near: string | null): SettledPoint | null {
  const dated = list.filter((s) => s.date);
  if (!dated.length) return null;
  if (dated.length === 1) return dated[0];
  if (near) return [...dated].sort((a, b) => gapDays(a.date!, near) - gapDays(b.date!, near))[0];
  return dated[dated.length - 1];
}

/**
 * The settled timeline applied to one medication row: the start nearest the row's own start (the latest when it has
 * none), the first stop on or after that start, the rest as marks. Null when nothing is settled.
 */
export function settledForRow(t: Pick<DrugTimeline, 'key' | 'settled'>, row: { start: string | null; stop: string | null }): MedicationSettled | null {
  const start = pick(t.settled.starts, row.start);
  const stops = t.settled.stops.filter((s) => s.date && (!start?.date || s.date >= start.date.slice(0, s.date.length) || sameWhen(s.date, start.date)));
  const stop = stops.length ? (row.stop ? pick(stops, row.stop) : stops[0]) : null;
  if (!start && !stop) return null;
  const as = (s: SettledPoint | null) => (s && s.date ? { date: s.date, precision: s.precision, dateText: s.dateText, who: s.who, by: s.by, recordsSaid: s.recordsSaid } : null);
  const extra: MedicationSettled['extra'] = [];
  for (const s of t.settled.starts) if (s !== start && s.date) extra.push({ kind: 'start', date: s.date, precision: s.precision, who: s.who, factId: s.factIds[0] ?? null });
  for (const s of t.settled.stops) if (s !== stop && s.date) extra.push({ kind: 'stop', date: s.date, precision: s.precision, who: s.who, factId: s.factIds[0] ?? null });
  const words: string[] = [];
  const said = (s: SettledPoint) => (s.recordsSaid ? ` (the records say ${whenWords(s.recordsSaid.date)})` : '');
  if (start?.date) words.push(`start ${whenWords(start.date, start.precision)} ${start.who}${said(start)}`);
  if (stop?.date) words.push(`stop ${whenWords(stop.date, stop.precision)} ${stop.who}${said(stop)}`);
  return { drugKey: t.key, start: as(start), stop: as(stop), extra, words: words.join('; ') };
}

// ---------------------------------------------------------------------------
// Note import: dates read from a note's own text
// ---------------------------------------------------------------------------

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const WEEKDAY = '(?:(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*,?\\s+)?';
/** Date shapes a note's first lines may carry, each read by parsePartialDate once found. */
const NOTE_DATE_SHAPES: RegExp[] = [
  /(?<![\d-])(\d{4}-\d{1,2}-\d{1,2})(?![\d-])/,
  new RegExp(`(?<![a-z])${WEEKDAY}(${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4})`, 'i'),
  new RegExp(`(?<![a-z\\d])${WEEKDAY}(\\d{1,2}\\s+${MONTH},?\\s+\\d{4})`, 'i'),
  /(?<![\d/])(\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2}))(?![\d/])/,
  new RegExp(`(?<![a-z])(${MONTH}\\s+\\d{4})`, 'i'),
];

/**
 * The date a note carries as a heading in its own first lines ("March 3, 2024", "Journal, 3/2/24", "2024-03-02"), as
 * written, or null. Only the first `lines` non-empty lines are read, and only a line that is mostly the date (at most
 * 20 letters of other words): "Started lisinopril 2024-03-02 at 10 mg" is something the note says happened, not when
 * it was written.
 */
export function noteDateText(text: string, lines = 3): string | null {
  const head = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .filter(Boolean)
    .slice(0, lines);
  for (const line of head) {
    if (line.length > 120) continue;
    for (const re of NOTE_DATE_SHAPES) {
      const m = re.exec(line);
      if (!m) continue;
      const rest = (line.slice(0, m.index) + line.slice(m.index + m[0].length)).replace(/[^a-z]/gi, '');
      if (rest.length > 20) continue;
      return m[1].replace(/\s+/g, ' ').trim();
    }
  }
  return null;
}

/** Where a note's date came from: its own text, the export's record of it, the file name, or the file's time. */
export const NOTE_DATE_FROM = ['content', 'export', 'filename', 'file', 'none'] as const;
export type NoteDateFrom = (typeof NOTE_DATE_FROM)[number];
export const NOTE_DATE_FROM_WORDS: Record<NoteDateFrom, string> = {
  content: 'date from the note',
  export: 'date from the export',
  filename: 'date from the file name',
  file: 'date from the file',
  none: 'no date',
};

/** What the import records on each note (`documents.metadata_json.note`). */
export interface NoteImportMeta {
  v: 1;
  batch: string;
  /** text, markdown, html, docx, pdf, rtf, csv, csv_row, keep, enex, image */
  format: string;
  /** The file (or the entry inside a zip) as named. */
  from: string;
  /** The zip, .enex or .csv it came out of, when it was one of several. */
  container: string | null;
  index: number | null;
  sourceSha256: string;
  dateFrom: NoteDateFrom;
  dateText: string | null;
  at: string;
  by: string | null;
  /** Pictures or files attached inside the note that were not imported (Evernote resources, Keep attachments). */
  attachmentsLeftOut?: number;
}

/** One import, as the page shows it. */
export interface NoteImportResult {
  batch: string;
  added: number;
  duplicates: number;
  skipped: Array<{ file: string; reason: string }>;
  skippedTotal: number;
  items: Array<{ documentId: string; title: string; duplicate: boolean; from: string; dateFrom: NoteDateFrom; date: string | null }>;
}

/** An import's progress and the cost of reading it. */
export interface NoteImportStatus {
  batch: string;
  notes: number;
  /** Text not ready yet (being stored and read off the file). */
  pending: number;
  ready: number;
  read: number;
  reading: number;
  failed: number;
  held: number;
  likelyCopies: number;
  /** What reading the notes not read yet would cost, once every note's text is ready. */
  estimate: NotesReadingEstimate | null;
}

export interface NotesReadingEstimate {
  /** Notes read together, several to a call. */
  packedNotes: number;
  packedCalls: number;
  /** Longer notes, each read on its own. */
  aloneNotes: number;
  aloneCalls: number;
  calls: number;
  approxUsd: number;
  model: string;
  /** One sentence: "34 short notes read 8 at a time in 5 calls, and 2 longer ones on their own (3 calls): about $0.42." */
  words: string;
}
