/**
 * Deterministic cross-reference rules. Each rule reads a RuleContext (a plain
 * snapshot of the ledger loaded by `buildRuleContext`) and returns
 * FindingDrafts. The rules do not write to the database;
 * `services/findings.ts` validates the evidence, fingerprints the drafts and
 * upserts them. The one exception is `patient_precedence`, whose decisions
 * (which patient statement outranks which clinician assessment) are handed
 * to the writer `buildRuleContext` attaches as `ctx.writeOverrides`; a
 * hand-built context without a writer stays side-effect free.
 *
 * Wording rule: a finding describes what the records say and why it is worth
 * a human look. It never states a diagnosis, never recommends a treatment and
 * never claims causation. Correlations say so in the title.
 *
 * Every draft carries evidence that resolves to rows (facts, citations,
 * communications, lab results, documents, inventory records, medications,
 * symptoms) and a stable `key` so the fingerprint survives re-runs.
 */
import { and, asc, eq, isNull, isNotNull, notInArray, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { normalizeKey, nowIso, parseJson } from '../util/ids';
import { dateSortKey, datesAgree, daysBetween, daysPastDue, formatPartialDate, isPastDue, parsePartialDate, todayIso } from '../../shared/dates';
import { descriptionTokens, inferGaps, modalityKeywords, type Gap } from './records';
import { hasSubject } from './dedup';
import { assumedLabRowIds, defaultSpecimenFor, fullReadingOf, isSetAside, loadLabEntries, loadLabReadings, partLabReading, readLabValues, readingView, setAsideLabParts, type LabValueRead } from './labs';
import { readingForFact, type LabReadingRecord } from './lab-reading';
import { labRuleDrafts } from './lab-rules';
import { COMPUTED_SOURCE } from '../../shared/labcompute';
import { textSimilarity } from '../ai/citations';
import { effectiveObjectivity } from '../../shared/schemas/facts';
import type { FindingCategory } from '../../shared/enums';
import { buildLabReading, labValueIdentity, numberOnlyValue, parseLabValue, roleForTier, unitKey, type LabReading, type ReadingRole } from '../../shared/labvalues';
import type { DatePrecision, PartialDate } from '../../shared/dates';
import { epicOrderKey, passageSourceUnitsOn, sameSource, segmentIdOf, type SourceRef } from './source-unit';
import { visibleWithRecordSql } from './communications';
import { factTier, segmentLinkOf } from '../../shared/trust';

export type Severity = 'info' | 'low' | 'medium' | 'high';

/** Optional restriction of a run: documents, and/or a partial-date window on dated rows. */
export interface CrossrefScope {
  documentIds?: string[];
  from?: string;
  to?: string;
}

// ---------------------------------------------------------------------------
// Context: a plain snapshot of what the rules read
// ---------------------------------------------------------------------------

export interface CtxCitation {
  id: string;
  factId: string | null;
  documentId: string;
  pageNumber: number;
  quote: string;
  verified: boolean;
}

export interface CtxFact {
  id: string;
  type: string;
  statement: string;
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  dateEnd: string | null;
  attributes: Record<string, unknown>;
  status: string;
  origin: string;
  confidence: number;
  sourceDocumentId: string | null;
  documentTitle: string | null;
  documentDate: string | null;
  personId: string | null;
  subjectKey: string | null;
  citations: CtxCitation[];
  /** patient | clinician | compiler | unknown (slice Q; optional so hand-built contexts stay small). */
  assertedBy?: string;
  /** objective | subjective | unknown as stored; `effectiveObjectivity` applies the per-type default. */
  objectivity?: string;
  /** The patient statement that takes precedence over this one, when set. */
  overriddenByFactId?: string | null;
  overrideReason?: string | null;
  /** True when the user set or cleared the override by hand (attributes._overrideManual); the rule then leaves it alone. */
  overrideManual?: boolean;
  /**
   * The passage of an export it was read from (source-unit.ts segmentIdOf; null: the whole document) and the printed
   * order it repeats (Epic prints one order up to three times). Optional so hand-built contexts stay small: missing
   * reads as the whole document, exactly as before 2026-10-07.
   */
  segmentId?: string | null;
  orderKey?: string | null;
}

export interface CtxDocument {
  id: string;
  title: string;
  category: string;
  documentDate: string | null;
  documentDatePrecision: string;
  authorPersonId: string | null;
  institutionId: string | null;
  pageCount: number;
  createdAt: string;
  /** primary | patient | compilation | external | unknown */
  sourceTier?: string;
}

/** One override the patient-precedence rule decided: `targetId` is outranked by the patient statement `byFactId`. */
export interface PrecedenceDecision {
  targetId: string;
  byFactId: string;
  reason: string;
  /** What the two statements are about (a medication, a diagnosis, a symptom...). */
  subject: string;
}

export interface CtxCommunication {
  id: string;
  occurredAt: string | null;
  occurredAtPrecision: string;
  direction: string;
  channel: string;
  subject: string;
  summary: string | null;
  outcome: string | null;
  /** The message or call as printed in a record (read out of an export; verbatim), else null. */
  body: string | null;
  followUpPromised: string | null;
  followUpDue: string | null;
  followUpDoneAt: string | null;
  followUpOwnerPersonId: string | null;
  documentId: string | null;
  participants: Array<{ personId: string; name: string; role: string }>;
  topics: string[];
}

export interface CtxLab {
  id: string;
  analyte: string;
  analyteKey: string;
  specimen: string;
  valueNum: number | null;
  valueText: string | null;
  unit: string | null;
  refLow: number | null;
  refHigh: number | null;
  flag: string | null;
  collectedAt: string | null;
  collectedAtPrecision: string;
  documentId: string | null;
  factId: string | null;
  /** The range as printed (2026-10; optional so hand-built contexts stay small). */
  refText?: string | null;
  /** The date the result came back, when stored apart (2026-10, rule 7). */
  resultedAt?: string | null;
}

export interface CtxPerson {
  id: string;
  name: string;
  kind: string;
  role: string | null;
  specialty: string | null;
  institutionId: string | null;
  aliases: string[];
}

export interface CtxMedicationEvent {
  id: string;
  kind: string;
  date: string | null;
  detail: string | null;
  dose: string | null;
  sourceFactId: string | null;
}

export interface CtxMedication {
  id: string;
  name: string;
  status: string;
  dose: string | null;
  unit: string | null;
  startDate: string | null;
  stopDate: string | null;
  sourceFactId: string | null;
  events: CtxMedicationEvent[];
}

export interface CtxEncounter {
  id: string;
  title: string;
  status: string;
  occurredAt: string | null;
  clinicianId: string | null;
  institutionId: string | null;
}

export interface CtxTask {
  id: string;
  title: string;
  status: string;
  sourceType: string;
  sourceId: string | null;
}

export interface RuleContext {
  today: string;
  scope: CrossrefScope;
  facts: CtxFact[];
  factById: Map<string, CtxFact>;
  documents: CtxDocument[];
  documentById: Map<string, CtxDocument>;
  /** Normalised (lower-case, punctuation stripped) text of every page of a document, loaded on first use. */
  pageText: (documentId: string) => string;
  communications: CtxCommunication[];
  labs: CtxLab[];
  people: CtxPerson[];
  medications: CtxMedication[];
  encounters: CtxEncounter[];
  tasks: CtxTask[];
  symptomDefinitions: Array<{ id: string; name: string }>;
  symptomEntries: Array<{ date: string; symptomId: string; score: number }>;
  gaps: Gap[];
  /** Attached by buildRuleContext: persists the patient-precedence decisions (sets overrides; clears stale automatic ones when `clearStale`). */
  writeOverrides?: (decisions: PrecedenceDecision[], opts: { clearStale: boolean }) => void;
  /** Filled by the patient_precedence rule when it runs. */
  lastPrecedenceDecisions?: PrecedenceDecision[];
  /**
   * Tests of lines that hold several which the Labs page sets aside (labs.ts setAsideLabParts: a copy of a clinical
   * record's value, or one it contradicts): `<lab row id>` or `fact:<fact id>` -> part indexes. Never a trend point.
   */
  labPartsSetAside?: Map<string, Set<number>>;
  /** Lab rows whose sample is only assumed (read as the Labs page reads them). */
  labRowsAssumed?: Set<string>;
  /**
   * Every lab value as the Labs page reads it (src/shared/labvalues.ts through services/lab-reading.ts), by the Labs
   * entry's id: `<row id>`, `fact:<fact id>`, and `#<index>` for one test of a line that holds several. A value missing
   * here (a context built by hand) is read from its own fields with the same shared parser.
   */
  labReadings?: Map<string, LabReading>;
  /** The lab checks' values (labs.ts loadLabReadings, the one loader; amendment G1), with the summary claims the reconciliation set aside (rule 12 only), loaded on first use. */
  labCheckRecords?: () => LabReadingRecord[];
}

/** Is a partial date inside the scope window? Undated rows always are. */
export function inScopeWindow(iso: string | null | undefined, scope: CrossrefScope): boolean {
  if (!iso) return true;
  const key = dateSortKey(iso);
  if (scope.from && key < dateSortKey(scope.from)) return false;
  if (scope.to && key.slice(0, scope.to.length) > scope.to) return false;
  return true;
}

/**
 * Load everything the rules read, in a handful of queries. Disputed and
 * superseded facts are excluded (the user's verdict outranks the model), as
 * are soft-deleted rows and facts whose document was deleted.
 */
/** The passage and printed order of a fact (only with passages as source units on; see source-unit.ts). */
function unitFields(type: string, statement: string, attributes: Record<string, unknown>, cites: readonly CtxCitation[], byPassage: boolean): { segmentId: string | null; orderKey: string | null } {
  if (!byPassage) return { segmentId: null, orderKey: null };
  const segmentId = segmentIdOf(attributes);
  return { segmentId, orderKey: segmentId ? epicOrderKey({ type, statement, attributes, quotes: cites.map((c) => c.quote) }) : null };
}

/** A fact's source unit: its document, its passage and the printed order it repeats. */
export function unitOf(f: Pick<CtxFact, 'sourceDocumentId' | 'segmentId' | 'orderKey'>): SourceRef {
  return { documentId: f.sourceDocumentId, segmentId: f.segmentId ?? null, orderKey: f.orderKey ?? null };
}

/**
 * "Same source" (D.1.8): the same document and passage, or the same printed order of a document. A fact with no
 * passage counts as the whole document; a fact with no document is never the same source as another (as before).
 */
export function sameFactSource(a: Pick<CtxFact, 'sourceDocumentId' | 'segmentId' | 'orderKey'>, b: Pick<CtxFact, 'sourceDocumentId' | 'segmentId' | 'orderKey'>): boolean {
  return sameSource(unitOf(a), unitOf(b));
}

export function buildRuleContext(scope: CrossrefScope = {}, today: string = todayIso()): RuleContext {
  const d = db();
  const docFilter = scope.documentIds?.length ? new Set(scope.documentIds) : null;

  const documents: CtxDocument[] = d
    .select()
    .from(schema.documents)
    .where(isNull(schema.documents.deletedAt))
    .all()
    .map((r) => ({ id: r.id, title: r.title, category: r.category, documentDate: r.documentDate, documentDatePrecision: r.documentDatePrecision, authorPersonId: r.authorPersonId, institutionId: r.institutionId, pageCount: r.pageCount, createdAt: r.createdAt, sourceTier: r.sourceTier }));
  const documentById = new Map(documents.map((x) => [x.id, x]));

  const citationRows = d.select().from(schema.citations).where(isNotNull(schema.citations.factId)).all();
  const byPassage = passageSourceUnitsOn();
  const citationsByFact = new Map<string, CtxCitation[]>();
  for (const c of citationRows) {
    const list = citationsByFact.get(c.factId!) ?? [];
    list.push({ id: c.id, factId: c.factId, documentId: c.documentId, pageNumber: c.pageNumber, quote: c.quote, verified: Boolean(c.verified) });
    citationsByFact.set(c.factId!, list);
  }

  const facts: CtxFact[] = d
    .select()
    .from(schema.facts)
    .where(and(isNull(schema.facts.deletedAt), notInArray(schema.facts.status, ['disputed', 'superseded'])))
    .all()
    .filter((f) => !f.sourceDocumentId || documentById.has(f.sourceDocumentId))
    .filter((f) => !docFilter || (f.sourceDocumentId !== null && docFilter.has(f.sourceDocumentId)))
    .filter((f) => inScopeWindow(f.date, scope))
    .map((f) => {
      const doc = f.sourceDocumentId ? documentById.get(f.sourceDocumentId) : undefined;
      const cites = (citationsByFact.get(f.id) ?? []).slice().sort((a, b) => Number(b.verified) - Number(a.verified) || a.pageNumber - b.pageNumber);
      const attributes = parseJson<Record<string, unknown>>(f.attributesJson, {});
      return {
        id: f.id,
        type: f.type,
        statement: f.statement,
        date: f.date,
        datePrecision: f.datePrecision,
        dateText: f.dateText,
        dateEnd: f.dateEnd,
        attributes,
        status: f.status,
        origin: f.origin,
        confidence: f.confidence,
        sourceDocumentId: f.sourceDocumentId,
        documentTitle: doc?.title ?? null,
        documentDate: doc?.documentDate ?? null,
        personId: f.personId,
        subjectKey: f.subjectKey,
        citations: cites,
        assertedBy: f.assertedBy,
        objectivity: f.objectivity,
        overriddenByFactId: f.overriddenByFactId,
        overrideReason: f.overrideReason,
        overrideManual: attributes._overrideManual === true,
        ...unitFields(f.type, f.statement, attributes, cites, byPassage),
      };
    });
  const factById = new Map(facts.map((f) => [f.id, f]));

  const people: CtxPerson[] = d
    .select()
    .from(schema.people)
    .where(isNull(schema.people.deletedAt))
    .all()
    .map((p) => ({ id: p.id, name: p.name, kind: p.kind, role: p.role, specialty: p.specialty, institutionId: p.institutionId, aliases: parseJson<string[]>(p.aliasesJson, []) }));
  const personName = new Map(people.map((p) => [p.id, p.name]));

  const partRows = d.select().from(schema.communicationParticipants).all();
  const topicRows = d.select().from(schema.communicationTopics).all();
  const partsBy = new Map<string, Array<{ personId: string; name: string; role: string }>>();
  for (const p of partRows) {
    const name = personName.get(p.personId);
    if (!name) continue;
    const list = partsBy.get(p.communicationId) ?? [];
    list.push({ personId: p.personId, name, role: p.role });
    partsBy.set(p.communicationId, list);
  }
  const topicsBy = new Map<string, string[]>();
  for (const t of topicRows) {
    const list = topicsBy.get(t.communicationId) ?? [];
    list.push(t.topic);
    topicsBy.set(t.communicationId, list);
  }
  const communications: CtxCommunication[] = d
    .select()
    .from(schema.communications)
    // A message read out of a record goes with its record (deleted, or held back as someone else's; review 2026-10-09).
    .where(and(isNull(schema.communications.deletedAt), sql.raw(visibleWithRecordSql('"communications"'))))
    .all()
    .filter((c) => inScopeWindow(c.occurredAt, scope))
    .filter((c) => !docFilter || (c.documentId !== null && docFilter.has(c.documentId)))
    .map((c) => ({
      id: c.id,
      occurredAt: c.occurredAt,
      occurredAtPrecision: c.occurredAtPrecision,
      direction: c.direction,
      channel: c.channel,
      subject: c.subject,
      summary: c.summary,
      outcome: c.outcome,
      body: c.body ?? null,
      followUpPromised: c.followUpPromised,
      followUpDue: c.followUpDue,
      followUpDoneAt: c.followUpDoneAt,
      followUpOwnerPersonId: c.followUpOwnerPersonId,
      documentId: c.documentId,
      participants: partsBy.get(c.id) ?? [],
      topics: topicsBy.get(c.id) ?? [],
    }));

  // Rows the Labs ledger sets aside (their fact disputed, replaced or deleted; services/labs.ts isSetAside) are not
  // current values: a copy the clinical-record pass replaced must not feed a trend or a never-in-range check.
  // A row whose replaced fact is a duplicate of the kept reading stands in for it there, and here too.
  // A row whose line holds several tests is dropped only when its whole line is set aside; a test of it the Labs page
  // sets aside on its own (a copy of a record's value, or one it contradicts) is left out by labSeries.
  const labEntries = loadLabEntries();
  const setAsideRows = new Set(
    labEntries
      .filter((e) => e.source === 'row' && e.labResultId && isSetAside(e) && !(e.partCheck && e.splitFrom))
      .map((e) => e.labResultId!),
  );
  const labPartsSetAside = setAsideLabParts(labEntries);
  const labRowsAssumed = assumedLabRowIds(labEntries);
  // Each value as the Labs page reads it (rule 1-8: as printed, a limit never a measurement, its own range only).
  const labReadings = new Map<string, LabReading>();
  for (const e of labEntries) {
    const r = fullReadingOf(e);
    if (r) labReadings.set(e.id, r);
  }
  let checkRecords: LabReadingRecord[] | null = null;
  // Rule 12 reads a summary's claims the reconciliation set aside too (marked passSetAside; rule 10 leaves them out).
  const labCheckRecords = (): LabReadingRecord[] => (checkRecords ??= loadLabReadings({ withPassSetAsideClaims: true }));
  const labs: CtxLab[] = d
    .select()
    .from(schema.labResults)
    .where(isNull(schema.labResults.deletedAt))
    .all()
    .filter((l) => !setAsideRows.has(l.id))
    // A row on a deleted document, or one held back as someone else's record, is hidden as the Labs page hides it (review
    // 2026-10-09: it fed the trend and range rules).
    .filter((l) => !l.documentId || documentById.has(l.documentId))
    // A value the patient computed (2026-10-09) is never in the out-of-range, trend or monitoring rules: only the printed record is.
    .filter((l) => l.rawSource !== COMPUTED_SOURCE)
    // A value dated only by its result (2026-10) is placed at that date.
    .filter((l) => inScopeWindow(l.collectedAt ?? l.resultedAt, scope))
    .filter((l) => !docFilter || (l.documentId !== null && docFilter.has(l.documentId)))
    .map((l) => ({ id: l.id, analyte: l.analyte, analyteKey: l.analyteKey || normalizeKey(l.analyte), specimen: l.specimen, valueNum: l.valueNum, valueText: l.valueText, unit: l.unit, refLow: l.refLow, refHigh: l.refHigh, flag: l.flag, collectedAt: l.collectedAt, collectedAtPrecision: l.collectedAtPrecision, documentId: l.documentId, factId: l.factId, refText: l.refText, resultedAt: l.resultedAt }));

  const eventRows = d.select().from(schema.medicationEvents).where(isNull(schema.medicationEvents.deletedAt)).all();
  const eventsBy = new Map<string, CtxMedicationEvent[]>();
  for (const e of eventRows) {
    const list = eventsBy.get(e.medicationId) ?? [];
    list.push({ id: e.id, kind: e.kind, date: e.date, detail: e.detail, dose: e.dose, sourceFactId: e.sourceFactId });
    eventsBy.set(e.medicationId, list);
  }
  const medications: CtxMedication[] = d
    .select()
    .from(schema.medications)
    .where(isNull(schema.medications.deletedAt))
    .all()
    .map((m) => ({ id: m.id, name: m.name, status: m.status, dose: m.dose, unit: m.unit, startDate: m.startDate, stopDate: m.stopDate, sourceFactId: m.sourceFactId, events: eventsBy.get(m.id) ?? [] }));

  const encounters: CtxEncounter[] = d
    .select()
    .from(schema.encounters)
    .where(isNull(schema.encounters.deletedAt))
    .all()
    .map((e) => ({ id: e.id, title: e.title, status: e.status, occurredAt: e.occurredAt, clinicianId: e.clinicianId, institutionId: e.institutionId }));

  const tasks: CtxTask[] = d
    .select()
    .from(schema.tasks)
    .where(isNull(schema.tasks.deletedAt))
    .all()
    .map((t) => ({ id: t.id, title: t.title, status: t.status, sourceType: t.sourceType, sourceId: t.sourceId }));

  const symptomDefinitions = d.select({ id: schema.symptomDefinitions.id, name: schema.symptomDefinitions.name }).from(schema.symptomDefinitions).all();
  const symptomEntries = d
    .select({ date: schema.symptomEntries.date, symptomId: schema.symptomEntries.symptomId, score: schema.symptomEntries.score })
    .from(schema.symptomEntries)
    .all()
    .filter((e) => inScopeWindow(e.date, scope));

  const gaps = inferGaps().filter((g) => !docFilter || (g.kind === 'inferred' && g.sourceDocumentId !== null && docFilter.has(g.sourceDocumentId)));

  const pageCache = new Map<string, string>();
  const pageText = (documentId: string): string => {
    const hit = pageCache.get(documentId);
    if (hit !== undefined) return hit;
    const pages = d
      .select({ text: schema.documentPages.text })
      .from(schema.documentPages)
      .where(eq(schema.documentPages.documentId, documentId))
      .orderBy(asc(schema.documentPages.pageNumber))
      .all()
      .map((p) => p.text);
    const text = normalizeKey(pages.join('\n'));
    pageCache.set(documentId, text);
    return text;
  };

  return { today, scope, facts, factById, documents, documentById, pageText, communications, labs, people, medications, encounters, tasks, symptomDefinitions, symptomEntries, gaps, writeOverrides: applyPrecedenceDecisions, labPartsSetAside, labRowsAssumed, labReadings, labCheckRecords };
}

/**
 * Persist the patient-precedence decisions: set `overridden_by_fact_id` and
 * the one-line reason on each outranked fact, and (over an unscoped context)
 * clear automatic overrides the rule no longer decides. Overrides the user
 * set or cleared by hand (attributes._overrideManual) are never touched.
 */
export function applyPrecedenceDecisions(decisions: PrecedenceDecision[], opts: { clearStale: boolean }): { set: number; cleared: number } {
  const d = db();
  const now = nowIso();
  let set = 0;
  let cleared = 0;
  const decided = new Map(decisions.map((x) => [x.targetId, x]));
  const current = d
    .select({ id: schema.facts.id, overriddenByFactId: schema.facts.overriddenByFactId, overrideReason: schema.facts.overrideReason, attributesJson: schema.facts.attributesJson })
    .from(schema.facts)
    .where(isNull(schema.facts.deletedAt))
    .all();
  for (const row of current) {
    const manual = parseJson<Record<string, unknown>>(row.attributesJson, {})._overrideManual === true;
    const want = decided.get(row.id);
    if (want) {
      if (manual) continue;
      if (row.overriddenByFactId === want.byFactId && row.overrideReason === want.reason) continue;
      d.update(schema.facts).set({ overriddenByFactId: want.byFactId, overrideReason: want.reason, updatedAt: now }).where(eq(schema.facts.id, row.id)).run();
      set++;
    } else if (opts.clearStale && row.overriddenByFactId && !manual) {
      d.update(schema.facts).set({ overriddenByFactId: null, overrideReason: null, updatedAt: now }).where(eq(schema.facts.id, row.id)).run();
      cleared++;
    }
  }
  // Facts soft-deleted or superseded since the override was set cannot keep taking precedence.
  if (opts.clearStale) {
    const r = d.run(sql`update facts set overridden_by_fact_id = null, override_reason = null, updated_at = ${now}
      where overridden_by_fact_id is not null and deleted_at is null
        and overridden_by_fact_id not in (select id from facts where deleted_at is null and status not in ('disputed', 'superseded'))`);
    cleared += Number((r as { changes?: number }).changes ?? 0);
  }
  return { set, cleared };
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/** A typed reference to a row that is not a fact/citation/communication/lab/document. */
export interface EvidenceRef {
  kind: 'record' | 'medication' | 'medication_event' | 'symptom' | 'encounter' | 'task';
  id: string;
}

export interface DraftEvidence {
  factId?: string | null;
  citationId?: string | null;
  documentId?: string | null;
  communicationId?: string | null;
  labResultId?: string | null;
  ref?: EvidenceRef | null;
  note?: string | null;
  /** A passage to verify and store as a citation of the finding (AI pass). */
  pendingCitation?: { documentId: string; pageNumber: number; quote: string } | null;
}

export interface FindingDraft {
  ruleId: string | null;
  category: FindingCategory;
  severity: Severity;
  title: string;
  whyItMatters: string;
  detail: string;
  evidence: DraftEvidence[];
  /** Stable identity parts; the fingerprint hashes the rule id plus these. */
  key: string[];
}

export interface CrossrefRule {
  id: string;
  category: FindingCategory;
  description: string;
  run(ctx: RuleContext): FindingDraft[];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const fmt = (iso: string | null | undefined): string => (iso ? formatPartialDate(iso) : 'undated');

/** First day covered by a partial date, for day arithmetic. */
export function toDay(iso: string): string {
  if (iso.length === 4) return `${iso}-01-01`;
  if (iso.length === 7) return `${iso}-01`;
  return iso.slice(0, 10);
}

function daysSince(iso: string, today: string): number {
  return daysBetween(toDay(iso), today);
}

function isAfter(iso: string | null | undefined, after: string): boolean {
  if (!iso) return false;
  return dateSortKey(iso) > dateSortKey(after);
}

function precise(iso: string | null | undefined): iso is string {
  return Boolean(iso && iso.length >= 7);
}

function str(a: Record<string, unknown>, key: string): string {
  const v = a[key];
  if (v == null) return '';
  return typeof v === 'string' ? v.trim() : String(v);
}

function num(a: Record<string, unknown>, key: string): number | null {
  const v = a[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

function groupBy<T>(items: T[], keyOf: (t: T) => string | null | undefined): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const k = keyOf(it);
    if (!k) continue;
    const list = out.get(k) ?? [];
    list.push(it);
    out.set(k, list);
  }
  return out;
}

function attributeText(a: Record<string, unknown>): string {
  return Object.entries(a)
    .filter(([k, v]) => !k.startsWith('_') && typeof v === 'string')
    .map(([, v]) => v as string)
    .join(' ');
}

function factText(f: CtxFact): string {
  return `${f.statement} ${attributeText(f.attributes)}`;
}

function pad(text: string): string {
  return ` ${normalizeKey(text)} `;
}

function hasWord(padded: string, token: string): boolean {
  return padded.includes(` ${token} `);
}

/** Modality keywords minus the ones that collide with ordinary words. */
function keywordsOf(text: string): Set<string> {
  const k = modalityKeywords(text);
  k.delete('us');
  return k;
}

function factEvidence(f: CtxFact, note?: string): DraftEvidence {
  const c = f.citations[0];
  return { factId: f.id, documentId: f.sourceDocumentId, citationId: c?.id ?? null, note: note ?? null };
}

function sourceLabel(f: CtxFact): string {
  const c = f.citations[0];
  if (f.documentTitle) return `"${f.documentTitle}"${c ? ` p.${c.pageNumber}` : ''}`;
  return f.origin === 'manual' ? 'a manual entry' : 'an entry without a document';
}

function statusNote(f: CtxFact): string {
  return f.status === 'unverified' ? ' (not checked)' : '';
}

// ---------------------------------------------------------------------------
// "Is there any later record of X?" — shared by the overlooked rules
// ---------------------------------------------------------------------------

export interface LaterHit {
  kind: 'fact' | 'document' | 'communication' | 'encounter' | 'task';
  id: string;
  label: string;
  date: string | null;
}

export interface LaterOptions {
  after: string;
  tokens: Set<string>;
  keywords: Set<string>;
  factTypes?: readonly string[];
  /** Document categories that count as "it happened" (results, not notes that repeat the plan). */
  documentCategories?: readonly string[];
  excludeFactId?: string | null;
  excludeDocumentId?: string | null;
  /**
   * The source unit of the promise (2026-10-07): facts of that unit do not count as later evidence, while facts of
   * another passage of the same export (a later encounter) do. Without it, every fact of `excludeDocumentId` is left out.
   */
  excludeUnit?: SourceRef | null;
  minOverlap?: number;
  /** A done task created from this fact also counts. */
  sourceFactId?: string | null;
}

const RESULT_CATEGORIES = ['lab_report', 'imaging_report', 'pathology', 'operative_report', 'discharge_summary'] as const;
const ACTION_FACT_TYPES = ['procedure', 'imaging_result', 'lab_result', 'referral', 'medication', 'event', 'follow_up'] as const;

function textMatches(text: string, tokens: Set<string>, keywords: Set<string>, minOverlap: number): boolean {
  const padded = pad(text);
  for (const k of keywords) if (hasWord(padded, k)) return true;
  if (!tokens.size) return false;
  let present = 0;
  for (const t of tokens) if (hasWord(padded, t)) present++;
  return present >= 1 && present / tokens.size >= minOverlap;
}

/** Items dated after `after` whose text refers to the same thing. */
export function laterEvidence(ctx: RuleContext, o: LaterOptions): LaterHit[] {
  const hits: LaterHit[] = [];
  const minOverlap = o.minOverlap ?? 0.5;
  const types = new Set(o.factTypes ?? ACTION_FACT_TYPES);
  const cats = new Set(o.documentCategories ?? RESULT_CATEGORIES);
  for (const f of ctx.facts) {
    if (f.id === o.excludeFactId || !types.has(f.type)) continue;
    if (o.excludeUnit ? sameSource(unitOf(f), o.excludeUnit) : o.excludeDocumentId && f.sourceDocumentId === o.excludeDocumentId) continue;
    if (!isAfter(f.date, o.after)) continue;
    if (textMatches(factText(f), o.tokens, o.keywords, minOverlap)) hits.push({ kind: 'fact', id: f.id, label: f.statement, date: f.date });
  }
  for (const doc of ctx.documents) {
    if (doc.id === o.excludeDocumentId || !cats.has(doc.category)) continue;
    if (!isAfter(doc.documentDate, o.after)) continue;
    const head = ctx.pageText(doc.id).slice(0, 4000);
    if (textMatches(`${doc.title} ${head}`, o.tokens, o.keywords, minOverlap)) hits.push({ kind: 'document', id: doc.id, label: doc.title, date: doc.documentDate });
  }
  for (const c of ctx.communications) {
    if (!isAfter(c.occurredAt, o.after)) continue;
    // The body too (2026-10-07 review, rev-comms #5): a call-back printed only as a telephone note is evidence.
    const text = [c.subject, c.summary, c.outcome, c.body, ...c.topics].filter(Boolean).join(' ');
    if (textMatches(text, o.tokens, o.keywords, minOverlap)) hits.push({ kind: 'communication', id: c.id, label: c.subject, date: c.occurredAt });
  }
  for (const e of ctx.encounters) {
    if (e.status === 'cancelled' || !isAfter(e.occurredAt, o.after)) continue;
    if (e.occurredAt && e.occurredAt > ctx.today) continue;
    if (textMatches(e.title, o.tokens, o.keywords, minOverlap)) hits.push({ kind: 'encounter', id: e.id, label: e.title, date: e.occurredAt });
  }
  if (o.sourceFactId) {
    for (const t of ctx.tasks) {
      if (t.sourceType === 'fact' && t.sourceId === o.sourceFactId && t.status === 'done') hits.push({ kind: 'task', id: t.id, label: t.title, date: null });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Lab series (lab_results rows + lab_result facts, deduplicated)
// ---------------------------------------------------------------------------

export interface LabPoint {
  key: string;
  specimen: string;
  analyteKey: string;
  analyte: string;
  /** The reading's date (2026-10, rule 7): collected, else a date of unknown kind, else resulted. */
  date: string | null;
  datePrecision: string;
  /** The measurement (reading.measurement): null for a limit ("<3"), words, a value printed as a range, or blank. */
  valueNum: number | null;
  /** The value as shown (reading.valueShown): as printed, or the user's own words. */
  valueText: string | null;
  unit: string | null;
  /** The bounds of the value's own range when read as numbers (reading.range). */
  refLow: number | null;
  refHigh: number | null;
  /** The flag printed with the value (H, L, N, A, C); null when none was printed, and always for a document's claim. */
  flag: string | null;
  labResultId: string | null;
  factId: string | null;
  documentId: string | null;
  citationId: string | null;
  documentTitle: string | null;
  /** The value as read (src/shared/labvalues.ts), as the Labs page reads it. Optional only for points built by hand. */
  reading?: LabReading;
}

function precisionOf(iso: string): DatePrecision {
  return iso.length === 4 ? 'year' : iso.length === 7 ? 'month' : 'day';
}

function partialOf(iso: string | null | undefined, precision?: string | null): PartialDate | null {
  return iso ? { iso, precision: (precision || precisionOf(iso)) as DatePrecision, text: iso } : null;
}

/** The tier a lab row is read at: its fact's passage when it was made from a fact (trust.ts factTier), else its document's. */
function rowTier(ctx: RuleContext, l: CtxLab, docTier: string | null): string | null {
  const f = l.factId ? ctx.factById.get(l.factId) : undefined;
  if (!f || docTier == null) return docTier;
  return factTier(docTier, { assertedBy: f.assertedBy ?? null, attributes: f.attributes });
}

/** A row read from its own fields with the shared parser, when the Labs page's reading is not at hand (a context built by hand). */
function rowReading(ctx: RuleContext, l: CtxLab): LabReading {
  const doc = l.documentId ? ctx.documentById.get(l.documentId) : undefined;
  return buildLabReading({
    value: { shown: l.valueText, raw: null, storedNumber: l.valueNum, userEdited: false },
    unit: { shown: l.unit, raw: null },
    range: { shown: l.refText ?? null, raw: null, storedLow: l.refLow, storedHigh: l.refHigh },
    flag: { shown: l.flag, raw: null },
    quote: null,
    // Trust follows the passage: a row made from the patient's own words in a clinical record reads as his claim.
    role: roleForTier(rowTier(ctx, l, doc?.sourceTier ?? null), Boolean(l.documentId)),
    dates: { collected: null, unknownKind: partialOf(l.collectedAt, l.collectedAtPrecision), resulted: partialOf(l.resultedAt), document: null },
    labName: null,
    claim: null,
  });
}

/** A fact read through the one accessor (services/lab-reading.ts readingForFact), when the Labs page's reading is not at hand. */
function factReading(ctx: RuleContext, f: CtxFact): LabReading {
  const doc = f.sourceDocumentId ? ctx.documentById.get(f.sourceDocumentId) : undefined;
  const cite = f.citations[0];
  const samePage = Boolean(cite && cite.documentId === f.sourceDocumentId);
  return readingForFact(
    { id: f.id, attributesJson: JSON.stringify(f.attributes), date: f.date, datePrecision: f.datePrecision, dateText: f.dateText, status: f.status, sourceDocumentId: f.sourceDocumentId, origin: f.origin, assertedBy: f.assertedBy ?? null },
    {
      cite: samePage ? { id: cite.id, documentId: cite.documentId, pageNumber: cite.pageNumber, verified: cite.verified, quote: cite.quote } : null,
      documentTier: doc?.sourceTier ?? null,
      documentDate: partialOf(doc?.documentDate, doc?.documentDatePrecision),
      hasDocument: Boolean(f.sourceDocumentId),
    },
  );
}

/** One test of a line that holds several, read on its own text (labs.ts partLabReading), with the line's role and dates. */
function partReadingOf(v: LabValueRead, line: LabReading): LabReading {
  return partLabReading({ valueText: v.valueText, valueNum: v.valueNum, unit: v.unit, flagRaw: v.flagRaw ?? null }, { reading: readingView(line), date: line.dates.reading, quote: null });
}

const ROLE_RANK: Record<ReadingRole, number> = { printed: 0, unclassified: 1, typed: 2, computed: 3, claimed: 4 };

/** The days a point can be matched on as one result (amendment G5): its own date, its collected and resulted days. */
function pointDays(p: LabPoint): Set<string> {
  const out = new Set<string>();
  const r = p.reading;
  for (const d of [p.date, r?.dates.collected?.iso, r?.dates.resulted?.iso]) if (d) out.add(d);
  if (!out.size) out.add('');
  return out;
}

/**
 * One result in two places (amendment G5): the same value ("62" = "62.0", "<3" is not "3"), the same unit, the same lab
 * when both name one, and a day in common (a lab report dated by collection and a copy dated by its result).
 */
function sameResultPoint(a: LabPoint, b: LabPoint): boolean {
  const ia = a.reading ? labValueIdentity(a.reading.value) : '';
  const ib = b.reading ? labValueIdentity(b.reading.value) : '';
  if (!ia || ia !== ib) return false;
  if ((a.reading?.unit.key ?? '') !== (b.reading?.unit.key ?? '')) return false;
  const la = a.reading?.lab.key ?? null;
  const lb = b.reading?.lab.key ?? null;
  if (la && lb && la !== lb) return false;
  const da = pointDays(a);
  for (const d of pointDays(b)) if (da.has(d)) return true;
  return false;
}

/** The flag a point is marked with: the flag printed with it; never a document's claim. */
function pointFlag(r: LabReading): string | null {
  if (r.role === 'claimed' || r.flag.state !== 'flag') return null;
  return r.flag.printed;
}

/**
 * Series per specimen + analyte, chronological, every value read as the Labs page reads it (ctx.labReadings; the shared
 * parser on a context built by hand). Grouped as the Labs page groups (labs.ts readLabValues): by the name as written,
 * never a stored key ("ICP (opening pressure)" and "Opening pressure" are one test, a CSF test), and a line that holds
 * several tests ("OP 17; protein 52") is one point per test, each with its own sample. A test the Labs page sets aside
 * on its own (ctx.labPartsSetAside) is no point.
 *
 * One result found in several places is one point (amendment G5): a fact linked to a row, or repeating a value (same
 * value, unit and lab, a day in common), folds into the row or the lab report's value. Values of one test in different
 * units, or from different named labs, are different series (rules 5 and 8): the series key stays
 * `<specimen>|<test>` when the test has one unit and one lab, so findings already judged keep their fingerprint, and
 * gains `|<unit>|<lab>` only when there are several (amendment G6).
 */
export function labSeries(ctx: RuleContext): Map<string, LabPoint[]> {
  const rows: LabPoint[] = [];
  const facts: LabPoint[] = [];
  const linkedFacts = new Set<string>();
  const setAside = (id: string, index: number | null) => {
    const set = ctx.labPartsSetAside?.get(id);
    return Boolean(set && (index == null ? set.has(-1) : set.has(index)));
  };
  const point = (v: LabValueRead, reading: LabReading, base: Pick<LabPoint, 'labResultId' | 'factId' | 'documentId' | 'citationId' | 'documentTitle'>): LabPoint => {
    const parsed = reading.range.status === 'parsed' || reading.range.fromNumbersOnly;
    const d = reading.dates.reading;
    return {
      key: `${v.specimen}|${v.analyteKey}`,
      specimen: v.specimen,
      analyteKey: v.analyteKey,
      analyte: v.analyte,
      date: d?.iso ?? null,
      datePrecision: d?.precision ?? 'unknown',
      valueNum: reading.measurement,
      valueText: reading.valueShown || null,
      unit: reading.unit.unit,
      refLow: parsed ? reading.range.low : null,
      refHigh: parsed ? reading.range.high : null,
      flag: pointFlag(reading),
      ...base,
      reading,
    };
  };
  for (const l of ctx.labs) {
    if (l.factId) linkedFacts.add(l.factId);
    const fact = l.factId ? ctx.factById.get(l.factId) : undefined;
    const read = readLabValues({ analyte: l.analyte, specimen: l.specimen, ...(ctx.labRowsAssumed?.has(l.id) ? { specimenAssumed: true } : {}), valueText: l.valueText, valueNum: l.valueNum, unit: l.unit, flag: l.flag, refLow: l.refLow, refHigh: l.refHigh, refText: l.refText ?? null });
    let line: LabReading | null = null;
    const lineReading = (): LabReading => (line ??= ctx.labReadings?.get(l.id) ?? rowReading(ctx, l));
    for (const v of read) {
      if (setAside(l.id, v.splitFrom?.index ?? null)) continue;
      const reading = v.splitFrom ? (ctx.labReadings?.get(`${l.id}#${v.splitFrom.index}`) ?? partReadingOf(v, lineReading())) : lineReading();
      rows.push(
        point(v, reading, {
          labResultId: l.id,
          factId: l.factId,
          documentId: l.documentId ?? fact?.sourceDocumentId ?? null,
          citationId: fact?.citations[0]?.id ?? null,
          documentTitle: l.documentId ? (ctx.documentById.get(l.documentId)?.title ?? null) : (fact?.documentTitle ?? null),
        }),
      );
    }
  }
  for (const f of ctx.facts) {
    if (f.type !== 'lab_result' || linkedFacts.has(f.id)) continue;
    const a = f.attributes;
    const analyte = str(a, 'analyte') || f.subjectKey?.split('|')[1] || '';
    if (!analyte) continue;
    const stated = str(a, 'specimen');
    const read = readLabValues({
      analyte,
      specimen: stated || defaultSpecimenFor(analyte),
      specimenAssumed: !stated,
      valueText: str(a, 'value') || null,
      valueNum: num(a, 'value_num'),
      unit: str(a, 'unit') || null,
      flag: str(a, 'flag') || null,
      refLow: num(a, 'ref_low'),
      refHigh: num(a, 'ref_high'),
      refText: str(a, 'ref_text') || null,
    });
    let line: LabReading | null = null;
    const lineReading = (): LabReading => (line ??= ctx.labReadings?.get(`fact:${f.id}`) ?? factReading(ctx, f));
    for (const v of read) {
      if (setAside(`fact:${f.id}`, v.splitFrom?.index ?? null)) continue;
      const reading = v.splitFrom ? (ctx.labReadings?.get(`fact:${f.id}#${v.splitFrom.index}`) ?? partReadingOf(v, lineReading())) : lineReading();
      facts.push(point(v, reading, { labResultId: null, factId: f.id, documentId: f.sourceDocumentId, citationId: f.citations[0]?.id ?? null, documentTitle: f.documentTitle }));
    }
  }
  // Rows first, then facts, a lab report's before a summary's: a copy folds into the first value it repeats.
  facts.sort((x, y) => ROLE_RANK[x.reading!.role] - ROLE_RANK[y.reading!.role]);
  const byTest = new Map<string, LabPoint[]>();
  for (const p of [...rows, ...facts]) {
    const list = byTest.get(p.key) ?? [];
    if (list.some((q) => sameResultPoint(q, p))) continue;
    list.push(p);
    byTest.set(p.key, list);
  }
  const out = new Map<string, LabPoint[]>();
  for (const [base, list] of byTest) {
    const groups = groupBy(list, (p) => `${p.reading?.unit.key ?? ''}\u0001${p.reading?.lab.key ?? ''}`);
    if (groups.size <= 1) {
      out.set(base, list);
      continue;
    }
    // The main series keeps the bare key, so a finding the user already judged on it keeps its fingerprint when a summary
    // restates a value with no unit, or one report names its lab (2026-10 review): a series with a unit printed before
    // one with none (as the charts read them), then the most values not from a summary, then the earliest. Only the
    // other series get the unit and the lab in their key.
    const hasUnit = (g: string) => (g.split('\u0001')[0] ? 1 : 0);
    const weight = (ps: LabPoint[]) => ps.filter((p) => p.reading?.role !== 'claimed').length;
    const first = (ps: LabPoint[]) => ps.map((p) => dateSortKey(p.date)).sort()[0] ?? '';
    const main = [...groups.entries()].sort((a, b) => hasUnit(b[0]) - hasUnit(a[0]) || weight(b[1]) - weight(a[1]) || first(a[1]).localeCompare(first(b[1])) || a[0].localeCompare(b[0]))[0][0];
    for (const [g, points] of groups) {
      const [u, lab] = g.split('\u0001');
      const key = g === main ? base : `${base}|${u || 'no unit'}|${lab || 'unnamed'}`;
      for (const p of points) p.key = key;
      out.set(key, points);
    }
  }
  for (const list of out.values()) list.sort((a, b) => dateSortKey(a.date).localeCompare(dateSortKey(b.date)));
  return out;
}

/** A reading built from a point's bare fields (a point made by hand, without its reading). */
function bareReading(p: Pick<LabPoint, 'flag' | 'valueNum' | 'refLow' | 'refHigh'>): LabReading {
  return buildLabReading({
    value: { shown: null, raw: null, storedNumber: p.valueNum, userEdited: false },
    unit: { shown: null, raw: null },
    range: { shown: null, raw: null, storedLow: p.refLow, storedHigh: p.refHigh },
    flag: { shown: p.flag, raw: null },
    quote: null,
    role: 'typed',
    dates: { collected: null, resulted: null, unknownKind: null, document: null },
    labName: null,
    claim: null,
  });
}

/**
 * true = outside its own range, false = inside, null = cannot tell (rules 4, 8, 12): the flag printed with the value
 * first (H, L, A, C out; N in), else the flag worked out from the value and the range printed with it. A document's
 * claim (a summary's flag or range) is never judged here: null.
 */
export function outOfRange(p: Pick<LabPoint, 'flag' | 'valueNum' | 'refLow' | 'refHigh'> & { reading?: LabReading }): boolean | null {
  const r = p.reading ?? bareReading(p);
  if (r.role === 'claimed') return null;
  if (r.flag.state === 'flag' && r.flag.printed) return r.flag.printed !== 'N';
  if (r.computed.flag === 'H' || r.computed.flag === 'L') return true;
  if (r.computed.flag === 'N') return false;
  return null;
}

/** The report printed a critical mark (HH, LL, "critical", "panic"); a bare "C" is the report's own letter, not called critical. */
function criticalMark(p: LabPoint): boolean {
  return Boolean(p.reading?.flag.critical);
}

/** A flag that makes a finding high severity: a critical mark, or the letter C (critical or corrected, as the report uses it). */
function severeFlag(p: LabPoint): boolean {
  return criticalMark(p) || (p.flag ?? '').toUpperCase() === 'C';
}

function labValue(p: LabPoint): string {
  const v = p.reading?.valueShown || p.valueText || (p.valueNum != null ? String(p.valueNum) : '?');
  return p.unit ? `${v} ${p.unit}` : v;
}

/** The value's own range as shown ("ref 15–45", "ref <50", "ref upper limit 50"); never a range composed with a dash for a missing bound. */
function labRef(p: LabPoint): string {
  const r = p.reading;
  if (r) {
    if (!r.rangeShown) return 'no reference range recorded';
    return r.role === 'claimed' ? `ref ${r.rangeShown}, as stated in this document` : `ref ${r.rangeShown}`;
  }
  if (p.refLow != null && p.refHigh != null) return `ref ${p.refLow}–${p.refHigh}`;
  if (p.refLow != null) return `ref lower limit ${p.refLow}`;
  if (p.refHigh != null) return `ref upper limit ${p.refHigh}`;
  return 'no reference range recorded';
}

/** The flag as printed; one worked out from the value's own range says so; a document's own flag is its claim. */
function labFlagWords(p: LabPoint): string {
  const r = p.reading;
  if (!r) return p.flag ? ` ${p.flag.toUpperCase()}` : '';
  if (r.role === 'claimed') return r.flag.state === 'flag' ? ` (this document's own flag: ${(r.flag.raw ?? '').trim()})` : '';
  if (r.flag.state === 'flag') return ` ${r.flag.shown}`;
  if (r.computed.flag === 'H' || r.computed.flag === 'L') {
    // What was printed, said as it is: none printed, not recorded, or a mark the app does not read ("Pos").
    const why = r.flag.state === 'no_flag_printed' ? 'no flag printed' : r.flag.state === 'not_understood' ? `flag "${(r.flag.raw ?? '').trim()}" not understood` : 'no flag recorded';
    return ` (${r.computed.flag === 'H' ? 'high' : 'low'} by its own range, ${why})`;
  }
  return '';
}

function labEvidence(p: LabPoint, note?: string): DraftEvidence {
  return { labResultId: p.labResultId, factId: p.factId, citationId: p.citationId, documentId: p.documentId, note: note ?? null };
}

function labLine(p: LabPoint): string {
  return `${fmt(p.date)}: ${labValue(p)} (${labRef(p)})${labFlagWords(p)} — ${p.documentTitle ?? 'no document'}`;
}

// ---------------------------------------------------------------------------
// Dose and effect normalisation (medications)
// ---------------------------------------------------------------------------

const UNIT_TO_MG: Record<string, number> = { mg: 1, g: 1000, gram: 1000, grams: 1000, mcg: 0.001, ug: 0.001, µg: 0.001, microgram: 0.001, micrograms: 0.001 };

/** Dose as a comparable value: mg-equivalent when the unit is a mass, else the normalised text. */
export function normalizeDose(dose: string | null | undefined, unit: string | null | undefined): { mg: number | null; text: string } | null {
  const raw = `${dose ?? ''} ${unit ?? ''}`.trim();
  if (!raw) return null;
  const text = normalizeKey(raw).replace(/\s+/g, '');
  const m = raw.toLowerCase().replace(',', '.').match(/(\d+(?:\.\d+)?)\s*(mg|g|gram|grams|mcg|ug|µg|microgram|micrograms)\b/);
  if (m) return { mg: Number(m[1]) * UNIT_TO_MG[m[2]], text };
  return { mg: null, text };
}

export function dosesDiffer(a: ReturnType<typeof normalizeDose>, b: ReturnType<typeof normalizeDose>): boolean {
  if (!a || !b) return false;
  if (a.mg != null && b.mg != null) return Math.abs(a.mg - b.mg) > 1e-9;
  return a.text !== b.text;
}

const NEGATIVE_EFFECT = /\b(no|without|minimal|little|limited|lack of|not|never|zero)\s+(\w+\s+){0,2}(benefit|improvement|response|effect|help|change|difference)\b|\b(ineffective|unhelpful|worse|worsen(?:ed|ing)?|deteriorat\w*|intoleran\w*|not tolerated|poorly tolerated|adverse|reaction|side effects?|discontinued (?:due|because)|stopped (?:due|because)|did not help|didn'?t help|failed|failure|flare\w*|relapse\w*)\b/i;
const POSITIVE_EFFECT = /\b(improv\w*|better|benefit\w*|respond\w*|response|helped|helpful|effective|resolved|resolution|relief|reduc\w*|fewer|less|tolerated well|well tolerated|good response|remission|stabili[sz]\w*)\b/i;

/** The direction a stated effect points in. Negative wins when both appear ("no improvement"). */
export function effectPolarity(effect: string | null | undefined): 'positive' | 'negative' | 'unknown' {
  const t = (effect ?? '').trim();
  if (!t) return 'unknown';
  if (NEGATIVE_EFFECT.test(t)) return 'negative';
  if (POSITIVE_EFFECT.test(t)) return 'positive';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const DATE_RULE_TYPES = new Set(['lab_result', 'medication', 'procedure', 'imaging_result', 'event']);
const DATE_WINDOW_DAYS = 45;

function effectiveDate(f: CtxFact): string | null {
  if (f.type === 'medication') {
    const s = str(f.attributes, 'start_date');
    const parsed = s ? parsePartialDate(s).iso : null;
    return parsed ?? f.date;
  }
  return f.date;
}

function thingLabel(f: CtxFact): string {
  const a = f.attributes;
  switch (f.type) {
    case 'lab_result':
      return clip(`${str(a, 'analyte')} ${str(a, 'value')}${str(a, 'unit') ? ` ${str(a, 'unit')}` : ''}`, 60) || 'the same result';
    case 'medication':
      return `the start of ${str(a, 'name') || 'the medication'}`;
    case 'imaging_result':
      return clip(`${str(a, 'modality')} ${str(a, 'body_part')}`, 60) || 'the same study';
    case 'procedure':
      return clip(str(a, 'name'), 60) || 'the same procedure';
    case 'event':
      return clip(str(a, 'name'), 60) || 'the same event';
    default:
      return 'the same item';
  }
}

/** A lab fact's value identity (labValueIdentity): its value text as read, else its stored number; '' when neither. */
function factValueIdentity(a: Record<string, unknown>): string {
  const text = str(a, 'value');
  const n = num(a, 'value_num');
  return labValueIdentity(text ? parseLabValue(text) : n != null ? numberOnlyValue(n) : parseLabValue(null));
}

/**
 * A lab result whose own collected or resulted date (printed with it, 2026-10) is the other fact's date: the two dates
 * are that result's two dates, not a disagreement (rule 7).
 */
function labDatesExplain(a: CtxFact, b: CtxFact): boolean {
  const own = (f: CtxFact) => [str(f.attributes, 'collected_date'), str(f.attributes, 'resulted_date')].map((t) => (t ? parsePartialDate(t).iso : null)).filter((x): x is string => Boolean(x));
  const da = effectiveDate(a);
  const dbb = effectiveDate(b);
  return Boolean((dbb && own(a).some((d) => datesAgree(d, dbb))) || (da && own(b).some((d) => datesAgree(d, da))));
}

/** Do two same-subject facts describe one occurrence (so differing dates are a disagreement, not two events)? */
function sameOccurrence(a: CtxFact, b: CtxFact): boolean {
  const aa = a.attributes;
  const ba = b.attributes;
  switch (a.type) {
    case 'lab_result': {
      // One value, as read by the shared parser (2026-10): "62" = "62.0", "<3" is not "3", "-2" is not "2"; a stored
      // number counts only when no value text is on record.
      const ia = factValueIdentity(aa);
      const sameValue = ia !== '' && ia === factValueIdentity(ba);
      const ua = unitKey(str(aa, 'unit') || null);
      const ub = unitKey(str(ba, 'unit') || null);
      return sameValue && (!ua || !ub || ua === ub);
    }
    case 'medication': {
      const da = normalizeDose(str(aa, 'dose'), str(aa, 'unit'));
      const dbb = normalizeDose(str(ba, 'dose'), str(ba, 'unit'));
      return !dosesDiffer(da, dbb);
    }
    default:
      return textSimilarity(a.statement, b.statement) >= 0.45;
  }
}

export const dateDisagreement: CrossrefRule = {
  id: 'date_disagreement',
  category: 'discrepancy',
  description: 'Two documents give different dates for what looks like the same result, medication start, procedure, study or event.',
  run(ctx) {
    const out: FindingDraft[] = [];
    const eligible = ctx.facts.filter((f) => DATE_RULE_TYPES.has(f.type) && hasSubject(f.subjectKey));
    for (const [, list] of groupBy(eligible, (f) => f.subjectKey)) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          if (sameFactSource(a, b)) continue;
          const da = effectiveDate(a);
          const dbb = effectiveDate(b);
          if (!precise(da) || !precise(dbb)) continue;
          if (datesAgree(da, dbb)) continue;
          const gap = Math.abs(daysBetween(toDay(da), toDay(dbb)));
          if (gap > DATE_WINDOW_DAYS) continue;
          if (!sameOccurrence(a, b)) continue;
          if (a.type === 'lab_result' && labDatesExplain(a, b)) continue;
          const [first, second] = dateSortKey(da) <= dateSortKey(dbb) ? [a, b] : [b, a];
          const d1 = effectiveDate(first)!;
          const d2 = effectiveDate(second)!;
          out.push({
            ruleId: 'date_disagreement',
            category: 'discrepancy',
            severity: gap <= 7 ? 'low' : 'medium',
            title: clip(`Sources disagree on the date of ${thingLabel(a)}: ${fmt(d1)} vs ${fmt(d2)}`, 140),
            whyItMatters: `Two records describe what looks like the same ${a.type.replace(/_/g, ' ')} with dates ${gap} day${gap === 1 ? '' : 's'} apart. One may be the collection date and the other the report date, or one record may simply be wrong. The team should know which date to rely on before it is copied forward.`,
            detail: [`${sourceLabel(first)} gives ${fmt(d1)}${statusNote(first)}: "${clip(first.statement, 240)}"`, `${sourceLabel(second)} gives ${fmt(d2)}${statusNote(second)}: "${clip(second.statement, 240)}"`].join('\n'),
            evidence: [factEvidence(first, `states ${fmt(d1)}`), factEvidence(second, `states ${fmt(d2)}`)],
            key: [a.id, b.id].sort(),
          });
        }
      }
    }
    return out;
  },
};

export const doseDisagreement: CrossrefRule = {
  id: 'dose_disagreement',
  category: 'discrepancy',
  description: 'Two documents give different doses of the same medication for the same period.',
  run(ctx) {
    const out: FindingDraft[] = [];
    const meds = ctx.facts.filter((f) => f.type === 'medication' && str(f.attributes, 'dose') && hasSubject(f.subjectKey));
    for (const [, list] of groupBy(meds, (f) => f.subjectKey)) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          if (sameFactSource(a, b)) continue;
          const da = normalizeDose(str(a.attributes, 'dose'), str(a.attributes, 'unit'));
          const dbb = normalizeDose(str(b.attributes, 'dose'), str(b.attributes, 'unit'));
          if (!dosesDiffer(da, dbb)) continue;
          // Same period: start dates (or fact dates) agree within 14 days; unknown on either side cannot be judged.
          const sa = effectiveDate(a);
          const sb = effectiveDate(b);
          if (!sa || !sb || !datesAgree(sa, sb, 14)) continue;
          const name = str(a.attributes, 'name') || 'the medication';
          const line = (f: CtxFact) => {
            const at = f.attributes;
            const parts = [str(at, 'dose'), str(at, 'unit'), str(at, 'route'), str(at, 'frequency')].filter(Boolean).join(' ');
            return `${sourceLabel(f)} (${fmt(effectiveDate(f))})${statusNote(f)}: ${parts} — "${clip(f.statement, 200)}"`;
          };
          out.push({
            ruleId: 'dose_disagreement',
            category: 'discrepancy',
            severity: 'medium',
            title: clip(`Sources disagree on the dose of ${name}: ${str(a.attributes, 'dose')} ${str(a.attributes, 'unit')} vs ${str(b.attributes, 'dose')} ${str(b.attributes, 'unit')}`, 140),
            whyItMatters: `Two records describe ${name} over the same period with different doses. A dose copied forward from the wrong record is a safety issue, so the team should confirm which one is right before the next prescription or summary.`,
            detail: [line(a), line(b)].join('\n'),
            evidence: [factEvidence(a), factEvidence(b)],
            key: [a.id, b.id].sort(),
          });
        }
      }
    }
    return out;
  },
};

export const effectDisagreement: CrossrefRule = {
  id: 'effect_disagreement',
  category: 'discrepancy',
  description: 'One document says a medication helped and another says it did not, or caused harm.',
  run(ctx) {
    const out: FindingDraft[] = [];
    // A clinician's account the patient has overridden is not in play: the patient's version is the one the engine reasons with.
    const meds = ctx.facts.filter((f) => f.type === 'medication' && !f.overriddenByFactId && effectPolarity(str(f.attributes, 'effect')) !== 'unknown' && hasSubject(f.subjectKey));
    for (const [, list] of groupBy(meds, (f) => f.subjectKey)) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          if (sameFactSource(a, b)) continue;
          const pa = effectPolarity(str(a.attributes, 'effect'));
          const pb = effectPolarity(str(b.attributes, 'effect'));
          if (pa === pb) continue;
          const name = str(a.attributes, 'name') || 'the medication';
          const pos = pa === 'positive' ? a : b;
          const neg = pa === 'positive' ? b : a;
          out.push({
            ruleId: 'effect_disagreement',
            category: 'discrepancy',
            severity: 'medium',
            title: clip(`Records disagree on the effect of ${name}`, 140),
            whyItMatters: `One record describes a benefit from ${name} and another describes no benefit or a problem. Which account the team relies on affects whether it is tried again, so the disagreement is worth settling with the people who wrote the records.`,
            detail: [
              `${sourceLabel(pos)} (${fmt(effectiveDate(pos))})${statusNote(pos)} records a benefit: "${str(pos.attributes, 'effect')}" — "${clip(pos.statement, 200)}"`,
              `${sourceLabel(neg)} (${fmt(effectiveDate(neg))})${statusNote(neg)} records none or harm: "${str(neg.attributes, 'effect')}" — "${clip(neg.statement, 200)}"`,
            ].join('\n'),
            evidence: [factEvidence(pos, 'benefit'), factEvidence(neg, 'no benefit or harm')],
            key: [a.id, b.id].sort(),
          });
        }
      }
    }
    return out;
  },
};

