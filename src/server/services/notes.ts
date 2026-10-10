/**
 * My notes (2026-10-09): only the user's and the chief of staff's own writing (documents of the patient tier, "Your own notes",
 * and the details read from them), never a clinical record. Views: All notes (by date), Medications (what his notes say
 * about each drug), Symptoms and effects, Events. Each entry shows its quote, the date as written and how it stands
 * against the records: agrees, differs, records disagree first, or nothing to compare.
 *
 * And the second stage of Reconciliation, "Records vs my notes": his notes against the records, for a topic only once
 * the records' side of it is settled. Medication starts, stops and doses come from the timeline
 * (services/med-timeline.ts). Lab values, scans, vital signs, procedures and events come from the reconciliation's own
 * comparison (services/reconcile.ts): a detail of his notes that differs from a clinical record (inaccurate) is listed
 * to answer; one whose event the clinical records themselves disagree about waits for stage 1. The four answers map
 * onto the reconciliation's own: "My notes are right" is "The record is wrong" (his version is used for the event, the
 * record stays as written and is marked), "Both are true" and "Not the same thing" are "Not the same event", and "The
 * records are right" changes nothing but the list. Which of the four he gave is kept on the detail
 * (`attributes_json._notesAnswer`); Undo puts the detail back to automatic. A detail he had already answered on its own
 * page (a verdict, a note) is never answered over here.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { HttpError, badRequest, conflict, notFound } from '../util/errors';
import { nowIso, parseJson } from '../util/ids';
import { RECONCILE_TYPES } from '../../shared/reconcile';
import {
  NOTES_ANSWERS,
  NOTES_ANSWER_WORDS,
  STANDINGS,
  type DrugTimeline,
  type NoteDateFrom,
  type NoteDocItem,
  type NoteDrugItem,
  type NoteEntry,
  type NotesAnswer,
  type NotesCounts,
  type NotesItem,
  type Standing,
} from '../../shared/notes';
import { factItemName, medicationKey, notMedicationReason } from './medications';
import { allDrugTimelines, answerIdOf, answerNotesPoint, medicationNotesItems, undoTimelineAnswer } from './med-timeline';
import { correctRecord, getReconcileEvent, passSetAsideSql, resetMention, separateMention, trustFor } from './reconcile';
import { noteMetaOf } from './notes-import';
import { readLikelyCopy } from './documents';
import { writeAudit } from './audit';
import { setVerdict } from './facts';
import { ftsQuery } from './search';

export const NOTES_ANSWER_KEY = '_notesAnswer';

/** Plain words for each kind of detail. */
export const NOTE_TYPE_WORDS: Record<string, string> = {
  medication: 'Medication',
  symptom: 'Symptom',
  allergy_intolerance: 'Side effect or allergy',
  event: 'Event',
  procedure: 'Procedure',
  lab_result: 'Lab value',
  imaging_result: 'Scan',
  vital: 'Vital sign',
  diagnosis: 'Diagnosis',
  clinician_statement: "A doctor's view",
  recommendation: 'Advice',
  referral: 'Referral',
  follow_up: 'Follow-up',
  record_reference: 'A record mentioned',
};

const EVENT_TYPES: readonly string[] = RECONCILE_TYPES;
const SYMPTOM_TYPES = ['symptom', 'allergy_intolerance'];

interface FactLite {
  id: string;
  type: string;
  statement: string;
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  attributesJson: string;
  status: string;
  verdictNote: string | null;
  verdictBasis: string | null;
  documentId: string;
  documentTitle: string;
  documentDate: string | null;
}

