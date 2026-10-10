/**
 * Context assembly for Ask the case.
 *
 * - buildLedger: the whole case as ordered text sections, deterministic for a
 *   given database state so the API prompt cache hits between questions.
 *   Every fact line ends with ⟦F:<factId>⟧, every communication line with
 *   ⟦C:<id>⟧, document mentions carry ⟦D:<documentId> p.N⟧ (or ⟦D:<id>⟧ when
 *   no page is known).
 * - collectLabRows: `lab_results` rows merged with lab_result facts for the
 *   ledger's Labs section (series and charts for the tools come from
 *   services/labs.ts).
 * - trustMarkers: every fact line, lab row and imaging study carries its
 *   automatic trust (services/reconcile.ts) first, then the patient's own
 *   answer when he gave one; the Reconciliation section lists the events
 *   that need a source and every inaccurate mention beside its record.
 * - selectPages: pages by relevance (pages_fts, bm25), then by document date in
 *   'everything' mode, within the preset's token budget.
 * - assembleMessages: the Anthropic `messages` for a session, with the ledger
 *   as document blocks on the first user turn (citations enabled, one cache
 *   breakpoint on the last ledger block), pages as further document blocks,
 *   a second breakpoint closing the newest user turn (the tool loop adds a
 *   third, moving one; see MAX_MESSAGE_BREAKPOINTS), and a registry of
 *   document block indexes so citations resolve.
 *
 * Nothing here calls the API. tokens ≈ characters / 3.6.
 */