const GAP_TITLE: Record<string, string> = { inferred: 'Not on file', expected: 'Not on file', requested: 'Requested, not yet received', not_held: 'Reported as not held', denied: 'Request denied' };
const GAP_SEVERITY: Record<string, Severity> = { inferred: 'medium', expected: 'medium', requested: 'low', not_held: 'medium', denied: 'high' };

export const missingRecord: CrossrefRule = {
  id: 'missing_record',
  category: 'missing_record',
  description: 'A record the documents refer to, or an inventory row, is not held.',
  run(ctx) {
    const out: FindingDraft[] = [];
    for (const g of ctx.gaps) {
      const fact = g.sourceFactId ? ctx.factById.get(g.sourceFactId) : undefined;
      const evidence: DraftEvidence[] = [];
      if (g.sourceFactId) evidence.push({ factId: g.sourceFactId, documentId: fact?.sourceDocumentId ?? g.sourceDocumentId ?? null, citationId: g.citation?.citationId ?? fact?.citations[0]?.id ?? null, note: 'the reference that implies this record' });
      if (g.kind === 'inventory') evidence.push({ ref: { kind: 'record', id: g.id }, note: `inventory row, status ${g.status.replace(/_/g, ' ')}` });
      if (g.matchedRecordId) evidence.push({ ref: { kind: 'record', id: g.matchedRecordId }, note: 'a held row that looks like the same record' });
      const where = [g.institution, g.date ? fmt(g.date) : null].filter(Boolean).join(', ');
      const detail: string[] = [];
      if (g.kind === 'inferred') detail.push(`Referenced in ${g.sourceDocumentTitle ? `"${g.sourceDocumentTitle}"` : 'a document'}${g.citation ? ` p.${g.citation.pageNumber}: "${clip(g.citation.quote, 240)}"` : ''}.`);
      else detail.push(`Inventory row "${g.title}" (${g.recordType.replace(/_/g, ' ')}) is in status ${g.status.replace(/_/g, ' ')}${g.sourceFactId ? ', created from a reference in the documents' : ''}.`);
      if (g.factStatement) detail.push(`Reference as extracted${fact && fact.status === 'unverified' ? ' (not checked)' : ''}: "${clip(g.factStatement, 240)}"`);
      if (g.likelyHeldDocumentId) detail.push(`A held document may already be this record: "${g.likelyHeldDocumentTitle ?? g.likelyHeldDocumentId}". If so, link it from Records and this finding clears on the next run.`);
      if (g.matchedRecordId) detail.push('A held inventory row looks like the same record; check whether this row is a duplicate.');
      out.push({
        ruleId: 'missing_record',
        category: 'missing_record',
        severity: GAP_SEVERITY[g.status] ?? 'medium',
        title: clip(`${GAP_TITLE[g.status] ?? 'Not on file'}: ${g.title}${where ? ` (${where})` : ''}`, 140),
        whyItMatters:
          g.kind === 'inferred'
            ? 'A document refers to this record, but the record itself is not in the case file. Anyone reading the file sees a summary of it rather than the original, and a second opinion cannot check it.'
            : g.status === 'denied'
              ? 'The request for this record was refused. Without it the case file has a hole that a release form, an appeal or a different route may be able to fill.'
              : 'This record is known to exist but is not held. Until it arrives the case file is incomplete at this point in the history.',
        detail: detail.join('\n'),
        evidence,
        key: g.sourceFactId ? ['fact', g.sourceFactId] : ['record', g.id],
      });
    }
    return out;
  },
};

