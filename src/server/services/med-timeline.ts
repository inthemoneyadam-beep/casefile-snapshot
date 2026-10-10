/**
 * The medication timeline reconciler (2026-10-09: records do not always agree, medication timelines above
 * all). Rules and shapes: src/shared/notes.ts (buildDrugTimeline).
 *
 * Sources: every live medication detail of a live clinical record (its passage of the record's own voice; the patient's words
 * quoted inside a record are neither) and of the patient's own notes. Summaries, outside letters and documents not sorted yet
 * are left out of the lanes: they are claims about records, not records. A detail gives a START only when it states
 * one (start_date), a STOP only when it states one (stop_date), and a DOSE on the day it is dated. Each lane is one
 * document. A drug is matched by its key (services/medications.ts medicationKey); list headings and two drugs on one
 * line are not drugs.
 *
 * Answers are written on the details themselves (`attributes_json._timeline[kind]`, private keys, with a short history
 * in `_timelineHistory`): never the status, the note or a field of a detail. Undo takes an answer back by its id (one
 * "Both happened" marks a point in every group and is taken back whole). A detail holding an answer is kept by a
 * re-reading like any detail the user worked on (services/fact-holds.ts).
 *
 * Medications and its history chart show the settled timeline of every drug the user answered (services/medications.ts
 * reads it through `setMedicationOverlay`), with who said each date; the rows and the records are never changed.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { badRequest, conflict, notFound } from '../util/errors';
import { newId, nowIso, parseJson } from '../util/ids';
import { parsePartialDate } from '../../shared/dates';
import { factTier } from '../../shared/trust';
import {
  NOTES_ANSWERS,
  NOTES_ANSWER_WORDS,
  PER_PATIENT_NOTES,
  POINT_KIND_WORDS,
  RECORDS_ANSWERS,
  RECORDS_ANSWER_WORDS,
  buildDrugTimeline,
  doseText,
  settledForRow,
  settledWords,
  whenWords,
  type DrugSummary,
  type DrugTimeline,
  type NotesAnswer,
  type NotesItem,
  type PointKind,
  type RecordsAnswer,
  type TimelineAnswer,
  type TimelinePoint,
} from '../../shared/notes';
import { factItemName, medicationKey, notMedicationReason, setMedicationOverlay } from './medications';
import { writeAudit } from './audit';
import { onLockChange } from '../auth';

/** The private key the answers live under on a detail. */
export const TIMELINE_KEY = '_timeline';
const HISTORY_KEY = '_timelineHistory';

interface FactRow {
  id: string;
  statement: string;
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  attributesJson: string;
  assertedBy: string;
  documentId: string;
  documentTitle: string;
  documentTier: string;
  documentDate: string | null;
}

/**
 * The user's verdict outranks the model (review 2026-10-09): a detail the user marked wrong on its own page (disputed) is
 * no source of the timeline, and a record's detail he said he is not sure of cannot stand for the record either (as
 * services/reconcile.ts `recordEligible`). Otherwise a reading he rejected could open a disagreement or show on
 * Medications as the settled date "per <record>".
 */
function loadFacts(): FactRow[] {
  return db().all<FactRow>(sql`
    select f.id, f.statement, f.date, f.date_precision as datePrecision, f.date_text as dateText, f.attributes_json as attributesJson,
           f.asserted_by as assertedBy, d.id as documentId, d.title as documentTitle, d.source_tier as documentTier, d.document_date as documentDate
    from facts f join documents d on d.id = f.source_document_id
    where f.type = 'medication' and f.deleted_at is null and f.status not in ('superseded', 'disputed') and d.deleted_at is null
      and d.source_tier in ('primary', 'patient')
      and not (d.source_tier = 'primary' and coalesce(f.verdict_basis, '') = 'unsure')`);
}

interface Cite {
  citationId: string;
  page: number;
  quote: string;
  verified: boolean;
}

function firstCitations(ids: string[]): Map<string, Cite> {
  const out = new Map<string, Cite>();
  const c = schema.citations;
  for (let i = 0; i < ids.length; i += 400) {
    const rows = db()
      .select({ id: c.id, factId: c.factId, page: c.pageNumber, quote: c.quote, verified: c.verified, createdAt: c.createdAt })
      .from(c)
      .where(inArray(c.factId, ids.slice(i, i + 400)))
      .all()
      .sort((x, y) => Number(y.verified) - Number(x.verified) || x.page - y.page || x.createdAt.localeCompare(y.createdAt));
    for (const r of rows) if (r.factId && !out.has(r.factId)) out.set(r.factId, { citationId: r.id, page: r.page, quote: r.quote, verified: Boolean(r.verified) });
  }
  return out;
}