import { and, asc, desc, eq, inArray, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import type Anthropic from '@anthropic-ai/sdk';
import { db, schema } from '../db';
import { getSetting } from './settings';
import { inferGaps, listRecords } from './records';
import { isFollowUpOverdue, visibleWithRecordSql } from './communications';
import { normaliseQuestions } from './encounters';
import { noteAfterReopen } from './findings';
import { MODEL_SUMMARY_PREFIX } from './inbox';
import { RECORD_CHOSEN_NOTE, listInaccurate, listReconcileEvents, trustFor, trustForRows } from './reconcile';
import { defaultSpecimenFor, effectiveSpecimen, formatRef, isPartSetAside, lineFactStatus, loadLabEntries, normalizeAnalyte, partLabReading, readingView, readLabValues, type LabEntry } from './labs';
import { readingForFact } from './lab-reading';
import { parseLabValue, type LabReadingView } from '../../shared/labvalues';
import type { ComputedView } from '../../shared/labcompute';
import { readStarts } from './medications';
import { timelineLedgerLines } from './med-timeline';
import { normalizeKey, parseJson } from '../util/ids';
import { dateSortKey, formatPartialDate, isPastDue, todayIso, type DatePrecision } from '../../shared/dates';
import { MODEL_CONTEXT_TOKENS, MODEL_PRICES, type ConsultPreset } from '../../shared/constants';
import type { AskContextStats, AskScope, DocIndexEntry, PageRef, ContextPreview } from '../../shared/ask';
import type { InaccurateItem, Mention, ReconcileEvent, TrustInfo } from '../../shared/reconcile';
import { authorWithRole, decodeStateRanges, formatPageRanges, pagesToRanges, parseCommunicationDetails, parseCoverage, type CommunicationDetails, type DocumentCoverage } from '../../shared/schemas/segments';
import { factTier, normalizeTier } from '../../shared/trust';
import type { PageCoverageState } from '../../shared/enums';

// ---------------------------------------------------------------------------
// Tokens, formatting, estimates
// ---------------------------------------------------------------------------

export const CHARS_PER_TOKEN = 3.6;
export const CONTEXT_RESERVE_TOKENS = 20_000;
export const OUTPUT_RESERVE_TOKENS = 30_000;
export const RETRIEVAL_MAX_PAGES = 40;

export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export const tokF = (id: string): string => `⟦F:${id}⟧`;
export const tokC = (id: string): string => `⟦C:${id}⟧`;
export const tokD = (id: string, page?: number | null): string => (page ? `⟦D:${id} p.${page}⟧` : `⟦D:${id}⟧`);

/** Matches ⟦F:id⟧, ⟦C:id⟧, ⟦D:id p.N⟧ and ⟦D:id⟧. */
export const TOKEN_RE = /⟦([FCD]):([0-9a-zA-Z_-]+)(?:\s+p\.(\d+))?⟧/g;

export interface ParsedToken {
  kind: 'F' | 'C' | 'D';
  id: string;
  page: number | null;
  start: number;
  end: number;
}

export function parseTokens(text: string): ParsedToken[] {
  const out: ParsedToken[] = [];
  const re = new RegExp(TOKEN_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({ kind: m[1] as ParsedToken['kind'], id: m[2], page: m[3] ? Number(m[3]) : null, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export function fmtDate(iso: string | null | undefined, precision?: string | null): string {
  if (!iso) return 'undated';
  return formatPartialDate(iso, (precision as 'day' | 'month' | 'year' | 'unknown' | undefined) ?? undefined);
}

// The case's local time (2026-10-08, lab check): the helpers live in util/localtime.ts (records and findings use them
// too); re-exported here, where the clinician's context was first written with them.
export { caseTimeZone, localDayOf, localStamp, localTimeOf } from '../util/localtime';
import { localDayOf, localStamp, localTimeOf } from '../util/localtime';

function clip(s: string | null | undefined, n: number): string {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function joinBits(bits: Array<string | null | undefined | false>, sep = ' · '): string {
  return bits.filter((b): b is string => Boolean(b && String(b).trim())).join(sep);
}

// ---------------------------------------------------------------------------
// Notes written by the patient or his team
// ---------------------------------------------------------------------------

/** The longest single note the ledger and the tools print, in characters. */
export const NOTE_MAX_CHARS = 1500;

/** The marker on text the patient or his team wrote on an item (the app stores no author for a note). */
export const NOTE_AUTHOR = '(patient or team)';

/**
 * `label (patient or team): "text"`: text the patient or his team wrote on
 * an item, in full up to NOTE_MAX_CHARS, on one line. Null when empty.
 */
export function userNote(text: string | null | undefined, label = 'note'): string | null {
  const t = clip(text, NOTE_MAX_CHARS);
  return t ? `${label} ${NOTE_AUTHOR}: "${t}"` : null;
}

function present<T>(bits: Array<T | null | undefined | false>): T[] {
  return bits.filter((b): b is T => Boolean(b));
}

const sameText = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const n = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return Boolean(n(a)) && n(a) === n(b);
};

/** The texts a row made from a document fact copied from it: the statement and the fields a medication or imaging row takes over. */
export interface SourceFactText {
  statement: string;
  attributes: Record<string, unknown>;
  verdictNote: string | null;
  /** Deleted or superseded: its check note no longer speaks for the row. */
  deleted: boolean;
}

/** Statement, attributes and check note of these facts, deleted and superseded ones included (a row keeps the text it copied). */
export function loadFactTexts(ids: Iterable<string | null | undefined>): Map<string, SourceFactText> {
  const want = [...new Set([...ids].filter((x): x is string => Boolean(x)))];
  const out = new Map<string, SourceFactText>();
  const d = db();
  for (let i = 0; i < want.length; i += 400) {
    const rows = d
      .select({ id: schema.facts.id, statement: schema.facts.statement, attributesJson: schema.facts.attributesJson, verdictNote: schema.facts.verdictNote, deletedAt: schema.facts.deletedAt, status: schema.facts.status })
      .from(schema.facts)
      .where(inArray(schema.facts.id, want.slice(i, i + 400)))
      .all();
    for (const r of rows) out.set(r.id, { statement: r.statement, attributes: parseJson<Record<string, unknown>>(r.attributesJson, {}), verdictNote: r.verdictNote, deleted: Boolean(r.deletedAt) || r.status === 'superseded' });
  }
  return out;
}

/** What a row made from these facts may have copied word for word from them (so not the person's own words). */
export function sourceTexts(...facts: Array<SourceFactText | null | undefined>): string[] {
  const out: string[] = [];
  for (const f of facts) {
    if (!f) continue;
    out.push(f.statement);
    const a = (k: string): string | null => (typeof f.attributes[k] === 'string' && (f.attributes[k] as string).trim() ? (f.attributes[k] as string) : null);
    const effect = a('effect');
    const reason = a('reason_stopped');
    const comparison = a('comparison');
    // services/medications.ts copies effect and reason_stopped (and writes "Reason stopped: …" events);
    // services/imaging.ts writes "Compared with: …" into the notes of a study made from a fact.
    if (effect) out.push(effect);
    if (reason) out.push(reason, `Reason stopped: ${reason}`);
    if (comparison) out.push(`Compared with: ${comparison}`);
  }
  return out;
}

/**
 * A free-text field of a row the patient or his team may have written, or
 * that the app copied from the document fact the row was made from: marked
 * as theirs unless it is word for word one of `sources`.
 */
export function fieldText(text: string | null | undefined, label: string, sources: string[] = []): string | null {
  if (!text || !text.trim()) return null;
  return sources.some((s) => sameText(text, s)) ? `${label}: ${clip(text, NOTE_MAX_CHARS)}` : userNote(text, label);
}

/**
 * The verdict note the app itself writes on a patient statement it creates
 * (services/facts.ts createPatientStatementFor). Not the patient's words.
 */
export const APP_PATIENT_STATEMENT_NOTE = 'Patient statement entered to take precedence over a recorded assessment.';

/**
 * The part of a fact's check note the patient or his team wrote: the app's own sentence (at the start) is left
 * out. That is the patient-statement sentence, or "This record is right." (RECORD_CHOSEN_NOTE, services/reconcile.ts),
 * which the app keeps as the note of a clinical record chosen with "This one is right" and no reason, alone or
 * followed by the earlier note it kept ("This record is right.\n\nEarlier note: …").
 */
export function personVerdictNote(note: string | null | undefined): string | null {
  const t = (note ?? '').trim();
  if (!t) return null;
  let rest = t.startsWith(APP_PATIENT_STATEMENT_NOTE) ? t.slice(APP_PATIENT_STATEMENT_NOTE.length).trim() : t;
  if (rest === RECORD_CHOSEN_NOTE || rest.startsWith(`${RECORD_CHOSEN_NOTE}\n`)) rest = rest.slice(RECORD_CHOSEN_NOTE.length).trim();
  return rest || null;
}

/** The note on a fact's check as the ledger prints it on the fact's own line. */
export function factNoteBit(note: string | null | undefined): string | null {
  return userNote(personVerdictNote(note));
}

/** The note on a fact's check, printed on a row linked to that fact. */
export function checkNote(note: string | null | undefined): string | null {
  return userNote(personVerdictNote(note), 'note on the check');
}

/** The provenance prefix a CSV import writes into lab notes (services/import-csv.ts, kept by labs.ts keepImportProvenance). */
const LAB_IMPORT_PREFIX = /^imported from [^;]*/;

/** A lab row's notes split into the import provenance the app wrote and the person's own note after it. */
export function splitLabNotes(notes: string | null | undefined): { provenance: string | null; note: string | null } {
  const t = (notes ?? '').trim();
  const m = t.match(LAB_IMPORT_PREFIX);
  if (!m) return { provenance: null, note: t || null };
  const rest = t.slice(m[0].length).replace(/^;\s*/, '').trim();
  return { provenance: clip(m[0], 300), note: rest || null };
}

/** Notes on a lab row: the import provenance (kept, as the app wrote it), the person's note, and the note on the linked fact's check. */
export function labNoteBits(notes: string | null | undefined, factNote: string | null | undefined): string[] {
  const { provenance, note } = splitLabNotes(notes);
  return present([provenance, userNote(note), checkNote(factNote)]);
}

/** A communication's summary and outcome: a summary the model wrote carries its own label and is not the patient's. */
export function communicationNoteBits(c: { summary: string | null; outcome: string | null }): string[] {
  const summary = c.summary?.trim() ? (c.summary.trim().startsWith(MODEL_SUMMARY_PREFIX.trim()) ? clip(c.summary, NOTE_MAX_CHARS) : userNote(c.summary, 'summary')) : null;
  return present([summary, userNote(c.outcome, 'outcome')]);
}

/** The promised follow-up of a communication with its state, e.g. `(OVERDUE (due 2024-04-19), owner X)`. */
export function followUpBit(promised: string | null | undefined, state: string): string | null {
  const t = clip(promised, NOTE_MAX_CHARS);
  return t ? `follow-up promised ${NOTE_AUTHOR}: "${t}" (${state})` : null;
}

/** An encounter's location, prep notes, questions with their answers, and outcomes. */
export function encounterNoteBits(e: { location: string | null; prepNotes: string | null; questionsJson: string; outcomes: string | null }): string[] {
  const questions = normaliseQuestions(parseJson<unknown>(e.questionsJson, []));
  const qs = questions.map((q, i) => `${i + 1}. "${clip(q.text, NOTE_MAX_CHARS)}"${q.asked ? ' (asked)' : ''}${q.answer ? ` answer: "${clip(q.answer, NOTE_MAX_CHARS)}"` : ''}`);
  return present([
    e.location?.trim() ? clip(e.location, 500) : null,
    userNote(e.prepNotes, 'prep'),
    qs.length ? `questions ${NOTE_AUTHOR}: ${qs.join('; ')}` : null,
    userNote(e.outcomes, 'outcomes'),
  ]);
}

/**
 * The texts a task made from a finding starts with, by finding id: the
 * finding's own words (services/findings.ts findingToTask copies "why it
 * matters" into the detail unless the person typed one). Deleted findings
 * included: the task keeps the text it copied.
 */
export function findingTaskTexts(tasks: Array<{ sourceType: string; sourceId: string | null }>): Map<string, string[]> {
  const want = [...new Set(tasks.filter((t) => t.sourceType === 'finding' && t.sourceId).map((t) => t.sourceId as string))];
  const out = new Map<string, string[]>();
  const d = db();
  for (let i = 0; i < want.length; i += 400) {
    const rows = d
      .select({ id: schema.findings.id, title: schema.findings.title, whyItMatters: schema.findings.whyItMatters, detail: schema.findings.detail })
      .from(schema.findings)
      .where(inArray(schema.findings.id, want.slice(i, i + 400)))
      .all();
    for (const r of rows) out.set(r.id, present([r.whyItMatters, r.detail, r.title]));
  }
  return out;
}

/**
 * A task's detail. The person's own words, marked: a task entered by hand,
 * a task added from a visit (its detail is typed in the task dialog), and a
 * task made from a finding whose detail differs from the finding's own text
 * (`findingTexts`, from findingTaskTexts). Text the app or the model composed
 * (a task made from an answer, a follow-up or a gap, or a finding's text
 * copied as it was) is printed unmarked.
 */
export function taskDetailBit(t: { detail: string | null; sourceType: string; sourceId: string | null }, findingTexts?: Map<string, string[]>): string | null {
  if (!t.detail?.trim()) return null;
  const fromFinding = t.sourceType === 'finding' && t.sourceId ? findingTexts?.get(t.sourceId) : undefined;
  const typed = (t.sourceType === 'manual' && !t.sourceId) || t.sourceType === 'encounter' || (fromFinding !== undefined && !fromFinding.some((s) => sameText(t.detail, s)));
  return typed ? userNote(t.detail, 'detail') : `detail: ${clip(t.detail, NOTE_MAX_CHARS)}`;
}

/** The patient's note on a finding (the engine's own clearance line is not theirs and is left out). */
export function findingNoteBit(verdictNote: string | null | undefined): string | null {
  return userNote(noteAfterReopen(verdictNote));
}

/** A medication's effect, reason stopped and notes. `sources`: the texts of the fact the row was made from. */
export function medicationNoteBits(m: { effect: string | null; reasonStopped: string | null; notes: string | null }, sources: string[] = []): string[] {
  return present([fieldText(m.effect, 'effect', sources), fieldText(m.reasonStopped, 'stopped because', sources), userNote(m.notes)]);
}

/** A medication event's detail: as written when copied from the fact the event or its medication was made from, else marked as the patient's or team's. */
export function medEventDetailBit(detail: string | null | undefined, sources: string[] = []): string | null {
  if (!detail || !detail.trim()) return null;
  return sources.some((s) => sameText(detail, s)) ? clip(detail, NOTE_MAX_CHARS) : userNote(detail, 'detail');
}

/** An imaging study's notes (marked unless copied from its fact) and the note on its fact's check. */
export function imagingNoteBits(notes: string | null | undefined, sources: string[], factNote: string | null | undefined): string[] {
  return present([fieldText(notes, 'note', sources), checkNote(factNote)]);
}

/** A document's tags and notes, both set by the patient or his team. */
export function documentNoteBits(notes: string | null | undefined, tags: string[]): string[] {
  const t = tags.map((x) => x.trim()).filter(Boolean);
  return present([t.length ? `tags ${NOTE_AUTHOR}: ${clip(t.join(', '), NOTE_MAX_CHARS)}` : null, userNote(notes)]);
}

/** A daily log day: the numbers, then the tags and notes the patient or his team wrote. */
export function dailyLogBits(r: { sleepHours: number | null; sleepQuality: number | null; energy: number | null; notes: string | null; tagsJson: string }): string[] {
  const tags = parseJson<string[]>(r.tagsJson, []).map((x) => String(x).trim()).filter(Boolean);
  return present([
    r.sleepHours != null ? `sleep ${r.sleepHours} h` : null,
    r.sleepQuality != null ? `sleep quality ${r.sleepQuality}/10` : null,
    r.energy != null ? `energy ${r.energy}/10` : null,
    tags.length ? `tags ${NOTE_AUTHOR}: ${clip(tags.join(', '), NOTE_MAX_CHARS)}` : null,
    userNote(r.notes),
  ]);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface LedgerFact {
  id: string;
  type: string;
  statement: string;
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  dateEnd: string | null;
  status: string;
  /** original | summary when the patient confirmed it (against the original record, or only against a summary); null otherwise. */
  verdictBasis?: string | null;
  /** The note the patient or his team wrote when checking it (why it was confirmed, disputed or left unsure). */
  verdictNote?: string | null;
  origin: string;
  confidence: number;
  attributes: Record<string, unknown>;
  subjectKey: string | null;
  personId: string | null;
  sourceDocumentId: string | null;
  documentTitle: string | null;
  /** primary | patient | compilation | external | unknown, from the source document. */
  documentTier: string | null;
  /** patient | clinician | compiler | unknown */
  assertedBy: string;
  /** objective | subjective | unknown as stored. */
  objectivity: string;
  /** The patient statement that takes precedence over this one in the consult, when set. */
  overriddenByFactId: string | null;
  overrideReason: string | null;
  /**
   * Whether that patient statement is still live (not deleted, disputed or
   * superseded, its document not deleted). Set by loadLedgerFacts; a stale
   * override prints no marker. Unset means not checked (treated as live).
   */
  overrideLive?: boolean;
  createdAt: string;
  cite: { documentId: string; pageNumber: number; quote: string; verified: boolean } | null;
  /** The automatic trust level (services/reconcile.ts), attached by loadLedgerFacts; unset when built by hand. */
  trust?: TrustInfo | null;
}

export interface PersonLite {
  id: string;
  name: string;
  kind: string;
  role: string | null;
  specialty: string | null;
  institutionId: string | null;
  phone: string | null;
  email: string | null;
  portal: string | null;
  fax: string | null;
  address: string | null;
  preferredChannel: string | null;
  notes: string | null;
  aliases: string[];
}

/**
 * Whether a stored partial date (YYYY, YYYY-MM or YYYY-MM-DD) overlaps a scope
 * window. Each bound is compared at the coarser of the two precisions, so a
 * year-only date is kept by any window that touches that year and a
 * month-only date by any window that touches that month (on both bounds
 * alike). Undated rows are kept.
 */
export function partialDateInWindow(iso: string | null | undefined, from?: string | null, to?: string | null): boolean {
  if (!iso) return true;
  if (from) {
    const n = Math.min(iso.length, from.length);
    if (iso.slice(0, n) < from.slice(0, n)) return false;
  }
  if (to) {
    const n = Math.min(iso.length, to.length);
    if (iso.slice(0, n) > to.slice(0, n)) return false;
  }
  return true;
}

const partialWithin = partialDateInWindow;

/**
 * Of the given fact ids, those still live: not deleted, not disputed or
 * superseded, and their source document (if any) not deleted. The rule the
 * precedence engine and the packet apply to an overriding patient statement.
 */
export function liveFactIds(ids: Iterable<string | null | undefined>): Set<string> {
  const want = [...new Set([...ids].filter((x): x is string => Boolean(x)))];
  const out = new Set<string>();
  const d = db();
  for (let i = 0; i < want.length; i += 400) {
    const part = want.slice(i, i + 400);
    const rows = d
      .select({ id: schema.facts.id })
      .from(schema.facts)
      .leftJoin(schema.documents, eq(schema.documents.id, schema.facts.sourceDocumentId))
      .where(and(inArray(schema.facts.id, part), isNull(schema.facts.deletedAt), notInArray(schema.facts.status, ['disputed', 'superseded']), or(isNull(schema.facts.sourceDocumentId), isNull(schema.documents.deletedAt))!))
      .all();
    for (const r of rows) out.add(r.id);
  }
  return out;
}

/** Live, non-superseded facts whose document (if any) is not deleted, oldest first, with their best citation. */
export function loadLedgerFacts(scope?: AskScope): LedgerFact[] {
  const d = db();
  const f = schema.facts;
  const conds = [isNull(f.deletedAt), ne(f.status, 'superseded'), or(isNull(f.sourceDocumentId), isNull(schema.documents.deletedAt))!];
  const rows = d
    .select({
      id: f.id,
      type: f.type,
      statement: f.statement,
      date: f.date,
      datePrecision: f.datePrecision,
      dateText: f.dateText,
      dateEnd: f.dateEnd,
      status: f.status,
      verdictBasis: f.verdictBasis,
      verdictNote: f.verdictNote,
      origin: f.origin,
      confidence: f.confidence,
      attributesJson: f.attributesJson,
      subjectKey: f.subjectKey,
      personId: f.personId,
      sourceDocumentId: f.sourceDocumentId,
      createdAt: f.createdAt,
      documentTitle: schema.documents.title,
      documentTier: schema.documents.sourceTier,
      assertedBy: f.assertedBy,
      objectivity: f.objectivity,
      overriddenByFactId: f.overriddenByFactId,
      overrideReason: f.overrideReason,
    })
    .from(f)
    .leftJoin(schema.documents, eq(schema.documents.id, f.sourceDocumentId))
    .where(and(...conds))
    .all();
  const docSet = scope?.documentIds?.length ? new Set(scope.documentIds) : null;
  const cites = d
    .select({ factId: schema.citations.factId, documentId: schema.citations.documentId, pageNumber: schema.citations.pageNumber, quote: schema.citations.quote, verified: schema.citations.verified })
    .from(schema.citations)
    .where(sql`${schema.citations.factId} is not null`)
    .orderBy(desc(schema.citations.verified), asc(schema.citations.pageNumber), asc(schema.citations.createdAt))
    .all();
  const firstCite = new Map<string, LedgerFact['cite']>();
  for (const c of cites) {
    if (!c.factId || firstCite.has(c.factId)) continue;
    firstCite.set(c.factId, { documentId: c.documentId, pageNumber: c.pageNumber, quote: c.quote, verified: Boolean(c.verified) });
  }
  // The overriding statements are resolved once (they may sit outside the scope).
  const live = liveFactIds(rows.map((r) => r.overriddenByFactId));
  const out: LedgerFact[] = [];
  for (const r of rows) {
    if (docSet && (!r.sourceDocumentId || !docSet.has(r.sourceDocumentId))) continue;
    if (!partialWithin(r.date, scope?.from, scope?.to)) continue;
    const overrideLive = r.overriddenByFactId ? live.has(r.overriddenByFactId) : undefined;
    out.push({ ...r, overrideLive, attributes: parseJson<Record<string, unknown>>(r.attributesJson, {}), cite: firstCite.get(r.id) ?? null });
  }
  // Each fact's automatic trust, from the reconciliation's model (one cheap query when nothing changed).
  const trust = trustForRows(out.map((f) => ({ id: f.id, status: f.status, verdictBasis: f.verdictBasis ?? null, verdictNote: f.verdictNote ?? null, documentTier: f.documentTier })));
  for (const f of out) f.trust = trust.get(f.id) ?? null;
  out.sort((a, b) => dateSortKey(a.date).localeCompare(dateSortKey(b.date)) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return out;
}

export function loadPeople(): Map<string, PersonLite> {
  const rows = db().select().from(schema.people).where(isNull(schema.people.deletedAt)).all();
  const m = new Map<string, PersonLite>();
  for (const r of rows) {
    m.set(r.id, { id: r.id, name: r.name, kind: r.kind, role: r.role, specialty: r.specialty, institutionId: r.institutionId, phone: r.phone, email: r.email, portal: r.portal, fax: r.fax, address: r.address, preferredChannel: r.preferredChannel, notes: r.notes, aliases: parseJson<string[]>(r.aliasesJson, []) });
  }
  return m;
}

export function loadDocumentTitles(): Map<string, { title: string; date: string | null; datePrecision: string; category: string; tier: string | null; pageCount: number; notes: string | null; tags: string[] }> {
  const rows = db()
    .select({ id: schema.documents.id, title: schema.documents.title, date: schema.documents.documentDate, datePrecision: schema.documents.documentDatePrecision, category: schema.documents.category, tier: schema.documents.sourceTier, pageCount: schema.documents.pageCount, notes: schema.documents.notes, tagsJson: schema.documents.tagsJson })
    .from(schema.documents)
    .where(isNull(schema.documents.deletedAt))
    .all();
  return new Map(rows.map((r) => [r.id, { title: r.title, date: r.date, datePrecision: r.datePrecision, category: r.category, tier: r.tier ?? null, pageCount: r.pageCount, notes: r.notes, tags: parseJson<unknown[]>(r.tagsJson, []).map(String) }]));
}

/**
 * Ids of soft-deleted documents. A lab row or imaging study on one is hidden,
 * as the Labs and Imaging pages hide it (services/labs.ts, imaging.ts); a row
 * with no document, or naming no stored document, stays.
 */
export function deletedDocumentIds(): Set<string> {
  return new Set(
    db()
      .select({ id: schema.documents.id })
      .from(schema.documents)
      .where(sql`${schema.documents.deletedAt} is not null`)
      .all()
      .map((r) => r.id),
  );
}

// ---------------------------------------------------------------------------
// Lab rows for the ledger (lab_results rows + lab_result facts)
// ---------------------------------------------------------------------------

export interface LabRow {
  labResultId: string | null;
  factId: string | null;
  factStatus: string | null;
  /** original | summary for a confirmed fact; null or unset otherwise. */
  factBasis?: string | null;
  analyte: string;
  analyteKey: string;
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  value: number | null;
  valueText: string | null;
  unit: string | null;
  refLow: number | null;
  refHigh: number | null;
  refText: string | null;
  flag: string | null;
  specimen: string | null;
  labName: string | null;
  documentId: string | null;
  documentTitle: string | null;
  pageNumber: number | null;
  /** The lab_results row's notes as stored (an import provenance prefix, then the person's note). */
  notes?: string | null;
  /** The note on the linked fact's check. */
  factNote?: string | null;
  /** The automatic trust of the linked fact (services/reconcile.ts); unset for a row typed by hand. */
  trust?: TrustInfo | null;
  /** Source tier of the linked fact's document (a clinical record the patient chose reads as his choice); unset when unknown. */
  factTier?: string | null;
  /**
   * A row standing for a clinical record's value (its linked fact is the record's, from another document than the
   * row's own, e.g. a summary's row the check set aside as a copy): the record's document and page, cited beside it.
   */
  recordDocumentId?: string | null;
  recordPageNumber?: number | null;
  /**
   * Notes the patient or his team wrote on copies of this value in other documents: rows whose detail the check
   * set aside as a copy of this record (labCopyNoteBit). The copy itself is not printed (the value once).
   */
  copyNotes?: string[];
  /**
   * The row was changed by hand (value, unit or date) away from its own detail (labs.ts labRowEditedFrom): what the
   * detail reads. The row is then the patient's own value: printed with no trust, marked as changed by hand.
   */
  editedFrom?: string | null;
  /** With editedFrom: the detail is a clinical record's own (labs.ts LabEntry.editedFromRecord): that document's id. */
  editedFromRecord?: string | null;
  /**
   * One test read out of a line that holds several (labs.ts readLabLine): the line as written ("CSF opening pressure /
   * protein: OP 17; protein 52"). The row's ids still name the original row or fact.
   */
  splitFrom?: string | null;
  /** With splitFrom: this test's 0-based place in the line (the Labs page's part id is `<row or fact id>#<partIndex>`). */
  partIndex?: number | null;
  /** A line that names several tests the app could not tell apart (kept whole, not compared with the records). */
  combined?: boolean;
  /**
   * The value as read (src/shared/labvalues.ts; the Labs page's own reading, LabEntry.reading): the value as printed,
   * a limit never a measurement, the range and flag as printed, a flag worked out from the value's own range, the
   * collected and resulted dates apart, and the warnings. What labRowLine prints.
   */
  reading?: LabReadingView | null;
  /**
   * A value the patient computed from printed values (2026-10-09, src/shared/labcompute.ts): its label, formula, each input with
   * its page, and the inputs that changed since. labRowLine says "computed by the patient" and cites the inputs' pages.
   */
  computed?: AskComputed | null;
}

/** What the clinician reads of a computed value (labRowLine). */
export interface AskComputed {
  label: string;
  expression: string;
  pairing: string;
  inputs: Array<{ slotLabel: string; documentId: string; page: number; words: string }>;
  changes: string[];
}

/** A Labs entry's computed view as the clinician reads it; null for any other value. */
export function askComputedOf(view: ComputedView | null | undefined): AskComputed | null {
  if (!view) return null;
  const r = view.record;
  return {
    label: r.label,
    expression: r.formula.expression,
    pairing: r.pairing.words,
    inputs: r.inputs.map((i) => ({ slotLabel: i.slotLabel, documentId: i.citation.documentId, page: i.citation.page, words: i.conversion.words || `${i.valueShown}${i.unit ? ` ${i.unit}` : ''}` })),
    changes: view.changes,
  };
}

/**
 * A ledger lab row read for the tests it holds: one row per test when its line holds several ("OP 17; protein 52" is
 * Opening pressure 17 and CSF protein 52, each with the line as written in splitFrom), else the row itself (marked
 * combined when its line names several tests that cannot be told apart). The same reading as the Labs page's
 * (labs.ts expandLabEntry). `raw` is the value as written (a fact's value text even when it has a number).
 */
export function labRowParts(r: LabRow, raw: string | null = r.valueText, specimenAssumed = false): LabRow[] {
  const specimen = r.specimen ?? defaultSpecimenFor(r.analyte);
  const read = readLabValues({
    analyte: r.analyte,
    specimen,
    // No sample stated (a fact that names none, or a row still on the sample assumed for its detail).
    specimenAssumed: specimenAssumed || !r.specimen,
    valueText: raw ?? (r.value != null ? String(r.value) : null),
    valueNum: r.value,
    unit: r.unit,
    flag: r.flag,
    refLow: r.refLow,
    refHigh: r.refHigh,
    refText: r.refText,
  });
  if (read.length === 1 && !read[0].splitFrom) return [{ ...r, specimen: read[0].specimen, ...(read[0].combined ? { combined: true } : {}) }];
  // Each part read on its own text, with the line's dates and source (labs.ts partLabReading): never the line's range.
  const line = { reading: r.reading ?? null, date: r.date || r.dateText ? { iso: r.date, precision: (r.datePrecision || 'unknown') as DatePrecision, text: r.dateText } : null };
  return read.map((p) => {
    const reading = readingView(partLabReading(p, line));
    return {
      ...r,
      analyte: p.analyte,
      analyteKey: p.analyteKey,
      // The part's own sample ("serum glucose" on a CSF line is blood work), else the line's.
      specimen: p.specimen,
      value: reading.measurement,
      valueText: reading.valueShown,
      unit: p.unit,
      refLow: null,
      refHigh: null,
      refText: null,
      flag: p.flag,
      splitFrom: p.splitFrom!.text,
      partIndex: p.splitFrom!.index,
      combined: false,
      reading,
    };
  });
}

/**
 * A note the patient or his team wrote on a lab row whose detail the reconciliation set aside automatically: a copy
 * of a clinical record's value (accurate), or a value the record contradicts (inaccurate). The row is not a current
 * value, so its note travels with the record's line (a copy) or with the inaccurate mention in Reconciliation.
 */
export interface SetAsideLabNote {
  rowId: string;
  /** The row's own detail (superseded by the pass). */
  factId: string;
  /** The clinical record's detail it was compared with. */
  recordFactId: string;
  documentId: string | null;
  documentTitle: string | null;
  /** The person's own note (the import provenance the app wrote is left out). */
  note: string;
  trust: TrustInfo;
  /**
   * The row was changed by hand to exactly the value of the record's line (labs.ts LabEntry.copyOf): a copy of that
   * line, whatever its own detail said. Its note always goes on that line, never beside an inaccurate mention.
   */
  copy?: boolean;
}

/**
 * Notes on lab rows whose detail the reconciliation set aside automatically (see SetAsideLabNote), read from the Labs
 * page's own entries (labs.ts loadLabEntries; pass them when already loaded) so the ledger, the tools and the Labs page
 * agree on every row. Rows without a note are skipped. A row changed by hand away from its detail (entry.editedFrom)
 * is the patient's own value, listed with its note on its own line: never folded into the record's line. A row changed
 * by hand to exactly the record's value (entry.copyOf) is a copy of the record's line: its note goes there.
 */
export function setAsideLabNotes(entries: LabEntry[] = loadLabEntries()): SetAsideLabNote[] {
  const out: SetAsideLabNote[] = [];
  for (const e of entries) {
    if (e.source !== 'row' || !e.labResultId || !e.factId || e.factDeleted || e.editedFrom || e.factStatus !== 'superseded') continue;
    // One test of a line set aside by the part check: the row (with any note of the person's) stays listed for its other tests.
    if (e.partCheck) continue;
    // A row read as several tests carries one note: it is listed once, with its first part.
    if (e.splitFrom && e.splitFrom.index > 0) continue;
    const note = splitLabNotes(e.notes).note;
    if (!note) continue;
    const base = { rowId: e.labResultId, factId: e.factId, documentId: e.documentId, documentTitle: e.documentTitle, note };
    const t = e.trust;
    if (e.copyOf) {
      out.push({ ...base, recordFactId: e.copyOf, trust: t ?? { trust: 'accurate', byUser: false, recordFactId: e.copyOf }, copy: true });
      continue;
    }
    // Only the pass's own judgement (a copy, or a contradiction): a duplicate merged by hand reads "replaced".
    if (!t || t.byUser || !t.recordFactId || t.recordFactId === e.factId || (t.trust !== 'accurate' && t.trust !== 'inaccurate')) continue;
    out.push({ ...base, recordFactId: t.recordFactId, trust: t });
  }
  return out;
}

/** The note on a copy, as printed on the record's line: `note on a copy from <document> ⟦D:id⟧ (patient or team): "…"`. */
export function labCopyNoteBit(c: Pick<SetAsideLabNote, 'documentId' | 'documentTitle' | 'note'>): string | null {
  return userNote(c.note, `note on a copy from ${clip(c.documentTitle ?? 'another document', 80)}${c.documentId ? ` ${tokD(c.documentId)}` : ''}`);
}

/**
 * Notes on copies of these rows' values carried onto them: each copy's note goes on the line of the record it was set
 * aside as a copy of (not on the copy's own row when that row stands for the record itself). Returns the copies whose
 * record has no line here.
 */
export function attachCopyNotes(rows: LabRow[], copies: SetAsideLabNote[] = setAsideLabNotes()): SetAsideLabNote[] {
  const byFact = new Map<string, LabRow[]>();
  for (const r of rows) {
    if (!r.factId) continue;
    const list = byFact.get(r.factId);
    if (list) list.push(r);
    else byFact.set(r.factId, [r]);
  }
  const rest: SetAsideLabNote[] = [];
  for (const c of copies) {
    if (c.trust.trust !== 'accurate' && !c.copy) continue;
    const lines = byFact.get(c.recordFactId) ?? [];
    // The copy's own row standing for the record already carries its note.
    if (lines.some((r) => r.labResultId === c.rowId)) continue;
    const target = lines[0];
    const bit = labCopyNoteBit(c);
    if (!target) rest.push(c);
    else if (bit) (target.copyNotes ??= []).push(bit);
  }
  return rest;
}

/**
 * The linked detail's document and page on rows whose linked fact is not from the row's own document: a row standing
 * for a clinical record's value (the row's own document is, say, the summary it was imported from; its fact is the
 * record's). The line then cites both documents. `known`: facts already loaded (their source document and citation).
 * `tierOf`: a document's source tier, to fill the tier of a linked fact not loaded (factTier) when it is unset.
 */
export function attachRecordCites(rows: LabRow[], known?: Map<string, Pick<LedgerFact, 'cite' | 'sourceDocumentId'>>, tierOf?: (documentId: string) => string | null | undefined): void {
  const linked = rows.filter((r) => r.factId && (r.documentId || (tierOf && r.factTier === undefined)));
  if (!linked.length) return;
  const info = new Map<string, { documentId: string | null; cite: { documentId: string; pageNumber: number } | null }>();
  const missing: string[] = [];
  for (const r of linked) {
    const f = known?.get(r.factId!);
    if (f) info.set(r.factId!, { documentId: f.sourceDocumentId, cite: f.cite ? { documentId: f.cite.documentId, pageNumber: f.cite.pageNumber } : null });
    else missing.push(r.factId!);
  }
  const want = [...new Set(missing)];
  for (let i = 0; i < want.length; i += 400) {
    const part = want.slice(i, i + 400);
    for (const f of db().select({ id: schema.facts.id, documentId: schema.facts.sourceDocumentId }).from(schema.facts).where(inArray(schema.facts.id, part)).all()) info.set(f.id, { documentId: f.documentId, cite: null });
    const cites = db()
      .select({ factId: schema.citations.factId, documentId: schema.citations.documentId, pageNumber: schema.citations.pageNumber })
      .from(schema.citations)
      .where(inArray(schema.citations.factId, part))
      .orderBy(desc(schema.citations.verified), asc(schema.citations.pageNumber), asc(schema.citations.createdAt))
      .all();
    for (const c of cites) {
      const x = c.factId ? info.get(c.factId) : undefined;
      if (x && !x.cite) x.cite = { documentId: c.documentId, pageNumber: c.pageNumber };
    }
  }
  for (const r of linked) {
    const x = info.get(r.factId!);
    const doc = x?.documentId ?? x?.cite?.documentId ?? null;
    if (tierOf && r.factTier === undefined && x?.documentId) r.factTier = tierOf(x.documentId) ?? null;
    if (!doc || !r.documentId || doc === r.documentId) continue;
    r.recordDocumentId = doc;
    r.recordPageNumber = x?.cite && x.cite.documentId === doc ? x.cite.pageNumber : null;
  }
}

/**
 * A ledger lab fact read through the one accessor (services/lab-reading.ts), for a fact the Labs page does not list as
 * an entry of its own (normally every unimported fact has one).
 */
function factReading(f: LedgerFact, docs: ReturnType<typeof loadDocumentTitles>): LabReadingView {
  const documentId = f.sourceDocumentId ?? f.cite?.documentId ?? null;
  const doc = documentId ? docs.get(documentId) : undefined;
  return readingView(
    readingForFact(
      { id: f.id, attributesJson: JSON.stringify(f.attributes ?? {}), date: f.date, datePrecision: f.datePrecision, dateText: f.dateText, status: f.status, sourceDocumentId: f.sourceDocumentId, origin: f.origin },
      {
        cite: f.cite && f.cite.documentId === documentId ? { id: '', documentId: f.cite.documentId, pageNumber: f.cite.pageNumber, verified: f.cite.verified, quote: f.cite.quote } : null,
        documentTier: doc?.tier ?? f.documentTier ?? null,
        documentDate: doc?.date ? { iso: doc.date, precision: (doc.datePrecision || 'unknown') as DatePrecision, text: null } : null,
        hasDocument: Boolean(documentId),
      },
    ),
  );
}

/**
 * All lab rows: lab_results merged with lab_result facts (a fact linked from a
 * row appears once). The ledger passes the lab facts and document titles it
 * already loaded for the same scope so they are not read twice.
 */
export function collectLabRows(scope?: AskScope, labFacts?: LedgerFact[], docTitles?: ReturnType<typeof loadDocumentTitles>, labEntries?: LabEntry[]): LabRow[] {
  const d = db();
  const docs = docTitles ?? loadDocumentTitles();
  const docSet = scope?.documentIds?.length ? new Set(scope.documentIds) : null;
  const facts = labFacts ?? loadLedgerFacts(scope).filter((f) => f.type === 'lab_result');
  const factById = new Map(facts.map((f) => [f.id, f]));
  const used = new Set<string>();
  const out: LabRow[] = [];
  const rows = d.select().from(schema.labResults).where(isNull(schema.labResults.deletedAt)).all();
  const deletedDocs = deletedDocumentIds();
  // Each row as the Labs page reads it (labs.ts loadLabEntries): a row whose detail the reconciliation set aside as an
  // exact copy of the clinical record stands for the record's detail (the keeper), so its note stays with the value. A
  // row whose detail was replaced by another value (a newer reading, or a value the record contradicts), set aside as
  // a copy written otherwise (another unit, no specimen named, a rougher number), or deleted is not a current value and
  // is skipped; the clinical record's own value is listed instead, and a note on a copy goes on the record's line
  // (attachCopyNotes). A row the user marked incorrect stays, marked. A row changed by hand away from its detail is the
  // patient's own value (entry.editedFrom): listed with no trust and no status, whatever became of its detail. A row
  // changed by hand to exactly the record's value, while the record's line is listed, is a copy of it (entry.copyOf):
  // set aside like any copy, its note on the record's line.
  const entries = labEntries ?? loadLabEntries();
  // Each row and unimported fact as the Labs page reads it: the entry itself, or its parts (`<id>#<index>`), each part
  // with its own trust after the part check (labs.ts checkLabParts). A part set aside there (a copy of a clinical
  // record's value, or one the record contradicts) is not a current value: the record's line is listed instead, and an
  // inaccurate part is named in the Reconciliation section.
  const entryById = new Map(entries.map((e) => [e.id, e]));
  const lineEntry = (id: string) => entryById.get(id) ?? entryById.get(`${id}#0`);
  const pushParts = (parts: LabRow[], idOf: (index: number) => string) => {
    for (const p of parts) {
      const pe = p.partIndex != null ? entryById.get(idOf(p.partIndex)) : undefined;
      if (pe) {
        if (isPartSetAside(pe)) continue;
        p.trust = pe.trust;
        p.factStatus = pe.factStatus;
        p.factBasis = pe.factBasis;
        p.reading = pe.reading;
      }
      out.push(p);
    }
  };
  const rowById = new Map(rows.map((r) => [r.id, r]));
  // In scope by the row's own reading date (collected, else of unknown kind, else resulted).
  const inScope = (r: (typeof rows)[number]) => (!docSet || Boolean(r.documentId && docSet.has(r.documentId))) && partialWithin(lineEntry(r.id)?.date ?? r.collectedAt ?? r.resultedAt, scope?.from, scope?.to);
  for (const r of rows) {
    if (r.documentId && deletedDocs.has(r.documentId)) continue;
    const entry = lineEntry(r.id);
    // The whole line set aside (its detail replaced or deleted, a copy the check set aside); a row made from one test
    // of a line, set aside by the part check, likewise.
    if (entry && (entry.factDeleted || (entry.factStatus === 'superseded' && !entry.partCheck) || (!entry.splitFrom && isPartSetAside(entry)))) {
      if (entry.factId && !entry.factDeleted && entry.partCheck) used.add(entry.factId);
      continue;
    }
    if (!inScope(r)) continue;
    const factId = entry ? entry.factId : r.factId ?? null;
    const fact = factId ? factById.get(factId) ?? null : null;
    // The keeper's own fact is not printed a second time.
    if (fact) used.add(fact.id);
    // Grouped by the name as written, read now (never the stored analyte_key), as on the Labs page.
    const analyteKey = normalizeAnalyte(r.analyte, r.specimen);
    const parts = labRowParts({
      labResultId: r.id,
      factId,
      factStatus: entry ? lineFactStatus(entry) : fact?.status ?? null,
      factBasis: entry ? entry.factBasis : fact?.verdictBasis ?? null,
      trust: entry ? entry.trust : undefined,
      factTier: fact ? fact.documentTier : undefined,
      analyte: r.analyte,
      analyteKey,
      // The row's own date as the Labs page reads it (collected, else of unknown kind, else resulted): a row with none is
      // "undated", never given its detail's date (rule 7).
      date: entry ? entry.date : (r.collectedAt ?? r.resultedAt ?? null),
      datePrecision: entry ? entry.datePrecision : r.collectedAt ? r.collectedAtPrecision : (r.resultedAtPrecision ?? 'unknown'),
      dateText: entry ? entry.dateText : (r.collectedAtText ?? r.resultedAtText ?? null),
      // The measurement only: a limit ("<3") or words never stand as a number, whatever is stored with them (rule 2).
      value: entry ? entry.reading.measurement : r.valueNum,
      valueText: r.valueText,
      unit: r.unit,
      refLow: r.refLow,
      refHigh: r.refHigh,
      refText: r.refText,
      flag: r.flag,
      specimen: effectiveSpecimen(analyteKey, r.specimen, r.analyte),
      labName: r.labName,
      documentId: r.documentId ?? fact?.cite?.documentId ?? null,
      documentTitle: r.documentId ? (docs.get(r.documentId)?.title ?? null) : (fact?.documentTitle ?? null),
      // The detail's page; for a detail not in the ledger (a row changed by hand whose detail was set aside), the Labs page's.
      pageNumber: fact?.cite && fact.cite.documentId === (r.documentId ?? fact.cite.documentId) ? fact.cite.pageNumber : (entry?.pageNumber ?? null),
      notes: r.notes,
      factNote: fact?.verdictNote ?? null,
      editedFrom: entry?.editedFrom ?? null,
      editedFromRecord: entry?.editedFromRecord ?? null,
      reading: entry?.reading ?? null,
      computed: askComputedOf(entry?.computed),
    }, r.valueText, Boolean(entry?.specimenAssumed));
    pushParts(parts, (i) => `${r.id}#${i}`);
  }
  for (const f of facts) {
    if (used.has(f.id)) continue;
    const a = f.attributes as Record<string, unknown>;
    const analyte = typeof a.analyte === 'string' && a.analyte.trim() ? a.analyte.trim() : f.subjectKey?.replace(/^lab_result\|/, '') ?? f.statement.slice(0, 40);
    // The fact as the Labs page reads it (its entry, `fact:<id>`): the value as printed is never dropped for a number.
    const fe = lineEntry(`fact:${f.id}`);
    const reading = fe?.reading ?? factReading(f, docs);
    const valueText = typeof a.value === 'string' ? a.value : null;
    const stated = typeof a.specimen === 'string' && a.specimen.trim() ? a.specimen : null;
    const parts = labRowParts({
      labResultId: null,
      factId: f.id,
      factStatus: f.status,
      factBasis: f.verdictBasis ?? null,
      factTier: f.documentTier,
      analyte,
      analyteKey: normalizeAnalyte(analyte, stated ?? defaultSpecimenFor(analyte)),
      date: fe ? fe.date : f.date,
      datePrecision: fe ? fe.datePrecision : f.datePrecision,
      dateText: fe ? fe.dateText : f.dateText,
      value: reading.measurement,
      valueText,
      unit: typeof a.unit === 'string' ? a.unit : null,
      refLow: typeof a.ref_low === 'number' ? a.ref_low : null,
      refHigh: typeof a.ref_high === 'number' ? a.ref_high : null,
      refText: typeof a.ref_text === 'string' ? a.ref_text : null,
      flag: typeof a.flag === 'string' ? a.flag : null,
      specimen: typeof a.specimen === 'string' ? a.specimen : null,
      labName: typeof a.lab_name === 'string' ? a.lab_name : null,
      documentId: f.cite?.documentId ?? f.sourceDocumentId,
      documentTitle: f.documentTitle,
      pageNumber: f.cite?.pageNumber ?? null,
      notes: null,
      factNote: f.verdictNote ?? null,
      reading,
    }, valueText);
    pushParts(parts, (i) => `fact:${f.id}#${i}`);
  }
  // Each row with a detail behind it carries that detail's automatic trust (a stored row already has its entry's).
  const pending = out.filter((r) => r.factId && r.trust === undefined);
  const trust = trustFor(pending.map((r) => r.factId ?? ''));
  for (const r of pending) r.trust = factById.get(r.factId!)?.trust ?? trust.get(r.factId!) ?? null;
  // A note on a copy of a record's value goes on the record's line. When that line is not here (the scope leaves the
  // record out), the copy is listed itself, with its own trust ([accurate: matches <record>]), so the note stays.
  for (const c of attachCopyNotes(out, setAsideLabNotes(entries))) {
    const r = rowById.get(c.rowId);
    if (!r || (r.documentId && deletedDocs.has(r.documentId)) || !inScope(r)) continue;
    const ce = lineEntry(r.id);
    out.push(...labRowParts({
      labResultId: r.id,
      factId: c.factId,
      factStatus: 'superseded',
      factBasis: null,
      trust: c.trust,
      analyte: r.analyte,
      analyteKey: normalizeAnalyte(r.analyte, r.specimen),
      date: ce ? ce.date : r.collectedAt,
      datePrecision: ce ? ce.datePrecision : r.collectedAtPrecision,
      dateText: ce ? ce.dateText : r.collectedAtText,
      value: ce ? ce.reading.measurement : r.valueNum,
      valueText: r.valueText,
      unit: r.unit,
      refLow: r.refLow,
      refHigh: r.refHigh,
      refText: r.refText,
      flag: r.flag,
      specimen: r.specimen,
      labName: r.labName,
      documentId: r.documentId,
      documentTitle: r.documentId ? (docs.get(r.documentId)?.title ?? null) : null,
      pageNumber: null,
      notes: r.notes,
      factNote: null,
      reading: ce?.reading ?? null,
    }));
  }
  attachRecordCites(out, factById, (id) => docs.get(id)?.tier);
  // The tests read out of one line stay together, in the line's order.
  out.sort((a, b) => dateSortKey(a.date).localeCompare(dateSortKey(b.date)) || (a.splitFrom ?? a.analyteKey).localeCompare(b.splitFrom ?? b.analyteKey));
  return out;
}

/**
 * A lab row changed by hand away from its own detail: the patient's (or his team's) value, what the document's detail
 * reads, and that the check has not compared this value with the clinical records (it compared the detail). A row made
 * from a clinical record's own detail (`recordDocumentId`, tier primary) says what the record reads as read and that
 * this value differs from it: never "not compared", since the record itself is what it was changed from.
 */
export function editedMarker(detailReads: string, recordDocumentId?: string | null): string {
  if (recordDocumentId) return `[value changed by hand (patient or team): the clinical record ${tokD(recordDocumentId)} reads ${clip(detailReads, 200)} (as read); this value differs from it]`;
  return `[value changed by hand (patient or team): the document's detail reads ${clip(detailReads, 200)}; this value is not compared with the clinical records]`;
}

/**
 * The date's kind and the other dates printed with it (rule 7): " (collected)", " (resulted)" or nothing (the document
 * does not say), then "; resulted 2025-03-03" when the result date is printed apart, and "; received …" (when the lab
 * received the sample; never the reading's date).
 */
function labDateWords(r: LabRow): string {
  const v = r.reading;
  if (!v) return '';
  const kind = r.date ? (v.dateKind === 'collected' ? ' (collected)' : v.dateKind === 'resulted' ? ' (resulted)' : '') : '';
  const resulted = v.resulted?.iso && v.dateKind !== 'resulted' ? `; resulted ${fmtDate(v.resulted.iso, v.resulted.precision)}` : '';
  const received = v.received?.iso ? `; received ${fmtDate(v.received.iso, v.received.precision)}` : '';
  return `${kind}${resulted}${received}`;
}

/** The value as printed (or the user's own words), its unit, and what a limit or a printed range means (rules 1, 2, 6). */
function labValueWords(r: LabRow): string {
  const v = r.reading;
  const unit = v ? v.unit : r.unit;
  const shown = v ? v.valueShown || '(no value)' : (r.valueText ?? (r.value != null ? String(r.value) : '?'));
  let extra = '';
  if (v?.kind === 'censored' && v.limit) {
    const bound = parseLabValue(v.valueShown).numberText;
    extra = ` (a limit: ${v.limit}, not a measurement${bound ? ` of ${bound}` : ''})`;
  } else if (v?.kind === 'range') extra = ' (printed as a range of values, not one measurement)';
  return `${shown}${unit ? ` ${unit}` : ''}${extra}`;
}

/**
 * The range as printed with the value (rule 3): "ref: <as printed>"; a stored number with no text "ref: upper limit
 * 50"; "ref: none printed"; a range the app does not read is quoted, "(not read as numbers)"; a document that restates
 * results gives its own range "(as stated in this document, not the lab's)". Never a range built as "-50" or "5-".
 */
function labRangeWords(r: LabRow): string {
  const v = r.reading;
  if (!v) {
    const shown = formatRef({ refLow: r.refLow, refHigh: r.refHigh, refText: r.refText });
    return shown ? `ref: ${shown}` : 'ref: none printed';
  }
  if (v.rangeStatus === 'none' || !v.rangeShown) return 'ref: none printed';
  if (v.role === 'claimed') return `ref: ${v.rangeShown} (as stated in this document, not the lab's)`;
  return `ref: ${v.rangeShown}`;
}

/**
 * The flag as printed, never "normal" for a blank (rule 4): "flag H", "flag HH (critical)", "no flag printed", "flag
 * not recorded", 'flag "Pos" (not understood)'; a document that restates results gives its own flag as a claim. Then
 * the flag the app works out from the value and the range printed with it, when it says something else:
 * "; by its range: high (above 98–108)".
 */
function labFlagWords(r: LabRow): string {
  const v = r.reading;
  if (!v) return r.flag ? `flag ${r.flag}` : 'flag not recorded';
  const printed = v.flagState === 'no_flag_printed' ? 'no flag printed' : v.flagState === 'not_recorded' ? 'flag not recorded' : `flag ${v.flagShown}`;
  let out = v.role === 'claimed' && (v.flagState === 'flag' || v.flagState === 'not_understood') ? `the document's own flag: ${v.flagShown} (a claim)` : printed;
  if (v.computed && v.computedAgainst && !(v.flagState === 'flag' && v.flagPrinted === v.computed)) {
    const how = v.computed === 'H' ? `high (above ${v.computedAgainst})` : v.computed === 'L' ? `low (below ${v.computedAgainst})` : `in range (${v.computedAgainst})`;
    out += v.role === 'claimed' ? `; by the range this document gives: ${how}` : `; by its range: ${how}`;
  }
  return out;
}

export function labRowLine(r: LabRow): string {
  // A value the patient computed (2026-10-09): never a lab's, never judged; it cites its inputs' pages.
  if (r.computed) {
    const c = r.computed;
    const inputs = c.inputs.map((i) => `${i.slotLabel} ${i.words} ${tokD(i.documentId, i.page)}`).join('; ');
    const changed = c.changes.length ? ` | [input changed: compute again: ${clip(c.changes.join(' '), 300)}]` : '';
    return `${fmtDate(r.date, r.datePrecision)}${labDateWords(r)} | ${labValueWords(r)} | ref: none (a computed value is never judged by a range) | no flag (computed) | [computed by the patient, not printed by a lab: ${c.label}; ${c.expression}; ${c.pairing}]${changed} | inputs: ${inputs}`;
  }
  // A row standing for a clinical record's value from another document cites the record's page too.
  const recordTok = r.recordDocumentId && r.recordDocumentId !== r.documentId ? tokD(r.recordDocumentId, r.recordPageNumber) : null;
  const toks = joinBits([r.documentId ? tokD(r.documentId, r.pageNumber) : null, recordTok, r.factId ? tokF(r.factId) : null], ' ');
  const lab = r.labName?.trim() ? ` | lab ${clip(r.labName, NOTE_MAX_CHARS)}` : '';
  const notes = [...labNoteBits(r.notes, r.factNote), ...(r.copyNotes ?? [])].map((n) => ` | ${n}`).join('');
  // A test read out of a line of several, or a line of several kept whole: said, with the line as written.
  const line = r.splitFrom ? ` | (from one line: ${clip(r.splitFrom, 200)})` : r.combined ? ' | (one line holds several tests; not split)' : '';
  const check = r.editedFrom
    ? ` | ${editedMarker(r.editedFrom, r.editedFromRecord)}`
    : r.trust
      ? ` | ${trustMarkers(r.trust, r.factStatus, r.factBasis, r.documentId, r.factTier)}`
      : r.factStatus
        ? ` | [${answerMarker(null, r.factStatus, r.factBasis, r.factTier)}]`
        : '';
  const warn = (r.reading?.warnings ?? []).map((w) => ` | [warning: ${clip(w, 300)}]`).join('');
  return `${fmtDate(r.date, r.datePrecision)}${labDateWords(r)} | ${labValueWords(r)} | ${labRangeWords(r)} | ${labFlagWords(r)}${check}${lab}${notes}${line}${warn} | ${toks}`;
}

/** The lab row format, shared by the ledger and the lab tools. */
export const LAB_ROW_FORMAT =
  'date (collected)? or (resulted)?; resulted <date>?; received <date>? | value as printed and its unit, (a limit: below 3, not a measurement of 3)? | ref: <the range as printed with this value> (or "ref: upper limit 50" when only a number is on record, "ref: none printed", "ref: "see comment" (not read as numbers)", or "ref: 0–35 (as stated in this document, not the lab\'s)") | flag H, flag HH (critical), no flag printed, flag not recorded, flag "Pos" (not understood), or the document\'s own flag: H (a claim); then "; by its range: high (above 98–108)"? | [trust] [the patient\'s answer]? (or [value changed by hand (patient or team): the document\'s detail reads …; this value is not compared with the clinical records], or for a row made from a clinical record [value changed by hand (patient or team): the clinical record ⟦D:id⟧ reads … (as read); this value differs from it]) | lab <lab name>? | imported from <file>? | note (patient or team): "…"? | note on the check (patient or team): "…"? | note on a copy from <document> ⟦D:id⟧ (patient or team): "…"? | [warning: …]? | ⟦D:documentId p.N⟧ ⟦D:record p.N⟧? ⟦F:factId⟧. How to read the values: a value written with <, >, ≤ or ≥ is a limit (below or above what the test measured), never a measurement: never compare, average or trend it as the number it names. "no flag printed" is not "normal", and "flag not recorded" means nothing was recorded about a flag. "by its range" is worked out by the app from the value and the range printed with it; the lab did not print it. A range belongs to the lab that printed it: ranges of different labs are not comparable, and a value is judged only against its own range. A range, flag or judgement "as stated in this document" or "(a claim)" is that document\'s claim (a summary, a letter, a patient\'s note), not the lab\'s. "(collected)" is when the sample was taken, "(resulted)" when the result came back; a date with neither is of a kind the document does not say; "received" is when the lab received the sample. A [warning: …] is a check the app made on this value (a flag that disagrees with the range, a sign the page shows, a range in another unit): say it when it matters. A row imported from one document that stands for a clinical record\'s value cites the record\'s page too. "note on a copy" is a note the patient or his team wrote on a copy of this same value in another document (set aside as a copy of this record; the value is listed once). A row whose value was changed by hand is the patient\'s own value: its ⟦F:…⟧ token names the detail it was made from, which reads otherwise; when it matters, say both and that this value has not been checked against the clinical records (or, for a row made from a clinical record, that it differs from what the record reads). A line in a document that held several tests is listed as one row per test, each with "(from one line: <the line as written>)" before its tokens and citing that line; a line whose values could not be matched to its tests is listed whole, marked "(one line holds several tests; not split)". A row marked "[computed by the patient, not printed by a lab: …]" is a value the patient computed himself from values printed on lab reports (an albumin index, for example); its inputs are cited one by one; it is never a lab\'s result, never judged by a range, and "input changed: compute again" means an input was edited, disputed or removed since';

function mostCommon<T>(values: T[]): T | null {
  const counts = new Map<string, { v: T; n: number }>();
  for (const v of values) {
    if (v == null || v === '') continue;
    const k = JSON.stringify(v);
    const cur = counts.get(k);
    if (cur) cur.n++;
    else counts.set(k, { v, n: 1 });
  }
  let best: { v: T; n: number } | null = null;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  return best?.v ?? null;
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

export interface LedgerSection {
  key: string;
  title: string;
  text: string;
  factIds: string[];
}

export const LEDGER_SECTION_KEYS = [
  'patient',
  'people',
  'intolerances',
  'medications',
  'diagnoses',
  'labs',
  'imaging',
  'procedures',
  'symptoms',
  'statements',
  'recommendations',
  'referrals',
  'records',
  'communications',
  'encounters',
  'events',
  'tasks',
  'findings',
  'reconciliation',
] as const;

const SECTION_TITLES: Record<(typeof LEDGER_SECTION_KEYS)[number], string> = {
  patient: 'Patient',
  people: 'People directory',
  intolerances: 'Intolerances and hard stops',
  medications: 'Medications',
  diagnoses: 'Diagnoses',
  labs: 'Labs',
  imaging: 'Imaging',
  procedures: 'Procedures',
  symptoms: 'Symptoms',
  statements: 'Clinician statements',
  recommendations: 'Recommendations and follow-ups',
  referrals: 'Referrals',
  records: 'Record references and gaps',
  communications: 'Communications log',
  encounters: 'Encounters',
  events: 'Events and vitals',
  tasks: 'Tasks',
  findings: 'Findings',
  reconciliation: 'Reconciliation',
};

interface LedgerData {
  facts: LedgerFact[];
  factById: Map<string, LedgerFact>;
  byType: Map<string, LedgerFact[]>;
  people: Map<string, PersonLite>;
  docs: ReturnType<typeof loadDocumentTitles>;
  scope?: AskScope;
  today: string;
  /** The Labs page's entries (labs.ts loadLabEntries), read once per ledger when first asked for. */
  labEntries: () => LabEntry[];
}

function attrStr(a: Record<string, unknown>, k: string): string | null {
  const v = a[k];
  if (v == null || v === '') return null;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'object') return null;
  return String(v);
}

/** A compact attribute tail for the fact types where the statement alone loses structure. */
export function attrSummary(type: string, a: Record<string, unknown>): string {
  const pairs: Array<[string, string | null]> = [];
  const add = (label: string, key: string) => pairs.push([label, attrStr(a, key)]);
  switch (type) {
    case 'medication':
      add('status', 'status');
      add('effect', 'effect');
      add('stopped because', 'reason_stopped');
      break;
    case 'recommendation':
      add('acted on', 'acted_on');
      break;
    case 'referral':
      add('status', 'status');
      break;
    case 'follow_up':
      add('owner', 'who');
      add('due', 'due');
      add('status', 'status');
      break;
    case 'record_reference':
      add('type', 'record_type');
      add('institution', 'institution');
      add('record date', 'record_date');
      add('present in this document', 'present_in_this_document');
      break;
    case 'diagnosis':
      add('certainty', 'certainty');
      break;
    case 'symptom':
      add('course', 'course');
      add('severity', 'severity');
      break;
    case 'imaging_result':
      add('impression', 'impression');
      add('comparison', 'comparison');
      break;
    case 'clinician_statement':
      add('stance', 'stance');
      add('about', 'about');
      break;
    case 'allergy_intolerance':
      add('kind', 'kind');
      add('reaction', 'reaction');
      add('severity', 'severity');
      break;
    default:
      break;
  }
  const bits = pairs.filter(([, v]) => v).map(([k, v]) => `${k}: ${clip(v, NOTE_MAX_CHARS)}`);
  return bits.length ? ` {${bits.join('; ')}}` : '';
}

/**
 * The ledger's marker for a fact a patient statement takes precedence over
 * (consult layer; the record itself is unchanged). Nothing when that
 * statement is no longer live (`overrideLive === false`).
 */
export function overrideMarker(f: Pick<LedgerFact, 'overriddenByFactId' | 'overrideReason' | 'overrideLive'>): string {
  if (!f.overriddenByFactId || f.overrideLive === false) return '';
  return ` [clinician assessment; patient states otherwise: ${clip(f.overrideReason ?? 'see the patient statement', NOTE_MAX_CHARS)} ${tokF(f.overriddenByFactId)}]`;
}

/**
 * Source tier of a fact for the ledger line, omitted when unknown. Trust follows the passage (shared/trust.ts): the
 * patient's own words inside a clinical record (his portal message in a chart print) read as `patient`, and say so.
 */
function tierMarker(f: Pick<LedgerFact, 'documentTier'> & Partial<Pick<LedgerFact, 'assertedBy' | 'attributes'>>): string {
  const doc = normalizeTier(f.documentTier);
  const passage = factTier(doc, { assertedBy: f.assertedBy ?? null, attributes: f.attributes ?? null });
  if (passage !== doc) return `, ${passage} (${passage === 'patient' ? 'his own words' : 'a passage'} inside a ${doc} record)`;
  return doc !== 'unknown' ? `, ${doc}` : '';
}

/**
 * The ledger's status marker: a fact the patient confirmed only against a
 * summary (no original record seen) reads "confirmed from a summary only".
 */
export function statusMarker(status: string | null | undefined, basis: string | null | undefined): string {
  if (status === 'confirmed' && basis === 'summary') return 'confirmed from a summary only';
  if (status === 'confirmed' && basis === 'original') return 'confirmed against the original record';
  if (status === 'confirmed' && basis === 'correction') return 'patient correction of the clinical record';
  if ((status ?? 'unverified') === 'unverified' && basis === 'unsure') return 'unsure';
  return status ?? 'unverified';
}

/** Did the patient answer the check himself (his answer is printed in its own bracket after the trust)? */
function answered(status: string | null | undefined, basis: string | null | undefined): boolean {
  return status === 'confirmed' || status === 'disputed' || (status === 'unverified' && basis === 'unsure');
}

/**
 * The app's words for the patient about his own correction ("Your correction says …",
 * "Matches your correction: …") in the third person, for the clinician.
 */
export function thirdPerson(text: string): string {
  return text
    .replace(/\bThe value you chose\b/g, 'The value the patient chose')
    .replace(/\bthe value you chose\b/g, 'the value the patient chose')
    .replace(/\bYour correction\b/g, "The patient's correction")
    .replace(/\byour correction\b/g, "the patient's correction");
}

/** "You said this is accurate." followed by what the record says: the patient kept a value the record contradicts. */
const KEPT_DESPITE_RE = /^You said this is accurate\.\s*\S/;

const lowerFirst = (s: string): string => (/^[A-Z][a-z]/.test(s) ? `${s[0].toLowerCase()}${s.slice(1)}` : s);

/**
 * A trust reason the app wrote for the patient ("You said the record is wrong: …")
 * in the clinician's words; what the patient wrote is marked (patient or team).
 */
export function clinicianReason(reason: string | null | undefined): string {
  const r = (reason ?? '').trim();
  let m: RegExpMatchArray | null;
  if ((m = r.match(/^You said the record is wrong:\s*([\s\S]*)$/))) return joinBits(['the patient says this record is wrong', userNote(m[1], 'reason')], '; ');
  if ((m = r.match(/^Your later correction says otherwise:\s*([\s\S]*)$/))) return joinBits(['a later correction by the patient says otherwise', userNote(m[1], 'reason')], '; ');
  if ((m = r.match(/^You corrected the record:\s*([\s\S]*)$/))) return joinBits(['the patient corrected the clinical record', userNote(m[1], 'reason')], '; ');
  if ((m = r.match(/^You marked this wrong\.\s*([\s\S]*)$/))) return m[1] ? `the patient marked it wrong. ${thirdPerson(m[1])}` : 'the patient marked it wrong';
  // "It's actually right" on a value the record contradicts: the reason goes on to say what the record says.
  if ((m = r.match(/^You said this is accurate(?:\.\s*([\s\S]*))?$/))) return m[1]?.trim() ? `the patient kept it as accurate, but ${lowerFirst(thirdPerson(m[1].trim()))}` : 'the patient said it is accurate';
  if (/^You marked it as seen only in a summary\.?$/.test(r)) return 'the patient has seen it only in a summary';
  if (/^You were not sure about this one\.?$/.test(r)) return 'the patient is not sure';
  if (/^You said this is another occasion\.?$/.test(r)) return 'the patient says this is another occasion, not the one in the record';
  if ((m = r.match(/^You said this record is right(?::\s*([\s\S]*)|\.)$/))) return joinBits(['the patient chose this record as the right one', m[1] ? userNote(m[1], 'reason') : ''], '; ');
  // A value chosen with "This one is right" where no record was outranked (values the record gives in another unit):
  // his choice of the value, never a correction of the record (and never "<value> as the right record" below).
  if ((m = r.match(/^You said this value is right(?::\s*([\s\S]*)|\.)$/))) return joinBits(['the patient chose this value as the right one', m[1] ? userNote(m[1], 'reason') : ''], '; ');
  if ((m = r.match(/^You said (.+?) is right(?::\s*([\s\S]*)|\.)$/))) return joinBits([`the patient chose ${m[1]} as the right record`, m[2] ? userNote(m[2], 'reason') : ''], '; ');
  return r;
}

/**
 * A clinical record the patient chose with "This one is right" when records disagreed (confirmed, basis correction,
 * on a clinical record): his choice of the record, never a correction of it. Without the tier, a verified trust
 * says it is a clinical record (only a clinical record's own detail reads verified).
 */
function chosenRecord(t: TrustInfo | null | undefined, status: string | null | undefined, basis: string | null | undefined, tier: string | null | undefined): boolean {
  return status === 'confirmed' && basis === 'correction' && (tier === 'primary' || t?.trust === 'verified');
}

/**
 * The patient's own answer, in its bracket after the trust: statusMarker's words, except a clinical record he chose
 * ("This one is right"): [the patient chose this record as the right one] while it stands (verified), [the patient
 * had chosen this record as the right one] once a later correction of his overrules it.
 */
export function answerMarker(t: TrustInfo | null | undefined, status: string | null | undefined, basis: string | null | undefined, tier?: string | null): string {
  if (chosenValue(t, status, basis)) return 'the patient chose this value as the right one';
  if (chosenRecord(t, status, basis, tier)) return t?.trust === 'verified' ? 'the patient chose this record as the right one' : 'the patient had chosen this record as the right one';
  return statusMarker(status, basis);
}

/**
 * A value the patient chose with "This one is right" that outranks no clinical record while a record of that day is
 * there (values the record gives in another unit that disagreed with each other; services/reconcile.ts sets
 * TrustInfo.chosenValue, its reason "You said this value is right: …"): his choice of the value, never a correction of
 * the record, which stays the truth.
 */
export function chosenValue(t: TrustInfo | null | undefined, status: string | null | undefined, basis: string | null | undefined): boolean {
  if (status !== 'confirmed' || basis !== 'correction' || !t) return false;
  return t.chosenValue === true || /^You said this value is right\b/.test((t.reason ?? '').trim());
}

/**
 * The reason the reconciliation gives a value it could not compare (services/reconcile.ts): a record that day gives it
 * in another unit that does not convert or in other words, this gives only the month or year, or it names no test or
 * gives no date. Not "Not compared automatically: …" (types the check never compares), which reads [unbacked].
 */
const NOT_COMPARED_RE = /^Not compared:\s*/;

/** A not-compared reason that quotes the record's wording (a scan impression): 'the scan report says "…"'. */
const QUOTES_WORDING_RE = /^(.*?) says (["“])/;
/** The same with several records quoted: 'the scan reports say "…" and "…"'. */
const QUOTES_SEVERAL_RE = /^(.*?) say (["“])/;

/** A quoted scan wording as compared with a report's: double quotes made single (as the reason quotes it), spaces folded. */
const quoteKey = (s: string): string => s.replace(/["“”]/g, "'").replace(/\s+/g, ' ').trim();

/**
 * Several scan reports quoted in a not-compared reason ('the scan reports say "A" and "B"'): each quote followed by
 * its report's ⟦D⟧ token, so the clinician can open each report. The reports are the clinical records' scans of the
 * record's day (live documents of tier primary) whose impression (or finding) the quote gives, whole or clipped ("…").
 * A quote whose report is not found keeps no token; the line's own document is never repeated.
 */
function withReportTokens(why: string, t: TrustInfo, lineDocumentId: string | null | undefined): string {
  if (!t.recordDate) return why;
  let reports: Array<{ documentId: string; words: string }>;
  try {
    reports = db()
      .select({ documentId: schema.facts.sourceDocumentId, attributesJson: schema.facts.attributesJson })
      .from(schema.facts)
      .innerJoin(schema.documents, eq(schema.documents.id, schema.facts.sourceDocumentId))
      .where(and(eq(schema.facts.type, 'imaging_result'), eq(schema.facts.date, t.recordDate), isNull(schema.facts.deletedAt), isNull(schema.documents.deletedAt), eq(schema.documents.sourceTier, 'primary')))
      .all()
      .map((r) => {
        const a = parseJson<Record<string, unknown>>(r.attributesJson, {});
        const words = typeof a.impression === 'string' && a.impression.trim() ? a.impression : typeof a.finding === 'string' ? a.finding : '';
        return { documentId: r.documentId ?? '', words: quoteKey(words) };
      })
      .filter((r) => r.documentId && r.words)
      .sort((a, b) => a.documentId.localeCompare(b.documentId));
  } catch {
    return why;
  }
  return why.replace(/(["“])([^"“”]*)(["”])/g, (whole, _open: string, quoted: string) => {
    const q = quoteKey(quoted);
    const clipped = q.endsWith('…');
    const head = clipped ? q.slice(0, -1).trimEnd() : q;
    if (!head) return whole;
    const docs = [...new Set(reports.filter((r) => (clipped ? r.words.startsWith(head) : r.words === head)).map((r) => r.documentId))].filter((id) => id !== lineDocumentId);
    return docs.length ? `${whole} ${docs.map((id) => tokD(id)).join(' ')}` : whole;
  });
}
/**
 * Values the record of their day could not be compared with (another unit, other words) that disagree with each other
 * between documents (services/reconcile.ts): "These documents give different values, and the lab report gives it in
 * another unit: 112 mg/dL on 2024-03-18." They need a source, but the record is there.
 */
const VALUES_DISAGREE_RE = /^These documents give different values\b/;
/** The advice to the patient that ends a scan's not-compared reason ("Read both.", "Read them all.", "Read the report."). */
const READ_ADVICE_RE = /\s+Read (?:both|them all|the report)\.?$/i;

/** Did the check leave this value "not compared" (src/server/services/reconcile.ts; its reason says why)? */
export function isNotCompared(t: TrustInfo | null | undefined): boolean {
  return Boolean(t && t.trust === 'unbacked' && !t.byUser && NOT_COMPARED_RE.test((t.reason ?? '').trim()));
}

/**
 * The bracketed trust words of a detail for the clinician (src/shared/reconcile.ts):
 * [verified] from a clinical record, the line's own document (the line names it or carries
 * it as ⟦D⟧, so the title is not repeated; only a line whose own document is another one,
 * such as a lab row imported from a summary that stands for the record's value, reads
 * [verified: <record>]); [accurate: matches <record>] a mention that agrees with one;
 * [unbacked] nothing to compare with; [not compared: <why, and what the record gives>] the app could
 * not tell whether it says the same as a record (another unit or other words, only a month, no test
 * named, no date); [inaccurate:
 * <reason>] it contradicts a clinical record or the patient's correction; [sources disagree:
 * needs a record], or [sources disagree: Clinical records disagree: …] when the clinical records
 * themselves disagree; [replaced]. When the patient answered the check himself, his answer
 * follows in its own bracket, in the words statusMarker has always used ([confirmed against the
 * original record], [confirmed from a summary only], [unsure], [disputed], [confirmed], [patient
 * correction of the clinical record]); a clinical record he chose with "This one is right" reads
 * [the patient chose this record as the right one] (or [the patient had chosen …] once a later
 * correction overrules it), and a value he kept although the record says otherwise reads
 * [accurate: the patient kept it as accurate, but …] [confirmed] (never "against the original
 * record", which says otherwise). Without a trust, the answer alone.
 *
 * `lineDocumentId`: the document the line itself names (null when it names none). Left out,
 * [verified] never names its record. `tier`: the source tier of the detail's document, when known.
 */
export function trustMarkers(t: TrustInfo | null | undefined, status: string | null | undefined, basis: string | null | undefined, lineDocumentId?: string | null, tier?: string | null): string {
  if (!t) return `[${answerMarker(null, status, basis, tier)}]`;
  const title = (s: string | null | undefined) => clip(s?.trim() || 'a clinical record', 120);
  let first: string;
  let answer = answered(status, basis) ? answerMarker(t, status, basis, tier) : null;
  switch (t.trust) {
    case 'verified':
      first = lineDocumentId !== undefined && t.recordDocumentId && t.recordDocumentId !== lineDocumentId ? `verified: ${title(t.recordDocumentTitle)}` : 'verified';
      break;
    case 'accurate':
      // "It's actually right" on a value the record contradicts: the patient's word stands, and the clinician sees what
      // the record says. His answer is a plain [confirmed]: it does not match the original record.
      if (t.byUser && KEPT_DESPITE_RE.test(t.reason ?? '')) {
        first = `accurate: ${clip(clinicianReason(t.reason), NOTE_MAX_CHARS + 200)}`;
        if (status === 'confirmed') answer = 'confirmed';
      } else first = t.byUser ? 'accurate' : `accurate: matches ${title(t.recordDocumentTitle)}`;
      break;
    case 'inaccurate': {
      // The patient's own "wrong" is in the second bracket; the first keeps what the record says, if anything.
      const why = t.byUser && status === 'disputed' ? thirdPerson((t.reason ?? '').replace(/^You marked this wrong\.\s*/, '').trim()) : t.byUser ? clinicianReason(t.reason) : thirdPerson((t.reason ?? '').trim()) || `differs from ${title(t.recordDocumentTitle)}`;
      first = why ? `inaccurate: ${clip(why, NOTE_MAX_CHARS + 200)}` : 'inaccurate';
      break;
    }
    case 'conflict': {
      // Clinical records that disagree with each other: say so and name them (the reason lists what each says). Values
      // that disagree with each other while the record gives the value in another unit or other words: the record is
      // there (what it gives is in the reason), so the clinician can compare them himself.
      const reason = (t.reason ?? '').trim();
      first = /^Clinical records disagree\b/.test(reason) ? `sources disagree: ${clip(reason, 300)}` : VALUES_DISAGREE_RE.test(reason) ? `sources disagree: ${clip(lowerFirst(reason), 400)}` : 'sources disagree: needs a record';
      break;
    }
    case 'replaced':
      first = 'replaced';
      break;
    default:
      if (isNotCompared(t)) {
        // A record that day gives it in another unit or other words (or this gives only the month, names no test, gives
        // no date): not backed, not contradicted; the clinician compares.
        // "…, so it cannot be matched with a clinical record." (no date, no test named) is said in its first words only.
        // A scan's wording is never judged automatically: the reason quotes the report ('the scan report says "…". Read
        // both.'); the advice to the patient is dropped, and the report's document is cited so its full text can be read.
        let why = (t.reason ?? '')
          .trim()
          .replace(NOT_COMPARED_RE, '')
          .replace(/,\s*so it cannot be matched with a clinical record\.?$/, '')
          .replace(READ_ADVICE_RE, '')
          .replace(/(["”])\.$/, '$1');
        if (t.recordDocumentId && t.recordDocumentId !== lineDocumentId && QUOTES_WORDING_RE.test(why)) why = why.replace(QUOTES_WORDING_RE, `$1 ${tokD(t.recordDocumentId)} says $2`);
        // Several reports quoted ('the scan reports say "A" and "B"'): each quote carries its own report's token.
        else if (QUOTES_SEVERAL_RE.test(why)) why = withReportTokens(why, t, lineDocumentId);
        first = `not compared: ${clip(lowerFirst(thirdPerson(why)), 600)}`;
        break;
      }
      // The patient's own word with nothing to compare ("this is another occasion"): said, so the clinician knows.
      first = t.byUser && !answered(status, basis) && t.reason ? `unbacked: ${clip(clinicianReason(t.reason), NOTE_MAX_CHARS + 200)}` : 'unbacked';
  }
  return answer ? `[${first}] [${answer}]` : `[${first}]`;
}

export function factLine(f: LedgerFact, people?: Map<string, PersonLite>): string {
  const who = f.type === 'clinician_statement' && f.personId && people?.get(f.personId) && !f.attributes.stated_by ? ` — ${people.get(f.personId)!.name}` : '';
  const voice = f.assertedBy === 'patient' ? ' [patient statement]' : '';
  let src = '';
  if (f.cite) src = ` (${clip(f.documentTitle ?? 'document', 60)}${tierMarker(f)} ${tokD(f.cite.documentId, f.cite.pageNumber)})`;
  else if (f.sourceDocumentId) src = ` (${clip(f.documentTitle ?? 'document', 60)}${tierMarker(f)} ${tokD(f.sourceDocumentId)})`;
  else if (f.origin === 'manual') src = ' (manual entry)';
  const note = factNoteBit(f.verdictNote);
  const check = f.trust ? trustMarkers(f.trust, f.status, f.verdictBasis, f.sourceDocumentId ?? f.cite?.documentId ?? null, f.documentTier) : `[${answerMarker(null, f.status, f.verdictBasis, f.documentTier)}]`;
  return `${fmtDate(f.date, f.datePrecision)}${f.dateEnd ? ` to ${fmtDate(f.dateEnd)}` : ''} ${check}${voice} ${clip(f.statement, NOTE_MAX_CHARS)}${who}${attrSummary(f.type, f.attributes)}${overrideMarker(f)}${src}${note ? ` ${note}` : ''} ${tokF(f.id)}`;
}

/** The one-line legend every fact section carries. */
export const FACT_LINE_FORMAT = 'Format: date [trust] [the patient\'s answer]? [patient statement]? statement {attributes} [clinician assessment; patient states otherwise: reason ⟦F:patientFactId⟧]? (source document, tier ⟦D:id p.N⟧) note (patient or team): "the note written when checking it"? ⟦F:factId⟧. Tiers: primary = the institution\'s own record, patient = the patient\'s own notes, compilation = a summary assembled from other records, external = insurer or employer letters.';

function sectionText(intro: string, lines: string[], empty = '(none recorded)'): string {
  return `${intro}\n${lines.length ? lines.join('\n') : empty}`;
}

function factsSection(data: LedgerData, key: (typeof LEDGER_SECTION_KEYS)[number], types: string[], intro: string): LedgerSection {
  const facts = types.flatMap((t) => data.byType.get(t) ?? []);
  facts.sort((a, b) => dateSortKey(a.date).localeCompare(dateSortKey(b.date)) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { key, title: SECTION_TITLES[key], text: sectionText(`${intro} ${facts.length} item${facts.length === 1 ? '' : 's'}. ${FACT_LINE_FORMAT}`, facts.map((f) => factLine(f, data.people))), factIds: facts.map((f) => f.id) };
}

function personLine(p: PersonLite, people: Map<string, PersonLite>): string {
  const inst = p.institutionId ? people.get(p.institutionId)?.name : null;
  return joinBits([
    `${p.name} (${p.kind.replace(/_/g, ' ')})`,
    p.role,
    p.specialty,
    inst ? `at ${inst}` : null,
    p.phone ? `phone ${p.phone}` : null,
    p.fax ? `fax ${p.fax}` : null,
    p.email ? `email ${p.email}` : null,
    p.portal ? `portal ${p.portal}` : null,
    p.address?.trim() ? `address ${clip(p.address, NOTE_MAX_CHARS)}` : null,
    p.preferredChannel ? `prefers ${p.preferredChannel}` : null,
    p.aliases.length ? `also known as ${p.aliases.join(', ')}` : null,
    userNote(p.notes),
  ]);
}

function patientSection(): LedgerSection {
  const lines = [
    `Name: ${getSetting('patient.name') || '(not recorded)'}`,
    `Date of birth: ${getSetting('patient.dob') || '(not recorded)'}`,
    `Blood type: ${getSetting('patient.bloodType') || '(not recorded)'}`,
    `Emergency contacts: ${clip(getSetting('patient.emergencyContacts'), 600) || '(not recorded)'}`,
    `Summary: ${clip(getSetting('patient.summary'), 4000) || '(not recorded)'}`,
  ];
  return { key: 'patient', title: SECTION_TITLES.patient, text: sectionText('Patient details as entered in Settings.', lines), factIds: [] };
}

function peopleSection(data: LedgerData): LedgerSection {
  const list = [...data.people.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { key: 'people', title: SECTION_TITLES.people, text: sectionText(`People, clinics and institutions in the case. ${list.length} entries.`, list.map((p) => personLine(p, data.people))), factIds: [] };
}

function intolerancesSection(data: LedgerData): LedgerSection {
  // Active rows first (hard stops leading), then the ones set inactive, which keep their notes.
  const rows = db().select().from(schema.intolerances).where(isNull(schema.intolerances.deletedAt)).orderBy(desc(schema.intolerances.active), desc(schema.intolerances.hardStop), asc(schema.intolerances.substance), asc(schema.intolerances.id)).all();
  const lines: string[] = [];
  const linked = new Set<string>();
  const sources = loadFactTexts(rows.map((r) => r.sourceFactId));
  for (const r of rows) {
    if (r.sourceFactId) linked.add(r.sourceFactId);
    const source = r.sourceFactId ? sources.get(r.sourceFactId) : undefined;
    const kind = r.kind.replace(/_/g, ' ');
    lines.push(
      joinBits([
        !r.active ? `${r.substance} (${kind}) [inactive${r.hardStop ? '; was a hard stop' : ''}]` : r.hardStop ? `HARD STOP — NEVER GIVE: ${r.substance}` : `${r.substance} (${kind})`,
        r.reaction ? `reaction: ${clip(r.reaction, NOTE_MAX_CHARS)}` : null,
        r.severity && r.severity !== 'unknown' ? `severity ${r.severity}` : null,
        r.date ? fmtDate(r.date, r.datePrecision) : null,
        userNote(r.notes),
        source && !source.deleted ? checkNote(source.verdictNote) : null,
        r.sourceFactId ? tokF(r.sourceFactId) : null,
      ]),
    );
  }
  const facts = (data.byType.get('allergy_intolerance') ?? []).filter((f) => !linked.has(f.id));
  if (facts.length) {
    lines.push('Allergy and intolerance facts from documents:');
    for (const f of facts) lines.push(factLine(f, data.people));
  }
  return {
    key: 'intolerances',
    title: SECTION_TITLES.intolerances,
    text: sectionText('Hard stops must be respected in every answer about treatment. Rows marked [inactive] were set inactive by the patient or his team and are listed for their notes.', lines),
    factIds: [...linked, ...facts.map((f) => f.id)],
  };
}

/** One medication record with its events: the line, then one indented line per event. */
interface MedicationBlock {
  group: 'Current and planned:' | 'Past:';
  text: string;
  factIds: string[];
}

function medicationBlocks(data: LedgerData): MedicationBlock[] {
  const d = db();
  const meds = d.select().from(schema.medications).where(isNull(schema.medications.deletedAt)).all();
  const events = d.select().from(schema.medicationEvents).where(isNull(schema.medicationEvents.deletedAt)).orderBy(asc(schema.medicationEvents.date), asc(schema.medicationEvents.createdAt)).all();
  const eventsBy = new Map<string, typeof events>();
  for (const e of events) {
    if (!eventsBy.has(e.medicationId)) eventsBy.set(e.medicationId, []);
    eventsBy.get(e.medicationId)!.push(e);
  }
  // What a row made from a document fact copied from it is the document's text, not the patient's.
  const sources = loadFactTexts([...meds.map((m) => m.sourceFactId), ...events.map((e) => e.sourceFactId)]);
  const order = (s: string) => (s === 'active' ? 0 : s === 'prn' ? 1 : s === 'planned' ? 2 : s === 'stopped' ? 3 : 4);
  meds.sort((a, b) => order(a.status) - order(b.status) || dateSortKey(a.startDate).localeCompare(dateSortKey(b.startDate)) || a.name.localeCompare(b.name));
  // A start that is only the date of a list that named the drug (or none) is not a start: said as such, with when the
  // records first place the drug (batched, never one query per row).
  const starts = readStarts(meds);
  const startBit = (m: (typeof meds)[number]): string => {
    const s = starts.get(m.id);
    if (!s || s.startRecorded) return fmtDate(m.startDate, m.startDatePrecision);
    return `start not recorded${s.firstSeen ? ` (first seen ${fmtDate(s.firstSeen, s.firstSeenPrecision)})` : ''}`;
  };
  return meds.map((m) => {
    const prescriber = m.prescriberId ? data.people.get(m.prescriberId)?.name : null;
    const factIds: string[] = [];
    if (m.sourceFactId) factIds.push(m.sourceFactId);
    const medSources = sourceTexts(m.sourceFactId ? sources.get(m.sourceFactId) : null);
    const lines = [
      joinBits([
        `${m.name}${m.genericName && m.genericName !== m.name ? ` (${m.genericName})` : ''}`,
        joinBits([m.dose, m.unit], ' '),
        m.route,
        m.frequency,
        `[${m.status}]`,
        `${startBit(m)} → ${m.stopDate ? fmtDate(m.stopDate, m.stopDatePrecision) : m.status === 'active' ? 'ongoing' : '?'}`,
        m.drugClass?.trim() ? `class ${clip(m.drugClass, NOTE_MAX_CHARS)}` : null,
        prescriber ? `prescriber ${prescriber}` : null,
        m.indication ? `for ${clip(m.indication, NOTE_MAX_CHARS)}` : null,
        ...medicationNoteBits(m, medSources),
        m.sourceFactId ? tokF(m.sourceFactId) : null,
      ]),
    ];
    for (const e of eventsBy.get(m.id) ?? []) {
      if (e.sourceFactId) factIds.push(e.sourceFactId);
      const detail = medEventDetailBit(e.detail, [...medSources, ...sourceTexts(e.sourceFactId ? sources.get(e.sourceFactId) : null)]);
      const sep = detail?.startsWith(`detail ${NOTE_AUTHOR}`) ? ' · ' : ': ';
      // On a row whose start is not recorded, a start line is the old list date (filed before 2026-10-06): "listed".
      const kind = e.kind === 'start' && starts.get(m.id)?.startRecorded === false ? 'listed' : e.kind;
      lines.push(`  - ${fmtDate(e.date, e.datePrecision)} ${kind.replace(/_/g, ' ')}${e.dose ? ` ${e.dose}` : ''}${detail ? `${sep}${detail}` : ''}${e.sourceFactId ? ` ${tokF(e.sourceFactId)}` : ''}`);
    }
    return { group: order(m.status) <= 2 ? 'Current and planned:' : 'Past:', text: lines.join('\n'), factIds };
  });
}

function medicationsSection(data: LedgerData): LedgerSection {
  const lines: string[] = [];
  const factIds: string[] = [];
  let group = '';
  for (const b of medicationBlocks(data)) {
    if (b.group !== group) {
      lines.push(b.group);
      group = b.group;
    }
    lines.push(b.text);
    factIds.push(...b.factIds);
  }
  const facts = data.byType.get('medication') ?? [];
  if (facts.length) {
    lines.push('Medication facts from documents (each with its own provenance):');
    for (const f of facts) {
      lines.push(factLine(f, data.people));
      factIds.push(f.id);
    }
  }
  // The medication timeline (My notes, 2026-10-09): what the user settled between the records and against his own notes.
  let timeline: string[] = [];
  try {
    timeline = timelineLedgerLines();
  } catch {
    timeline = [];
  }
  if (timeline.length) {
    lines.push(`Medication timeline (Reconciliation; "per the patient's notes" marks his version, which won over the records: the records stay as written):`);
    lines.push(...timeline);
  }
  return { key: 'medications', title: SECTION_TITLES.medications, text: sectionText('Medication records (current then past, with their events), then every medication fact extracted from documents.', lines), factIds };
}

/** ", in mg/dL and g/dL" (most frequent first), ", some with no unit printed": every unit of a test's values as printed. */
function unitsWords(rows: LabRow[]): string {
  const counts = new Map<string, number>();
  let none = 0;
  for (const r of rows) {
    const u = (r.reading ? r.reading.unit : r.unit)?.trim();
    if (u) counts.set(u, (counts.get(u) ?? 0) + 1);
    else none++;
  }
  const units = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u);
  if (!units.length) return '';
  const list = units.length === 1 ? units[0] : `${units.slice(0, -1).join(', ')} and ${units[units.length - 1]}`;
  return `, in ${list}${none ? ', some with no unit printed' : ''}`;
}

function labsSection(data: LedgerData): LedgerSection {
  const rows = collectLabRows(data.scope, data.byType.get('lab_result') ?? [], data.docs, data.labEntries());
  const groups = new Map<string, LabRow[]>();
  for (const r of rows) {
    // One test in one place: a value with no specimen stated joins its test as the Labs page lists it.
    const k = `${r.analyteKey}|${effectiveSpecimen(r.analyteKey, r.specimen ?? defaultSpecimenFor(r.analyte), r.analyte)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const keys = [...groups.keys()].sort();
  const lines: string[] = [];
  const factIds: string[] = [];
  for (const k of keys) {
    const g = groups.get(k)!;
    const name = mostCommon(g.map((r) => r.analyte)) ?? k;
    const spec = mostCommon(g.map((r) => r.specimen));
    // Every unit the values were printed in, never one unit over mixed values (rule 5).
    lines.push(`## ${name}${spec ? ` (${spec})` : ''} — ${g.length} result${g.length === 1 ? '' : 's'}${unitsWords(g)}`);
    for (const r of g) {
      lines.push(`  ${labRowLine(r)}`);
      if (r.factId) factIds.push(r.factId);
    }
  }
  const vitals = data.byType.get('vital') ?? [];
  return {
    key: 'labs',
    title: SECTION_TITLES.labs,
    text: sectionText(`Laboratory results grouped by analyte, chronological. Row format: ${LAB_ROW_FORMAT}. ${rows.length} results across ${keys.length} analytes.`, lines),
    factIds: [...factIds, ...vitals.map((v) => v.id)],
  };
}

/** One line per imaging study, chronological, with the facts they are linked to. */
function imagingStudyLines(data: LedgerData): { lines: string[]; linked: Set<string> } {
  const deletedDocs = deletedDocumentIds();
  const studies = db()
    .select()
    .from(schema.imagingStudies)
    .where(isNull(schema.imagingStudies.deletedAt))
    .all()
    .filter((s) => !(s.documentId && deletedDocs.has(s.documentId)));
  studies.sort((a, b) => dateSortKey(a.performedAt).localeCompare(dateSortKey(b.performedAt)) || a.title.localeCompare(b.title));
  const lines: string[] = [];
  const linked = new Set<string>();
  const imagingFacts = new Map((data.byType.get('imaging_result') ?? []).map((f) => [f.id, f]));
  const sources = loadFactTexts(studies.map((s) => s.factId));
  // A study whose detail the reconciliation set aside (a copy of a clinical record, or one that contradicts it) keeps its trust too.
  const trust = trustFor(studies.map((s) => s.factId ?? ''));
  for (const s of studies) {
    if (s.factId) linked.add(s.factId);
    const inst = s.institutionId ? data.people.get(s.institutionId)?.name : null;
    const fact = s.factId ? imagingFacts.get(s.factId) : undefined;
    const source = s.factId ? sources.get(s.factId) : undefined;
    lines.push(
      joinBits([
        fmtDate(s.performedAt, s.performedAtPrecision),
        `${s.modality}${s.bodyPart ? ` ${s.bodyPart}` : ''}`,
        s.title,
        s.contrast ? `contrast: ${s.contrast}` : null,
        s.impression ? `impression: ${clip(s.impression, NOTE_MAX_CHARS)}` : null,
        s.findings ? `findings: ${clip(s.findings, NOTE_MAX_CHARS)}` : null,
        inst ? `at ${inst}` : null,
        s.hasImages ? 'images held' : null,
        s.documentId ? `(${clip(data.docs.get(s.documentId)?.title ?? 'report', 60)} ${tokD(s.documentId)})` : null,
        fact ? trustMarkers(fact.trust ?? trust.get(fact.id), fact.status, fact.verdictBasis, s.documentId ?? null, fact.documentTier) : s.factId && trust.get(s.factId) ? trustMarkers(trust.get(s.factId), null, null, s.documentId ?? null) : null,
        ...imagingNoteBits(s.notes, sourceTexts(source), fact ? fact.verdictNote : null),
        s.factId ? tokF(s.factId) : null,
      ]),
    );
  }
  return { lines, linked };
}

function imagingSection(data: LedgerData): LedgerSection {
  const { lines, linked } = imagingStudyLines(data);
  const facts = (data.byType.get('imaging_result') ?? []).filter((f) => !linked.has(f.id));
  if (facts.length) {
    lines.push('Imaging facts from documents:');
    for (const f of facts) lines.push(factLine(f, data.people));
  }
  return { key: 'imaging', title: SECTION_TITLES.imaging, text: sectionText('Imaging studies, chronological, then imaging facts not yet linked to a study.', lines), factIds: [...linked, ...facts.map((f) => f.id)] };
}

function weekStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function symptomsSection(data: LedgerData): LedgerSection {
  const facts = data.byType.get('symptom') ?? [];
  const lines: string[] = [];
  if (facts.length) {
    lines.push('Symptom facts from documents:');
    for (const f of facts) lines.push(factLine(f, data.people));
  }
  const since = new Date(`${data.today}T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - 90);
  const sinceIso = since.toISOString().slice(0, 10);
  const entries = db()
    .select({ date: schema.symptomEntries.date, score: schema.symptomEntries.score, name: schema.symptomDefinitions.name, sortOrder: schema.symptomDefinitions.sortOrder })
    .from(schema.symptomEntries)
    .innerJoin(schema.symptomDefinitions, eq(schema.symptomDefinitions.id, schema.symptomEntries.symptomId))
    .where(sql`${schema.symptomEntries.date} >= ${sinceIso}`)
    .orderBy(asc(schema.symptomEntries.date), asc(schema.symptomDefinitions.sortOrder))
    .all();
  if (entries.length) {
    const weeks = new Map<string, Map<string, { sum: number; n: number; order: number; days: Set<string> }>>();
    for (const e of entries) {
      const w = weekStart(e.date);
      if (!weeks.has(w)) weeks.set(w, new Map());
      const wk = weeks.get(w)!;
      if (!wk.has(e.name)) wk.set(e.name, { sum: 0, n: 0, order: e.sortOrder, days: new Set() });
      const s = wk.get(e.name)!;
      s.sum += e.score;
      s.n++;
      s.days.add(e.date);
    }
    lines.push(`Patient-logged symptom scores (0-10), weekly means over the last 90 days (since ${sinceIso}):`);
    for (const [w, wk] of [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const parts = [...wk.entries()].sort((a, b) => a[1].order - b[1].order).map(([name, s]) => `${name} ${(s.sum / s.n).toFixed(1)} (${s.days.size}d)`);
      lines.push(`  week of ${w}: ${parts.join(' · ')}`);
    }
  }
  const notes = symptomNoteLines(data);
  if (notes.definitions.length) {
    lines.push('What each logged symptom means, in the patient\'s or team\'s words:');
    lines.push(...notes.definitions.map((l) => `  ${l}`));
  }
  if (notes.entries.length) {
    lines.push('Notes written on single symptom scores, chronological:');
    lines.push(...notes.entries.map((l) => `  ${l}`));
  }
  if (notes.daily.length) {
    lines.push('Daily log days with notes or tags, chronological:');
    lines.push(...notes.daily.map((l) => `  ${l}`));
  }
  return { key: 'symptoms', title: SECTION_TITLES.symptoms, text: sectionText('Symptoms: facts from documents, the patient\'s own daily scores, and the notes the patient or his team wrote in the symptom and daily logs.', lines), factIds: facts.map((f) => f.id) };
}

/** Symptom definitions with a description, symptom scores with a note, and daily log days with notes or tags (within the scope's dates). */
function symptomNoteLines(data: LedgerData): { definitions: string[]; entries: string[]; daily: string[] } {
  const d = db();
  const defs = d.select().from(schema.symptomDefinitions).orderBy(asc(schema.symptomDefinitions.sortOrder), asc(schema.symptomDefinitions.name)).all();
  const definitions = defs.filter((s) => s.description?.trim()).map((s) => `${s.name}${s.active ? '' : ' (no longer tracked)'}: ${userNote(s.description, 'description')}`);
  const entries = d
    .select({ date: schema.symptomEntries.date, score: schema.symptomEntries.score, note: schema.symptomEntries.note, name: schema.symptomDefinitions.name })
    .from(schema.symptomEntries)
    .innerJoin(schema.symptomDefinitions, eq(schema.symptomDefinitions.id, schema.symptomEntries.symptomId))
    .where(sql`trim(coalesce(${schema.symptomEntries.note}, '')) != ''`)
    .orderBy(asc(schema.symptomEntries.date), asc(schema.symptomDefinitions.sortOrder))
    .all()
    .filter((e) => partialWithin(e.date, data.scope?.from, data.scope?.to))
    .map((e) => `${e.date} · ${e.name} ${e.score}/10 · ${userNote(e.note)}`);
  const daily = d
    .select()
    .from(schema.dailyLog)
    .where(sql`trim(coalesce(${schema.dailyLog.notes}, '')) != '' or ${schema.dailyLog.tagsJson} not in ('', '[]')`)
    .orderBy(asc(schema.dailyLog.date))
    .all()
    .filter((r) => partialWithin(r.date, data.scope?.from, data.scope?.to))
    .map((r) => joinBits([r.date, ...dailyLogBits(r)]));
  return { definitions, entries, daily };
}

/** One line per records inventory row. */
function inventoryLines(): { lines: string[]; factIds: string[] } {
  const lines: string[] = [];
  const factIds: string[] = [];
  for (const r of listRecords()) {
    if (r.sourceFactId) factIds.push(r.sourceFactId);
    lines.push(
      joinBits([
        `[${r.status.replace(/_/g, ' ')}${r.held ? ', held' : ''}]`,
        r.title,
        r.recordType.replace(/_/g, ' '),
        r.heldForm?.trim() ? `held as ${clip(r.heldForm, NOTE_MAX_CHARS)}` : null,
        r.institutionName ? `from ${r.institutionName}` : null,
        r.recordDate ? fmtDate(r.recordDate, r.recordDatePrecision) : null,
        r.system ? `system ${r.system}` : null,
        r.requestedAt ? `requested ${localDayOf(r.requestedAt)}` : null,
        r.receivedAt ? `received ${localDayOf(r.receivedAt)}` : null,
        userNote(r.notes),
        r.documentId ? `(${clip(r.documentTitle ?? 'document', 60)} ${tokD(r.documentId)})` : null,
        r.sourceFactId ? `source ${tokF(r.sourceFactId)}` : null,
      ]),
    );
  }
  return { lines, factIds };
}

/** Documents on file (within the scope) that carry notes or tags from the patient or his team, by date. */
function documentNoteLines(data: LedgerData): Array<{ id: string; line: string }> {
  const docSet = data.scope?.documentIds?.length ? new Set(data.scope.documentIds) : null;
  const rows = [...data.docs.entries()].filter(([id, doc]) => (doc.notes?.trim() || doc.tags.length) && (!docSet || docSet.has(id)) && partialWithin(doc.date, data.scope?.from, data.scope?.to));
  rows.sort(([ia, a], [ib, b]) => dateSortKey(a.date).localeCompare(dateSortKey(b.date)) || a.title.localeCompare(b.title) || ia.localeCompare(ib));
  return rows.map(([id, doc]) => ({ id, line: joinBits([`${clip(doc.title, 120)} (${doc.category.replace(/_/g, ' ')}, ${fmtDate(doc.date, doc.datePrecision)}) ${tokD(id)}`, ...documentNoteBits(doc.notes, doc.tags)]) }));
}

function recordsSection(data: LedgerData): LedgerSection {
  const lines: string[] = [];
  const inventory = inventoryLines();
  const factIds: string[] = [...inventory.factIds];
  if (inventory.lines.length) {
    lines.push('Records inventory (what is held, requested or missing):');
    lines.push(...inventory.lines);
  }
  const docNotes = documentNoteLines(data).map((x) => x.line);
  if (docNotes.length) {
    lines.push('Documents on file with notes or tags from the patient or his team:');
    lines.push(...docNotes);
  }
  // What was not read: an answer that leans on one of these says which pages were not read (rule 15).
  const reading = readingGapLines(data.scope);
  if (reading.partial.length) {
    lines.push('Documents whose details were pulled out from only part of their pages (the rest is not in the ledger; get_document_coverage says which pages):');
    lines.push(...reading.partial);
  }
  if (reading.unreadCount) {
    lines.push(`Documents whose details were never pulled out (${reading.unreadCount}; their pages can still be read with get_document_pages):`);
    lines.push(...reading.unread);
    if (reading.unreadCount > reading.unread.length) lines.push(`… and ${reading.unreadCount - reading.unread.length} more (list_documents shows each one's state).`);
  }
  const gaps = inferGaps().filter((g) => g.kind === 'inferred');
  if (gaps.length) {
    lines.push('Inferred gaps (records mentioned in documents that are not on file and match no inventory row):');
    for (const g of gaps) {
      if (g.sourceFactId) factIds.push(g.sourceFactId);
      lines.push(
        joinBits([
          'GAP',
          g.title,
          g.recordType.replace(/_/g, ' '),
          g.institution ? `from ${g.institution}` : null,
          g.date ? fmtDate(g.date, g.datePrecision) : null,
          g.sourceDocumentTitle ? `mentioned in ${clip(g.sourceDocumentTitle, 60)}` : null,
          g.citation ? tokD(g.citation.documentId, g.citation.pageNumber) : null,
          g.likelyHeldDocumentTitle && g.likelyHeldDocumentId ? `possibly already held as "${clip(g.likelyHeldDocumentTitle, 60)}" ${tokD(g.likelyHeldDocumentId)}` : null,
          g.sourceFactId ? tokF(g.sourceFactId) : null,
        ]),
      );
    }
  }
  const facts = data.byType.get('record_reference') ?? [];
  if (facts.length) {
    lines.push('Record references found in documents (present_in_this_document: no means only mentioned):');
    for (const f of facts) {
      lines.push(factLine(f, data.people));
      factIds.push(f.id);
    }
  }
  return { key: 'records', title: SECTION_TITLES.records, text: sectionText('Inventory rows, documents on file that carry notes or tags, documents not fully read, inferred gaps, and every record reference.', lines), factIds };
}

/** The state of a promised follow-up as the ledger and the tools print it. */
export function followUpState(r: { followUpDoneAt: string | null; followUpDue: string | null }, today: string, owner?: string | null): string {
  const state = r.followUpDoneAt ? `done ${localDayOf(r.followUpDoneAt)}` : isFollowUpOverdue(r.followUpDue, today) ? `OVERDUE (due ${r.followUpDue})` : r.followUpDue ? `open, due ${r.followUpDue}` : 'open, no due date';
  return `${state}${owner ? `, owner ${owner}` : ''}`;
}

/** One line per communication within the scope's dates, chronological. */
function communicationLines(data: LedgerData): string[] {
  const d = db();
  const c = schema.communications;
  // A message read out of a record goes with its record (deleted, or held back as someone else's; review 2026-10-09).
  const rows = d.select().from(c).where(and(isNull(c.deletedAt), sql.raw(visibleWithRecordSql('"communications"')))).all();
  const parts = d.select().from(schema.communicationParticipants).all();
  const topics = d.select().from(schema.communicationTopics).all();
  const partsBy = new Map<string, string[]>();
  for (const p of parts) {
    const name = data.people.get(p.personId)?.name;
    if (!name) continue;
    if (!partsBy.has(p.communicationId)) partsBy.set(p.communicationId, []);
    partsBy.get(p.communicationId)!.push(`${name}${p.role !== 'to' ? ` (${p.role})` : ''}`);
  }
  const topicsBy = new Map<string, string[]>();
  for (const t of topics) {
    if (!topicsBy.has(t.communicationId)) topicsBy.set(t.communicationId, []);
    topicsBy.get(t.communicationId)!.push(t.topic);
  }
  const list = rows.filter((r) => partialWithin(r.occurredAt, data.scope?.from, data.scope?.to));
  sortCommunications(list);
  return list.map((r) => {
    const owner = r.followUpOwnerPersonId ? data.people.get(r.followUpOwnerPersonId)?.name : null;
    const names = partsBy.get(r.id) ?? [];
    const details = parseCommunicationDetails(r.detailsJson);
    return joinBits([
      `${fmtDate(r.occurredAt, r.occurredAtPrecision)}${r.occurredTime ? ` ${r.occurredTime}` : ''}`,
      `${r.direction} ${r.channel}`,
      messageAuthorBit(details) ?? (names.length ? `with ${names.join(', ')}` : null),
      r.subject,
      ...communicationBits(r, details, MESSAGE_LEDGER_CHARS, followUpState(r, data.today, owner)),
      topicsBy.get(r.id)?.length ? `topics: ${topicsBy.get(r.id)!.join(', ')}` : null,
      r.threadKey ? `thread ${r.threadKey}` : null,
      r.documentId ? communicationSourceBit(r.documentId, details, data.docs.get(r.documentId)?.title ?? 'document', isFromRecord(details, r.body)) : null,
      tokC(r.id),
    ]);
  });
}

function communicationsSection(data: LedgerData): LedgerSection {
  const lines = communicationLines(data);
  return {
    key: 'communications',
    title: SECTION_TITLES.communications,
    text: sectionText(`Every contact event, chronological. ${COMMUNICATIONS_LEGEND} ${lines.length} entries.`, lines),
    factIds: [],
  };
}

// ---------------------------------------------------------------------------
// Messages read out of records (2026-10-07, large exports): voice, page tokens, threads
// ---------------------------------------------------------------------------

/** The longest start of a message body the ledger prints (get_thread gives whole bodies). */
export const MESSAGE_LEDGER_CHARS = 240;

/** What the communications lines mean, said once (the ledger's section and get_communications). */
export const COMMUNICATIONS_LEGEND =
  'Most were logged by the patient or his team (format: date · direction channel · with · subject · summary (patient or team): "…" · outcome (patient or team): "…" · follow-up promised (patient or team): "…" (state) · topics ⟦C:communicationId⟧; a summary starting "Model summary" was written by the model from the filed document, not by the patient). Lines with message (from the record, <whose words>): "…" were read word for word out of a clinical record (a portal message, a telephone note, a letter, a questionnaire): date and time as printed · direction channel · from <author as printed> (<whose words>) to <recipient as printed> · subject · the start of the message, verbatim · read receipt · thread <key> (get_thread reads the whole thread, every message in full) · the record and its page ⟦D:id p.N⟧ · ⟦C:id⟧. Whose words: "the patient\'s own words" are his claims even inside a clinical record (trusted as the patient\'s, patient tier, never as the record\'s: a value he quotes is not a printed result); "a clinician" and "care team staff" are the record\'s own words; "automatic" is a system message. An outcome or follow-up "(worked out from the replies)" was read from later messages of the thread, not written by the patient.';

/** Whose words a message body is, for the clinician. */
export const VOICE_WORDS: Record<string, string> = {
  patient: "the patient's own words",
  clinician: 'a clinician',
  staff: 'care team staff',
  system: 'automatic',
  third_party: 'someone outside the care team',
  unknown: 'whose words is not known',
};

/** True when a communication was read out of a record (word for word), not logged by hand. */
export function isFromRecord(details: CommunicationDetails, body?: string | null): boolean {
  return details.origin === 'extracted' || (Boolean(body?.trim()) && details.origin !== 'manual' && details.origin !== 'import');
}

/** Chronological, then by time of day, then (Epic prints newest first) by printed order, then as logged. */
export function sortCommunications<T extends { occurredAt: string | null; occurredTime?: string | null; createdAt: string; id: string; detailsJson?: string | null }>(rows: T[]): T[] {
  const printed = (r: T) => parseCommunicationDetails(r.detailsJson ?? null).printedOrder ?? -1;
  return rows.sort(
    (a, b) =>
      dateSortKey(a.occurredAt).localeCompare(dateSortKey(b.occurredAt)) ||
      (a.occurredTime ?? '').localeCompare(b.occurredTime ?? '') ||
      printed(b) - printed(a) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
}

/** "from Pat Example (the patient's own words) to P Example Nurses (supporting Dr. A. Example)", as printed. */
export function messageAuthorBit(d: CommunicationDetails): string | null {
  const voice = d.voice ? VOICE_WORDS[d.voice] ?? null : null;
  const from = d.authorText?.trim() ? `from ${clip(authorWithRole(d.authorText, d.authorRole ? clip(d.authorRole, 20) : null), 104)}${voice ? ` (${voice})` : ''}` : voice ? `(${voice})` : null;
  const to = d.recipientText?.trim() ? `to ${clip(d.recipientText, 100)}${d.intendedFor && !d.recipientText.includes(d.intendedFor) ? ` (for ${clip(d.intendedFor, 60)})` : ''}` : null;
  return [from, to].filter(Boolean).join(' ') || null;
}

/**
 * A communication's words, each labelled with whose they are: the message as printed in its record (verbatim, the
 * first `maxChars`), its read receipts, then the summary, outcome and follow-up. On a row read out of a record these
 * three were worked out by the app from the thread unless the patient or his team edited them; on every other row they
 * are the patient's or his team's (a summary starting "Model summary" excepted), as before.
 */
export function communicationBits(
  r: { body?: string | null; summary: string | null; outcome: string | null; followUpPromised?: string | null },
  d: CommunicationDetails,
  maxChars: number,
  followUp?: string | null,
): string[] {
  const voice = d.voice ? VOICE_WORDS[d.voice] : null;
  const body = r.body?.trim() ? `message (from the record${voice ? `, ${voice}` : ''}): "${clip(r.body, maxChars)}"` : null;
  const receipts = (d.readReceipts ?? []).map((x) => `read ${clip(x.atText, 40)} by ${clip(x.byText, 60)}`);
  const model = d.modelSummary?.text?.trim() ? `Model summary (written by the model, not the record): "${clip(d.modelSummary.text, NOTE_MAX_CHARS)}"` : null;
  const flag = d.unverified ? '(read from a layout not yet checked against a real file: unverified)' : null;
  if (d.origin !== 'extracted') {
    return present([body, ...receipts, ...communicationNoteBits(r), followUp !== undefined ? followUpBit(r.followUpPromised, followUp ?? '') : null, model, flag]);
  }
  const summary = r.summary?.trim() ? (userEdited(d, 'summary') ? userNote(r.summary, 'summary') : r.summary.trim().startsWith(MODEL_SUMMARY_PREFIX.trim()) ? clip(r.summary, NOTE_MAX_CHARS) : `summary (worked out by the app): "${clip(r.summary, NOTE_MAX_CHARS)}"`) : null;
  const outcome = r.outcome?.trim() ? (userEdited(d, 'outcome') ? userNote(r.outcome, 'outcome') : `outcome (worked out from the replies): "${clip(r.outcome, NOTE_MAX_CHARS)}"`) : null;
  const promised = clip(r.followUpPromised, NOTE_MAX_CHARS);
  const fu = followUp === undefined || !promised ? null : userEdited(d, 'followUpPromised') ? followUpBit(r.followUpPromised, followUp ?? '') : `follow-up promised (worked out from the replies): "${promised}" (${followUp})`;
  return present([body, ...receipts, summary, outcome, fu, model, flag]);
}

function userEdited(d: CommunicationDetails, field: string): boolean {
  return Boolean(d.userFields?.includes(field));
}

/** The page a message starts on in its record (its header), else its first page. */
export function messagePage(d: CommunicationDetails): number | null {
  return d.headerPage ?? d.pages?.[0] ?? null;
}

/** "(Example chart print p.51 ⟦D:id p.51⟧)": the record a message was read from, with its real page; a filed transcript keeps page 1. */
export function communicationSourceBit(documentId: string, d: CommunicationDetails, title: string, fromRecord: boolean): string {
  const page = messagePage(d);
  if (fromRecord && page) {
    const pages = d.pages && d.pages[1] !== d.pages[0] ? ` pp.${d.pages[0]}-${d.pages[1]}` : '';
    return `(in ${clip(title, 60)}${pages} ${tokD(documentId, page)})`;
  }
  return `(transcript ${clip(title, 60)} ${tokD(documentId, 1)})`;
}

// ---------------------------------------------------------------------------
// How much of a document was read (2026-10-07): "details from pp.1-48 of 1,840; 1,792 not read; 214 scanned pages"
// ---------------------------------------------------------------------------

const n0 = (x: number): string => x.toLocaleString('en-US');

/** The extraction status in a word or two, for the clinician. */
export function extractionWords(status: string | null | undefined): string {
  switch (status) {
    case 'done':
      return 'read';
    case 'partial':
      return 'partly read';
    case 'failed':
      return 'reading failed';
    case 'queued':
    case 'running':
      return 'being read';
    default:
      return 'not read';
  }
}

/** Page ranges in words, at most `max` ranges ("pp.1-48, 61-72 and 14 more ranges"). */
function rangesWords(ranges: Array<[number, number]>, max = 12): string {
  if (ranges.length <= max) return formatPageRanges(ranges);
  return `${formatPageRanges(ranges.slice(0, max))} and ${n0(ranges.length - max)} more ranges`;
}

/** The pages of a coverage in one state, as ranges. */
export function pagesInState(cov: DocumentCoverage, states: readonly PageCoverageState[]): Array<[number, number]> {
  const per = decodeStateRanges(cov.ranges, cov.pagesTotal);
  const out: number[] = [];
  per.forEach((s, i) => {
    if (states.includes(s)) out.push(i + 1);
  });
  return pagesToRanges(out);
}

/**
 * How much of a document Claude has read, for the clinician (list_documents, the ledger, get_document_coverage):
 * "details from pp.1-48 of 1,840; 1,792 not read; 214 scanned pages (not read by OCR yet)". Worked out from the
 * coverage; without one, from the extraction status alone.
 */
export function readingWords(doc: { pageCount: number; extractionStatus: string; textStatus?: string | null }, cov: DocumentCoverage | null): string {
  if (doc.textStatus === 'failed') return 'its pages could not be read';
  if (doc.textStatus === 'pending' || doc.textStatus === 'extracting' || doc.textStatus === 'ocr_running') return 'its pages are being read';
  if (!cov || !cov.pagesTotal) {
    switch (doc.extractionStatus) {
      case 'done':
        return 'details pulled out (which pages they came from is not counted)';
      case 'partial':
        return 'details pulled out from only part of it (which pages is not counted)';
      case 'failed':
        return 'pulling out the details failed';
      case 'queued':
      case 'running':
        return 'details being pulled out now';
      default:
        return doc.pageCount ? 'details not pulled out yet' : 'no pages';
    }
  }
  const total = cov.pagesTotal;
  const skipped = cov.pagesSkipped.duplicate + cov.pagesSkipped.boilerplate + cov.pagesSkipped.blank + cov.pagesSkipped.no_text;
  const notRead = cov.pagesPending + cov.pagesRunning;
  const parts: string[] = [];
  // "details from all" only when every page gave details; otherwise how many did (the skipped ones are listed below).
  const withDetails = cov.pagesDone + cov.pagesParsed;
  if (cov.state === 'complete') parts.push(cov.pagesDone ? (withDetails >= total ? `details from all ${n0(total)} pages` : `all ${n0(total)} pages accounted for; details from ${n0(withDetails)} ${withDetails === 1 ? 'page' : 'pages'}`) : `all ${n0(total)} pages accounted for`);
  else if (!cov.pagesDone) parts.push(cov.state === 'running' ? 'being read now; no details yet' : `details not pulled out yet (0 of ${n0(total)} pages)`);
  else parts.push(`details from ${rangesWords(pagesInState(cov, ['done']))} of ${n0(total)}`);
  if (cov.state !== 'complete' && notRead) parts.push(`${n0(notRead)} not read${cov.pagesRunning ? ` (${n0(cov.pagesRunning)} being read now)` : ''}`);
  if (cov.pagesFailed) parts.push(`${n0(cov.pagesFailed)} could not be read (${rangesWords(pagesInState(cov, ['failed']), 6)})`);
  if (cov.pagesParsed) parts.push(`${n0(cov.pagesParsed)} of messages, notes or letters read word for word without the model`);
  if (skipped) {
    const why = [
      cov.pagesSkipped.duplicate + cov.pagesSkipped.boilerplate ? `${n0(cov.pagesSkipped.duplicate + cov.pagesSkipped.boilerplate)} ${cov.pagesSkipped.duplicate + cov.pagesSkipped.boilerplate === 1 ? 'repeat' : 'repeats'}` : null,
      cov.pagesSkipped.blank ? `${n0(cov.pagesSkipped.blank)} blank` : null,
      cov.pagesSkipped.no_text ? `${n0(cov.pagesSkipped.no_text)} with nothing readable` : null,
    ].filter(Boolean);
    parts.push(`${n0(skipped)} skipped (${why.join(', ')})`);
  }
  const scanned = Math.max(cov.pagesImage, cov.pagesOcr);
  if (scanned) parts.push(`${n0(scanned)} scanned pages${cov.pagesOcr ? (cov.pagesOcr >= scanned ? ' read by OCR' : ` (${n0(cov.pagesOcr)} read by OCR)`) : ' (not read by OCR yet)'}`);
  if (cov.basis === 'legacy') parts.push('worked out from an earlier reading');
  return parts.join('; ');
}

/** A document's coverage from its metadata JSON (null when none or unreadable). */
export function coverageOfMetadata(metadataJson: string | null | undefined): DocumentCoverage | null {
  return parseCoverage(parseJson<Record<string, unknown>>(metadataJson ?? '{}', {}));
}

const READING_GAP_LIST = 30;

/**
 * Documents (within the scope) whose details were pulled out from only part of their pages, or not at all, so an
 * answer can say what was not read. Clinical documents first by date.
 */
function readingGapLines(scope?: AskScope): { partial: string[]; unread: string[]; unreadCount: number } {
  const docSet = scope?.documentIds?.length ? new Set(scope.documentIds) : null;
  const D = schema.documents;
  const rows = db()
    .select({ id: D.id, title: D.title, category: D.category, date: D.documentDate, precision: D.documentDatePrecision, pageCount: D.pageCount, extractionStatus: D.extractionStatus, textStatus: D.textStatus, metadataJson: D.metadataJson })
    .from(D)
    .where(isNull(D.deletedAt))
    .all()
    .filter((r) => (!docSet || docSet.has(r.id)) && partialWithin(r.date, scope?.from, scope?.to) && r.pageCount > 0);
  rows.sort((a, b) => dateSortKey(a.date).localeCompare(dateSortKey(b.date)) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const partial: string[] = [];
  const unread: string[] = [];
  let unreadCount = 0;
  for (const r of rows) {
    const cov = coverageOfMetadata(r.metadataJson);
    const incomplete = ['partial', 'failed', 'queued', 'running'].includes(r.extractionStatus) || (cov != null && (cov.state === 'partial' || cov.state === 'running') && r.extractionStatus !== 'none') || r.textStatus === 'failed';
    const head = `${clip(r.title, 120)} (${r.category.replace(/_/g, ' ')}, ${fmtDate(r.date, r.precision)}, ${n0(r.pageCount)} pages) ${tokD(r.id)}`;
    if (incomplete) partial.push(`${head}: ${extractionWords(r.extractionStatus)}; ${readingWords(r, cov)}`);
    else if (r.extractionStatus === 'none') {
      unreadCount++;
      if (unread.length < READING_GAP_LIST) unread.push(head);
    }
  }
  return { partial, unread, unreadCount };
}

/** One line per encounter, chronological. */
function encounterLines(data: LedgerData): string[] {
  const rows = db().select().from(schema.encounters).where(isNull(schema.encounters.deletedAt)).all();
  rows.sort((a, b) => dateSortKey(a.occurredAt).localeCompare(dateSortKey(b.occurredAt)) || a.title.localeCompare(b.title));
  return rows.map((e) => {
    const clinician = e.clinicianId ? data.people.get(e.clinicianId)?.name : null;
    const inst = e.institutionId ? data.people.get(e.institutionId)?.name : null;
    const docIds = parseJson<string[]>(e.documentIdsJson, []);
    return joinBits([
      fmtDate(e.occurredAt, e.occurredAtPrecision) + (e.timeText ? ` ${e.timeText}` : ''),
      `${e.kind} [${e.status}]`,
      e.title,
      clinician ? `with ${clinician}` : null,
      inst ? `at ${inst}` : null,
      ...encounterNoteBits(e),
      docIds.length ? `documents: ${docIds.map((id) => `${clip(data.docs.get(id)?.title ?? 'document', 50)} ${tokD(id)}`).join(', ')}` : null,
    ]);
  });
}

function encountersSection(data: LedgerData): LedgerSection {
  return { key: 'encounters', title: SECTION_TITLES.encounters, text: sectionText('Visits, admissions, procedures and tests as scheduled or recorded, chronological. Prep notes, questions (marked "(asked)", with the answer when one was recorded) and outcomes were written by the patient or his team.', encounterLines(data)), factIds: [] };
}

const OPEN_TASK_STATUSES = new Set(['open', 'in_progress']);

/**
 * One line per open task, soonest due first, then one per closed task (done
 * or cancelled) that carries a detail, most recently closed first, so the
 * detail written on it still reaches the consult. The status is on the line.
 */
function taskLines(data: LedgerData): { open: string[]; closed: string[] } {
  const rows = db()
    .select()
    .from(schema.tasks)
    .where(and(isNull(schema.tasks.deletedAt), or(inArray(schema.tasks.status, [...OPEN_TASK_STATUSES]), sql`trim(coalesce(${schema.tasks.detail}, '')) != ''`)!))
    .all();
  const open = rows.filter((t) => OPEN_TASK_STATUSES.has(t.status));
  const closed = rows.filter((t) => !OPEN_TASK_STATUSES.has(t.status));
  open.sort((a, b) => dateSortKey(a.dueAt).localeCompare(dateSortKey(b.dueAt)) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  closed.sort((a, b) => (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const findingTexts = findingTaskTexts(rows);
  const line = (t: (typeof rows)[number]) => {
    const owner = t.ownerPersonId ? data.people.get(t.ownerPersonId)?.name : null;
    const isOpen = OPEN_TASK_STATUSES.has(t.status);
    return joinBits([
      t.dueAt ? `due ${localDayOf(t.dueAt)}${isOpen && isPastDue(localDayOf(t.dueAt), data.today) ? ' (OVERDUE)' : ''}` : 'no due date',
      `[${t.status.replace(/_/g, ' ')}${!isOpen && t.completedAt ? ` ${localDayOf(t.completedAt)}` : ''}]`,
      t.priority !== 'normal' ? t.priority : null,
      t.title,
      taskDetailBit(t, findingTexts),
      `owner ${owner ?? t.owner.replace(/_/g, ' ')}`,
      t.sourceType !== 'manual' && t.sourceId ? `from ${t.sourceType} ${t.sourceType === 'fact' ? tokF(t.sourceId) : t.sourceType === 'communication' ? tokC(t.sourceId) : t.sourceType === 'document' ? tokD(t.sourceId) : t.sourceId}` : null,
    ]);
  };
  return { open: open.map(line), closed: closed.map(line) };
}

function tasksSection(data: LedgerData): LedgerSection {
  const { open, closed } = taskLines(data);
  const lines = [...open];
  if (closed.length) {
    lines.push('Closed tasks (done or cancelled) that carry a detail, most recently closed first:');
    lines.push(...closed);
  }
  return { key: 'tasks', title: SECTION_TITLES.tasks, text: sectionText('Open tasks, soonest due first, then closed tasks that carry a detail. Details marked (patient or team) were written by the patient or his team.', lines), factIds: [] };
}

/**
 * Findings that are new or confirmed, then findings the patient set aside
 * (dismissed, resolved or disputed) that carry the patient's or team's note,
 * so the reason they were set aside is not lost.
 */
function findingLines(): { open: string[]; setAside: string[] } {
  const d = db();
  const rows = d.select().from(schema.findings).where(isNull(schema.findings.deletedAt)).orderBy(desc(schema.findings.createdAt)).all();
  const open = rows.filter((f) => f.status === 'new' || f.status === 'confirmed');
  const setAside = rows.filter((f) => f.status !== 'new' && f.status !== 'confirmed' && findingNoteBit(f.verdictNote));
  const ids = new Set([...open, ...setAside].map((f) => f.id));
  const evidence = ids.size ? d.select().from(schema.findingEvidence).orderBy(asc(schema.findingEvidence.sortOrder)).all() : [];
  const evBy = new Map<string, string[]>();
  for (const e of evidence) {
    if (!ids.has(e.findingId)) continue;
    const toks = [e.factId ? tokF(e.factId) : null, e.communicationId ? tokC(e.communicationId) : null, e.documentId ? tokD(e.documentId) : null].filter(Boolean) as string[];
    if (!toks.length) continue;
    if (!evBy.has(e.findingId)) evBy.set(e.findingId, []);
    evBy.get(e.findingId)!.push(...toks);
  }
  const line = (f: (typeof rows)[number]) =>
    joinBits([`[${f.status}]`, f.category.replace(/_/g, ' '), `severity ${f.severity}`, f.title, `why it matters: ${clip(f.whyItMatters, 400)}`, f.detail ? clip(f.detail, 400) : null, findingNoteBit(f.verdictNote), evBy.get(f.id)?.length ? `evidence: ${evBy.get(f.id)!.join(' ')}` : null]);
  return { open: open.map(line), setAside: setAside.map(line) };
}

function findingsSection(): LedgerSection {
  const { open, setAside } = findingLines();
  const lines = [...open];
  if (setAside.length) {
    lines.push('Findings the patient set aside, with the note saying why:');
    lines.push(...setAside);
  }
  return { key: 'findings', title: SECTION_TITLES.findings, text: sectionText('Cross-reference findings that are new or confirmed, then those the patient set aside with a note. These are prompts for a human look, never diagnoses.', lines), factIds: [] };
}

// ---------------------------------------------------------------------------
// Reconciliation: events that need a source, and every inaccurate mention
// ---------------------------------------------------------------------------

/** At most this many events that need a source, and this many inaccurate mentions, are listed in the ledger. */
export const RECONCILE_LEDGER_EVENTS = 40;
export const RECONCILE_LEDGER_INACCURATE = 80;
/** Mentions named per group of an event (the rest are counted). */
export const RECONCILE_LEDGER_MENTIONS = 6;

const RECONCILE_TYPE_WORDS: Record<string, string> = { lab_result: 'lab', imaging_result: 'imaging', vital: 'vital sign', procedure: 'procedure', event: 'event' };

/**
 * The subject's own report for each reconciled type (services/reconcile.ts ownReport): the lab report (or pathology
 * report) for a lab result, the scan report for a scan, the procedure report for a procedure. Vital signs and events
 * have none.
 */
const OWN_REPORT: Partial<Record<string, { categories: string[]; words: string }>> = {
  lab_result: { categories: ['lab_report', 'pathology'], words: 'the lab report' },
  imaging_result: { categories: ['imaging_report'], words: 'the scan report' },
  procedure: { categories: ['operative_report'], words: 'the procedure report' },
};

/** Document categories by id (deleted documents included: they are only named). */
function documentCategories(ids: Array<string | null | undefined>): Map<string, string> {
  const want = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  const out = new Map<string, string>();
  for (let i = 0; i < want.length; i += 400) {
    for (const r of db().select({ id: schema.documents.id, category: schema.documents.category }).from(schema.documents).where(inArray(schema.documents.id, want.slice(i, i + 400))).all()) out.set(r.id, r.category);
  }
  return out;
}

/**
 * What the subject's own report (OWN_REPORT) can still do for an event that needs a source: nothing ('none': the type
 * has no such report, or it is already one of the event's clinical records); 'mark': it is one of the event's documents
 * but not a clinical record yet (its titles and tokens); 'add': none of the event's documents is that report.
 */
function ownReportAdvice(e: ReconcileEvent, own: { categories: string[] } | undefined, categories: Map<string, string>): { kind: 'none' | 'add' | 'mark'; titles: string; count: number } {
  if (!own) return { kind: 'none', titles: '', count: 0 };
  const mentions = [...(e.record ? [e.record] : []), ...e.groups.flatMap((g) => g.mentions)];
  const reports = mentions.filter((m) => m.documentId && own.categories.includes(categories.get(m.documentId) ?? ''));
  if (reports.some((m) => m.documentTier === 'primary')) return { kind: 'none', titles: '', count: 0 };
  if (!reports.length) return { kind: 'add', titles: '', count: 0 };
  const docs = new Map<string, string>();
  for (const m of [...reports].sort((a, b) => (a.documentTitle ?? '').localeCompare(b.documentTitle ?? '') || a.documentId!.localeCompare(b.documentId!))) {
    if (!docs.has(m.documentId!)) docs.set(m.documentId!, `${clip(m.documentTitle ?? 'a document', 80)} ${tokD(m.documentId!)}`);
  }
  const named = [...docs.values()].slice(0, 3);
  return { kind: 'mark', titles: `${named.join(' or ')}${docs.size > named.length ? ` (or ${docs.size - named.length} more)` : ''}`, count: docs.size };
}

/** A mention's source, as the ledger names documents: title, tier, page and fact tokens. */
function mentionSource(m: Mention): string {
  const tier = m.documentTier && m.documentTier !== 'unknown' ? `, ${m.documentTier}` : '';
  const doc = m.documentId ? `${clip(m.documentTitle ?? 'document', 60)}${tier} ${tokD(m.documentId, m.page)}` : 'manual entry';
  return `${doc} ${tokF(m.factId)}`;
}

/** The event's date (the last date in its key), for the scope's window. */
function eventKeyDate(key: string): string | null {
  const parts = key.split('|');
  for (let i = parts.length - 1; i >= 0; i--) if (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(parts[i])) return parts[i];
  return null;
}

/** Every page of a reconciliation list (500 at a time), filtered, stopping once `want` items passed the filter (the total is still counted). */
function collectPaged<T>(load: (offset: number) => { items: T[]; total: number }, keep: (x: T) => boolean, want: number): { items: T[]; total: number } {
  const items: T[] = [];
  let total = 0;
  for (let offset = 0; ; offset += 500) {
    const page = load(offset);
    for (const x of page.items) {
      if (!keep(x)) continue;
      total++;
      if (items.length < want) items.push(x);
    }
    if (!page.items.length || offset + page.items.length >= page.total) break;
  }
  return { items, total };
}

/**
 * The head of a "values disagree" event's line: its reason ("These documents give different values, and the lab report
 * gives it in another unit: 112 mg/dL on 2024-03-18.") with the record named and cited; what the record gives is added
 * when the reason does not already end with it.
 */
function valuesDisagreeHead(reason: string, given: TrustInfo): string {
  const head = reason.trim().replace(/\.$/, '');
  const doc = `${clip(given.recordDocumentTitle ?? 'the record', 60)} ${tokD(given.recordDocumentId!)}`;
  return given.recordValue && head.includes(given.recordValue) ? `${head} (${doc})` : `${head} (${clip(given.recordValue, 120)}, ${doc})`;
}

/**
 * The Reconciliation section: events whose documents disagree with no clinical record
 * to settle them (each group with what it says and which documents say it), then every
 * inaccurate mention with what it says and what the record says. Capped; the rest are
 * counted. A scope keeps what touches its documents and dates.
 */
export function reconciliationSection(scope?: AskScope, labEntries?: () => LabEntry[]): LedgerSection {
  const docSet = scope?.documentIds?.length ? new Set(scope.documentIds) : null;
  const inDocs = (ids: Array<string | null | undefined>) => !docSet || ids.some((id) => Boolean(id) && docSet.has(id as string));
  const inDates = (iso: string | null | undefined) => partialWithin(iso, scope?.from, scope?.to);
  const eventMentions = (e: ReconcileEvent): Mention[] => [...(e.record ? [e.record] : []), ...e.groups.flatMap((g) => g.mentions)];
  const needs = collectPaged((offset) => listReconcileEvents('needs_source', { limit: 500, offset }), (e) => inDocs(eventMentions(e).map((m) => m.documentId)) && inDates(eventKeyDate(e.key)), RECONCILE_LEDGER_EVENTS);
  const wrong = collectPaged((offset) => listInaccurate({ limit: 500, offset }), (it: InaccurateItem) => inDocs([it.documentId, it.record?.documentId]) && inDates(it.date), RECONCILE_LEDGER_INACCURATE);
  const lines: string[] = [];
  const factIds: string[] = [];
  lines.push(`Needs a source: ${needs.total} event${needs.total === 1 ? '' : 's'} the documents disagree about, with no clinical record that settles ${needs.total === 1 ? 'it' : 'them'} (none yet, or clinical records that disagree with each other). Say that the documents disagree and which record would settle it (where the clinical records disagree, cite each record and say the patient can choose the right one); do not pick a side unless the materials justify it.`);
  // The categories of the documents in these events: is the subject's own report one of them, and is it a record yet?
  const categories = documentCategories(needs.items.flatMap((e) => eventMentions(e).map((m) => m.documentId)));
  for (const e of needs.items) {
    const own = OWN_REPORT[e.type];
    const report = ownReportAdvice(e, own, categories);
    // Clinical records that disagree with each other: a record is there, but it does not settle the event. The subject's
    // own report settles it: marking it as a clinical record where it is already one of the event's documents (not a
    // record yet), adding it where none of them is that report; nothing where it is already one of the records.
    const reportWords = report.kind === 'mark' ? `marking ${report.titles} as a clinical record (Use a document already here)` : report.kind === 'add' ? `adding the subject's own report (${own!.words})` : '';
    // Values that disagree with each other while the record gives the value in another unit or other words: the record
    // is there, named with what it gives, for the clinician to compare each value with.
    const given = VALUES_DISAGREE_RE.test(e.reason ?? '') ? eventMentions(e).find((m) => m.trust.recordValue && m.trust.recordDocumentId)?.trust : undefined;
    const contest = e.recordsDisagree
      ? `. ${e.reason ?? 'Clinical records disagree'} with each other: the patient settles it by choosing the right one (This one is right) or Both happened${reportWords ? `, or by ${reportWords}` : ''}`
      : given
        ? `. ${valuesDisagreeHead(e.reason ?? '', given)}: compare each value with it; the patient settles it by choosing the right value (This one is right)`
        : report.kind === 'mark'
        ? report.count === 1
          ? `. ${report.titles} (${own!.words}) is in the case but not a clinical record yet: the patient settles it by marking that report as a clinical record (Use a document already here)`
          : `. ${report.titles} (${own!.words}) are in the case but not clinical records yet: the patient settles it by marking the right one as a clinical record (Use a document already here)`
        : '';
    lines.push(`- ${e.subject} (${RECONCILE_TYPE_WORDS[e.type] ?? e.type}), ${e.dateLabel}: ${e.mentionCount} mention${e.mentionCount === 1 ? '' : 's'} in ${e.documentCount} document${e.documentCount === 1 ? '' : 's'}${contest}`);
    for (const g of e.groups) {
      const shown = g.mentions.slice(0, RECONCILE_LEDGER_MENTIONS);
      const more = g.mentions.length - shown.length;
      lines.push(`    says ${clip(g.says, 200)} (${g.mentions.length}): ${shown.map(mentionSource).join('; ')}${more ? `; and ${more} more` : ''}`);
      factIds.push(...shown.map((m) => m.factId));
    }
  }
  if (needs.total > needs.items.length) lines.push(`… and ${needs.total - needs.items.length} more event${needs.total - needs.items.length === 1 ? '' : 's'} that need a source (use get_facts or search_case for one).`);
  lines.push(`Inaccurate: ${wrong.total} mention${wrong.total === 1 ? '' : 's'} that contradict a clinical record (or the patient's correction of one). They are kept only so you can point out where a document is wrong: rely on the record, never on these.`);
  // A note the patient or his team wrote on the lab row of a mention the check set aside as inaccurate: the row is not
  // a current value (it is not in Labs), so the note stays beside the mention here.
  const rowNotes = new Map<string, string[]>();
  if (wrong.items.length) {
    for (const c of setAsideLabNotes(labEntries?.())) {
      // A row changed by hand to the record's value is a copy of the record: its note is on the record's line.
      if (c.trust.trust !== 'inaccurate' || c.copy) continue;
      const list = rowNotes.get(c.factId);
      if (list) list.push(c.note);
      else rowNotes.set(c.factId, [c.note]);
    }
  }
  for (const it of wrong.items) {
    const rec = it.record;
    // A clinical record the patient chose (This one is right) is still the record; a mention he corrected is his word.
    const who = rec ? `${rec.trust.chosenValue ? 'the value the patient chose' : rec.trust.byUser && rec.documentTier !== 'primary' ? "the patient's correction" : 'the record'} (${mentionSource(rec)})` : null;
    // An automatic finding carries the comparison's own words, which name every reading the record gives that day
    // ("The lab report says CSF protein 67 mg/dL or 84 mg/dL on …"); an answer of the patient's keeps the record's value.
    // A value the patient chose (This one is right, no record outranked) is his choice, never "his correction".
    const said = !it.trust.byUser ? thirdPerson((it.trust.reason ?? '').trim()) : '';
    const reason = rec?.trust.chosenValue ? said.replace(/^(?:The patient's correction|The value the patient chose) says\b/, 'The patient chose') : said;
    const recordBit = reason ? (who ? `${who}: ${clip(reason, 300)}` : clip(reason, 300)) : who && rec ? `${who} says ${clip(rec.says, 200)}` : null;
    const why = it.trust.byUser ? clinicianReason(it.trust.reason) : null;
    const notes = (rowNotes.get(it.factId) ?? []).map((n) => userNote(n, 'note on its lab row')).filter(Boolean);
    lines.push(`- ${fmtDate(it.date, it.datePrecision)} ${it.event.subject}: ${mentionSource(it)} says ${clip(it.says, 200)}${recordBit ? `; ${recordBit}` : ''}${why ? `; ${why}` : ''}${notes.length ? `; ${notes.join('; ')}` : ''}`);
    factIds.push(it.factId);
    if (rec) factIds.push(rec.factId);
  }
  if (wrong.total > wrong.items.length) lines.push(`… and ${wrong.total - wrong.items.length} more inaccurate mention${wrong.total - wrong.items.length === 1 ? '' : 's'} not listed here (the patient sees every one on the Reconciliation page, under Inaccurate); rely on the clinical records for those subjects.`);
  // One test of a document's line that holds several, which differs from the clinical record of its test, sample and
  // day (labs.ts checkLabParts, read only): marked inaccurate on the Labs page, not on the Reconciliation page (the
  // line's detail is listed there as a whole). Named here so it is never read as a result.
  const partsWrong = (labEntries ? labEntries() : loadLabEntries()).filter((e) => e.partCheck === 'inaccurate' && e.trust && inDocs([e.documentId, e.trust.recordDocumentId]) && inDates(e.date));
  if (partsWrong.length) {
    lines.push(`Inaccurate tests inside lines that hold several tests: ${partsWrong.length} (one test of a document's line differs from the clinical record; the line's other tests are listed in Labs). Rely on the record, never on these.`);
    for (const e of partsWrong.slice(0, RECONCILE_LEDGER_INACCURATE)) {
      const source = e.documentId ? `${clip(e.documentTitle ?? 'document', 60)} ${tokD(e.documentId, e.pageNumber)}` : 'manual entry';
      const value = `${(e.valueText ?? (e.valueNum != null ? String(e.valueNum) : '?')).trim()}${e.unit ? ` ${e.unit}` : ''}`;
      const record = e.trust!.recordDocumentId ? ` (the record ${tokD(e.trust!.recordDocumentId)}${e.trust!.recordFactId ? ` ${tokF(e.trust!.recordFactId)}` : ''})` : '';
      lines.push(`- ${fmtDate(e.date, e.datePrecision)} ${e.analyte}: ${source}${e.factId ? ` ${tokF(e.factId)}` : ''} says ${clip(value, 120)}${e.splitFrom ? ` (from one line: ${clip(e.splitFrom.text, 200)})` : ''}; ${clip(thirdPerson((e.trust!.reason ?? '').trim()) || 'the record says otherwise', 300)}${record}`);
      if (e.factId) factIds.push(e.factId);
      if (e.trust!.recordFactId) factIds.push(e.trust!.recordFactId);
    }
    if (partsWrong.length > RECONCILE_LEDGER_INACCURATE) lines.push(`… and ${partsWrong.length - RECONCILE_LEDGER_INACCURATE} more not listed here.`);
  }
  return {
    key: 'reconciliation',
    title: SECTION_TITLES.reconciliation,
    text: sectionText('How the measurements, scans, procedures and events in the documents compare with the clinical records (worked out automatically; the patient settles what needs a source by adding the record, or, where clinical records disagree with each other, by choosing the right one).', lines),
    factIds: [...new Set(factIds)],
  };
}

function loadLedgerData(scope?: AskScope, today = todayIso()): LedgerData {
  const facts = loadLedgerFacts(scope);
  const byType = new Map<string, LedgerFact[]>();
  for (const f of facts) {
    if (!byType.has(f.type)) byType.set(f.type, []);
    byType.get(f.type)!.push(f);
  }
  let entries: LabEntry[] | null = null;
  const labEntries = () => (entries ??= loadLabEntries());
  return { facts, factById: new Map(facts.map((f) => [f.id, f])), byType, people: loadPeople(), docs: loadDocumentTitles(), scope, today, labEntries };
}

/** The complete ledger: 19 sections in a fixed order, always all present so block indexes are stable. */
export function buildLedger(scope?: AskScope, today = todayIso()): LedgerSection[] {
  const data = loadLedgerData(scope, today);
  return [
    patientSection(),
    peopleSection(data),
    intolerancesSection(data),
    medicationsSection(data),
    factsSection(data, 'diagnoses', ['diagnosis'], 'Diagnoses, working diagnoses, differentials and ruled-out conditions as written by each author.'),
    labsSection(data),
    imagingSection(data),
    factsSection(data, 'procedures', ['procedure'], 'Procedures (lumbar punctures, biopsies, infusions, surgeries).'),
    symptomsSection(data),
    factsSection(data, 'statements', ['clinician_statement'], 'Opinions and positions clinicians or institutions have taken.'),
    factsSection(data, 'recommendations', ['recommendation', 'follow_up'], 'Recommendations and promised or planned follow-ups, with whether they were acted on when known.'),
    factsSection(data, 'referrals', ['referral'], 'Referrals placed or proposed.'),
    recordsSection(data),
    communicationsSection(data),
    encountersSection(data),
    factsSection(data, 'events', ['event', 'vital'], 'Dated events (admissions, ER visits, relapses) and vital signs.'),
    tasksSection(data),
    findingsSection(),
    reconciliationSection(scope, data.labEntries),
  ];
}

/** At most this many non-fact items, and this many characters of them, join the matching facts in retrieval mode. */
export const RETRIEVAL_MAX_ITEMS = 40;
export const RETRIEVAL_ITEM_CHARS = 30_000;

/**
 * Every non-fact item of the ledger as one block of text in the full
 * ledger's line format (a medication with its events, a communication, an
 * encounter, a lab row, a note in the symptom or daily log, ...), with its kind.
 */
function itemBlocks(data: LedgerData): Array<{ kind: string; text: string; documentId?: string }> {
  const out: Array<{ kind: string; text: string; documentId?: string }> = [];
  const add = (kind: string, texts: string[]) => {
    for (const text of texts) out.push({ kind, text });
  };
  add('person', [...data.people.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).map((p) => personLine(p, data.people)));
  add('medication', medicationBlocks(data).map((b) => b.text));
  add('lab result', collectLabRows(data.scope, data.byType.get('lab_result') ?? [], data.docs, data.labEntries()).filter((r) => r.labResultId || r.copyNotes?.length).map((r) => `${r.analyte}${r.specimen ? ` (${r.specimen})` : ''}: ${labRowLine(r)}`));
  add('imaging study', imagingStudyLines(data).lines);
  const symptoms = symptomNoteLines(data);
  add('symptom definition', symptoms.definitions);
  add('symptom score', symptoms.entries);
  add('daily log', symptoms.daily);
  add('record', inventoryLines().lines);
  for (const x of documentNoteLines(data)) out.push({ kind: 'document', text: x.line, documentId: x.id });
  add('communication', communicationLines(data));
  add('encounter', encounterLines(data));
  const tasks = taskLines(data);
  add('task', [...tasks.open, ...tasks.closed]);
  const findings = findingLines();
  add('finding', [...findings.open, ...findings.setAside]);
  return out;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Word-start matchers for the question's significant words (the same words the full-text search uses). */
function questionMatchers(question: string): RegExp[] {
  return significantTokens(question).map((t) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t)}`, 'iu'));
}

/** Documents with a page the question's words match (pages_fts), so their notes travel with the pages retrieval sends. */
function pageMatchDocumentIds(question: string): Set<string> {
  const match = pagesFtsQuery(question);
  if (!match) return new Set();
  return new Set(db().all<{ document_id: string }>(sql`select distinct document_id from pages_fts where pages_fts match ${match} limit 500`).map((r) => r.document_id));
}

/**
 * The non-fact items that mention the question's words (a document also
 * when one of its pages does), most words matched first, then items carrying
 * a note from the patient or his team. Whole blocks only: an item is either
 * shown in full or left for the tools.
 */
/** Item kinds whose line carries the linked fact's status and the note on its check (so the fact's own line would repeat it). */
const FACT_CARRYING_KINDS = new Set(['lab result', 'imaging study']);

function matchingItemLines(question: string, data: LedgerData): Array<{ line: string; factIds: string[] }> {
  const res = questionMatchers(question);
  if (!res.length) return [];
  const pageDocs = pageMatchDocumentIds(question);
  const scored = itemBlocks(data)
    .map((b, i) => ({ line: `${b.kind}: ${b.text}`, kind: b.kind, text: b.text, i, score: res.filter((re) => re.test(b.text)).length + (b.documentId && pageDocs.has(b.documentId) ? 1 : 0), noted: b.text.includes(NOTE_AUTHOR) }))
    .filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score || Number(b.noted) - Number(a.noted) || a.i - b.i);
  const out: Array<{ line: string; factIds: string[] }> = [];
  let chars = 0;
  for (const x of scored) {
    if (out.length >= RETRIEVAL_MAX_ITEMS) break;
    if (chars + x.line.length > RETRIEVAL_ITEM_CHARS) continue;
    out.push({ line: x.line, factIds: FACT_CARRYING_KINDS.has(x.kind) ? parseTokens(x.text).filter((t) => t.kind === 'F').map((t) => t.id) : [] });
    chars += x.line.length;
  }
  return out;
}

/**
 * A compact ledger for retrieval mode: patient, intolerances, and what
 * matches the question: facts by full-text search or by the note on their
 * check, then other items (people, medications, lab rows, logs, records,
 * documents with notes, communications, encounters, tasks, findings) that
 * mention the question's words, each with its notes in full.
 */
export function buildRetrievalLedger(question: string, scope?: AskScope, limit = 80): LedgerSection[] {
  const data = loadLedgerData(scope);
  const ids = new Set(matchingFactIds(question, limit));
  // The full-text index holds statements, not the notes on them: a fact whose note names the question's words matches too.
  const res = questionMatchers(question);
  for (const f of data.facts) {
    if (ids.size >= limit) break;
    const note = personVerdictNote(f.verdictNote);
    if (note && res.some((re) => re.test(note))) ids.add(f.id);
  }
  const intolerances = intolerancesSection(data);
  const items = matchingItemLines(question, data);
  // A fact already shown on a listed lab row or imaging study, or in the intolerances section, carries its
  // status and the note on its check there: its own line would print that note a second time.
  const onRows = new Set(items.flatMap((x) => x.factIds));
  const shown = new Set([...onRows, ...intolerances.factIds]);
  const facts = data.facts.filter((f) => ids.has(f.id) && !shown.has(f.id));
  const factBlock = sectionText(
    `Facts whose statement, or the note on its check, matches the question (full-text search). Format: date [trust] [the patient's answer]? statement {attributes} (source ⟦D:id p.N⟧) note (patient or team): "…"? ⟦F:factId⟧. ${facts.length} items.`,
    facts.map((f) => factLine(f, data.people)),
    data.facts.some((f) => ids.has(f.id)) ? '(the matching facts are shown in the intolerances section or on the rows below)' : '(no facts match the question; use the tools)',
  );
  const itemBlock = items.length
    ? `\n${sectionText(`Other items that mention the question's words, most relevant first, as "kind: line" in the full ledger's formats. Text marked (patient or team) was written by the patient or his team. A fact shown on a lab row or imaging study here is not repeated above. ${items.length} items.`, items.map((x) => x.line))}`
    : '';
  const live = new Set(data.facts.map((f) => f.id));
  const matches: LedgerSection = { key: 'matches', title: 'Matching facts', text: `${factBlock}${itemBlock}`, factIds: [...new Set([...facts.map((f) => f.id), ...[...onRows].filter((id) => live.has(id))])] };
  // The matching facts stay last: prepareContext sends them after the cached, question-independent sections.
  return [patientSection(), intolerances, reconciliationSection(scope, data.labEntries), matches];
}

export function ledgerTokens(sections: LedgerSection[]): number {
  return sections.reduce((n, s) => n + estimateTokens(s.text) + 12, 0);
}

export function ledgerFactCount(sections: LedgerSection[]): number {
  return new Set(sections.flatMap((s) => s.factIds)).size;
}

/**
 * Trim the largest sections until the ledger fits `budgetTokens`. Only needed
 * for tiny budgets. Whole lines are dropped from the end of a section, so a
 * line that stays keeps its notes in full; a section without line breaks is
 * cut by characters.
 */
export function fitLedger(sections: LedgerSection[], budgetTokens: number): LedgerSection[] {
  let out = sections.map((s) => ({ ...s }));
  let rounds = 0;
  while (ledgerTokens(out) > budgetTokens && rounds < 40) {
    rounds++;
    const biggest = out.reduce((a, b) => (b.text.length > a.text.length ? b : a));
    if (biggest.text.length < 600) break;
    const keep = Math.floor(biggest.text.length * 0.7);
    const lineEnd = biggest.text.lastIndexOf('\n', keep);
    biggest.text = `${biggest.text.slice(0, lineEnd > 0 ? lineEnd : keep)}\n… (section truncated to fit the context budget; use the tools for the rest)`;
    out = [...out];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Page selection
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'my', 'in', 'on', 'for', 'to', 'with', 'what', 'is', 'are', 'was', 'were', 'how', 'when', 'which', 'who', 'why', 'where',
  'plot', 'chart', 'graph', 'analyse', 'analyze', 'analysis', 'between', 'across', 'show', 'me', 'please', 'this', 'that', 'there', 'these', 'those', 'it', 'its', 'be', 'from', 'by', 'as', 'at',
  'do', 'does', 'did', 'have', 'has', 'had', 'i', 'you', 'we', 'they', 'can', 'could', 'would', 'should', 'about', 'any', 'all', 'over', 'into', 'up', 'down', 'after', 'before', 'during',
  'since', 'until', 'than', 'then', 'also', 'just', 'only', 'not', 'no', 'yes', 'tell', 'give', 'list', 'find', 'look', 'summarise', 'summarize', 'summary', 'explain', 'compare', 'review',
  'case', 'file', 'record', 'records', 'document', 'documents', 'page', 'pages', 'note', 'notes', 'report', 'reports', 'result', 'results', 'value', 'values', 'level', 'levels', 'trend', 'time',
  'mode', 'question', 'today', 'draft', 'briefing', 'search', 'directory', 'message', 'write', 'scope', 'dates', 'restricted', 'selected',
]);

/** Significant query tokens: lower-cased words of 3+ letters (or 4-digit years) minus stop words, at most 14. */
export function significantTokens(q: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of q.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/)) {
    const t = raw.replace(/^-+|-+$/g, '');
    if (!t || seen.has(t) || STOP_WORDS.has(t)) continue;
    const isYear = /^(19|20)\d{2}$/.test(t);
    if (!isYear && (t.length < 3 || /^\d+$/.test(t))) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 14) break;
  }
  return out;
}

/** An FTS5 OR query over the significant tokens, prefix-matched. */
export function pagesFtsQuery(q: string): string | null {
  const tokens = significantTokens(q);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '')}"*`).join(' OR ');
}

export function matchingFactIds(q: string, limit = 200): string[] {
  const match = pagesFtsQuery(q);
  if (!match) return [];
  return db()
    .all<{ fact_id: string }>(sql`select f.fact_id from facts_fts f join facts fa on fa.id = f.fact_id and fa.deleted_at is null and fa.status != 'superseded' where facts_fts match ${match} order by bm25(facts_fts, 0, 1.0, 2.0) limit ${limit}`)
    .map((r) => r.fact_id);
}

export interface SelectedPage {
  documentId: string;
  documentTitle: string;
  pageNumber: number;
  text: string;
  tokens: number;
  reason: 'fact' | 'match' | 'date';
  rank: number;
}

export interface SelectPagesOptions {
  ledgerTokens?: number;
  reserve?: number;
  /** `${documentId}:${pageNumber}` keys already in the conversation. */
  exclude?: Set<string>;
  /** When false, `text` is left empty (cheap counting for previews). */
  withText?: boolean;
  maxPages?: number;
}

/** A page's length in characters: the stored char_count, measuring the text only when no count was recorded. */
const PAGE_LEN_SQL = sql.raw('(case when p.char_count > 0 then p.char_count else length(p.text) end)');

function scopeDocFilter(scope: AskScope | undefined, col: ReturnType<typeof sql>): ReturnType<typeof sql> {
  const ids = scope?.documentIds ?? [];
  if (!ids.length) return sql``;
  return sql` and ${col} in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`;
}

/** The SQL form of partialDateInWindow on doc.document_date: each bound compared at the coarser of the two precisions. */
function scopeDateFilter(scope: AskScope | undefined): ReturnType<typeof sql> {
  const parts: ReturnType<typeof sql>[] = [];
  const from = scope?.from?.trim();
  const to = scope?.to?.trim();
  if (from) parts.push(sql` and (doc.document_date is null or substr(doc.document_date, 1, min(length(doc.document_date), ${from.length})) >= substr(${from}, 1, min(length(doc.document_date), ${from.length})))`);
  if (to) parts.push(sql` and (doc.document_date is null or substr(doc.document_date, 1, min(length(doc.document_date), ${to.length})) <= substr(${to}, 1, min(length(doc.document_date), ${to.length})))`);
  return parts.length ? sql.join(parts, sql``) : sql``;
}

/**
 * Pages by relevance within the budget: pages cited by facts matching the
 * question first, then pages_fts matches (bm25), then (everything mode only)
 * every other page by document date descending.
 */
export function selectPages(question: string, preset: ConsultPreset, scope?: AskScope, opts: SelectPagesOptions = {}): SelectedPage[] {
  const d = db();
  const budget = Math.max(0, preset.maxContextTokens - (opts.ledgerTokens ?? 0) - (opts.reserve ?? CONTEXT_RESERVE_TOKENS));
  const maxPages = opts.maxPages ?? (preset.contextMode === 'retrieval' ? RETRIEVAL_MAX_PAGES : Number.POSITIVE_INFINITY);
  const exclude = opts.exclude ?? new Set<string>();
  const withText = opts.withText !== false;
  const chosen: SelectedPage[] = [];
  const seen = new Set<string>(exclude);
  let used = 0;
  const docSet = scope?.documentIds?.length ? new Set(scope.documentIds) : null;

  const candidates: Array<{ documentId: string; pageNumber: number; reason: SelectedPage['reason']; rank: number }> = [];
  const match = pagesFtsQuery(question);
  if (match) {
    // Pages cited by matching facts.
    const factIds = matchingFactIds(question, 200);
    if (factIds.length) {
      // Verified citations first, then the matched facts' relevance order (bm25), then age; the
      // explicit rank keeps the order deterministic when citations share a created_at millisecond.
      const factRank = new Map(factIds.map((id, i) => [id, i] as const));
      const cites = d.all<{ document_id: string; page_number: number; fact_id: string; verified: number }>(sql`
        select c.document_id, c.page_number, c.fact_id, c.verified from citations c join documents doc on doc.id = c.document_id and doc.deleted_at is null
        where c.fact_id in (${sql.join(factIds.map((id) => sql`${id}`), sql`, `)})${scopeDocFilter(scope, sql`c.document_id`)}${scopeDateFilter(scope)}
        order by c.verified desc, c.created_at asc, c.page_number asc, c.id asc`);
      cites.sort((a, b) => Number(b.verified) - Number(a.verified) || (factRank.get(a.fact_id) ?? 1e9) - (factRank.get(b.fact_id) ?? 1e9));
      let i = 0;
      for (const c of cites) candidates.push({ documentId: c.document_id, pageNumber: c.page_number, reason: 'fact', rank: -1000 + i++ });
    }
    const hits = d.all<{ document_id: string; page_number: number; rank: number }>(sql`
      select p.document_id, p.page_number, bm25(pages_fts) as rank
      from pages_fts p join documents doc on doc.id = p.document_id and doc.deleted_at is null
      where pages_fts match ${match}${scopeDocFilter(scope, sql`p.document_id`)}${scopeDateFilter(scope)}
      order by rank limit 2000`);
    for (const h of hits) candidates.push({ documentId: h.document_id, pageNumber: h.page_number, reason: 'match', rank: h.rank });
  }
  // Lengths and titles for the candidate pages. Lengths come from the stored
  // char_count so page text is not read here (a page whose count was never
  // recorded falls back to measuring its text).
  const byDoc = new Map<string, Map<number, { len: number; title: string }>>();
  const note = (documentId: string, pageNumber: number, len: number, title: string) => {
    if (!byDoc.has(documentId)) byDoc.set(documentId, new Map());
    byDoc.get(documentId)!.set(pageNumber, { len, title });
  };
  if (preset.contextMode === 'everything') {
    const rest = d.all<{ document_id: string; page_number: number; len: number; title: string }>(sql`
      select p.document_id, p.page_number, ${PAGE_LEN_SQL} as len, doc.title as title
      from document_pages p join documents doc on doc.id = p.document_id and doc.deleted_at is null
      where (p.char_count > 0 or (p.char_count = 0 and length(trim(p.text)) > 0))${scopeDocFilter(scope, sql`p.document_id`)}${scopeDateFilter(scope)}
      order by (doc.document_date is null) asc, doc.document_date desc, doc.created_at desc, p.page_number asc`);
    let i = 0;
    for (const r of rest) {
      candidates.push({ documentId: r.document_id, pageNumber: r.page_number, reason: 'date', rank: 1e6 + i++ });
      note(r.document_id, r.page_number, r.len, r.title);
    }
  }
  const missing = [...new Set(candidates.map((c) => c.documentId))].filter((id) => !byDoc.has(id) && (!docSet || docSet.has(id)));
  for (let i = 0; i < missing.length; i += 400) {
    const chunk = missing.slice(i, i + 400);
    const rows = d.all<{ document_id: string; page_number: number; len: number; title: string }>(sql`
      select p.document_id, p.page_number, ${PAGE_LEN_SQL} as len, doc.title as title
      from document_pages p join documents doc on doc.id = p.document_id
      where p.document_id in (${sql.join(chunk.map((id) => sql`${id}`), sql`, `)})`);
    for (const r of rows) note(r.document_id, r.page_number, r.len, r.title);
  }

  for (const c of candidates) {
    if (chosen.length >= maxPages) break;
    const key = `${c.documentId}:${c.pageNumber}`;
    if (seen.has(key)) continue;
    const info = byDoc.get(c.documentId)?.get(c.pageNumber);
    if (!info || info.len === 0) continue;
    const tokens = Math.ceil(info.len / CHARS_PER_TOKEN) + 12;
    if (used + tokens > budget) {
      if (c.reason === 'date') break;
      continue;
    }
    seen.add(key);
    used += tokens;
    chosen.push({ documentId: c.documentId, documentTitle: info.title, pageNumber: c.pageNumber, text: '', tokens, reason: c.reason, rank: c.rank });
  }

  if (withText && chosen.length) {
    fillPageTexts(chosen);
    // A page counted as non-empty but holding only whitespace is not sent (an empty document block is useless).
    return chosen.filter((p) => p.text.trim().length > 0);
  }
  return chosen;
}

/** Load page text for the given pages, one query per document. */
export function fillPageTexts(pages: SelectedPage[]): void {
  const d = db();
  const byDoc = new Map<string, SelectedPage[]>();
  for (const p of pages) {
    if (!byDoc.has(p.documentId)) byDoc.set(p.documentId, []);
    byDoc.get(p.documentId)!.push(p);
  }
  for (const [docId, list] of byDoc) {
    const rows = d
      .select({ pageNumber: schema.documentPages.pageNumber, text: schema.documentPages.text })
      .from(schema.documentPages)
      .where(eq(schema.documentPages.documentId, docId))
      .all();
    const m = new Map(rows.map((r) => [r.pageNumber, r.text]));
    for (const p of list) {
      p.text = m.get(p.pageNumber) ?? '';
      p.tokens = estimateTokens(p.text) + 12;
    }
  }
}

/** Re-fetch pages included in earlier turns (deleted documents drop out). */
export function pagesFor(refs: PageRef[]): SelectedPage[] {
  if (!refs.length) return [];
  const docs = loadDocumentTitles();
  const out: SelectedPage[] = [];
  for (const r of refs) {
    const doc = docs.get(r.documentId);
    if (!doc) continue;
    out.push({ documentId: r.documentId, documentTitle: doc.title, pageNumber: r.pageNumber, text: '', tokens: 0, reason: 'match', rank: 0 });
  }
  fillPageTexts(out);
  return out.filter((p) => p.text.length > 0);
}

export function pageText(documentId: string, pageNumber: number): string | undefined {
  return db()
    .select({ text: schema.documentPages.text })
    .from(schema.documentPages)
    .where(and(eq(schema.documentPages.documentId, documentId), eq(schema.documentPages.pageNumber, pageNumber)))
    .get()?.text;
}

// ---------------------------------------------------------------------------
// Message assembly
// ---------------------------------------------------------------------------

export interface PriorTurn {
  /** The formatted user turn text (mode lines + question). */
  userText: string;
  assistantText: string;
  includedPages: PageRef[];
}

export interface PreparedContext {
  preset: ConsultPreset;
  ledger: LedgerSection[];
  /** Retrieval mode only: the per-question matching-facts block. */
  matches: LedgerSection | null;
  ledgerTokens: number;
  factCount: number;
  priorTurns: Array<PriorTurn & { pages: SelectedPage[] }>;
  questionText: string;
  candidatePages: SelectedPage[];
  alreadyIncluded: Set<string>;
}

export interface Assembled {
  messages: Anthropic.MessageParam[];
  docIndex: DocIndexEntry[];
  ledger: LedgerSection[];
  ledgerIncluded: boolean;
  pages: SelectedPage[];
  stats: AskContextStats;
  documentIds: string[];
}

export interface AssembleInput {
  questionText: string;
  /** The raw question, for full-text retrieval. */
  retrievalQuery: string;
  preset: ConsultPreset;
  scope?: AskScope;
  priorTurns?: PriorTurn[];
  today?: string;
}

export function prepareContext(input: AssembleInput): PreparedContext {
  const preset = input.preset;
  const retrieval = preset.contextMode === 'retrieval';
  const baseLedger = retrieval ? buildRetrievalLedger(input.retrievalQuery, input.scope) : buildLedger(input.scope, input.today);
  let matches: LedgerSection | null = null;
  let ledger = baseLedger;
  if (retrieval) {
    matches = baseLedger[baseLedger.length - 1];
    ledger = baseLedger.slice(0, -1);
  }
  ledger = fitLedger(ledger, Math.max(5000, preset.maxContextTokens - CONTEXT_RESERVE_TOKENS));
  const priorTurns = (input.priorTurns ?? []).map((t) => ({ ...t, pages: pagesFor(t.includedPages) }));
  const alreadyIncluded = new Set<string>();
  for (const t of priorTurns) for (const p of t.pages) alreadyIncluded.add(`${p.documentId}:${p.pageNumber}`);
  const lt = ledgerTokens(ledger) + (matches ? ledgerTokens([matches]) : 0);
  const priorTokens = priorTurns.reduce((n, t) => n + estimateTokens(t.userText) + estimateTokens(t.assistantText) + t.pages.reduce((m, p) => m + p.tokens, 0), 0);
  const candidatePages = selectPages(input.retrievalQuery, preset, input.scope, { ledgerTokens: lt + priorTokens + estimateTokens(input.questionText), exclude: alreadyIncluded });
  return { preset, ledger, matches, ledgerTokens: lt, factCount: ledgerFactCount([...ledger, ...(matches ? [matches] : [])]), priorTurns, questionText: input.questionText, candidatePages, alreadyIncluded };
}

/**
 * Prompt-cache breakpoints. The API allows four per request and the system
 * prompt takes one (ai/client.ts), so the messages carry at most three: the
 * last ledger block (stable between questions), the end of the newest user
 * turn (ledger + pages + question, re-sent by every tool turn of the answer)
 * and one moving breakpoint on the newest tool_result batch, placed by the
 * tool loop in ask.ts. All are 1h (DECISIONS 23: a 1h breakpoint may not
 * follow a 5m one). Moving a marker is not a history edit for the API.
 */
export const MAX_REQUEST_BREAKPOINTS = 4;
export const SYSTEM_BREAKPOINTS = 1;
export const MAX_MESSAGE_BREAKPOINTS = MAX_REQUEST_BREAKPOINTS - SYSTEM_BREAKPOINTS;

export function cacheBreakpoint(): Anthropic.CacheControlEphemeral {
  return { type: 'ephemeral', ttl: '1h' };
}

/** How many content blocks in `messages` carry a cache_control breakpoint. */
export function countCacheBreakpoints(messages: Anthropic.MessageParam[]): number {
  let n = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    for (const b of m.content) if ((b as { cache_control?: unknown }).cache_control) n++;
  }
  return n;
}

type Cacheable = { cache_control?: Anthropic.CacheControlEphemeral | null };

/**
 * Move the tool loop's breakpoint onto `next` (the last block of the newest
 * tool_result batch, not yet pushed onto `messages`): the previous moving
 * breakpoint comes off first, and none is placed when the messages already
 * hold the maximum. Returns the block that now carries it, if any.
 */
export function moveCacheBreakpoint<T extends Cacheable>(messages: Anthropic.MessageParam[], prev: Cacheable | null, next: T | null | undefined): T | null {
  if (prev) delete prev.cache_control;
  if (!next || countCacheBreakpoints(messages) >= MAX_MESSAGE_BREAKPOINTS) return null;
  next.cache_control = cacheBreakpoint();
  return next;
}

function documentBlock(title: string, data: string, context: Record<string, unknown>, cache?: boolean): Anthropic.DocumentBlockParam {
  const block: Anthropic.DocumentBlockParam = {
    type: 'document',
    source: { type: 'text', media_type: 'text/plain', data },
    title,
    context: JSON.stringify(context),
    citations: { enabled: true },
  };
  if (cache) block.cache_control = cacheBreakpoint();
  return block;
}

/** Build the request messages from a prepared context and the pages to include in the new turn. */
export function composeMessages(prep: PreparedContext, pages: SelectedPage[]): Assembled {
  const messages: Anthropic.MessageParam[] = [];
  const docIndex: DocIndexEntry[] = [];
  const documentIds = new Set<string>();
  let index = 0;
  let ledgerPlaced = false;
  let ledgerOnThisTurn = false;

  const ledgerBlocks = (): Anthropic.ContentBlockParam[] => {
    const out: Anthropic.ContentBlockParam[] = [];
    prep.ledger.forEach((s, i) => {
      out.push(documentBlock(`Ledger — ${s.title}`, s.text, { ledger: s.key }, i === prep.ledger.length - 1));
      docIndex.push({ index: index++, kind: 'ledger', key: s.key });
    });
    ledgerPlaced = true;
    return out;
  };
  const pageBlock = (p: SelectedPage): Anthropic.ContentBlockParam => {
    docIndex.push({ index: index++, kind: 'page', documentId: p.documentId, pageNumber: p.pageNumber });
    documentIds.add(p.documentId);
    return documentBlock(`${p.documentTitle} — p.${p.pageNumber}`, p.text, { documentId: p.documentId, pageNumber: p.pageNumber });
  };

  for (const t of prep.priorTurns) {
    const content: Anthropic.ContentBlockParam[] = [];
    if (!ledgerPlaced) content.push(...ledgerBlocks());
    for (const p of t.pages) content.push(pageBlock(p));
    content.push({ type: 'text', text: t.userText });
    messages.push({ role: 'user', content });
    messages.push({ role: 'assistant', content: t.assistantText.trim() || '(no answer was recorded for this turn)' });
  }

  const content: Anthropic.ContentBlockParam[] = [];
  if (!ledgerPlaced) {
    content.push(...ledgerBlocks());
    ledgerOnThisTurn = true;
  }
  if (prep.matches) {
    content.push(documentBlock(`Ledger — ${prep.matches.title}`, prep.matches.text, { ledger: prep.matches.key }));
    docIndex.push({ index: index++, kind: 'ledger', key: prep.matches.key });
  }
  for (const p of pages) content.push(pageBlock(p));
  // The turn breakpoint: every tool turn of this answer re-sends the whole turn, so
  // its pages are read from the cache after the first call instead of billed again.
  content.push({ type: 'text', text: prep.questionText, cache_control: cacheBreakpoint() });
  messages.push({ role: 'user', content });

  const pageTokens = pages.reduce((n, p) => n + p.tokens, 0);
  const priorTokens = prep.priorTurns.reduce((n, t) => n + estimateTokens(t.userText) + estimateTokens(t.assistantText) + t.pages.reduce((m, p) => m + p.tokens, 0), 0);
  const stats: AskContextStats = {
    ledgerTokens: prep.ledgerTokens,
    pages: pages.length,
    pageTokens,
    facts: prep.factCount,
    totalTokensApprox: prep.ledgerTokens + pageTokens + priorTokens + estimateTokens(prep.questionText) + 2500,
  };
  return { messages, docIndex, ledger: prep.matches ? [...prep.ledger, prep.matches] : prep.ledger, ledgerIncluded: ledgerOnThisTurn, pages, stats, documentIds: [...documentIds] };
}

export function assembleMessages(input: AssembleInput): Assembled {
  const prep = prepareContext(input);
  return composeMessages(prep, prep.candidatePages);
}

// ---------------------------------------------------------------------------
// Preview (no API call)
// ---------------------------------------------------------------------------

/**
 * The full ledger does not depend on the question, so the preview remembers
 * its size (numbers only, never the ledger text) for a few seconds: a burst of
 * keystrokes in the composer builds it once. The cache belongs to the open
 * connection (a lock or another database starts afresh) and its key carries
 * the connection's change counter, so any write rebuilds it. The real ask
 * path always builds the ledger fresh.
 */
const PREVIEW_LEDGER_TTL_MS = 10_000;
const previewLedgerCache = new WeakMap<object, Map<string, { at: number; tokens: number; facts: number }>>();

function previewLedgerSize(preset: ConsultPreset, scope?: AskScope): { tokens: number; facts: number } {
  const d = db();
  const changes = d.get<{ n: number }>(sql`select total_changes() as n`)?.n ?? 0;
  const key = JSON.stringify([preset.maxContextTokens, scope ?? null, todayIso(), changes]);
  let cache = previewLedgerCache.get(d);
  if (!cache) {
    cache = new Map();
    previewLedgerCache.set(d, cache);
  }
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < PREVIEW_LEDGER_TTL_MS) return hit;
  const ledger = fitLedger(buildLedger(scope), preset.maxContextTokens - CONTEXT_RESERVE_TOKENS);
  const size = { at: now, tokens: ledgerTokens(ledger), facts: ledgerFactCount(ledger) };
  // Drop expired sizes and any taken before the latest write.
  for (const [k, v] of cache) if (now - v.at >= PREVIEW_LEDGER_TTL_MS || !k.endsWith(`,${changes}]`)) cache.delete(k);
  cache.set(key, size);
  return size;
}

export function contextPreview(preset: ConsultPreset, q: string, scope?: AskScope): ContextPreview {
  const retrieval = preset.contextMode === 'retrieval';
  let lt: number;
  let facts: number;
  if (retrieval) {
    const base = buildRetrievalLedger(q, scope);
    const ledger = fitLedger(base.slice(0, -1), preset.maxContextTokens - CONTEXT_RESERVE_TOKENS).concat(base.slice(-1));
    lt = ledgerTokens(ledger);
    facts = ledgerFactCount(ledger);
  } else {
    const size = previewLedgerSize(preset, scope);
    lt = size.tokens;
    facts = size.facts;
  }
  const pages = selectPages(q, preset, scope, { ledgerTokens: lt, withText: false });
  const pageTokens = pages.reduce((n, p) => n + p.tokens, 0);
  const totalTokensApprox = lt + pageTokens + estimateTokens(q) + 2500;
  const price = MODEL_PRICES[preset.model] ?? MODEL_PRICES['claude-sonnet-5-5'];
  const contextWindow = MODEL_CONTEXT_TOKENS[preset.model] ?? 200_000;
  return {
    preset: preset.key,
    model: preset.model,
    effort: preset.effort,
    contextMode: preset.contextMode,
    ledgerTokens: lt,
    pages: pages.length,
    pageTokens,
    facts,
    totalTokensApprox,
    estimatedUsdInput: Math.round(((totalTokensApprox * price.input) / 1_000_000) * 10000) / 10000,
    fitsContext: totalTokensApprox + OUTPUT_RESERVE_TOKENS <= contextWindow,
    contextWindow,
  };
}