export const labNeverInRange: CrossrefRule = {
  id: 'lab_never_in_range',
  category: 'trend',
  description: 'Every recorded value of a test has been outside its reference range (at least two results).',
  run(ctx) {
    const out: FindingDraft[] = [];
    for (const [key, points] of labSeries(ctx)) {
      const judged = points.filter((p) => outOfRange(p) !== null);
      if (judged.length < 2) continue;
      if (!judged.every((p) => outOfRange(p) === true)) continue;
      const critical = judged.some(severeFlag);
      const first = judged[0];
      const last = judged[judged.length - 1];
      const analyte = first.analyte;
      out.push({
        ruleId: 'lab_never_in_range',
        category: 'trend',
        severity: critical ? 'high' : 'medium',
        title: clip(`${analyte} (${first.specimen}) outside the reference range in all ${judged.length} results, ${fmt(first.date)} to ${fmt(last.date)}`, 140),
        whyItMatters: `Every recorded value of this test is outside its reference range; it has never been seen in range in the case file. That is a pattern in the numbers as recorded, not an interpretation. Worth asking the team whether it is being followed and whether the range used applies.`,
        detail: judged.map(labLine).join('\n'),
        evidence: judged.map((p) => labEvidence(p, labLine(p))),
        key: [key],
      });
    }
    return out;
  },
};