/** Live details read from the patient's own notes (live documents of the patient tier), optionally of one note. */
function noteFacts(opts: { documentId?: string; types?: readonly string[] } = {}): FactLite[] {
  // A mention the reconciliation set aside beside its clinical record (a copy, or a value that differs) is still his.
  const conds = [sql`f.deleted_at is null`, sql`(f.status <> 'superseded' or ${passSetAsideSql(sql.raw('f.id'))})`, sql`d.deleted_at is null`, sql`d.source_tier = 'patient'`];
  if (opts.documentId) conds.push(sql`d.id = ${opts.documentId}`);
  if (opts.types?.length) conds.push(sql`f.type in (${sql.join(opts.types.map((t) => sql`${t}`), sql`, `)})`);
  return db().all<FactLite>(sql`
    select f.id, f.type, f.statement, f.date, f.date_precision as datePrecision, f.date_text as dateText, f.attributes_json as attributesJson,
           f.status, f.verdict_note as verdictNote, f.verdict_basis as verdictBasis,
           d.id as documentId, d.title as documentTitle, d.document_date as documentDate
    from facts f join documents d on d.id = f.source_document_id
    where ${sql.join(conds, sql` and `)}
    order by coalesce(f.date, d.document_date, '9999') desc, f.created_at`);
}

function firstCites(ids: string[]): Map<string, { id: string; page: number; quote: string; verified: boolean }> {
  const out = new Map<string, { id: string; page: number; quote: string; verified: boolean }>();
  const c = schema.citations;
  for (let i = 0; i < ids.length; i += 400) {
    const rows = db()
      .select({ id: c.id, factId: c.factId, page: c.pageNumber, quote: c.quote, verified: c.verified, createdAt: c.createdAt })
      .from(c)
      .where(inArray(c.factId, ids.slice(i, i + 400)))
      .all()
      .sort((x, y) => Number(y.verified) - Number(x.verified) || x.page - y.page || x.createdAt.localeCompare(y.createdAt));
    for (const r of rows) if (r.factId && !out.has(r.factId)) out.set(r.factId, { id: r.id, page: r.page, quote: r.quote, verified: Boolean(r.verified) });
  }
  return out;
}

function drugKeyOf(f: Pick<FactLite, 'type' | 'statement' | 'attributesJson'>): string | null {
  if (f.type !== 'medication' && f.type !== 'allergy_intolerance') return null;
  const name = factItemName(f);
  if (f.type === 'medication' && notMedicationReason(name)) return null;
  return medicationKey(name) || null;
}

function subjectOf(f: FactLite): string {
  const a = parseJson<Record<string, unknown>>(f.attributesJson, {});
  for (const k of ['name', 'analyte', 'substance', 'modality', 'about', 'action', 'to']) if (typeof a[k] === 'string' && (a[k] as string).trim()) return (a[k] as string).trim();
  return NOTE_TYPE_WORDS[f.type] ?? f.type;
}