function readAnswers(attrs: Record<string, unknown>): Partial<Record<PointKind, TimelineAnswer>> {
  const t = attrs[TIMELINE_KEY];
  if (!t || typeof t !== 'object') return {};
  const out: Partial<Record<PointKind, TimelineAnswer>> = {};
  for (const k of ['start', 'stop', 'dose'] as const) {
    const a = (t as Record<string, unknown>)[k] as Partial<TimelineAnswer> | undefined;
    if (a && typeof a.id === 'string' && typeof a.answer === 'string' && (a.stage === 1 || a.stage === 2)) out[k] = { id: a.id, stage: a.stage, answer: a.answer as TimelineAnswer['answer'], by: a.by ?? null, at: String(a.at ?? '') };
  }
  return out;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The points of one medication detail (none when it states no start, stop or dated dose). */
export function pointsOfFact(f: FactRow, cite: Cite | undefined): { key: string; name: string; points: TimelinePoint[] } | null {
  const tier = f.documentTier === 'patient' ? 'note' : factTier(f.documentTier, f) === 'primary' ? 'record' : null;
  if (!tier) return null;
  const name = factItemName({ type: 'medication', statement: f.statement, attributesJson: f.attributesJson });
  if (notMedicationReason(name)) return null;
  const key = medicationKey(name);
  if (!key) return null;
  const attrs = parseJson<Record<string, unknown>>(f.attributesJson, {});
  const answers = readAnswers(attrs);
  const dose = doseText(str(attrs.dose), str(attrs.unit));
  const base = {
    factId: f.id,
    dose,
    documentId: f.documentId,
    documentTitle: f.documentTitle,
    documentDate: f.documentDate,
    tier: tier as TimelinePoint['tier'],
    page: cite?.page ?? null,
    citationId: cite?.citationId ?? null,
    quote: cite?.quote ?? null,
    verified: cite?.verified ?? false,
    statement: f.statement,
  };
  const points: TimelinePoint[] = [];
  const start = parsePartialDate(str(attrs.start_date));
  if (start.iso) points.push({ ...base, id: `${f.id}:start`, kind: 'start', date: start.iso, precision: start.precision, dateText: start.text, answer: answers.start ?? null });
  const stop = parsePartialDate(str(attrs.stop_date));
  if (stop.iso) points.push({ ...base, id: `${f.id}:stop`, kind: 'stop', date: stop.iso, precision: stop.precision, dateText: stop.text, dose: null, answer: answers.stop ?? null });
  if (dose && f.date) points.push({ ...base, id: `${f.id}:dose`, kind: 'dose', date: f.date, precision: f.datePrecision, dateText: f.dateText, answer: answers.dose ?? null });
  return points.length ? { key, name, points } : null;
}

let cache: { sig: string; map: Map<string, DrugTimeline> } | null = null;
/** Bumped by every answer written here: two writes in one millisecond leave the table's times alike. */
let localVersion = 0;

function signature(): string {
  const f = db().get<{ n: number; m: string | null }>(sql`select count(*) as n, max(updated_at) as m from facts where type = 'medication'`);
  const d = db().get<{ n: number; m: string | null; x: number }>(sql`select count(*) as n, max(updated_at) as m, sum(case when deleted_at is null then 1 else 0 end) as x from documents`);
  const c = db().get<{ n: number }>(sql`select count(*) as n from citations where fact_id is not null`);
  return `${localVersion}|${f?.n}|${f?.m}|${d?.n}|${d?.m}|${d?.x}|${c?.n}`;
}

/** Forget the cached timelines (tests, a lock). */
export function resetTimelineCache(): void {
  cache = null;
  localVersion++;
}

// Nothing read from the case stays in memory once it is locked.
onLockChange(() => resetTimelineCache());

/** Every drug's timeline, by its key. Cached until a medication detail, a document or a citation changes. */
export function allDrugTimelines(): Map<string, DrugTimeline> {
  const sig = signature();
  if (cache && cache.sig === sig) return cache.map;
  const facts = loadFacts();
  const cites = firstCitations(facts.map((f) => f.id));
  const byDrug = new Map<string, { names: Map<string, number>; points: TimelinePoint[] }>();
  for (const f of facts) {
    const r = pointsOfFact(f, cites.get(f.id));
    if (!r) continue;
    const e = byDrug.get(r.key) ?? { names: new Map<string, number>(), points: [] as TimelinePoint[] };
    e.names.set(r.name, (e.names.get(r.name) ?? 0) + 1);
    e.points.push(...r.points);
    byDrug.set(r.key, e);
  }
  const map = new Map<string, DrugTimeline>();
  for (const [key, e] of byDrug) {
    const name = [...e.names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    map.set(key, buildDrugTimeline(key, name, e.points));
  }
  cache = { sig, map };
  return map;
}

export function drugTimeline(key: string): DrugTimeline {
  const t = allDrugTimelines().get(key);
  if (!t) throw notFound('no medication timeline for that drug');
  return t;
}

/** The drugs for the Medications tab: those with something to settle or compare first, then the rest by name. */
export function listDrugs(opts: { q?: string; only?: 'open' | 'all' } = {}): DrugSummary[] {
  const q = (opts.q ?? '').trim().toLowerCase();
  const out: DrugSummary[] = [];
  for (const t of allDrugTimelines().values()) {
    const records = t.lanes.filter((l) => l.tier === 'record').length;
    const notes = t.lanes.filter((l) => l.tier === 'note').length;
    const open = t.disagreements.filter((d) => d.open).length;
    const notesToAnswer = t.notes.filter((n) => n.standing === 'differs' && !n.answer).length;
    if (opts.only === 'open' && !open) continue;
    if (q && !`${t.name} ${t.key}`.toLowerCase().includes(q)) continue;
    // Only drugs with something to look at: two sources, or a disagreement or an answer.
    if (records + notes < 2 && !open && !t.answered) continue;
    out.push({ key: t.key, name: t.name, records, notes, open, notesToAnswer, answered: t.answered, settledWords: settledWords(t) });
  }
  return out.sort((a, b) => b.open - a.open || b.notesToAnswer - a.notesToAnswer || a.name.localeCompare(b.name));
}

/** The settled timeline Medications shows, by drug key, for every drug the user answered. */
export function settledOverlay(): Map<string, DrugTimeline> {
  const out = new Map<string, DrugTimeline>();
  for (const [k, t] of allDrugTimelines()) if (t.answered) out.set(k, t);
  return out;
}

// Medications and its history chart read the settled timeline through this (no import back: medications.ts is imported here).
setMedicationOverlay((row) => {
  try {
    const t = settledOverlay().get(medicationKey(row.name));
    return t ? settledForRow(t, row) : null;
  } catch {
    return null;
  }
});

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/** Writes (or clears, with null) the answer for one kind on a detail, keeping the earlier one in its history. */
function writeAnswer(factId: string, kind: PointKind, answer: TimelineAnswer | null, by: string | null): void {
  const row = db().select({ attributesJson: schema.facts.attributesJson }).from(schema.facts).where(and(eq(schema.facts.id, factId), isNull(schema.facts.deletedAt))).get();
  if (!row) throw notFound('detail not found');
  const attrs = parseJson<Record<string, unknown>>(row.attributesJson, {});
  const current = { ...((attrs[TIMELINE_KEY] as Record<string, unknown> | undefined) ?? {}) };
  const before = current[kind];
  if (before) {
    const history = Array.isArray(attrs[HISTORY_KEY]) ? (attrs[HISTORY_KEY] as unknown[]) : [];
    attrs[HISTORY_KEY] = [...history, { kind, answer: before, endedAt: nowIso(), endedBy: by }].slice(-20);
  }
  if (answer) current[kind] = answer;
  else delete current[kind];
  if (Object.keys(current).length) attrs[TIMELINE_KEY] = current;
  else delete attrs[TIMELINE_KEY];
  db().update(schema.facts).set({ attributesJson: JSON.stringify(attrs), updatedAt: nowIso() }).where(eq(schema.facts.id, factId)).run();
  localVersion++;
}

export interface TimelineAnswerResult {
  answerId: string | null;
  timeline: DrugTimeline;
  /** One plain sentence for the toast. */
  words: string;
}

function drugOfKey(disagreementKey: string): string {
  const i = disagreementKey.indexOf('|');
  return i > 0 ? disagreementKey.slice(0, i) : disagreementKey;
}

/**
 * Stage 1: the user's answer on a records-vs-records disagreement. "right" and "wrong" name the record point; "both" marks
 * one point of every group that is not marked yet. Choosing another record as right takes the earlier choice back.
 */
export function answerRecords(input: { disagreementKey: string; answer: RecordsAnswer; pointId?: string | null }, by: string | null): TimelineAnswerResult {
  if (!(RECORDS_ANSWERS as readonly string[]).includes(input.answer)) throw badRequest('unknown answer');
  const t = drugTimeline(drugOfKey(input.disagreementKey));
  const dis = t.disagreements.find((d) => d.key === input.disagreementKey);
  if (!dis) throw notFound('that disagreement is not there any more (the records changed); open the drug again');
  const all = dis.groups.flatMap((g) => g.points);
  const id = newId();
  const at = nowIso();
  const mk = (): TimelineAnswer => ({ id, stage: 1, answer: input.answer, by, at });
  db().transaction(() => {
    if (input.answer === 'both') {
      if (!dis.open && dis.how === 'both') throw conflict('you already said both happened');
      // A choice made before gives way to both.
      for (const p of all) if (p.answer?.answer === 'right') writeAnswer(p.factId, dis.kind, null, by);
      for (const g of dis.groups) {
        const live = g.points.filter((p) => p.answer?.answer !== 'wrong');
        if (!live.length || live.some((p) => p.answer?.answer === 'both')) continue;
        writeAnswer(live[0].factId, dis.kind, mk(), by);
      }
      return;
    }
    const point = all.find((p) => p.id === input.pointId);
    if (!point) throw badRequest('say which record (pointId) this answer is about');
    // One record chosen as right takes back an earlier choice and an earlier "Both happened" (review 2026-10-09: the
    // "both" marks left behind kept every course settled, so the choice changed nothing), as "both" takes back "right".
    if (input.answer === 'right') for (const p of all) if (p !== point && (p.answer?.answer === 'right' || p.answer?.answer === 'both')) writeAnswer(p.factId, dis.kind, null, by);
    writeAnswer(point.factId, dis.kind, mk(), by);
  });
  writeAudit({ userName: by, action: 'update', entityType: 'medication_timeline', entityId: input.disagreementKey, summary: `${RECORDS_ANSWER_WORDS[input.answer]} (${t.name}, ${POINT_KIND_WORDS[dis.kind].toLowerCase()})` });
  const after = drugTimeline(t.key);
  return { answerId: id, timeline: after, words: `${RECORDS_ANSWER_WORDS[input.answer]}: ${t.name}, ${POINT_KIND_WORDS[dis.kind].toLowerCase()}.` };
}

/** Stage 2 on a medication point: the user's answer on a difference between his notes and the records' settled timeline. */
export function answerNotesPoint(itemKey: string, answer: NotesAnswer, by: string | null): TimelineAnswerResult {
  if (!(NOTES_ANSWERS as readonly string[]).includes(answer)) throw badRequest('unknown answer');
  const m = /^med:(.+):([^:]+):(start|stop|dose)$/.exec(itemKey);
  if (!m) throw badRequest('not a medication item');
  const t = drugTimeline(m[1]);
  const item = t.notes.find((n) => n.key === itemKey);
  if (!item) throw notFound('that entry is not there any more; open the drug again');
  if (!t.recordsSettled) throw conflict('The records disagree about this drug first. Settle that under Records vs records, then come back.');
  if (item.standing !== 'differs') throw conflict(item.standing === 'agrees' ? 'Your notes agree with the records here; nothing to answer.' : 'There is nothing in the records to compare this with.');
  const id = newId();
  writeAnswer(item.point.factId, item.point.kind, { id, stage: 2, answer, by, at: nowIso() }, by);
  writeAudit({ userName: by, action: 'update', entityType: 'medication_timeline', entityId: itemKey, summary: `${NOTES_ANSWER_WORDS[answer]} (${t.name}, ${POINT_KIND_WORDS[item.point.kind].toLowerCase()})` });
  return { answerId: id, timeline: drugTimeline(t.key), words: `${NOTES_ANSWER_WORDS[answer]}: ${t.name}, ${POINT_KIND_WORDS[item.point.kind].toLowerCase()}.` };
}

/** Undo: every point one answer wrote goes back to no answer (its history keeps it). */
export function undoTimelineAnswer(answerId: string, by: string | null): { undone: number; drugKey: string | null } {
  if (!answerId) throw badRequest('answerId is required');
  const rows = db().all<{ id: string; attributesJson: string; statement: string }>(sql`
    select id, attributes_json as attributesJson, statement from facts
    where type = 'medication' and deleted_at is null and instr(attributes_json, ${answerId}) > 0`);
  let undone = 0;
  let drugKey: string | null = null;
  db().transaction(() => {
    for (const r of rows) {
      const attrs = parseJson<Record<string, unknown>>(r.attributesJson, {});
      const answers = readAnswers(attrs);
      for (const k of ['start', 'stop', 'dose'] as const) {
        if (answers[k]?.id !== answerId) continue;
        writeAnswer(r.id, k, null, by);
        undone++;
        drugKey ??= medicationKey(factItemName({ type: 'medication', statement: r.statement, attributesJson: r.attributesJson }));
      }
    }
  });
  if (!undone) throw notFound('that answer is not there any more');
  writeAudit({ userName: by, action: 'update', entityType: 'medication_timeline', entityId: answerId, summary: 'Undid an answer on the medication timeline' });
  return { undone, drugKey };
}

/** The answer id held on one point (for Undo from a list). */
export function answerIdOf(factId: string, kind: PointKind): string | null {
  const row = db().select({ attributesJson: schema.facts.attributesJson }).from(schema.facts).where(eq(schema.facts.id, factId)).get();
  return row ? (readAnswers(parseJson<Record<string, unknown>>(row.attributesJson, {}))[kind]?.id ?? null) : null;
}

// ---------------------------------------------------------------------------
// Stage 2 rows and the clinician's lines
// ---------------------------------------------------------------------------

/** Every start, stop and dose of the patient's notes that differs from the records, waits for them, or was answered. */
export function medicationNotesItems(): NotesItem[] {
  const out: NotesItem[] = [];
  for (const t of allDrugTimelines().values()) {
    for (const c of t.notes) {
      const answered = c.answer && (NOTES_ANSWERS as readonly string[]).includes(c.answer.answer) ? c.answer : null;
      const state: NotesItem['state'] | null = answered ? 'answered' : c.standing === 'differs' ? 'answer' : c.standing === 'waiting' ? 'waiting' : null;
      if (!state) continue;
      const p = c.point;
      const rec = c.recordPoints[0] ?? null;
      out.push({
        key: c.key,
        topic: 'medication',
        subject: t.name,
        what: POINT_KIND_WORDS[p.kind],
        state,
        standing: c.standing,
        notes: { says: p.kind === 'dose' ? `${p.dose ?? ''} on ${whenWords(p.date, p.precision)}` : whenWords(p.date, p.precision), factId: p.factId, documentId: p.documentId, documentTitle: p.documentTitle, page: p.page, citationId: p.citationId, quote: p.quote, date: p.date, precision: p.precision, dateText: p.dateText },
        records: c.recordsSay ? { says: c.recordsSay, factId: rec?.factId ?? null, documentId: rec?.documentId ?? null, documentTitle: rec?.documentTitle ?? null, page: rec?.page ?? null, citationId: rec?.citationId ?? null } : null,
        answer: answered ? { answer: answered.answer as NotesAnswer, by: answered.by, at: answered.at } : null,
        drugKey: t.key,
        eventKey: null,
      });
    }
  }
  return out;
}

const tok = (id: string) => `⟦F:${id}⟧`;

/**
 * The clinician's lines about the medication timeline: what is settled for each drug the user answered (and who said each
 * date: "per the patient's notes" where his version won, the records' version beside it), what the records still disagree on,
 * and where his notes differ from the records with no answer yet. Empty when there is nothing of the kind.
 */
export function timelineLedgerLines(): string[] {
  const lines: string[] = [];
  for (const t of [...allDrugTimelines().values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const bits: string[] = [];
    if (t.answered) {
      const say = (label: string, s: DrugTimeline['settled']['starts'][number]) => {
        const who = s.by === 'notes' ? PER_PATIENT_NOTES : s.who;
        const was = s.recordsSaid ? ` (the records say ${whenWords(s.recordsSaid.date)}${s.recordsSaid.dose ? ` ${s.recordsSaid.dose}` : ''}, ${s.recordsSaid.who}; the record stays as written)` : '';
        return `${label} ${s.kind === 'dose' ? `${s.dose ?? ''} on ` : ''}${whenWords(s.date, s.precision)} ${who} ${s.factIds.map(tok).join(' ')}${was}`;
      };
      for (const s of t.settled.starts) bits.push(say('started', s));
      for (const s of t.settled.stops) bits.push(say('stopped', s));
      for (const s of t.settled.doses.filter((x) => x.answered)) bits.push(say('dose', s));
    }
    for (const d of t.disagreements.filter((x) => x.open)) {
      bits.push(`the records disagree on the ${POINT_KIND_WORDS[d.kind].toLowerCase()}${d.date ? ` on ${whenWords(d.date)}` : ''}: ${d.groups.map((g) => `${g.says} ${g.points.map((p) => tok(p.factId)).join(' ')}`).join(' vs ')} (waiting for the patient to settle it)`);
    }
    for (const n of t.notes.filter((x) => x.standing === 'differs' && !x.answer)) {
      bits.push(`The patient's notes give the ${POINT_KIND_WORDS[n.point.kind].toLowerCase()} as ${n.point.kind === 'dose' ? n.point.dose : whenWords(n.point.date, n.point.precision)} ${tok(n.point.factId)}, the records ${n.recordsSay ?? 'otherwise'} (not answered yet)`);
    }
    if (bits.length) lines.push(`- ${t.name}: ${bits.join('; ')}`);
  }
  return lines;
}

const tokD = (id: string, page: number | null) => `⟦D:${id}${page ? ` p.${page}` : ''}⟧`;

/** The clinician's get_medication_timeline: one drug in full, in lines with their tokens. */
export function medicationTimelineText(drug: string): string {
  const all = allDrugTimelines();
  const key = medicationKey(drug);
  let t = all.get(key) ?? null;
  if (!t) {
    const want = drug.trim().toLowerCase();
    const hits = [...all.values()].filter((x) => x.name.toLowerCase().includes(want) || x.key.includes(key));
    if (hits.length === 1) t = hits[0];
    else if (hits.length > 1) return `Several drugs match "${drug}": ${hits.map((h) => h.name).join(', ')}. Ask again by one of these names.`;
    else return `No medication timeline for "${drug}": no clinical record or note of the patient's own states a start, stop or dated dose for it.`;
  }
  const lines: string[] = [`${t.name}: the timeline as each source states it (a start only where one is written).`];
  for (const l of t.lanes) {
    const pts = l.points.map((p) => `${p.kind} ${p.kind === 'dose' ? `${p.dose ?? ''} on ` : ''}${whenWords(p.date, p.precision)} ${tok(p.factId)}${p.answer ? ` [answer: ${p.answer.stage === 1 ? RECORDS_ANSWER_WORDS[p.answer.answer as RecordsAnswer] : NOTES_ANSWER_WORDS[p.answer.answer as NotesAnswer]}]` : ''}`);
    lines.push(`- [${l.tier === 'record' ? 'clinical record' : "the patient's notes"}] ${l.title}${l.documentDate ? ` (${whenWords(l.documentDate)})` : ''} ${tokD(l.documentId, l.points[0]?.page ?? null)}: ${pts.join('; ')}`);
  }
  if (t.disagreements.length) {
    lines.push('Records vs records:');
    for (const d of t.disagreements) {
      const state = d.open ? 'waiting for the patient' : d.how === 'chosen' ? 'settled: he chose one record' : d.how === 'both' ? 'settled: both happened' : 'settled: he said a record is wrong';
      lines.push(`- ${POINT_KIND_WORDS[d.kind]}${d.date ? ` on ${whenWords(d.date)}` : ''}: ${d.groups.map((g) => `${g.says} (${g.points.map((p) => `${p.documentTitle} ${tok(p.factId)}${p.answer?.answer === 'wrong' ? ', he said this record is wrong' : p.answer?.answer === 'right' ? ', he said this record is right' : ''}`).join('; ')})`).join(' vs ')}: ${state}`);
    }
  }
  const settled = timelineLedgerLines().find((l) => l.startsWith(`- ${t!.name}:`));
  lines.push(t.answered && settled ? `Settled timeline${settled.slice(t.name.length + 2)}` : `Settled timeline: ${settledWords(t) || 'nothing settled yet'}${t.answered ? '' : ' (the records as they stand; the patient has not answered on this drug)'}.`);
  if (t.notes.length) {
    lines.push("The patient's notes against the records:");
    for (const n of t.notes) {
      const p = n.point;
      lines.push(`- ${POINT_KIND_WORDS[p.kind]} ${p.kind === 'dose' ? `${p.dose ?? ''} on ` : ''}${whenWords(p.date, p.precision)} ${tok(p.factId)}: ${n.standing === 'waiting' ? 'waits until the records are settled' : n.standing === 'nothing' ? 'nothing in the records to compare' : `${n.standing}${n.recordsSay ? ` (the records: ${n.recordsSay})` : ''}`}${n.answer ? `; he answered: ${NOTES_ANSWER_WORDS[n.answer.answer as NotesAnswer]}` : ''}`);
    }
  }
  return lines.join('\n');
}