export const labTrend: CrossrefRule = {
  id: 'lab_trend',
  category: 'trend',
  description: 'A test has moved in one direction across at least three consecutive results by 20% or more.',
  run(ctx) {
    const out: FindingDraft[] = [];
    // A series is one test in one unit from one lab (labSeries, rules 5 and 8); only measurements count (a limit or
    // words are no step, rules 2 and 6).
    for (const [key, points] of labSeries(ctx)) {
      let numeric = points.filter((p) => p.valueNum != null && precise(p.date));
      // A summary's restated values join a trend only when nothing else is on file (amendment D4).
      const own = numeric.filter((p) => p.reading?.role !== 'claimed');
      if (own.length) numeric = own;
      // One step per date: two values on one date are one step when they agree, and no step at all (the run stops
      // there) when they do not.
      const steps: Array<{ value: number | null; point: LabPoint }> = [];
      for (const p of numeric) {
        const last = steps[steps.length - 1];
        if (last && last.point.date === p.date) {
          if (last.value != null && Math.abs(last.value - p.valueNum!) > 1e-9 * Math.max(1, Math.abs(last.value))) last.value = null;
          continue;
        }
        steps.push({ value: p.valueNum!, point: p });
      }
      if (steps.length < 3) continue;
      // Longest strictly monotonic run that ends at the latest result.
      const end = steps.length - 1;
      let start = end;
      if (steps[end].value == null || steps[end - 1].value == null) continue;
      const dir = Math.sign(steps[end].value! - steps[end - 1].value!);
      if (dir === 0) continue;
      while (start > 0 && steps[start - 1].value != null && Math.sign(steps[start].value! - steps[start - 1].value!) === dir) start--;
      const run = steps.slice(start, end + 1).map((s) => s.point);
      if (run.length < 3) continue;
      const v0 = run[0].valueNum!;
      const vn = run[run.length - 1].valueNum!;
      const change = v0 === 0 ? Math.abs(vn) : Math.abs(vn - v0) / Math.abs(v0);
      if (change < 0.2) continue;
      const direction = dir > 0 ? 'rising' : 'falling';
      const latestOut = outOfRange(run[run.length - 1]) === true;
      const unit = run[0].unit ? ` ${run[0].unit}` : '';
      // The values as printed ("62.0", "1,200"), never re-printed numbers (rule 1).
      const shown = (p: LabPoint, n: number) => p.reading?.valueShown || p.valueText || String(n);
      out.push({
        ruleId: 'lab_trend',
        category: 'trend',
        severity: latestOut ? 'medium' : 'low',
        title: clip(`${run[0].analyte} (${run[0].specimen}) ${direction} across ${run.length} consecutive results: ${shown(run[0], v0)} → ${shown(run[run.length - 1], vn)}${unit}, ${fmt(run[0].date)} to ${fmt(run[run.length - 1].date)}`, 140),
        whyItMatters: `A steady movement in one direction across several results is worth raising, whether or not each value is inside the range${latestOut ? ', and the latest value is outside it' : ''}. Values from different labs can use different methods, so the team should check the series is comparable before reading anything into it.`,
        detail: run.map(labLine).join('\n'),
        evidence: run.map((p) => labEvidence(p, labLine(p))),
        key: [key, direction],
      });
    }
    return out;
  },
};