/** How each entry stands: medication points from the timeline, measurements from the reconciliation, the rest nothing. */
function standings(facts: FactLite[]): Map<string, { standing: Standing; why: string | null; answer: string | null; eventKey: string | null }> {
  const out = new Map<string, { standing: Standing; why: string | null; answer: string | null; eventKey: string | null }>();
  // Medications: the comparisons of the drug's timeline, worst first (differs, waiting, agrees, nothing).
  const meds = facts.filter((f) => f.type === 'medication');
  if (meds.length) {
    const byFact = new Map<string, Array<{ standing: Standing; says: string | null; answer: string | null }>>();
    for (const t of allDrugTimelines().values()) {
      for (const c of t.notes) {
        const list = byFact.get(c.point.factId) ?? [];
        list.push({ standing: c.standing, says: c.recordsSay, answer: c.answer ? NOTES_ANSWER_WORDS[c.answer.answer as NotesAnswer] ?? null : null });
        byFact.set(c.point.factId, list);
      }
    }
    const rank: Record<Standing, number> = { differs: 0, waiting: 1, agrees: 2, nothing: 3 };
    for (const f of meds) {
      const list = byFact.get(f.id) ?? [];
      if (f.status === 'disputed') {
        // Marked wrong on its own page: not set against the records (services/med-timeline.ts leaves it out).
        out.set(f.id, { standing: 'nothing', why: 'You marked this detail wrong on its own page, so it is not compared.', answer: null, eventKey: null });
        continue;
      }
      if (!list.length) {
        out.set(f.id, { standing: 'nothing', why: 'It gives no start, stop or dated dose to compare.', answer: null, eventKey: null });
        continue;
      }
      const worst = [...list].sort((a, b) => rank[a.standing] - rank[b.standing])[0];
      const why = worst.standing === 'waiting' ? 'The records disagree about this drug first (Reconciliation, Records vs records).' : worst.says ? `The records: ${worst.says}.` : worst.standing === 'nothing' ? 'The records give nothing to compare it with.' : null;
      out.set(f.id, { standing: worst.standing, why, answer: list.find((x) => x.answer)?.answer ?? null, eventKey: null });
    }
  }
  // Measurements and events: the reconciliation's own trust.
  const measured = facts.filter((f) => EVENT_TYPES.includes(f.type));
  const trust = trustFor(measured.map((f) => f.id));
  for (const f of measured) {
    const t = trust.get(f.id);
    const a = parseJson<Record<string, unknown>>(f.attributesJson, {});
    const mine = (a[NOTES_ANSWER_KEY] as { answer?: string } | undefined)?.answer;
    const answer = mine && (NOTES_ANSWERS as readonly string[]).includes(mine) ? NOTES_ANSWER_WORDS[mine as NotesAnswer] : null;
    if (!t) {
      out.set(f.id, { standing: 'nothing', why: null, answer, eventKey: null });
      continue;
    }
    let standing: Standing = 'nothing';
    if (t.trust === 'accurate' || t.trust === 'replaced') standing = 'agrees';
    else if (t.trust === 'inaccurate') standing = 'differs';
    else if (t.trust === 'conflict') standing = t.eventKey && getReconcileEvent(t.eventKey)?.recordsDisagree ? 'waiting' : 'nothing';
    out.set(f.id, { standing, why: t.reason ?? null, answer: answer ?? (t.byUser && standing !== 'agrees' ? 'answered on its own page' : null), eventKey: t.eventKey ?? null });
  }
  for (const f of facts) {
    if (out.has(f.id)) continue;
    const subjective = ['symptom', 'allergy_intolerance', 'clinician_statement', 'diagnosis'].includes(f.type);
    out.set(f.id, { standing: 'nothing', why: subjective ? 'Your own account: on how things felt and worked, your word counts first.' : null, answer: null, eventKey: null });
  }
  return out;
}

function toEntries(facts: FactLite[]): NoteEntry[] {
  const st = standings(facts);
  const cites = firstCites(facts.map((f) => f.id));
  return facts.map((f) => {
    const c = cites.get(f.id);
    const s = st.get(f.id)!;
    return {
      factId: f.id,
      type: f.type,
      kind: NOTE_TYPE_WORDS[f.type] ?? f.type,
      subject: subjectOf(f),
      statement: f.statement,
      quote: c?.quote ?? null,
      page: c?.page ?? null,
      citationId: c?.id ?? null,
      verified: c?.verified ?? false,
      date: f.date,
      precision: f.datePrecision,
      dateText: f.dateText,
      documentId: f.documentId,
      documentTitle: f.documentTitle,
      documentDate: f.documentDate,
      standing: s.standing,
      standingWhy: s.why,
      answer: s.answer,
      drugKey: drugKeyOf(f),
      eventKey: s.eventKey,
    };
  });
}

const matches = (q: string, ...parts: Array<string | null | undefined>) => !q || parts.some((p) => (p ?? '').toLowerCase().includes(q));