const RECOMMENDATION_DAYS = 60;

export const recommendationNotActed: CrossrefRule = {
  id: 'recommendation_not_acted',
  category: 'overlooked',
  description: 'A recommendation at least 60 days old with no later record of the test, referral, drug or step it asked for.',
  run(ctx) {
    const out: FindingDraft[] = [];
    for (const f of ctx.facts) {
      if (f.type !== 'recommendation') continue;
      const a = f.attributes;
      if (str(a, 'acted_on') === 'yes') continue;
      const when = f.date ?? f.documentDate;
      if (!precise(when) || daysSince(when, ctx.today) < RECOMMENDATION_DAYS) continue;
      const action = str(a, 'action') || f.statement;
      const target = str(a, 'target');
      const tokens = descriptionTokens(`${target} ${action}`);
      const keywords = keywordsOf(`${target} ${action}`);
      if (!tokens.size && !keywords.size) continue;
      const later = laterEvidence(ctx, { after: when, tokens, keywords, excludeFactId: f.id, excludeDocumentId: f.sourceDocumentId, excludeUnit: unitOf(f), sourceFactId: f.id });
      if (later.length) continue;
      const by = str(a, 'recommended_by');
      const age = daysSince(when, ctx.today);
      out.push({
        ruleId: 'recommendation_not_acted',
        category: 'overlooked',
        severity: age > 180 ? 'medium' : 'low',
        title: clip(`Recommended ${fmt(when)}, no later record of it: ${action}`, 140),
        whyItMatters: 'A recommendation in the records has nothing after it: no result, report, referral, prescription or contact that refers to it. It may have been done and not written down, or it may have been dropped; either way it is worth a question.',
        detail: [
          `${by ? `${by} recommended` : 'Recommended'} on ${fmt(when)} in ${sourceLabel(f)}${statusNote(f)}: "${clip(f.statement, 240)}"`,
          `Checked for later procedures, results, referrals, medications, result documents, communications, encounters and done tasks mentioning: ${[...keywords, ...tokens].slice(0, 8).join(', ')}. None found as of ${ctx.today} (${age} days).`,
        ].join('\n'),
        evidence: [factEvidence(f, 'the recommendation')],
        key: [f.id],
      });
    }
    return out;
  },
};

const FOLLOW_UP_GRACE_DAYS = 14;

export const followUpMissed: CrossrefRule = {
  id: 'follow_up_missed',
  category: 'overlooked',
  description: 'A promised follow-up (in a communication or a document) is past due with no record that it happened.',
  run(ctx) {
    const out: FindingDraft[] = [];
    for (const c of ctx.communications) {
      if (!c.followUpPromised || c.followUpDoneAt || !c.followUpDue) continue;
      // At the stored precision: a promise due "October 2025" is not overdue
      // until November, and its days overdue count from the end of October.
      if (!isPastDue(c.followUpDue, ctx.today)) continue;
      const overdue = daysPastDue(c.followUpDue, ctx.today);
      const owner = c.followUpOwnerPersonId ? (ctx.people.find((p) => p.id === c.followUpOwnerPersonId)?.name ?? null) : null;
      const names = c.participants.map((p) => p.name).join(', ');
      out.push({
        ruleId: 'follow_up_missed',
        category: 'overlooked',
        severity: overdue > 30 ? 'medium' : 'low',
        title: clip(`Promised follow-up overdue since ${fmt(c.followUpDue)}: ${c.followUpPromised}`, 140),
        whyItMatters: 'Someone promised to do something and the due date has passed without it being marked done. Promises that slip are how records, results and referrals go missing, so it is worth chasing or closing.',
        detail: [
          `Promised in "${c.subject}" (${c.direction} ${c.channel}, ${fmt(c.occurredAt)}${names ? `, with ${names}` : ''})${owner ? `, owner ${owner}` : ''}.`,
          `Due ${fmt(c.followUpDue)}; ${overdue} day${overdue === 1 ? '' : 's'} overdue as of ${ctx.today}. Mark it done in Communications if it happened.`,
        ].join('\n'),
        evidence: [{ communicationId: c.id, documentId: c.documentId, note: 'the promise' }],
        key: ['communication', c.id],
      });
    }
    for (const f of ctx.facts) {
      if (f.type !== 'follow_up') continue;
      const a = f.attributes;
      const status = str(a, 'status');
      if (status === 'done' || status === 'missed') continue;
      const dueText = str(a, 'due');
      const due = (dueText ? parsePartialDate(dueText).iso : null) ?? f.date;
      // The grace period starts when the stated period ends (end of the month for "September 2024").
      if (!precise(due) || daysPastDue(due, ctx.today) < FOLLOW_UP_GRACE_DAYS) continue;
      const what = str(a, 'what') || f.statement;
      const tokens = descriptionTokens(what);
      const keywords = keywordsOf(what);
      if (!tokens.size && !keywords.size) continue;
      const after = f.date ?? f.documentDate ?? due;
      const later = laterEvidence(ctx, { after, tokens, keywords, excludeFactId: f.id, excludeDocumentId: f.sourceDocumentId, excludeUnit: unitOf(f), sourceFactId: f.id });
      if (later.length) continue;
      const who = str(a, 'who');
      out.push({
        ruleId: 'follow_up_missed',
        category: 'overlooked',
        severity: daysPastDue(due, ctx.today) > 90 ? 'medium' : 'low',
        title: clip(`Follow-up due ${fmt(due)} with no record it happened: ${what}`, 140),
        whyItMatters: 'A document promised or scheduled this step and the date has passed, but nothing later in the case file refers to it. If it happened, the record of it is missing; if it did not, it may have been forgotten.',
        detail: [
          `${who ? `${who} owns it. ` : ''}Recorded in ${sourceLabel(f)}${statusNote(f)}: "${clip(f.statement, 240)}"`,
          `Checked for later results, procedures, referrals, result documents, communications, encounters and done tasks mentioning: ${[...keywords, ...tokens].slice(0, 8).join(', ')}. None found as of ${ctx.today}.`,
        ].join('\n'),
        evidence: [factEvidence(f, 'the promised step')],
        key: ['fact', f.id],
      });
    }
    return out;
  },
};

const REFERRAL_DAYS = 90;

function peopleMatching(ctx: RuleContext, to: string, specialty: string): CtxPerson[] {
  const toKey = normalizeKey(to);
  const specKey = normalizeKey(specialty);
  const toTokens = descriptionTokens(to);
  return ctx.people.filter((p) => {
    const names = [p.name, ...p.aliases].map(normalizeKey).filter(Boolean);
    if (toKey && names.some((n) => n === toKey || n.includes(toKey) || toKey.includes(n))) return true;
    if (toTokens.size) {
      const nameTokens = descriptionTokens(`${p.name} ${p.aliases.join(' ')}`);
      let shared = 0;
      for (const t of toTokens) if (nameTokens.has(t)) shared++;
      if (shared >= 1 && shared / toTokens.size >= 0.5 && shared >= Math.min(2, toTokens.size)) return true;
    }
    if (specKey && p.specialty && normalizeKey(p.specialty) === specKey) return true;
    if (specKey && p.kind !== 'clinician' && normalizeKey(p.name).includes(specKey)) return true;
    return false;
  });
}

export const referralNotCompleted: CrossrefRule = {
  id: 'referral_not_completed',
  category: 'overlooked',
  description: 'A referral at least 90 days old with no later document, contact, encounter or statement from the referred-to clinician or specialty.',
  run(ctx) {
    const out: FindingDraft[] = [];
    for (const f of ctx.facts) {
      if (f.type !== 'referral') continue;
      const a = f.attributes;
      const status = str(a, 'status');
      if (status === 'completed' || status === 'declined') continue;
      const when = f.date ?? f.documentDate;
      if (!precise(when) || daysSince(when, ctx.today) < REFERRAL_DAYS) continue;
      const to = str(a, 'to');
      const specialty = str(a, 'specialty');
      const matched = peopleMatching(ctx, to, specialty);
      const ids = new Set(matched.map((p) => p.id));
      // Institutions matched by name, plus the institutions of matched clinicians (a letter may carry only the institution).
      const institutionIds = new Set<string>();
      for (const p of matched) {
        if (p.kind === 'institution' || p.kind === 'clinic') institutionIds.add(p.id);
        else if (p.institutionId) institutionIds.add(p.institutionId);
      }
      let seen = false;
      if (ids.size) {
        seen =
          ctx.documents.some((d) => d.id !== f.sourceDocumentId && isAfter(d.documentDate, when) && ((d.authorPersonId && ids.has(d.authorPersonId)) || (d.institutionId && institutionIds.has(d.institutionId)))) ||
          ctx.communications.some((c) => isAfter(c.occurredAt, when) && c.participants.some((p) => ids.has(p.personId))) ||
          ctx.encounters.some((e) => e.status !== 'cancelled' && isAfter(e.occurredAt, when) && e.occurredAt !== null && e.occurredAt <= ctx.today && ((e.clinicianId && ids.has(e.clinicianId)) || (e.institutionId && institutionIds.has(e.institutionId)))) ||
          ctx.facts.some((g) => g.id !== f.id && !sameFactSource(g, f) && isAfter(g.date, when) && g.personId !== null && ids.has(g.personId));
      }
      if (!seen) {
        // Fall back to text: a later statement, diagnosis, recommendation or procedure that names the clinician or specialty.
        const tokens = descriptionTokens(`${to} ${specialty}`);
        const keywords = keywordsOf(`${to} ${specialty}`);
        if (tokens.size || keywords.size) {
          const later = laterEvidence(ctx, { after: when, tokens, keywords, factTypes: ['clinician_statement', 'diagnosis', 'recommendation', 'procedure', 'imaging_result', 'event'], documentCategories: ['clinical_note', 'letter', 'summary', ...RESULT_CATEGORIES], excludeFactId: f.id, excludeDocumentId: f.sourceDocumentId, excludeUnit: unitOf(f), minOverlap: 0.67, sourceFactId: f.id });
          seen = later.length > 0;
        }
      }
      if (seen) continue;
      const age = daysSince(when, ctx.today);
      out.push({
        ruleId: 'referral_not_completed',
        category: 'overlooked',
        severity: age > 180 ? 'medium' : 'low',
        title: clip(`Referral of ${fmt(when)} with no later contact on record: ${to}${specialty ? ` (${specialty})` : ''}`, 140),
        whyItMatters: 'A referral was placed or proposed and nothing later in the case file comes from the clinician or specialty it went to: no letter, visit, message or statement. Referrals that stall quietly are a common reason care drifts, so it is worth asking where it stands.',
        detail: [
          `Recorded in ${sourceLabel(f)}${statusNote(f)}${status ? `, status "${status}"` : ''}: "${clip(f.statement, 240)}"`,
          matched.length ? `Matched people: ${matched.map((p) => p.name).join(', ')}. No later document, communication, encounter or statement from them.` : `No person in the directory matches "${to}"${specialty ? ` or specialty "${specialty}"` : ''}; checked later statements and documents for the name instead.`,
          `${age} days since the referral as of ${ctx.today}.`,
        ].join('\n'),
        evidence: [factEvidence(f, 'the referral')],
        key: [f.id],
      });
    }
    return out;
  },
};