/** All notes, newest first: the patient's own notes with their dates, how many details, and how they stand. */
export function listNoteDocs(opts: { q?: string } = {}): NoteDocItem[] {
  const q = (opts.q ?? '').trim().toLowerCase();
  const rows = db()
    .select()
    .from(schema.documents)
    .where(and(isNull(schema.documents.deletedAt), eq(schema.documents.sourceTier, 'patient')))
    .all();
  const counts = new Map<string, { details: number }>();
  for (const r of db().all<{ id: string; n: number }>(sql`select f.source_document_id as id, count(*) as n from facts f join documents d on d.id = f.source_document_id where d.source_tier = 'patient' and d.deleted_at is null and f.deleted_at is null and (f.status <> 'superseded' or ${passSetAsideSql(sql.raw('f.id'))}) group by f.source_document_id`)) counts.set(r.id, { details: Number(r.n) });
  const facts = noteFacts({ types: ['medication', ...EVENT_TYPES] });
  const st = standings(facts);
  const per = new Map<string, { agrees: number; differs: number }>();
  for (const f of facts) {
    const s = st.get(f.id)!;
    const e = per.get(f.documentId) ?? { agrees: 0, differs: 0 };
    if (s.standing === 'agrees') e.agrees++;
    if (s.standing === 'differs' && !s.answer) e.differs++;
    per.set(f.documentId, e);
  }
  const live = new Map(db().select({ id: schema.documents.id, title: schema.documents.title }).from(schema.documents).where(isNull(schema.documents.deletedAt)).all().map((r) => [r.id, r.title]));
  // "Words in your notes" (review 2026-10-09): the search finds a note by the words on its pages too, not only its title.
  const match = q ? ftsQuery(q) : null;
  const byWords = match ? new Set(db().all<{ id: string }>(sql`select distinct p.document_id as id from pages_fts p join documents d on d.id = p.document_id where d.source_tier = 'patient' and d.deleted_at is null and pages_fts match ${match}`).map((x) => x.id)) : null;
  const out: NoteDocItem[] = [];
  for (const r of rows) {
    if (!matches(q, r.title, r.filename, r.documentDateText) && !byWords?.has(r.id)) continue;
    const meta = parseJson<Record<string, unknown>>(r.metadataJson, {});
    const note = noteMetaOf(r.metadataJson);
    const copy = meta.possibleCopyOf && typeof meta.possibleCopyOf === 'object' ? (meta.possibleCopyOf as { documentId?: string }) : null;
    const copyTitle = copy?.documentId ? live.get(copy.documentId) : undefined;
    const src = meta.dateSource;
    const dateFrom: NoteDateFrom | null = !note || src === 'user' ? null : (note.dateFrom === 'file' || note.dateFrom === 'filename') && src === 'ai' ? 'content' : note.dateFrom;
    out.push({
      id: r.id,
      title: r.title,
      date: r.documentDate,
      precision: r.documentDatePrecision,
      dateText: r.documentDateText,
      dateFrom,
      format: note?.format ?? null,
      imported: Boolean(note),
      details: counts.get(r.id)?.details ?? 0,
      textStatus: r.textStatus,
      extractionStatus: r.extractionStatus,
      agrees: per.get(r.id)?.agrees ?? 0,
      differs: per.get(r.id)?.differs ?? 0,
      likelyCopyOf: copy?.documentId && copyTitle ? readLikelyCopy(JSON.stringify({ documentId: copy.documentId, title: copyTitle })) : null,
      createdAt: r.createdAt,
    });
  }
  return out.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.createdAt.localeCompare(a.createdAt));
}

/** One note: its row and every detail read from it. */
export function noteDetail(documentId: string): { note: NoteDocItem; entries: NoteEntry[] } {
  const note = listNoteDocs().find((n) => n.id === documentId);
  if (!note) throw notFound('not one of your own notes (or it was deleted)');
  return { note, entries: toEntries(noteFacts({ documentId })) };
}

/** The entries of one view (symptoms and effects, or events), newest first. */
export function listNoteEntries(view: 'symptoms' | 'events', opts: { q?: string } = {}): NoteEntry[] {
  const q = (opts.q ?? '').trim().toLowerCase();
  let facts: FactLite[];
  if (view === 'symptoms') {
    // Symptoms, side effects, and what a drug did (its effect, why it was stopped).
    facts = noteFacts({ types: [...SYMPTOM_TYPES, 'medication'] }).filter((f) => {
      if (f.type !== 'medication') return true;
      const a = parseJson<Record<string, unknown>>(f.attributesJson, {});
      return Boolean((typeof a.effect === 'string' && a.effect.trim()) || (typeof a.reason_stopped === 'string' && a.reason_stopped.trim()));
    });
  } else facts = noteFacts({ types: EVENT_TYPES });
  return toEntries(facts.filter((f) => matches(q, f.statement, f.documentTitle, f.dateText)));
}

const SAYS_ORDER = ['started', 'stopped', 'dose', 'taking', 'effect', 'why stopped', 'side effects'];