const RESULT_SILENCE_DAYS = 90;
const NARRATIVE_CATEGORIES = new Set(['clinical_note', 'letter', 'summary', 'dossier', 'portal_message', 'call_transcript', 'discharge_summary', 'other']);

/** Dated items whose text mentions one search (phrase + tokens), found once per rule context. */
interface MentionHits {
  documents: Array<{ id: string; date: string }>;
  facts: Array<{ id: string; sourceDocumentId: string | null; date: string }>;
  communications: Array<{ date: string }>;
}

/**
 * Per-context memo for mentionedLater. A rule context is a snapshot, so the
 * padded search text of each narrative document, fact and communication is
 * normalised once, and each distinct search (one per analyte or study, not
 * one per result) scans them once; every result date then only compares
 * dates. Without it, every abnormal result re-normalised the full text of
 * every later document inside the request.
 */
interface MentionIndex {
  documentText: Map<string, string>;
  factText: Map<string, string>;
  communicationText: Map<string, string>;
  hits: Map<string, MentionHits>;
}

const mentionIndexes = new WeakMap<RuleContext, MentionIndex>();

function mentionIndexOf(ctx: RuleContext): MentionIndex {
  let idx = mentionIndexes.get(ctx);
  if (!idx) {
    idx = { documentText: new Map(), factText: new Map(), communicationText: new Map(), hits: new Map() };
    mentionIndexes.set(ctx, idx);
  }
  return idx;
}

function cachedPad(cache: Map<string, string>, id: string, text: () => string): string {
  let padded = cache.get(id);
  if (padded === undefined) {
    padded = pad(text());
    cache.set(id, padded);
  }
  return padded;
}

function mentionHits(ctx: RuleContext, tokens: Set<string>, phrase: string): MentionHits {
  const idx = mentionIndexOf(ctx);
  const key = `${phrase}\u001f${[...tokens].sort().join(' ')}`;
  const hit = idx.hits.get(key);
  if (hit) return hit;
  const found = (padded: string): boolean => {
    if (phrase && padded.includes(` ${phrase} `)) return true;
    if (!tokens.size) return false;
    for (const t of tokens) if (!hasWord(padded, t)) return false;
    return true;
  };
  const hits: MentionHits = { documents: [], facts: [], communications: [] };
  for (const d of ctx.documents) {
    if (!d.documentDate || !NARRATIVE_CATEGORIES.has(d.category)) continue;
    if (found(cachedPad(idx.documentText, d.id, () => `${d.title} ${ctx.pageText(d.id)}`))) hits.documents.push({ id: d.id, date: d.documentDate });
  }
  for (const f of ctx.facts) {
    if (!f.date) continue;
    if (found(cachedPad(idx.factText, f.id, () => factText(f)))) hits.facts.push({ id: f.id, sourceDocumentId: f.sourceDocumentId, date: f.date });
  }
  for (const c of ctx.communications) {
    if (!c.occurredAt) continue;
    if (found(cachedPad(idx.communicationText, c.id, () => [c.subject, c.summary, c.outcome, c.body, ...c.topics].filter(Boolean).join(' ')))) hits.communications.push({ date: c.occurredAt });
  }
  idx.hits.set(key, hits);
  return hits;
}

function mentionedLater(ctx: RuleContext, after: string, tokens: Set<string>, phrase: string, excludeDocumentId: string | null, excludeFactId: string | null): boolean {
  if (!tokens.size && !phrase) return true; // nothing to look for; do not raise
  const hits = mentionHits(ctx, tokens, phrase);
  if (hits.documents.some((d) => d.id !== excludeDocumentId && isAfter(d.date, after))) return true;
  // The result's own passage is left out (a later encounter of the same export does count, 2026-10-07).
  const own = excludeFactId ? ctx.factById.get(excludeFactId) : undefined;
  const ownUnit: SourceRef = own ? unitOf(own) : { documentId: excludeDocumentId };
  if (hits.facts.some((f) => f.id !== excludeFactId && !(ownUnit.documentId ? sameSource(unitOf(f), ownUnit) : false) && isAfter(f.date, after))) return true;
  return hits.communications.some((c) => isAfter(c.date, after));
}

export const resultNeverMentionedAgain: CrossrefRule = {
  id: 'result_never_mentioned_again',
  category: 'overlooked',
  description: 'An abnormal lab result or an imaging impression at least 90 days old that no later note, letter, message or statement refers to.',
  run(ctx) {
    const out: FindingDraft[] = [];
    for (const [, points] of labSeries(ctx)) {
      for (const p of points) {
        if (outOfRange(p) !== true || !precise(p.date) || daysSince(p.date, ctx.today) < RESULT_SILENCE_DAYS) continue;
        const tokens = descriptionTokens(p.analyte);
        const phrase = normalizeKey(p.analyte);
        if (mentionedLater(ctx, p.date, tokens, phrase, p.documentId, p.factId)) continue;
        // "Critical" only when the report printed a critical mark (HH, LL, "critical"); a bare "C" is the report's own
        // letter (critical or corrected), said as printed (2026-10, amendment C5).
        const what = criticalMark(p) ? 'Critical result' : (p.flag ?? '').toUpperCase() === 'C' ? 'Result flagged C' : 'Abnormal result';
        out.push({
          ruleId: 'result_never_mentioned_again',
          category: 'overlooked',
          severity: severeFlag(p) ? 'high' : 'medium',
          title: clip(`${what} not referred to in any later record: ${p.analyte} ${labValue(p)} (${fmt(p.date)})`, 140),
          whyItMatters: 'This value was flagged or outside its range, and nothing written afterwards in the case file mentions the test again. It may have been addressed in a conversation that was never recorded, or it may have been overlooked; the team can say which.',
          detail: [labLine(p), `Checked notes, letters, messages, later facts and communications after ${fmt(p.date)} for "${p.analyte}". No mention found as of ${ctx.today}.`].join('\n'),
          evidence: [labEvidence(p, 'the result')],
          key: [p.labResultId ? `lab:${p.labResultId}` : `fact:${p.factId}`],
        });
      }
    }
    for (const f of ctx.facts) {
      if (f.type !== 'imaging_result' || !precise(f.date) || daysSince(f.date, ctx.today) < RESULT_SILENCE_DAYS) continue;
      const a = f.attributes;
      const impression = str(a, 'impression') || str(a, 'finding');
      if (!impression) continue;
      const modality = str(a, 'modality');
      const bodyPart = str(a, 'body_part');
      const tokens = descriptionTokens(`${modality} ${bodyPart}`);
      if (!tokens.size) continue;
      if (mentionedLater(ctx, f.date, tokens, '', f.sourceDocumentId, f.id)) continue;
      out.push({
        ruleId: 'result_never_mentioned_again',
        category: 'overlooked',
        severity: 'medium',
        title: clip(`Imaging impression not referred to in any later record: ${modality} ${bodyPart} (${fmt(f.date)})`, 140),
        whyItMatters: 'An imaging report with a stated impression has nothing after it in the case file that mentions the study. Later notes normally refer back to imaging; silence may mean the report never reached the people who needed it.',
        detail: [`${sourceLabel(f)}${statusNote(f)}: "${clip(f.statement, 240)}"`, `Impression as recorded: "${clip(impression, 240)}"`, `Checked notes, letters, messages, later facts and communications after ${fmt(f.date)} for "${modality} ${bodyPart}". No mention found as of ${ctx.today}.`].join('\n'),
        evidence: [factEvidence(f, 'the study')],
        key: [`fact:${f.id}`],
      });
    }
    return out;
  },
};

const EXPOSURE_WINDOW_DAYS = 14;

interface Exposure {
  key: string;
  label: string;
  date: string;
  evidence: DraftEvidence;
  source: string;
}