/** What his notes say about each drug, one row per drug. */
export function listNoteDrugs(opts: { q?: string } = {}): NoteDrugItem[] {
  const q = (opts.q ?? '').trim().toLowerCase();
  const facts = noteFacts({ types: ['medication', 'allergy_intolerance'] });
  const entries = toEntries(facts);
  const byKey = new Map<string, { names: Map<string, number>; entries: NoteEntry[]; says: Set<string> }>();
  facts.forEach((f, i) => {
    const key = drugKeyOf(f);
    if (!key) return;
    const e = byKey.get(key) ?? { names: new Map<string, number>(), entries: [] as NoteEntry[], says: new Set<string>() };
    const name = factItemName(f);
    e.names.set(name, (e.names.get(name) ?? 0) + 1);
    e.entries.push(entries[i]);
    const a = parseJson<Record<string, unknown>>(f.attributesJson, {});
    const has = (k: string) => typeof a[k] === 'string' && (a[k] as string).trim().length > 0;
    if (f.type === 'allergy_intolerance') e.says.add('side effects');
    else {
      if (has('start_date')) e.says.add('started');
      if (has('stop_date')) e.says.add('stopped');
      if (has('dose')) e.says.add('dose');
      if (a.status === 'active') e.says.add('taking');
      if (has('effect')) e.says.add('effect');
      if (has('reason_stopped')) e.says.add('why stopped');
    }
    byKey.set(key, e);
  });
  // Allergy details only count for a drug his notes also name as a medication (a food allergy is not a drug).
  const medKeys = new Set(facts.filter((f) => f.type === 'medication').map(drugKeyOf).filter(Boolean) as string[]);
  const rank: Record<Standing, number> = { differs: 0, waiting: 1, agrees: 2, nothing: 3 };
  const out: NoteDrugItem[] = [];
  for (const [key, e] of byKey) {
    if (!medKeys.has(key)) continue;
    const name = [...e.names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    if (!matches(q, name, ...e.entries.map((x) => x.statement))) continue;
    const worst = [...e.entries].filter((x) => !x.answer).sort((a, b) => rank[a.standing] - rank[b.standing])[0]?.standing ?? (e.entries.some((x) => x.standing === 'agrees') ? 'agrees' : 'nothing');
    out.push({ key, name, entries: e.entries.length, says: SAYS_ORDER.filter((s) => e.says.has(s)).join(', '), standing: worst, toAnswer: e.entries.filter((x) => x.standing === 'differs' && !x.answer).length });
  }
  return out.sort((a, b) => rank[a.standing] - rank[b.standing] || a.name.localeCompare(b.name));
}

/** One drug: what his notes say about it, and its timeline. */
export function noteDrug(key: string): { key: string; name: string; entries: NoteEntry[]; timeline: DrugTimeline | null } {
  const facts = noteFacts({ types: ['medication', 'allergy_intolerance'] }).filter((f) => drugKeyOf(f) === key);
  if (!facts.length) throw notFound('your notes say nothing about that drug');
  const timeline = allDrugTimelines().get(key) ?? null;
  return { key, name: timeline?.name ?? factItemName(facts[0]), entries: toEntries(facts), timeline };
}

// ---------------------------------------------------------------------------
// Stage 2: Records vs my notes
// ---------------------------------------------------------------------------

/** The measurements and events of his notes against the clinical records (the reconciliation's comparison). */
function reconciledNotesItems(): NotesItem[] {
  const facts = noteFacts({ types: EVENT_TYPES });
  if (!facts.length) return [];
  const trust = trustFor(facts.map((f) => f.id));
  const cites = firstCites(facts.map((f) => f.id));
  const recordIds = [...new Set([...trust.values()].map((t) => t.recordFactId).filter((x): x is string => Boolean(x)))];
  const recordCites = firstCites(recordIds);
  const out: NotesItem[] = [];
  for (const f of facts) {
    const t = trust.get(f.id);
    if (!t) continue;
    const a = parseJson<Record<string, unknown>>(f.attributesJson, {});
    const mine = a[NOTES_ANSWER_KEY] as { answer?: string; by?: string | null; at?: string } | undefined;
    const answered = mine?.answer && (NOTES_ANSWERS as readonly string[]).includes(mine.answer) ? { answer: mine.answer as NotesAnswer, by: mine.by ?? null, at: mine.at ?? '' } : null;
    let state: NotesItem['state'] | null = null;
    let standing: Standing = 'nothing';
    const ev = t.eventKey ? getReconcileEvent(t.eventKey) : null;
    if (answered) {
      state = 'answered';
      standing = t.trust === 'inaccurate' ? 'differs' : t.trust === 'accurate' ? 'agrees' : 'nothing';
    } else if (t.trust === 'inaccurate' && !t.byUser) {
      state = 'answer';
      standing = 'differs';
    } else if (t.trust === 'conflict' && ev?.recordsDisagree) {
      state = 'waiting';
      standing = 'waiting';
    }
    if (!state) continue;
    const mention = ev ? [...ev.groups.flatMap((g) => g.mentions)].find((m) => m.factId === f.id) : null;
    const c = cites.get(f.id);
    const rc = t.recordFactId ? recordCites.get(t.recordFactId) : undefined;
    out.push({
      key: `fact:${f.id}`,
      topic: f.type as NotesItem['topic'],
      subject: ev?.subject ?? subjectOf(f),
      what: NOTE_TYPE_WORDS[f.type] ?? f.type,
      state,
      standing,
      notes: { says: mention?.says ?? f.statement, factId: f.id, documentId: f.documentId, documentTitle: f.documentTitle, page: c?.page ?? null, citationId: c?.id ?? null, quote: c?.quote ?? null, date: f.date, precision: f.datePrecision, dateText: f.dateText },
      records: t.recordFactId || ev?.record ? { says: ev?.record?.says ?? t.recordValue ?? t.reason ?? '', factId: t.recordFactId ?? ev?.record?.factId ?? null, documentId: t.recordDocumentId ?? ev?.record?.documentId ?? null, documentTitle: t.recordDocumentTitle ?? ev?.record?.documentTitle ?? null, page: rc?.page ?? ev?.record?.page ?? null, citationId: rc?.id ?? ev?.record?.citationId ?? null } : state === 'waiting' ? { says: ev?.reason ?? 'The clinical records disagree.', factId: null, documentId: null, documentTitle: null, page: null, citationId: null } : null,
      answer: answered,
      drugKey: null,
      eventKey: t.eventKey ?? null,
    });
  }
  return out;
}

/** Every row of stage 2 (medication points first, then the rest), newest first within each. */
export function notesItems(): NotesItem[] {
  const all = [...medicationNotesItems(), ...reconciledNotesItems()];
  return all.sort((a, b) => (a.topic === 'medication' ? 0 : 1) - (b.topic === 'medication' ? 0 : 1) || (b.notes.date ?? '').localeCompare(a.notes.date ?? ''));
}

export function listNotesItems(list: NotesItem['state'], opts: { q?: string } = {}): { items: NotesItem[]; counts: NotesCounts } {
  const q = (opts.q ?? '').trim().toLowerCase();
  const all = notesItems();
  const items = all.filter((i) => i.state === list && matches(q, i.subject, i.what, i.notes.says, i.notes.documentTitle, i.records?.says));
  return { items, counts: countsOf(all) };
}

function countsOf(all: NotesItem[]): NotesCounts {
  let medsOpen = 0;
  for (const t of allDrugTimelines().values()) medsOpen += t.disagreements.filter((d) => d.open).length;
  return { medsOpen, toAnswer: all.filter((i) => i.state === 'answer').length, waiting: all.filter((i) => i.state === 'waiting').length, answered: all.filter((i) => i.state === 'answered').length };
}

export function notesCounts(): NotesCounts {
  return countsOf(notesItems());
}

function factRow(id: string) {
  const f = db().select().from(schema.facts).where(and(eq(schema.facts.id, id), isNull(schema.facts.deletedAt))).get();
  if (!f) throw notFound('detail not found');
  return f;
}

function writeMarker(factId: string, value: { answer: NotesAnswer; by: string | null; at: string; reason?: string } | null): void {
  const f = factRow(factId);
  const a = parseJson<Record<string, unknown>>(f.attributesJson, {});
  if (value) a[NOTES_ANSWER_KEY] = value;
  else delete a[NOTES_ANSWER_KEY];
  db().update(schema.facts).set({ attributesJson: JSON.stringify(a), updatedAt: nowIso() }).where(eq(schema.facts.id, factId)).run();
}

export interface NotesAnswerResult {
  key: string;
  words: string;
  counts: NotesCounts;
  /** For a medication point: the answer's id (Undo). */
  answerId: string | null;
}

/** The user's answer on a row of stage 2. */
export function answerNotesItem(input: { key: string; answer: NotesAnswer; reason?: string | null }, by: string | null): NotesAnswerResult {
  if (!(NOTES_ANSWERS as readonly string[]).includes(input.answer)) throw badRequest('unknown answer');
  if (input.key.startsWith('med:')) {
    const r = answerNotesPoint(input.key, input.answer, by);
    return { key: input.key, words: r.words, counts: notesCounts(), answerId: r.answerId };
  }
  const m = /^fact:(.+)$/.exec(input.key);
  if (!m) throw badRequest('unknown entry');
  const item = notesItems().find((i) => i.key === input.key);
  if (!item) throw notFound('that entry is not there any more');
  if (item.state === 'waiting') throw conflict('The clinical records disagree about this first. Settle that under Records vs records, then come back.');
  if (item.state === 'answered') throw conflict('You already answered this one. Undo it first to answer again.');
  const f = factRow(m[1]);
  // A detail he answered on its own page keeps that answer: the user's verdict outranks anything done here.
  if ((f.status === 'confirmed' || f.status === 'disputed') || (f.verdictNote ?? '').trim()) throw conflict('You already answered this detail on its own page. Change it there.');
  const reason = (input.reason ?? '').trim() || 'My notes are right.';
  if (input.answer === 'notes_right') correctRecord(f.id, reason, by);
  else if (input.answer === 'both' || input.answer === 'not_same') {
    try {
      separateMention(f.id, by);
    } catch (err) {
      // Reconciliation's own refusal names its own buttons; say it in this stage's words (review 2026-10-09).
      if (err instanceof HttpError && /same day as the clinical record/.test(err.message)) throw conflict('This is the same day as the clinical record, so it cannot be another reading. Say which is right: My notes are right, or The records are right.');
      throw err;
    }
  }
  writeMarker(f.id, { answer: input.answer, by, at: nowIso(), ...(input.answer === 'notes_right' ? { reason } : {}) });
  writeAudit({ userName: by, action: 'update', entityType: 'notes_reconcile', entityId: f.id, summary: `${NOTES_ANSWER_WORDS[input.answer]} (${item.subject})` });
  return { key: input.key, words: `${NOTES_ANSWER_WORDS[input.answer]}: ${item.subject}.`, counts: notesCounts(), answerId: null };
}

/** Undo an answer of stage 2: the detail goes back to automatic (a medication point loses its answer). */
export function undoNotesItem(key: string, by: string | null): { key: string; words: string; counts: NotesCounts } {
  const med = /^med:(.+):([^:]+):(start|stop|dose)$/.exec(key);
  if (med) {
    const id = answerIdOf(med[2], med[3] as 'start' | 'stop' | 'dose');
    if (!id) throw notFound('there is no answer to undo');
    undoTimelineAnswer(id, by);
    return { key, words: 'Your answer is taken back.', counts: notesCounts() };
  }
  const m = /^fact:(.+)$/.exec(key);
  if (!m) throw badRequest('unknown entry');
  const f = factRow(m[1]);
  const a = parseJson<Record<string, unknown>>(f.attributesJson, {});
  const mine = a[NOTES_ANSWER_KEY] as { answer?: string; reason?: string } | undefined;
  if (!mine?.answer) throw notFound('there is no answer to undo');
  if (mine.answer !== 'records_right') resetMention(f.id, by);
  // The reason given with "My notes are right" was written here, on a detail that had no note before (answering over
  // a note is refused): it goes with the answer.
  if (mine.answer === 'notes_right' && mine.reason && (factRow(f.id).verdictNote ?? '').trim() === mine.reason) setVerdict(f.id, 'unverified', null, null, { reconcile: true });
  writeMarker(f.id, null);
  writeAudit({ userName: by, action: 'update', entityType: 'notes_reconcile', entityId: f.id, summary: 'Undid an answer on Records vs my notes' });
  return { key, words: 'Your answer is taken back.', counts: notesCounts() };
}

export { STANDINGS };