function exposures(ctx: RuleContext): Exposure[] {
  const out: Exposure[] = [];
  const seenMedEvent = new Set<string>();
  for (const f of ctx.facts) {
    if (f.type === 'medication') {
      const s = str(f.attributes, 'start_date');
      const date = (s ? parsePartialDate(s).iso : null) ?? f.date;
      if (!precise(date)) continue;
      const name = str(f.attributes, 'name') || 'a medication';
      out.push({ key: `fact:${f.id}`, label: `${name} started`, date, evidence: factEvidence(f, 'the exposure'), source: `${sourceLabel(f)}${statusNote(f)}` });
      seenMedEvent.add(`${normalizeKey(name)}|${toDay(date)}`);
    } else if (f.type === 'procedure' && precise(f.date)) {
      const name = str(f.attributes, 'name') || 'a procedure';
      out.push({ key: `fact:${f.id}`, label: name, date: f.date, evidence: factEvidence(f, 'the exposure'), source: `${sourceLabel(f)}${statusNote(f)}` });
    }
  }
  for (const m of ctx.medications) {
    for (const e of m.events) {
      if (!['start', 'resume', 'dose_change'].includes(e.kind) || !precise(e.date)) continue;
      const dedupe = `${normalizeKey(m.name)}|${toDay(e.date)}`;
      if (seenMedEvent.has(dedupe)) continue;
      seenMedEvent.add(dedupe);
      const fact = e.sourceFactId ? ctx.factById.get(e.sourceFactId) : undefined;
      out.push({
        key: `medication_event:${e.id}`,
        label: `${m.name} ${e.kind.replace(/_/g, ' ')}${e.dose ? ` (${e.dose})` : ''}`,
        date: e.date,
        evidence: fact ? factEvidence(fact, 'the exposure') : { ref: { kind: 'medication_event', id: e.id }, note: `${m.name} ${e.kind.replace(/_/g, ' ')} on ${e.date}` },
        source: 'the medications ledger',
      });
    }
    if (!m.events.some((e) => e.kind === 'start') && precise(m.startDate) && !seenMedEvent.has(`${normalizeKey(m.name)}|${toDay(m.startDate)}`)) {
      const fact = m.sourceFactId ? ctx.factById.get(m.sourceFactId) : undefined;
      out.push({ key: `medication:${m.id}`, label: `${m.name} started`, date: m.startDate, evidence: fact ? factEvidence(fact, 'the exposure') : { ref: { kind: 'medication', id: m.id }, note: `${m.name} start ${m.startDate}` }, source: 'the medications ledger' });
    }
  }
  return out;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export const exposureSymptomTiming: CrossrefRule = {
  id: 'exposure_symptom_timing',
  category: 'correlation',
  description: 'A new or worsening symptom, or a rise in diary scores, within 14 days after a medication start, dose change or procedure. Correlation only.',
  run(ctx) {
    const out: FindingDraft[] = [];
    const exps = exposures(ctx);
    if (!exps.length) return out;
    const symptomFacts = ctx.facts.filter((f) => f.type === 'symptom');
    for (const x of exps) {
      const xDay = toDay(x.date);
      for (const s of symptomFacts) {
        const course = str(s.attributes, 'course');
        if (course !== 'new' && course !== 'worsening') continue;
        const onsetText = str(s.attributes, 'onset_date');
        const onset = (onsetText ? parsePartialDate(onsetText).iso : null) ?? s.date;
        if (!precise(onset) || onset.length < 10) continue;
        const delta = daysBetween(xDay, onset);
        if (delta < 0 || delta > EXPOSURE_WINDOW_DAYS) continue;
        const name = str(s.attributes, 'name') || 'a symptom';
        out.push({
          ruleId: 'exposure_symptom_timing',
          category: 'correlation',
          severity: 'info',
          title: clip(`Correlation only: ${name} recorded as ${course} ${delta} day${delta === 1 ? '' : 's'} after ${x.label}`, 140),
          whyItMatters: 'A symptom change inside a two-week window after a new exposure is a timing observation, not a causal claim. It is worth mentioning to the clinical team so they can decide whether it matters.',
          detail: [`Exposure: ${x.label} on ${fmt(x.date)} (${x.source}).`, `Symptom: "${clip(s.statement, 240)}" dated ${fmt(onset)} in ${sourceLabel(s)}${statusNote(s)}.`].join('\n'),
          evidence: [x.evidence, factEvidence(s, 'the symptom')],
          key: [x.key, `fact:${s.id}`],
        });
      }
      if (x.date.length < 10) continue;
      for (const def of ctx.symptomDefinitions) {
        const before: number[] = [];
        const after: number[] = [];
        for (const e of ctx.symptomEntries) {
          if (e.symptomId !== def.id) continue;
          const delta = daysBetween(xDay, e.date);
          if (delta >= -EXPOSURE_WINDOW_DAYS && delta <= -1) before.push(e.score);
          else if (delta >= 1 && delta <= EXPOSURE_WINDOW_DAYS) after.push(e.score);
        }
        if (before.length < 2 || after.length < 2) continue;
        const mb = mean(before);
        const ma = mean(after);
        if (ma - mb < 2) continue;
        out.push({
          ruleId: 'exposure_symptom_timing',
          category: 'correlation',
          severity: 'info',
          title: clip(`Correlation only: ${def.name} diary scores rose after ${x.label} (mean ${mb.toFixed(1)} → ${ma.toFixed(1)})`, 140),
          whyItMatters: 'Diary scores for this symptom were higher in the two weeks after the exposure than in the two weeks before. That is a timing observation from the symptom log, not a causal claim; the team can weigh it with everything else they know.',
          detail: [`Exposure: ${x.label} on ${fmt(x.date)} (${x.source}).`, `${def.name}: ${before.length} entries before (mean ${mb.toFixed(1)}), ${after.length} entries in the 14 days after (mean ${ma.toFixed(1)}).`].join('\n'),
          evidence: [x.evidence, { ref: { kind: 'symptom', id: def.id }, note: `${def.name} diary entries ${fmt(xDay)} ± 14 days` }],
          key: [x.key, `symptom:${def.id}`],
        });
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Patient precedence (slice Q): for SUBJECTIVE matters only, the patient's own
// statement outranks a clinician's or a compiler's. Objective facts (lab
// values, vitals, procedures, doses on record) are ground truth and are never
// overridden by anyone. The override lives on the outranked fact and is
// reversible by hand; the repository hides nothing.
// ---------------------------------------------------------------------------

type Stance = 'positive' | 'negative' | 'unknown';

const NEGATIVE_RECORD = /\b(not|never|no|wasn'?t|weren'?t|isn'?t|hasn'?t|haven'?t|without)\b[^.]{0,40}\b(received|sent|on file|available|obtained|provided|forwarded|released|exists?|held)\b|\b(missing|lost|absent|unavailable|withheld|denied)\b/i;
const POSITIVE_RECORD = /\b(received|on file|available|obtained|provided|forwarded|released|reviewed|attached|enclosed|held)\b/i;

/** The subject two facts must share to be compared, per type; null when the type takes no stance. */
function precedenceSubject(f: CtxFact): string | null {
  const a = f.attributes;
  switch (f.type) {
    case 'medication': {
      const name = normalizeKey(str(a, 'name'));
      return name ? `drug|${name}` : null;
    }
    case 'allergy_intolerance': {
      // Never grouped with medication facts: "it gave me relief" is a benefit, not a tolerance, and must not
      // outrank a recorded allergy or intolerance (nor the reverse). Every intolerance takes the same stance,
      // so within its own group nothing contradicts and a recorded allergy is never overridden.
      const name = normalizeKey(str(a, 'substance'));
      return name ? `intolerance|${name}` : null;
    }
    case 'diagnosis': {
      const name = normalizeKey(str(a, 'name'));
      return name ? `diagnosis|${name}` : null;
    }
    case 'symptom': {
      const name = normalizeKey(str(a, 'name'));
      return name ? `symptom|${name}` : null;
    }
    case 'record_reference':
      return hasSubject(f.subjectKey) ? `record|${f.subjectKey}` : null;
    default:
      return null;
  }
}

/** What the fact asserts about its subject: positive (helped, tolerated, confirmed, improving, on file) or negative (no effect, not tolerated, ruled out, worsening, missing). */
export function precedenceStance(f: CtxFact): Stance {
  const a = f.attributes;
  switch (f.type) {
    case 'medication':
      return effectPolarity(str(a, 'effect'));
    case 'allergy_intolerance':
      return 'negative';
    case 'diagnosis': {
      const c = str(a, 'certainty');
      if (c === 'confirmed' || c === 'probable') return 'positive';
      if (c === 'ruled_out') return 'negative';
      return 'unknown';
    }
    case 'symptom': {
      const c = str(a, 'course');
      if (c === 'improving' || c === 'resolved') return 'positive';
      if (c === 'worsening' || c === 'new') return 'negative';
      return 'unknown';
    }
    case 'record_reference': {
      const text = `${f.statement} ${str(a, 'description')}`;
      if (NEGATIVE_RECORD.test(text)) return 'negative';
      if (POSITIVE_RECORD.test(text)) return 'positive';
      return 'unknown';
    }
    default:
      return 'unknown';
  }
}

function stanceWords(f: CtxFact, s: Stance): string {
  switch (f.type) {
    case 'medication':
    case 'allergy_intolerance':
      return s === 'positive' ? 'a benefit or good tolerance' : 'no benefit or poor tolerance';
    case 'diagnosis':
      return s === 'positive' ? 'the diagnosis as confirmed or probable' : 'the diagnosis as ruled out';
    case 'symptom':
      return s === 'positive' ? 'the symptom as improving or resolved' : 'the symptom as new or worsening';
    case 'record_reference':
      return s === 'positive' ? 'the record as on file' : 'the record as missing';
    default:
      return s;
  }
}

/** Whose voice a fact is in, falling back to the document's tier for rows stored as unknown. */
function voiceOf(f: CtxFact, ctx: RuleContext): 'patient' | 'clinician' | 'compiler' | 'unknown' {
  const v = f.assertedBy ?? 'unknown';
  if (v === 'patient' || v === 'clinician' || v === 'compiler') return v;
  // Trust follows the passage (2026-10-07): a fact read from the patient's own message or questionnaire is his.
  const seg = segmentLinkOf(f.attributes);
  if (seg?.voice === 'patient' || seg?.tier === 'patient') return 'patient';
  const tier = f.sourceDocumentId ? ctx.documentById.get(f.sourceDocumentId)?.sourceTier : undefined;
  if (tier === 'patient') return 'patient';
  if (tier === 'primary' || tier === 'external') return 'clinician';
  if (tier === 'compilation') return 'compiler';
  return 'unknown';
}

/** A statement the user has checked: confirmed, or entered by hand. */
function userChecked(f: CtxFact): boolean {
  return f.status === 'confirmed' || f.origin === 'manual';
}

function subjectLabel(f: CtxFact): string {
  const a = f.attributes;
  return str(a, 'name') || str(a, 'substance') || str(a, 'description') || f.statement.slice(0, 60);
}

/**
 * Decide the overrides: in every subject group, a patient-asserted subjective
 * fact with a stance outranks each clinician- or compiler-asserted subjective
 * fact of the opposite stance from a different source. A confirmed or
 * hand-entered statement wins over an unchecked one, then the most recent;
 * an unchecked statement never outranks a confirmed assessment. Facts the
 * user decided by hand keep their state. Pure; nothing is written here.
 */
export function computePatientPrecedence(ctx: RuleContext): PrecedenceDecision[] {
  const subjective = ctx.facts.filter((f) => effectiveObjectivity({ type: f.type, objectivity: f.objectivity, attributes: f.attributes }) === 'subjective');
  const out: PrecedenceDecision[] = [];
  for (const [, list] of groupBy(subjective, precedenceSubject)) {
    const patient = list.filter((f) => voiceOf(f, ctx) === 'patient' && precedenceStance(f) !== 'unknown');
    if (!patient.length) continue;
    for (const target of list) {
      const voice = voiceOf(target, ctx);
      if (voice !== 'clinician' && voice !== 'compiler') continue;
      const ts = precedenceStance(target);
      if (ts === 'unknown') continue;
      if (target.overrideManual) {
        // The user decided: keep an override they set (so the finding stays), never re-create one they cleared.
        const by = target.overriddenByFactId ? ctx.factById.get(target.overriddenByFactId) : undefined;
        if (by) out.push({ targetId: target.id, byFactId: by.id, reason: target.overrideReason ?? 'Set by hand.', subject: subjectLabel(target) });
        continue;
      }
      // A statement the user has not checked (an unverified extraction) never outranks an assessment the user
      // confirmed: the model's attribution of a voice must not beat the user's verdict. Checked statements
      // (confirmed, or entered by hand) win first, then the most recent.
      const contradicting = patient
        .filter((p) => p.id !== target.id && precedenceStance(p) !== ts && !sameFactSource(p, target))
        .filter((p) => target.status !== 'confirmed' || userChecked(p))
        .sort((a, b) => Number(userChecked(b)) - Number(userChecked(a)) || dateSortKey(b.date).localeCompare(dateSortKey(a.date)));
      const p = contradicting[0];
      if (!p) continue;
      const reason = clip(`The patient states ${stanceWords(p, precedenceStance(p))} (${fmt(p.date)}: "${clip(p.statement, 90)}"); ${target.documentTitle ? `"${target.documentTitle}"` : 'the record'} gives ${stanceWords(target, ts)}.`, 480);
      out.push({ targetId: target.id, byFactId: p.id, reason, subject: subjectLabel(target) });
    }
  }
  return out;
}

export const patientPrecedence: CrossrefRule = {
  id: 'patient_precedence',
  category: 'discrepancy',
  description: "The patient's own statement on a subjective matter (effect, tolerance, diagnosis certainty, symptom course, a missing record) contradicts a clinician's or a compilation's; the patient's version takes precedence in the consult and the record is marked, never hidden.",
  run(ctx) {
    const decisions = computePatientPrecedence(ctx);
    ctx.lastPrecedenceDecisions = decisions;
    const scoped = Boolean(ctx.scope.documentIds?.length || ctx.scope.from || ctx.scope.to);
    ctx.writeOverrides?.(decisions, { clearStale: !scoped });
    // Later rules read the patient's version: mark the context the way the database now reads.
    const decided = new Map(decisions.map((d) => [d.targetId, d]));
    for (const f of ctx.facts) {
      const want = decided.get(f.id);
      if (want) {
        f.overriddenByFactId = want.byFactId;
        f.overrideReason = want.reason;
      } else if (!scoped && !f.overrideManual && f.overriddenByFactId) {
        f.overriddenByFactId = null;
        f.overrideReason = null;
      }
    }
    const out: FindingDraft[] = [];
    for (const dcsn of decisions) {
      const target = ctx.factById.get(dcsn.targetId);
      const by = ctx.factById.get(dcsn.byFactId);
      if (!target || !by) continue;
      const source = target.documentTitle ?? (target.origin === 'manual' ? 'a manual entry' : 'an entry without a document');
      out.push({
        ruleId: 'patient_precedence',
        category: 'discrepancy',
        severity: 'info',
        title: clip(`Your assessment differs from ${source}`, 140),
        whyItMatters: `On ${dcsn.subject}, your own statement and this record disagree. Clinicians and summaries can only report what they saw or were told; for how a treatment felt, how a symptom ran, or what was never received, your account is the primary source. The consult reasons with your version and mentions the record's; the record itself is kept exactly as written.`,
        detail: [`Your statement (${fmt(by.date)}${by.documentTitle ? `, ${by.documentTitle}` : ''}): "${clip(by.statement, 240)}"`, `${source} (${fmt(target.date)})${statusNote(target)}: "${clip(target.statement, 240)}"`, dcsn.reason].join('\n'),
        evidence: [factEvidence(by, 'your statement, which takes precedence'), factEvidence(target, 'the record as written')],
        key: [target.id, by.id],
      });
    }
    return out;
  },
};

/**
 * Rule 10 (the user's lab rules, 2026-10): one document gives two values of one test, sample and day that differ like a
 * typing error. The drafts come from services/lab-rules.ts, the one draft builder runLabChecks uses too (amendment G1),
 * over the lab checks' one loader (ctx.labCheckRecords); a context built by hand has none and drafts nothing.
 */
export const labSameSourceConflict: CrossrefRule = {
  id: 'lab_same_source_conflict',
  category: 'discrepancy',
  description: 'One document gives two values for one test, sample and day that differ like a typing error: a decimal point (0.08 and 0.8), a dropped sign ("<3" and "3") or two swapped digits (62 and 26).',
  run: (ctx) => labRuleDrafts(ctx, 'conflict'),
};

/** Rule 12: a summary's or a note's own judgement or limit differs from what the lab report printed. One finding per (that document, the lab report). */
export const labClaimDiffers: CrossrefRule = {
  id: 'lab_claim_differs',
  category: 'discrepancy',
  description: "A summary, a patient note or an outside letter judges a lab value, or names a limit, otherwise than the lab report printed (one finding per document and lab report).",
  run: (ctx) => labRuleDrafts(ctx, 'claim'),
};

/** A printed index (albumin index, IgG index) differs from the one the patient computed for the same collection (2026-10-09; services/lab-compute-check.ts). */
export const labComputedDiffers: CrossrefRule = {
  id: 'lab_computed_differs',
  category: 'discrepancy',
  description: "The lab prints an index for the same collection as one the patient computed from the printed inputs, and the two differ at the lab's precision.",
  run: (ctx) => labRuleDrafts(ctx, 'computed'),
};

/** The comparison and trend rules (the Phase 3 set, in contract order, then the lab checks of 2026-10). */
export const CROSSREF_RULES: CrossrefRule[] = [
  dateDisagreement,
  doseDisagreement,
  effectDisagreement,
  missingRecord,
  labNeverInRange,
  labTrend,
  recommendationNotActed,
  followUpMissed,
  referralNotCompleted,
  resultNeverMentionedAgain,
  exposureSymptomTiming,
  labSameSourceConflict,
  labClaimDiffers,
  labComputedDiffers,
];

/** Every rule a full run executes: precedence first, so the other rules read the patient's version of subjective matters. */
export const ALL_RULES: CrossrefRule[] = [patientPrecedence, ...CROSSREF_RULES];

export const CROSSREF_RULE_IDS = ALL_RULES.map((r) => r.id);

/** Run every rule over one context. Drafts are returned in rule order. */
export function runAllRules(ctx: RuleContext, rules: CrossrefRule[] = ALL_RULES): FindingDraft[] {
  const out: FindingDraft[] = [];
  for (const r of rules) out.push(...r.run(ctx));
  return out;
}
