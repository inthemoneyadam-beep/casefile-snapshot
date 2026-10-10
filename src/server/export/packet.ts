/**
 * Packet export: assemble a printable case packet (cover, how-to-read note,
 * emergency card, document index and records inventory, timeline, facts by
 * type with [D# p.N] references, findings with evidence, lab tables with
 * static charts, medications) from the ledger, print it to PDF with the
 * browser already on the machine, append the selected originals, and store
 * the result encrypted like any other file.
 *
 * Reads the medication, intolerance and settings tables directly; the
 * emergency-card diagnoses come from the medications service's
 * confirmedDiagnoses() so the packet and the printable card agree. Every
 * ledger read drops rows whose source document was soft-deleted. The browser
 * step and file I/O are injectable (`ExportDeps`) so the whole job runs in
 * tests.
 */
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { getFile, putFile } from '../files/store';
import { cancelJob, enqueueJob, type JobContext, type JobRow } from '../jobs/queue';
import { getSetting } from '../services/settings';
import { listTimeline } from '../services/timeline';
import { inferGaps, listRecords } from '../services/records';
import { confirmedDiagnoses } from '../services/medications';
import { careTeamSummary } from '../services/care-team';
import { badRequest, notFound, zodIssues } from '../util/errors';
import { newId, normalizeKey, nowIso, parseJson } from '../util/ids';
import { dateSortKey, type DatePrecision, type PartialDate } from '../../shared/dates';
import {
  analyteLabel,
  assumedLabRowIds,
  defaultSpecimenFor,
  labDocumentMeta,
  labRowEditedFrom,
  normalizeAnalyte,
  partLabReading,
  rangeSignature,
  readingView,
  readLabValues,
  setAsideLabParts,
  loadLabEntries,
  type LabValueRead,
} from '../services/labs';
import { COMPUTED_SOURCE, readComputedRecord, typedRangeLabel } from '../../shared/labcompute';
import { typedRangeFor } from '../services/lab-computed-ranges';
import { readingForFact, readingForRow, type CiteLite, type FactLite } from '../services/lab-reading';
import { unitKey as sharedUnitKey, type LabReading, type LabReadingView } from '../../shared/labvalues';
import { chartSpec, type ChartSpec } from '../../shared/chart';
import { FACT_TYPES } from '../../shared/enums';
import { renderChartSvg } from './chart-svg';
import { renderPacketHtml, type RenderMode } from './html';
import { appendOriginals, appendixPageCount, findBrowserExecutable, htmlToPdfWithBrowser, pdfPageCountOf, type AppendItem } from './pdf';
import {
  packetConfig,
  type AppendixKind,
  type EmergencyCardData,
  type PacketConfig,
  type PacketContact,
  type PacketData,
  type PacketDocument,
  type PacketFact,
  type PacketFinding,
  type PacketGap,
  type PacketIntolerance,
  type PacketLabRow,
  type PacketLabSeries,
  type PacketMedication,
  type PacketPatient,
  type PacketPatientNote,
  type PacketRef,
  type PacketResult,
  type StoredPacketConfig,
} from './types';

export { packetConfig } from './types';
export type { PacketConfig, PacketData, PacketResult } from './types';

export type PacketRow = typeof schema.exportPackets.$inferSelect;

export interface PacketListItem extends PacketRow {
  config: PacketConfig;
  result: PacketResult | null;
  note: string | null;
  recipient: string | null;
  format: 'pdf' | 'html' | null;
  documentCount: number;
}

export interface PacketDetail extends PacketListItem {
  job: Pick<JobRow, 'id' | 'status' | 'progress' | 'progressText' | 'error' | 'startedAt' | 'finishedAt'> | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chunk<T>(list: T[], size = 400): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function parseConfig(raw: unknown): PacketConfig {
  const r = packetConfig.safeParse(raw);
  if (!r.success) throw badRequest(zodIssues(r.error));
  return r.data;
}

function readStored(row: PacketRow): StoredPacketConfig {
  const parsed = parseJson<Partial<StoredPacketConfig> & Record<string, unknown>>(row.configJson, {});
  if (parsed && typeof parsed === 'object' && parsed.config && typeof parsed.config === 'object') {
    const cfg = packetConfig.safeParse(parsed.config);
    return { config: cfg.success ? cfg.data : (parsed.config as PacketConfig), result: (parsed.result as PacketResult | null | undefined) ?? null, note: (parsed.note as string | null | undefined) ?? null };
  }
  // Legacy shape: the config itself.
  const cfg = packetConfig.safeParse({ title: row.title, ...parsed });
  return { config: cfg.success ? cfg.data : { title: row.title, documentIds: [], includeEmergencyCard: true, includeRecordsIndex: true, includeMedications: true, includeLabs: [], factsFromPacketDocumentsOnly: false, includeCareTeam: false }, result: null, note: null };
}

function appendixKindFor(kind: string): AppendixKind {
  if (kind === 'pdf') return 'pdf';
  if (kind === 'image') return 'image';
  return 'text';
}

function peopleNames(ids: Iterable<string | null | undefined>): Map<string, string> {
  const want = [...new Set([...ids].filter((x): x is string => Boolean(x)))];
  const out = new Map<string, string>();
  for (const part of chunk(want)) {
    for (const p of db().select({ id: schema.people.id, name: schema.people.name }).from(schema.people).where(inArray(schema.people.id, part)).all()) out.set(p.id, p.name);
  }
  return out;
}

function patientFromSettings(): PacketPatient {
  const s = (k: 'patient.name' | 'patient.dob' | 'patient.bloodType' | 'patient.emergencyContacts' | 'patient.summary') => String(getSetting(k) ?? '').trim();
  return { name: s('patient.name'), dob: s('patient.dob'), bloodType: s('patient.bloodType'), emergencyContacts: s('patient.emergencyContacts'), summary: s('patient.summary') };
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

function loadDocuments(ids: string[]): { documents: PacketDocument[]; docIndex: Map<string, number>; missing: string[] } {
  const d = db();
  const rows = new Map<string, typeof schema.documents.$inferSelect>();
  for (const part of chunk(ids)) {
    for (const r of d.select().from(schema.documents).where(and(inArray(schema.documents.id, part), isNull(schema.documents.deletedAt))).all()) rows.set(r.id, r);
  }
  const names = peopleNames(
    [...rows.values()].flatMap((r) => [r.institutionId, r.authorPersonId]),
  );
  const documents: PacketDocument[] = [];
  const docIndex = new Map<string, number>();
  const missing: string[] = [];
  for (const id of ids) {
    const r = rows.get(id);
    if (!r) {
      missing.push(id);
      continue;
    }
    if (docIndex.has(id)) continue;
    const n = documents.length + 1;
    docIndex.set(id, n);
    const appendix = appendixKindFor(r.kind);
    const pages =
      appendix === 'text'
        ? d
            .select({ pageNumber: schema.documentPages.pageNumber, text: schema.documentPages.text })
            .from(schema.documentPages)
            .where(eq(schema.documentPages.documentId, id))
            .orderBy(asc(schema.documentPages.pageNumber))
            .all()
        : [];
    documents.push({
      n,
      id,
      title: r.title,
      filename: r.filename,
      kind: r.kind,
      mime: r.mime,
      category: r.category,
      documentDate: r.documentDate,
      documentDatePrecision: r.documentDatePrecision,
      documentDateText: r.documentDateText,
      institutionName: r.institutionId ? (names.get(r.institutionId) ?? null) : null,
      authorName: r.authorPersonId ? (names.get(r.authorPersonId) ?? null) : null,
      pageCount: r.pageCount,
      sizeBytes: r.sizeBytes,
      storageKey: r.storageKey,
      notes: r.notes,
      appendix,
      pages,
      appendixPages: null,
      packetPage: null,
    });
  }
  return { documents, docIndex, missing };
}

// ---------------------------------------------------------------------------
// Facts and references
// ---------------------------------------------------------------------------

type CitationRow = typeof schema.citations.$inferSelect;

function refFromCitation(c: CitationRow, docIndex: Map<string, number>, docTitles: Map<string, string>): PacketRef {
  return {
    docN: docIndex.get(c.documentId) ?? null,
    documentId: c.documentId,
    documentTitle: docTitles.get(c.documentId) ?? null,
    pageNumber: c.pageNumber,
    quote: c.quote,
    verified: Boolean(c.verified),
    citationId: c.id,
  };
}

function docRef(documentId: string, pageNumber: number | null, docIndex: Map<string, number>, docTitles: Map<string, string>): PacketRef {
  return { docN: docIndex.get(documentId) ?? null, documentId, documentTitle: docTitles.get(documentId) ?? null, pageNumber, quote: null, verified: null, citationId: null };
}

function titlesFor(documentIds: Iterable<string>): Map<string, string> {
  const want = [...new Set(documentIds)];
  const out = new Map<string, string>();
  for (const part of chunk(want)) {
    for (const r of db().select({ id: schema.documents.id, title: schema.documents.title }).from(schema.documents).where(inArray(schema.documents.id, part)).all()) out.set(r.id, r.title);
  }
  return out;
}

function citationsForFacts(factIds: string[]): Map<string, CitationRow[]> {
  const out = new Map<string, CitationRow[]>();
  for (const part of chunk(factIds)) {
    for (const c of db().select().from(schema.citations).where(inArray(schema.citations.factId, part)).orderBy(desc(schema.citations.verified), asc(schema.citations.pageNumber), asc(schema.citations.createdAt)).all()) {
      if (!c.factId) continue;
      const list = out.get(c.factId) ?? [];
      list.push(c);
      out.set(c.factId, list);
    }
  }
  return out;
}

type FactRow = typeof schema.facts.$inferSelect;

/** Live facts (not deleted, source document not deleted) for a scope. */
function selectFacts(scope: PacketConfig['factIds'], packetDocumentIds: Set<string> | null): FactRow[] {
  if (!scope || scope === 'none') return [];
  const d = db();
  const live = d
    .select({ f: schema.facts, docDeleted: schema.documents.deletedAt, docId: schema.documents.id })
    .from(schema.facts)
    .leftJoin(schema.documents, eq(schema.documents.id, schema.facts.sourceDocumentId));
  let rows: Array<{ f: FactRow; docDeleted: string | null; docId: string | null }>;
  if (Array.isArray(scope)) {
    rows = [];
    for (const part of chunk(scope)) rows.push(...live.where(and(inArray(schema.facts.id, part), isNull(schema.facts.deletedAt))).all());
    const order = new Map(scope.map((id, i) => [id, i]));
    rows.sort((a, b) => (order.get(a.f.id) ?? 0) - (order.get(b.f.id) ?? 0));
  } else if (scope === 'confirmed') {
    rows = live.where(and(isNull(schema.facts.deletedAt), eq(schema.facts.status, 'confirmed'))).all();
  } else {
    rows = live.where(and(isNull(schema.facts.deletedAt), sql`${schema.facts.status} != 'superseded'`)).all();
  }
  return rows
    .filter((r) => !(r.f.sourceDocumentId && (r.docDeleted || !r.docId)))
    .filter((r) => !packetDocumentIds || (r.f.sourceDocumentId && packetDocumentIds.has(r.f.sourceDocumentId)))
    .map((r) => r.f);
}

type OverrideFields = Pick<FactRow, 'id' | 'overriddenByFactId' | 'overrideReason'>;

/**
 * The "Patient's notes on this" line for each overridden fact, keyed by the
 * overridden fact's id. Only a live overriding statement counts (not deleted,
 * not disputed or superseded, source document not deleted), the same rule
 * the precedence engine uses to clear stale overrides.
 */
function patientNotesFor(rows: OverrideFields[], docIndex: Map<string, number>): Map<string, PacketPatientNote> {
  const out = new Map<string, PacketPatientNote>();
  const byIds = [...new Set(rows.map((r) => r.overriddenByFactId).filter((x): x is string => Boolean(x)))];
  if (!byIds.length) return out;
  const live = new Map<string, FactRow>();
  for (const part of chunk(byIds)) {
    for (const x of db()
      .select({ f: schema.facts, docId: schema.documents.id, docDeleted: schema.documents.deletedAt })
      .from(schema.facts)
      .leftJoin(schema.documents, eq(schema.documents.id, schema.facts.sourceDocumentId))
      .where(and(inArray(schema.facts.id, part), isNull(schema.facts.deletedAt), sql`${schema.facts.status} not in ('disputed', 'superseded')`))
      .all()) {
      if (x.f.sourceDocumentId && (!x.docId || x.docDeleted)) continue;
      live.set(x.f.id, x.f);
    }
  }
  if (!live.size) return out;
  const cites = citationsForFacts([...live.keys()]);
  const docIds = new Set<string>();
  for (const list of cites.values()) for (const c of list) docIds.add(c.documentId);
  const titles = titlesFor(docIds);
  for (const r of rows) {
    const by = r.overriddenByFactId ? live.get(r.overriddenByFactId) : undefined;
    if (!by) continue;
    out.set(r.id, { factId: by.id, statement: by.statement, reason: r.overrideReason, refs: (cites.get(by.id) ?? []).map((c) => refFromCitation(c, docIndex, titles)) });
  }
  return out;
}

/** A fact's verdict basis as printed: only a confirmed fact carries one. */
function basisOf(status: string | null | undefined, basis: string | null | undefined): string | null {
  return status === 'confirmed' && (basis === 'original' || basis === 'summary') ? basis : null;
}

function certaintyOf(f: FactRow): string | null {
  if (f.type !== 'diagnosis') return null;
  const c = parseJson<{ certainty?: unknown }>(f.attributesJson, {}).certainty;
  return typeof c === 'string' && c.trim() ? c.trim() : null;
}

function toPacketFacts(rows: FactRow[], docIndex: Map<string, number>): PacketFact[] {
  const cites = citationsForFacts(rows.map((r) => r.id));
  const docIds = new Set<string>();
  for (const r of rows) if (r.sourceDocumentId) docIds.add(r.sourceDocumentId);
  for (const list of cites.values()) for (const c of list) docIds.add(c.documentId);
  const titles = titlesFor(docIds);
  const names = peopleNames(rows.map((r) => r.personId));
  const notes = patientNotesFor(rows, docIndex);
  return rows.map((f) => ({
    id: f.id,
    type: f.type,
    statement: f.statement,
    date: f.date,
    datePrecision: f.datePrecision,
    dateText: f.dateText,
    dateEnd: f.dateEnd,
    status: f.status,
    verdictBasis: basisOf(f.status, f.verdictBasis),
    confidence: f.confidence,
    origin: f.origin,
    verdictNote: f.verdictNote,
    personName: f.personId ? (names.get(f.personId) ?? null) : null,
    sourceDocumentId: f.sourceDocumentId,
    documentTitle: f.sourceDocumentId ? (titles.get(f.sourceDocumentId) ?? null) : null,
    refs: (cites.get(f.id) ?? []).map((c) => refFromCitation(c, docIndex, titles)),
    certainty: certaintyOf(f),
    patientNote: notes.get(f.id) ?? null,
  }));
}

function groupFacts(facts: PacketFact[], keepOrder: boolean): Array<{ type: string; facts: PacketFact[] }> {
  const byType = new Map<string, PacketFact[]>();
  for (const f of facts) {
    const list = byType.get(f.type) ?? [];
    list.push(f);
    byType.set(f.type, list);
  }
  const order: string[] = [...FACT_TYPES];
  for (const t of byType.keys()) if (!order.includes(t)) order.push(t);
  return order
    .filter((t) => byType.has(t))
    .map((t) => {
      const list = byType.get(t)!;
      if (!keepOrder) list.sort((a, b) => dateSortKey(a.date).localeCompare(dateSortKey(b.date)) || a.statement.localeCompare(b.statement));
      return { type: t, facts: list };
    });
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

function selectFindings(scope: PacketConfig['findingIds']): Array<typeof schema.findings.$inferSelect> {
  if (!scope || scope === 'none') return [];
  const d = db();
  const base = d.select().from(schema.findings);
  if (Array.isArray(scope)) {
    const out: Array<typeof schema.findings.$inferSelect> = [];
    for (const part of chunk(scope)) out.push(...base.where(and(inArray(schema.findings.id, part), isNull(schema.findings.deletedAt))).all());
    const order = new Map(scope.map((id, i) => [id, i]));
    return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }
  const conds = [isNull(schema.findings.deletedAt)];
  if (scope === 'confirmed') conds.push(eq(schema.findings.status, 'confirmed'));
  else conds.push(sql`${schema.findings.status} not in ('dismissed')`);
  return base.where(and(...conds)).orderBy(sql`case ${schema.findings.severity} when 'high' then 0 when 'medium' then 1 when 'low' then 2 else 3 end`, desc(schema.findings.createdAt)).all();
}

function toPacketFindings(rows: Array<typeof schema.findings.$inferSelect>, docIndex: Map<string, number>): PacketFinding[] {
  if (!rows.length) return [];
  const d = db();
  const ids = rows.map((r) => r.id);
  const evidence: Array<typeof schema.findingEvidence.$inferSelect> = [];
  const findingCites: Array<CitationRow> = [];
  for (const part of chunk(ids)) {
    evidence.push(...d.select().from(schema.findingEvidence).where(inArray(schema.findingEvidence.findingId, part)).orderBy(asc(schema.findingEvidence.sortOrder)).all());
    findingCites.push(...d.select().from(schema.citations).where(inArray(schema.citations.findingId, part)).all());
  }
  const factIds = [...new Set(evidence.map((e) => e.factId).filter((x): x is string => Boolean(x)))];
  const facts = new Map<string, FactRow>();
  for (const part of chunk(factIds)) for (const f of d.select().from(schema.facts).where(inArray(schema.facts.id, part)).all()) facts.set(f.id, f);
  const factCites = citationsForFacts(factIds);
  const citeIds = [...new Set(evidence.map((e) => e.citationId).filter((x): x is string => Boolean(x)))];
  const cites = new Map<string, CitationRow>();
  for (const part of chunk(citeIds)) for (const c of d.select().from(schema.citations).where(inArray(schema.citations.id, part)).all()) cites.set(c.id, c);
  const commIds = [...new Set(evidence.map((e) => e.communicationId).filter((x): x is string => Boolean(x)))];
  const comms = new Map<string, typeof schema.communications.$inferSelect>();
  for (const part of chunk(commIds)) for (const c of d.select().from(schema.communications).where(inArray(schema.communications.id, part)).all()) comms.set(c.id, c);
  const labIds = [...new Set(evidence.map((e) => e.labResultId).filter((x): x is string => Boolean(x)))];
  const labs = new Map<string, typeof schema.labResults.$inferSelect>();
  for (const part of chunk(labIds)) for (const l of d.select().from(schema.labResults).where(inArray(schema.labResults.id, part)).all()) labs.set(l.id, l);
  const docIds = new Set<string>();
  for (const e of evidence) if (e.documentId) docIds.add(e.documentId);
  for (const c of [...cites.values(), ...findingCites]) docIds.add(c.documentId);
  for (const list of factCites.values()) for (const c of list) docIds.add(c.documentId);
  for (const l of labs.values()) if (l.documentId) docIds.add(l.documentId);
  for (const c of comms.values()) if (c.documentId) docIds.add(c.documentId);
  const titles = titlesFor(docIds);
  const notes = patientNotesFor([...facts.values()], docIndex);

  return rows.map((f) => {
    const ev = evidence.filter((e) => e.findingId === f.id);
    const items: PacketFinding['evidence'] = [];
    for (const e of ev) {
      if (e.factId) {
        const fact = facts.get(e.factId);
        items.push({
          kind: 'fact',
          label: fact ? fact.statement : `fact ${e.factId}`,
          detail: e.note,
          status: fact?.status ?? null,
          basis: fact ? basisOf(fact.status, fact.verdictBasis) : null,
          refs: (factCites.get(e.factId) ?? []).map((c) => refFromCitation(c, docIndex, titles)),
          patientNote: notes.get(e.factId) ?? null,
        });
      } else if (e.citationId) {
        const c = cites.get(e.citationId);
        items.push({ kind: 'citation', label: c ? `"${c.quote}"` : `citation ${e.citationId}`, detail: e.note, status: null, refs: c ? [refFromCitation(c, docIndex, titles)] : [] });
      } else if (e.documentId) {
        items.push({ kind: 'document', label: titles.get(e.documentId) ?? e.documentId, detail: e.note, status: null, refs: [docRef(e.documentId, null, docIndex, titles)] });
      } else if (e.communicationId) {
        const c = comms.get(e.communicationId);
        items.push({ kind: 'communication', label: c ? `${c.occurredAt ?? ''} ${c.subject}`.trim() : `communication ${e.communicationId}`, detail: e.note ?? c?.summary ?? null, status: null, refs: c?.documentId ? [docRef(c.documentId, null, docIndex, titles)] : [] });
      } else if (e.labResultId) {
        const l = labs.get(e.labResultId);
        items.push({
          kind: 'lab',
          label: l ? `${l.analyte} ${l.valueText ?? (l.valueNum != null ? String(l.valueNum) : '')}${l.unit ? ` ${l.unit}` : ''}${l.collectedAt ? ` (${l.collectedAt})` : ''}` : `lab ${e.labResultId}`,
          detail: e.note,
          status: l?.flag ?? null,
          refs: l?.documentId ? [docRef(l.documentId, null, docIndex, titles)] : [],
        });
      } else if (e.note) {
        items.push({ kind: 'note', label: e.note, detail: null, status: null, refs: [] });
      }
    }
    for (const c of findingCites.filter((x) => x.findingId === f.id)) {
      items.push({ kind: 'citation', label: `"${c.quote}"`, detail: null, status: null, refs: [refFromCitation(c, docIndex, titles)] });
    }
    return {
      id: f.id,
      category: f.category,
      title: f.title,
      whyItMatters: f.whyItMatters,
      detail: f.detail,
      severity: f.severity,
      status: f.status,
      verdictNote: f.verdictNote,
      origin: f.origin,
      createdAt: f.createdAt,
      evidence: items,
    };
  });
}

// ---------------------------------------------------------------------------
// Labs
// ---------------------------------------------------------------------------

interface LabFactAttrs {
  analyte?: string;
  value?: string;
  value_num?: number | null;
  unit?: string | null;
  ref_low?: number | null;
  ref_high?: number | null;
  ref_text?: string | null;
  flag?: string | null;
  specimen?: string | null;
  lab_name?: string | null;
}

export interface AnalyteOption {
  analyteKey: string;
  analyte: string;
  specimens: string[];
  count: number;
  /** The unit when every value has one and the same unit; null when the units differ or a value printed none (rule 5). */
  unit: string | null;
  /** Every unit as printed, most frequent first; '' for "no unit printed". */
  units: string[];
  lastDate: string | null;
}

type LabResultRow = typeof schema.labResults.$inferSelect;

interface LiveLabRow {
  r: LabResultRow;
  /** Status and verdict note of the linked fact, when that fact is live. */
  factStatus: string | null;
  factBasis: string | null;
  verdictNote: string | null;
  factLive: boolean;
  /** The linked fact as the reading needs it (its printed text is the row's provenance), when live. */
  fact: FactLite | null;
}

/**
 * lab_results rows the ledger still stands behind: not deleted, source
 * document not deleted (deleteDocument leaves lab rows in place), and not
 * backed by a fact the user superseded. `linked` is every fact id a kept row
 * points at (whatever its analyte key), so those facts are not listed a
 * second time.
 */
function liveLabRows(): { rows: LiveLabRow[]; linked: Set<string> } {
  const l = schema.labResults;
  const raw = db()
    .select({ r: l, docId: schema.documents.id, docDeleted: schema.documents.deletedAt, f: schema.facts })
    .from(l)
    .leftJoin(schema.documents, eq(schema.documents.id, l.documentId))
    .leftJoin(schema.facts, eq(schema.facts.id, l.factId))
    .where(isNull(l.deletedAt))
    .all();
  const rows: LiveLabRow[] = [];
  const linked = new Set<string>();
  for (const x of raw) {
    if (x.r.documentId && (!x.docId || x.docDeleted)) continue;
    if (x.r.factId) linked.add(x.r.factId);
    const factLive = Boolean(x.r.factId && x.f?.id && !x.f.deletedAt);
    if (factLive && x.f!.status === 'superseded') continue;
    rows.push({
      r: x.r,
      factLive,
      factStatus: factLive ? x.f!.status : null,
      factBasis: factLive ? basisOf(x.f!.status, x.f!.verdictBasis) : null,
      verdictNote: factLive ? x.f!.verdictNote : null,
      fact: factLive ? x.f! : null,
    });
  }
  return { rows, linked };
}

/** Live lab_result facts not linked to a kept lab_results row (source document not deleted, not superseded). */
function unlinkedLabFacts(linked: Set<string>): FactRow[] {
  return db()
    .select({ f: schema.facts, docId: schema.documents.id, docDeleted: schema.documents.deletedAt })
    .from(schema.facts)
    .leftJoin(schema.documents, eq(schema.documents.id, schema.facts.sourceDocumentId))
    .where(and(eq(schema.facts.type, 'lab_result'), isNull(schema.facts.deletedAt), ne(schema.facts.status, 'superseded')))
    .all()
    .filter((x) => !linked.has(x.f.id) && !(x.f.sourceDocumentId && (!x.docId || x.docDeleted)))
    .map((x) => x.f);
}

/** A lab row read for the tests it holds, as the Labs page reads it (labs.ts readLabValues). */
function rowValues(r: LabResultRow, assumed: Set<string>): LabValueRead[] {
  return readLabValues({ analyte: r.analyte, specimen: r.specimen, ...(assumed.has(r.id) ? { specimenAssumed: true } : {}), valueText: r.valueText, valueNum: r.valueNum, unit: r.unit, flag: r.flag, refLow: r.refLow, refHigh: r.refHigh, refText: r.refText });
}

/**
 * An unlinked lab fact read for the tests it holds; a fact that names no sample is read on the one the app assumes.
 * `valueNum` is the number of the fact's reading (lab-reading.ts readingForFact), as the Labs page passes it: the line
 * never reads value_num itself.
 */
function factValues(a: LabFactAttrs, valueNum: number | null): LabValueRead[] {
  const analyte = (a.analyte ?? '').trim();
  if (!analyte) return [];
  const stated = typeof a.specimen === 'string' && a.specimen.trim() ? a.specimen.trim() : null;
  return readLabValues({
    analyte,
    specimen: stated ?? defaultSpecimenFor(analyte),
    specimenAssumed: !stated,
    valueText: typeof a.value === 'string' ? a.value : null,
    valueNum,
    unit: a.unit ?? null,
    flag: a.flag ?? null,
    refLow: a.ref_low ?? null,
    refHigh: a.ref_high ?? null,
    refText: a.ref_text ?? null,
  });
}

/** A test of a line the Labs page sets aside on its own (labs.ts setAsideLabParts): never printed as a reading. */
function partSetAside(parts: Map<string, Set<number>>, id: string, v: LabValueRead): boolean {
  const set = parts.get(id);
  return Boolean(set && set.has(v.splitFrom ? v.splitFrom.index : -1));
}

/** A citation as the reading needs it (the first verified one of the value's own document). */
function citeLite(c: CitationRow | undefined, documentId: string | null): CiteLite | null {
  return c && c.documentId === documentId ? { id: c.id, documentId: c.documentId, pageNumber: c.pageNumber, verified: Boolean(c.verified), quote: c.quote } : null;
}

/**
 * The reading of each test a line holds, as the Labs page reads it (src/shared/labvalues.ts through
 * services/lab-reading.ts): the line's own reading, or each part read on its own text (labs.ts partLabReading).
 */
function valueReadings(values: LabValueRead[], whole: LabReading, line: { date: string | null; precision: string; text: string | null }, cite: CiteLite | null): LabReadingView[] {
  const wholeView = readingView(whole);
  const date: PartialDate | null = line.date || line.text ? { iso: line.date, precision: (line.precision || 'unknown') as DatePrecision, text: line.text } : null;
  const quote = cite?.verified ? { text: cite.quote, verified: true, citationId: cite.id } : null;
  return values.map((v) => (v.splitFrom ? readingView(partLabReading(v, { reading: wholeView, date, quote })) : wholeView));
}

/** The flag column of the printed table (rule 4): as printed ("H", "HH (critical)", "none printed"), then what the value's own range says when that differs ("high by its range"); a summary's own flag as its claim. */
function flagShownOf(v: LabReadingView): string {
  // A value computed by the patient has no flag and is never judged (2026-10-09).
  if (v.role === 'computed') return '';
  const printed = v.flagState === 'flag' || v.flagState === 'not_understood' ? v.flagShown : v.flagState === 'no_flag_printed' ? 'none printed' : '';
  const claim = v.role === 'claimed' && printed && v.flagState !== 'no_flag_printed' ? `${printed} (this document's own flag)` : printed;
  const computed = v.computed && !(v.flagState === 'flag' && v.flagPrinted === v.computed) ? `${v.computed === 'H' ? 'high' : v.computed === 'L' ? 'low' : 'in range'} by ${v.role === 'claimed' ? 'the range this document gives' : 'its range'}` : '';
  return [claim, computed].filter(Boolean).join('; ');
}

/** A computed row's label and inputs for the printed table (2026-10-09); null for any other row. */
function computedOfRow(r: LabResultRow, inputChanged: (id: string) => boolean): PacketLabRow['computed'] {
  if (r.rawSource !== COMPUTED_SOURCE) return null;
  const rec = readComputedRecord(r.parseJson);
  if (!rec) return null;
  return { label: rec.label, inputs: rec.inputs.map((i) => `${i.slotLabel}: ${i.conversion.words || `${i.valueShown}${i.unit ? ` ${i.unit}` : ''}`}, p.${i.citation.page} of "${i.citation.documentTitle ?? 'a document'}"`), changed: inputChanged(r.id) };
}

/** The chart flag of a value (src/shared/chart.ts): printed H, L, A or C, or worked out from its own range ("H~"); a summary's claim never marks a point. */
function chartFlagOf(v: LabReadingView): string | null {
  if (v.role === 'claimed' || v.role === 'computed') return null;
  if (v.flagState === 'flag' && v.flagPrinted && v.flagPrinted !== 'N') return v.flagPrinted;
  if (v.computed === 'H' || v.computed === 'L') return `${v.computed}~`;
  return null;
}

/** The fields of a printed row that come from the value's reading. */
function readingRowFields(v: LabReadingView, labName: string | null): Pick<PacketLabRow, 'value' | 'valueNum' | 'unit' | 'refLow' | 'refHigh' | 'refText' | 'flag' | 'valueShown' | 'rangeShown' | 'rangeUnit' | 'flagShown' | 'lab' | 'role' | 'rangeSignature' | 'unitKey' | 'valueKind'> {
  return {
    value: v.valueShown,
    valueNum: v.measurement,
    unit: v.unit,
    refLow: v.rangeStatus === 'parsed' ? v.rangeLow : null,
    refHigh: v.rangeStatus === 'parsed' ? v.rangeHigh : null,
    refText: v.rangeShown,
    flag: chartFlagOf(v),
    valueShown: v.valueShown,
    rangeShown: v.rangeShown,
    rangeUnit: v.rangeUnit ?? null,
    flagShown: flagShownOf(v),
    lab: v.lab ?? labName,
    role: v.role,
    rangeSignature: v.role === 'claimed' ? null : rangeSignature(v),
    unitKey: v.unitKey,
    valueKind: v.kind,
  };
}

/**
 * Analytes known to the ledger: lab_results rows plus lab_result facts not yet linked to a row, grouped as the Labs
 * page groups them (by the name as written, a line of several tests as its tests). `unit` only when every value has one
 * and the same unit; `units` lists each unit as printed (rule 5).
 */
export function listAnalytes(): AnalyteOption[] {
  const map = new Map<string, AnalyteOption & { spec: Set<string>; unitCounts: Map<string, number>; keys: Set<string> }>();
  const add = (v: LabValueRead, date: string | null) => {
    const key = v.analyteKey;
    if (!key) return;
    const cur = map.get(key) ?? { analyteKey: key, analyte: analyteLabel(key, v.analyte), specimens: [], count: 0, unit: null, units: [], lastDate: null, spec: new Set<string>(), unitCounts: new Map<string, number>(), keys: new Set<string>() };
    cur.count++;
    if (v.specimen) cur.spec.add(v.specimen);
    const u = (v.unit ?? '').trim();
    cur.unitCounts.set(u, (cur.unitCounts.get(u) ?? 0) + 1);
    cur.keys.add(sharedUnitKey(u) ?? '');
    if (date && (!cur.lastDate || date > cur.lastDate)) cur.lastDate = date;
    map.set(key, cur);
  };
  const parts = setAsideLabParts();
  const assumed = assumedLabRowIds();
  const { rows, linked } = liveLabRows();
  for (const { r } of rows) for (const v of rowValues(r, assumed)) if (!partSetAside(parts, r.id, v)) add(v, r.collectedAt ?? r.resultedAt);
  for (const f of unlinkedLabFacts(linked)) {
    const measurement = readingForFact(f, { hasDocument: Boolean(f.sourceDocumentId) }).measurement;
    for (const v of factValues(parseJson<LabFactAttrs>(f.attributesJson, {}), measurement)) if (!partSetAside(parts, `fact:${f.id}`, v)) add(v, f.date);
  }
  return [...map.values()]
    .map(({ spec, unitCounts, keys, ...rest }) => {
      const units = [...unitCounts.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u);
      return { ...rest, specimens: [...spec].sort(), units, unit: keys.size === 1 && !keys.has('') ? (units[0] ?? null) : null };
    })
    .sort((a, b) => a.analyte.localeCompare(b.analyte));
}

/** The most frequent key among `items` (ties go to the most recent item), with the most recent item carrying it. */
function mostCommonOf<T>(items: T[], key: (x: T) => string, recency: (x: T) => string): { key: string; item: T; distinct: number } | null {
  const groups = new Map<string, { n: number; latest: string; item: T }>();
  for (const x of items) {
    const k = key(x);
    const r = recency(x);
    const g = groups.get(k);
    if (!g) groups.set(k, { n: 1, latest: r, item: x });
    else {
      g.n++;
      if (r > g.latest) {
        g.latest = r;
        g.item = x;
      }
    }
  }
  let best: { key: string; n: number; latest: string; item: T } | null = null;
  for (const [k, g] of groups) {
    if (!best || g.n > best.n || (g.n === best.n && g.latest > best.latest)) best = { key: k, ...g };
  }
  return best ? { key: best.key, item: best.item, distinct: groups.size } : null;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "15–45 mg/dL (Example Reference Lab)": a range as printed with its unit (when the text has none) and its lab. */
function rangeWords(r: PacketLabRow, withLab = true): string {
  const shown = r.rangeShown ?? '';
  // The value's unit only for a range read as numbers that prints no unit of its own ("0.15-0.45 g/L" is never relabelled).
  const unit = r.unit && !r.rangeUnit && /\d/.test(shown) && !/^"/.test(shown.trim()) && !shown.toLowerCase().includes(r.unit.toLowerCase()) ? ` ${r.unit}` : '';
  return `${shown}${unit}${withLab && r.lab ? ` (${r.lab})` : ''}`;
}

/**
 * One chart per analyte and specimen, honest about what it shows: only measurements are drawn (a limit such as "<3"
 * and results in words never are), only the most common unit is plotted (values in other units are not comparable on
 * one axis), disputed values are left off, a summary's values are listed but not drawn beside a lab's, and the band is
 * drawn only when every plotted value that printed a range printed the same one (rule 8: ranges belong to their lab;
 * otherwise each range is named with its lab and each point is judged by its own).
 */
function labChart(g: { analyte: string; specimen: string; rows: PacketLabRow[]; key?: string }): { unit: string | null; spec: ChartSpec | null; svg: string | null; note: string | null } {
  const notes: string[] = [];
  const recency = (r: PacketLabRow) => dateSortKey(r.date);
  const spelledUnit = (rows: PacketLabRow[]) => mostCommonOf(rows.filter((r) => r.unit && r.unit.trim()), (r) => r.unit!.trim(), recency)?.key ?? null;
  const dated = g.rows.filter((r) => r.valueNum != null && r.date);
  const limits = g.rows.filter((r) => r.valueKind === 'censored');
  if (limits.length) notes.push(`${plural(limits.length, 'limit')} (${[...new Set(limits.map((r) => r.valueShown))].slice(0, 3).join(', ')}) listed in the table, not drawn: a limit is not a measurement`);
  const disputed = dated.filter((r) => r.factStatus === 'disputed');
  if (disputed.length) notes.push(`${plural(disputed.length, 'disputed value')} listed in the table but not plotted`);
  let plottable = dated.filter((r) => r.factStatus !== 'disputed');
  // A summary's or a note's values are its claims (rule 11): drawn only when the test has nothing from a lab report.
  const own = plottable.filter((r) => r.role !== 'claimed');
  if (own.length && own.length < plottable.length) {
    notes.push(`${plural(plottable.length - own.length, 'value')} stated in summaries or notes listed in the table, not drawn`);
    plottable = own;
  } else if (!own.length && plottable.length) notes.push('every value in this chart comes from summaries or notes, not from a lab report');
  const main = mostCommonOf(plottable, (r) => r.unitKey ?? '', recency);
  const mainRows = main ? plottable.filter((r) => (r.unitKey ?? '') === main.key) : [];
  const unit = main ? spelledUnit(mainRows) : spelledUnit(g.rows);
  if (main && mainRows.length < plottable.length) {
    const others = plottable.filter((r) => (r.unitKey ?? '') !== main.key);
    const names = [...new Set(others.map((r) => (r.unit && r.unit.trim()) || 'no unit printed'))];
    notes.push(`${plural(others.length, 'result')} in ${names.join(', ')} not plotted on the ${unit ?? 'unitless'} axis (see the table)`);
  }
  // Results in words only (Negative, Clear, Not detected): no chart, the table lists them.
  if (g.rows.length && g.rows.every((r) => r.valueNum == null)) notes.push('results in words or limits, so none is drawn; the table lists them');
  if (!mainRows.length) return { unit, spec: null, svg: null, note: notes.length ? `${notes.join('; ')}.` : null };

  // The band: one range signature among the plotted values that printed one; a value that printed none is not judged.
  const sigs = new Map<string, PacketLabRow[]>();
  for (const r of mainRows) {
    if (!r.rangeSignature || r.rangeSignature.startsWith('t:')) continue;
    const list = sigs.get(r.rangeSignature) ?? [];
    list.push(r);
    sigs.set(r.rangeSignature, list);
  }
  let referenceBand: ChartSpec['referenceBand'] = null;
  if (sigs.size === 1) {
    const list = [...sigs.values()][0];
    const r = list[list.length - 1];
    referenceBand = { low: r.refLow, high: r.refHigh, label: `ref ${rangeWords(r, false)}` };
    const unjudged = mainRows.filter((r) => r.role !== 'computed').length - list.length;
    if (unjudged) notes.push(`${plural(unjudged, 'value')} printed no range of ${unjudged === 1 ? 'its' : 'their'} own and ${unjudged === 1 ? 'is' : 'are'} not judged by the band`);
  } else if (sigs.size > 1) {
    const named = [...new Set([...sigs.values()].map((list) => rangeWords(list[list.length - 1])))];
    notes.push(`these results print ${named.length} different reference ranges (${named.join('; ')}), so no band is drawn; each flagged point is outside the range printed with it`);
  }
  // A value computed by the patient is an open square, never red (2026-10-09).
  const points = mainRows.map((r) => ({ x: r.date!, y: r.valueNum!, flag: r.role === 'computed' ? null : (r.flag ?? null), label: r.dateText ?? null, ...(r.role === 'computed' ? { marker: 'square' as const } : {}) }));
  const computedRows = mainRows.filter((r) => r.role === 'computed').length;
  if (computedRows) notes.push(`${plural(computedRows, 'value')} computed by the patient drawn as open squares, never judged by a range`);
  const typed = computedRows ? typedRangeFor(g.key ?? null) : null;
  const candidate = {
    type: 'line' as const,
    title: `${g.analyte} (${g.specimen})`,
    xType: 'date' as const,
    yLabel: unit,
    series: [{ name: g.analyte, unit, kind: points.length > 1 ? ('line' as const) : ('scatter' as const), points }],
    referenceBand,
    ...(typed ? { typedRange: { low: typed.low, high: typed.high, label: typedRangeLabel(typed) } } : {}),
    source: 'db' as const,
  };
  const parsed = chartSpec.safeParse(candidate);
  const spec = parsed.success ? parsed.data : null;
  return { unit, spec, svg: spec ? renderChartSvg(spec, { width: 640, height: 210 }) : null, note: notes.length ? `${notes.join('; ')}.` : null };
}

/**
 * The chosen tests' series, grouped as the Labs page groups them: by the name as written (normalizeAnalyte), never a
 * stored key, so "ICP (opening pressure)" and "Opening pressure" are one test; a line that holds several tests ("OP
 * 19; protein 52") is one row per test, each under its own test with the line as written. A test the Labs page sets
 * aside on its own (a copy of a clinical record's value, or one it contradicts) is not printed. A key chosen before
 * this grouping (a stored key, a fact's name) still selects the values it selected. Every value is printed as read
 * (src/shared/labvalues.ts): as printed, its range as printed, its flag as printed and what its own range says.
 */
function labSeriesFor(keys: string[], docIndex: Map<string, number>): PacketLabSeries[] {
  const forms = keys.map((k) => new Set([normalizeKey(k), normalizeAnalyte(k)].filter(Boolean)));
  const want = new Set(forms.flatMap((f) => [...f]));
  if (!want.size) return [];
  const rows: Array<{ key: string; analyte: string; specimen: string; row: PacketLabRow }> = [];
  const docIds = new Set<string>();
  const parts = setAsideLabParts();
  const assumed = assumedLabRowIds();
  const { rows: labRows, linked } = liveLabRows();
  const factCites = citationsForFacts(labRows.filter((x) => x.factLive && x.r.factId).map((x) => x.r.factId!));
  const facts = unlinkedLabFacts(linked);
  const cites = citationsForFacts(facts.map((f) => f.id));
  const meta = labDocumentMeta([...labRows.map((x) => x.r.documentId), ...facts.map((f) => f.sourceDocumentId), ...[...factCites.values(), ...cites.values()].flat().map((c) => c.documentId)]);
  // Computed values whose input changed since (2026-10-09): read once, only when a computed value is printed.
  let changedComputed: Set<string> | null = null;
  const inputChanged = (id: string) => (changedComputed ??= new Set(loadLabEntries().filter((e) => e.computed?.changes.length && e.labResultId).map((e) => e.labResultId!))).has(id);
  for (const { r, factLive, factStatus, factBasis, verdictNote, fact } of labRows) {
    // The stored key selects the whole line, as it did before tests were grouped by their names.
    const lineWanted = want.has(normalizeKey(r.analyteKey));
    const c = factLive && r.factId ? factCites.get(r.factId)?.[0] : undefined;
    const values = rowValues(r, assumed).filter((v) => (lineWanted || want.has(v.analyteKey)) && !partSetAside(parts, r.id, v));
    if (!values.length) continue;
    const documentId = r.documentId ?? c?.documentId ?? null;
    const cite = citeLite(c, documentId);
    const m = documentId ? meta.get(documentId) : undefined;
    const whole = readingForRow(r, { fact, editedFrom: fact ? labRowEditedFrom(r, fact) : null, cite, documentTier: m?.tier ?? null, documentDate: m?.date ?? null, hasDocument: Boolean(documentId) });
    const views = valueReadings(values, whole, { date: r.collectedAt ?? r.resultedAt, precision: r.collectedAt ? r.collectedAtPrecision : (r.resultedAtPrecision ?? 'unknown'), text: r.collectedAtText ?? r.resultedAtText }, cite);
    values.forEach((v, i) => {
      if (r.documentId) docIds.add(r.documentId);
      if (c) docIds.add(c.documentId);
      const d = whole.dates.reading;
      rows.push({
        key: v.analyteKey,
        analyte: v.analyte,
        specimen: v.specimen,
        row: {
          id: v.splitFrom ? `${r.id}#${v.splitFrom.index}` : r.id,
          // The value's own date (collected, else of unknown kind, else resulted): rule 7.
          date: d?.iso ?? null,
          datePrecision: d?.precision ?? 'unknown',
          dateText: d?.text ?? null,
          ...readingRowFields(views[i], r.labName),
          labName: r.labName,
          source: 'lab_result',
          factStatus,
          factBasis,
          verdictNote,
          ref: c ? { docN: null, documentId: c.documentId, documentTitle: null, pageNumber: c.pageNumber, quote: c.quote, verified: Boolean(c.verified), citationId: c.id } : r.documentId ? { docN: null, documentId: r.documentId, documentTitle: null, pageNumber: null, quote: null, verified: null, citationId: null } : null,
          splitFrom: v.splitFrom?.text ?? null,
          computed: computedOfRow(r, inputChanged),
        },
      });
    });
  }
  for (const f of facts) {
    const a = parseJson<LabFactAttrs>(f.attributesJson, {});
    // A fact's name selected it before tests were grouped by their names.
    const lineWanted = want.has(normalizeKey(a.analyte));
    const c = cites.get(f.id)?.[0];
    const documentId = f.sourceDocumentId ?? c?.documentId ?? null;
    const cite = citeLite(c, documentId);
    const m = documentId ? meta.get(documentId) : undefined;
    const whole = readingForFact(f, { cite, documentTier: m?.tier ?? null, documentDate: m?.date ?? null, hasDocument: Boolean(documentId) });
    const values = factValues(a, whole.measurement).filter((v) => (lineWanted || want.has(v.analyteKey)) && !partSetAside(parts, `fact:${f.id}`, v));
    if (!values.length) continue;
    const views = valueReadings(values, whole, { date: f.date, precision: f.datePrecision, text: f.dateText }, cite);
    values.forEach((v, i) => {
      if (c) docIds.add(c.documentId);
      else if (f.sourceDocumentId) docIds.add(f.sourceDocumentId);
      const d = whole.dates.reading;
      rows.push({
        key: v.analyteKey,
        analyte: v.analyte,
        specimen: v.specimen,
        row: {
          id: v.splitFrom ? `${f.id}#${v.splitFrom.index}` : f.id,
          date: d?.iso ?? null,
          datePrecision: d?.precision ?? 'unknown',
          dateText: d?.text ?? null,
          ...readingRowFields(views[i], a.lab_name ?? null),
          labName: a.lab_name ?? null,
          source: 'fact',
          factStatus: f.status,
          factBasis: basisOf(f.status, f.verdictBasis),
          verdictNote: f.verdictNote,
          ref: c ? { docN: null, documentId: c.documentId, documentTitle: null, pageNumber: c.pageNumber, quote: c.quote, verified: Boolean(c.verified), citationId: c.id } : f.sourceDocumentId ? { docN: null, documentId: f.sourceDocumentId, documentTitle: null, pageNumber: null, quote: null, verified: null, citationId: null } : null,
          splitFrom: v.splitFrom?.text ?? null,
        },
      });
    });
  }
  const titles = titlesFor(docIds);
  for (const r of rows) {
    if (r.row.ref) {
      r.row.ref.docN = docIndex.get(r.row.ref.documentId) ?? null;
      r.row.ref.documentTitle = titles.get(r.row.ref.documentId) ?? null;
    }
  }
  const groups = new Map<string, { key: string; analyte: string; specimen: string; rows: PacketLabRow[]; names: string[] }>();
  for (const r of rows) {
    const gk = `${r.key}|${r.specimen}`;
    const g = groups.get(gk) ?? { key: r.key, analyte: r.analyte, specimen: r.specimen, rows: [], names: [] };
    g.rows.push(r.row);
    g.names.push(r.analyte);
    groups.set(gk, g);
  }
  // In the order the tests were chosen (a group selected only by an older key goes after them).
  const order = (key: string) => {
    const i = forms.findIndex((f) => f.has(key));
    return i < 0 ? forms.length : i;
  };
  const out: PacketLabSeries[] = [];
  for (const g of [...groups.values()].sort((a, b) => order(a.key) - order(b.key) || a.key.localeCompare(b.key) || a.specimen.localeCompare(b.specimen))) {
    g.rows.sort((a, b) => dateSortKey(a.date).localeCompare(dateSortKey(b.date)));
    const analyte = analyteLabel(g.key, mostCommonOf(g.names, (n) => n, () => '')?.key ?? g.analyte);
    const chart = labChart({ analyte, specimen: g.specimen, rows: g.rows, key: g.key });
    // Every unit the values were printed in, most frequent first (rule 5: the header never names one unit over mixed values).
    const unitCounts = new Map<string, number>();
    for (const r of g.rows) unitCounts.set((r.unit ?? '').trim(), (unitCounts.get((r.unit ?? '').trim()) ?? 0) + 1);
    const units = [...unitCounts.entries()].sort((x, y) => y[1] - x[1]).map(([u]) => u);
    out.push({ analyteKey: g.key, analyte, specimen: g.specimen, unit: chart.unit, units, rows: g.rows, chart: chart.spec, svg: chart.svg, chartNote: chart.note });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Medications, intolerances, emergency card
// ---------------------------------------------------------------------------

function loadIntolerances(): PacketIntolerance[] {
  return db()
    .select()
    .from(schema.intolerances)
    .where(and(isNull(schema.intolerances.deletedAt), eq(schema.intolerances.active, true)))
    .orderBy(desc(schema.intolerances.hardStop), asc(schema.intolerances.substance))
    .all()
    .map((r) => ({ id: r.id, substance: r.substance, kind: r.kind, reaction: r.reaction, severity: r.severity, hardStop: Boolean(r.hardStop), date: r.date, datePrecision: r.datePrecision, notes: r.notes }));
}

const MED_ORDER: Record<string, number> = { active: 0, prn: 1, planned: 2, unknown: 3, stopped: 4 };

function loadMedications(): PacketMedication[] {
  const d = db();
  const rows = d.select().from(schema.medications).where(isNull(schema.medications.deletedAt)).all();
  const names = peopleNames(rows.map((r) => r.prescriberId));
  const events = rows.length
    ? d
        .select()
        .from(schema.medicationEvents)
        .where(and(inArray(schema.medicationEvents.medicationId, rows.map((r) => r.id)), isNull(schema.medicationEvents.deletedAt)))
        .orderBy(asc(schema.medicationEvents.date), asc(schema.medicationEvents.createdAt))
        .all()
    : [];
  return rows
    .map((m) => ({
      id: m.id,
      name: m.name,
      genericName: m.genericName,
      drugClass: m.drugClass,
      dose: m.dose,
      unit: m.unit,
      route: m.route,
      frequency: m.frequency,
      status: m.status,
      startDate: m.startDate,
      startDatePrecision: m.startDatePrecision,
      startDateText: m.startDateText,
      stopDate: m.stopDate,
      stopDatePrecision: m.stopDatePrecision,
      stopDateText: m.stopDateText,
      prescriberName: m.prescriberId ? (names.get(m.prescriberId) ?? null) : null,
      indication: m.indication,
      reasonStopped: m.reasonStopped,
      effect: m.effect,
      notes: m.notes,
      events: events.filter((e) => e.medicationId === m.id).map((e) => ({ id: e.id, kind: e.kind, date: e.date, datePrecision: e.datePrecision, dateText: e.dateText, detail: e.detail, dose: e.dose })),
    }))
    .sort((a, b) => (MED_ORDER[a.status] ?? 9) - (MED_ORDER[b.status] ?? 9) || dateSortKey(b.startDate).localeCompare(dateSortKey(a.startDate)) || a.name.localeCompare(b.name));
}

const CONTACT_KIND_ORDER: Record<string, number> = { clinician: 0, chief_of_staff: 1, advocate: 2, family: 3, clinic: 4, institution: 5, other: 6, patient: 9 };

function loadKeyContacts(): PacketContact[] {
  const rows = db().select().from(schema.people).where(isNull(schema.people.deletedAt)).all();
  const names = new Map(rows.map((r) => [r.id, r.name]));
  return rows
    .filter((p) => p.kind !== 'patient' && (p.phone || p.email || p.fax))
    .map((p) => ({ id: p.id, name: p.name, kind: p.kind, role: p.role, specialty: p.specialty, institutionName: p.institutionId ? (names.get(p.institutionId) ?? null) : null, phone: p.phone, fax: p.fax, email: p.email, portal: p.portal }))
    .sort((a, b) => (CONTACT_KIND_ORDER[a.kind] ?? 8) - (CONTACT_KIND_ORDER[b.kind] ?? 8) || a.name.localeCompare(b.name))
    .slice(0, 16);
}

/**
 * The same diagnoses as the printable emergency card: confirmed diagnosis
 * facts, one per subject, ruled-out ones left out, source document not
 * deleted (services/medications confirmedDiagnoses). A fact's `confirmed`
 * status is the patient's check of the statement, not clinical certainty, so
 * each row carries the certainty the source stated.
 */
function emergencyDiagnoses(docIndex: Map<string, number>): PacketFact[] {
  const order = confirmedDiagnoses().map((x) => x.id);
  if (!order.length) return [];
  const rows = new Map<string, FactRow>();
  for (const part of chunk(order)) for (const f of db().select().from(schema.facts).where(inArray(schema.facts.id, part)).all()) rows.set(f.id, f);
  return toPacketFacts(order.map((id) => rows.get(id)).filter((f): f is FactRow => Boolean(f)), docIndex);
}

function buildEmergencyCard(docIndex: Map<string, number>, medications: PacketMedication[], intolerances: PacketIntolerance[]): EmergencyCardData {
  const diagnoses = emergencyDiagnoses(docIndex);
  return {
    patient: patientFromSettings(),
    hardStops: intolerances.filter((i) => i.hardStop),
    intolerances: intolerances.filter((i) => !i.hardStop),
    activeMedications: medications.filter((m) => m.status === 'active' || m.status === 'prn'),
    diagnoses,
    keyContacts: loadKeyContacts(),
  };
}

// ---------------------------------------------------------------------------
// Records and timeline
// ---------------------------------------------------------------------------

function buildRecords(docIndex: Map<string, number>): PacketData['records'] {
  const inventory = listRecords().map((r) => ({
    id: r.id,
    title: r.title,
    recordType: r.recordType,
    institutionName: r.institutionName,
    recordDate: r.recordDate,
    recordDatePrecision: r.recordDatePrecision,
    recordDateText: r.recordDateText,
    status: r.status,
    held: Boolean(r.held),
    heldForm: r.heldForm,
    system: r.system,
    docN: r.documentId ? (docIndex.get(r.documentId) ?? null) : null,
    documentTitle: r.documentTitle,
    requestedAt: r.requestedAt,
    receivedAt: r.receivedAt,
    notes: r.notes,
  }));
  const gaps: PacketGap[] = inferGaps().map((g) => ({
    kind: g.kind,
    title: g.title,
    recordType: g.recordType,
    institution: g.institution,
    date: g.date,
    datePrecision: String(g.datePrecision),
    dateText: g.dateText,
    status: g.status,
    ref: g.citation ? { docN: docIndex.get(g.citation.documentId) ?? null, documentId: g.citation.documentId, documentTitle: g.citation.documentTitle, pageNumber: g.citation.pageNumber, quote: g.citation.quote, verified: g.citation.verified, citationId: g.citation.citationId } : null,
  }));
  return { inventory, gaps };
}

const TIMELINE_LIMIT = 3000;

function buildTimeline(cfg: NonNullable<PacketConfig['timeline']>, docIndex: Map<string, number>): PacketData['timeline'] {
  const res = listTimeline({ from: cfg.from ?? null, to: cfg.to ?? null, kinds: cfg.kinds && cfg.kinds.length ? cfg.kinds : null, limit: TIMELINE_LIMIT + 1 });
  const kept = res.items.slice(0, TIMELINE_LIMIT);
  // Fact rows: the patient's overriding statement, read here so the packet does not depend on the timeline row shape.
  const factIds = kept.filter((it) => it.kind === 'fact').map((it) => it.id);
  const overrides: OverrideFields[] = [];
  for (const part of chunk(factIds)) {
    overrides.push(
      ...db()
        .select({ id: schema.facts.id, overriddenByFactId: schema.facts.overriddenByFactId, overrideReason: schema.facts.overrideReason })
        .from(schema.facts)
        .where(and(inArray(schema.facts.id, part), sql`${schema.facts.overriddenByFactId} is not null`))
        .all(),
    );
  }
  const notes = patientNotesFor(overrides, docIndex);
  const items = kept.map((it) => ({ ...it, docN: it.documentId ? (docIndex.get(it.documentId) ?? null) : null, patientNote: it.kind === 'fact' ? (notes.get(it.id) ?? null) : null }));
  return { from: cfg.from ?? null, to: cfg.to ?? null, kinds: cfg.kinds && cfg.kinds.length ? cfg.kinds : null, items, truncated: res.items.length > TIMELINE_LIMIT };
}

// ---------------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------------

export function buildPacketData(config: PacketConfig, opts: { now?: string } = {}): PacketData {
  const { documents, docIndex } = loadDocuments(config.documentIds);
  const packetDocIds = config.factsFromPacketDocumentsOnly ? new Set(docIndex.keys()) : null;
  const factRows = selectFacts(config.factIds, packetDocIds);
  const facts = toPacketFacts(factRows, docIndex);
  const factsIncluded = Boolean(config.factIds && config.factIds !== 'none');
  const findingsIncluded = Boolean(config.findingIds && config.findingIds !== 'none');
  const intolerances = config.includeEmergencyCard || config.includeMedications ? loadIntolerances() : [];
  const medications = config.includeEmergencyCard || config.includeMedications ? loadMedications() : [];
  const patient = patientFromSettings();
  const coverSummary = (config.coverSummary ?? '').trim() || patient.summary || null;
  return {
    config,
    generatedAt: opts.now ?? nowIso(),
    patient,
    coverSummary,
    documents,
    factGroups: groupFacts(facts, Array.isArray(config.factIds)),
    factsIncluded,
    findings: toPacketFindings(selectFindings(config.findingIds), docIndex),
    findingsIncluded,
    labs: labSeriesFor(config.includeLabs, docIndex),
    emergencyCard: config.includeEmergencyCard ? buildEmergencyCard(docIndex, medications, intolerances) : null,
    medications: config.includeMedications ? { medications, intolerances } : null,
    records: config.includeRecordsIndex ? buildRecords(docIndex) : null,
    timeline: config.timeline ? buildTimeline(config.timeline, docIndex) : null,
    careTeam: config.includeCareTeam ? careTeamSummary() : null,
  };
}

/** The packet HTML for a config, without touching the file store (preview). */
export function previewPacketHtml(raw: unknown, mode: RenderMode = 'preview'): string {
  const config = parseConfig(raw);
  return renderPacketHtml(buildPacketData(config), { mode });
}

// ---------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------

export interface ExportDeps {
  /** Converts HTML to PDF bytes. `null` means "no browser": the HTML is stored instead. */
  htmlToPdf?: ((html: string, info: { title: string; footerText: string; signal?: AbortSignal }) => Promise<Buffer>) | null;
  /** Reported in the result; the default is the detected executable. */
  browserLabel?: string | null;
  readFile?: (storageKey: string) => Buffer;
  storeFile?: (bytes: Buffer, name: string) => string;
  now?: () => string;
}

export interface ExportRunResult {
  packetId: string;
  status: 'done';
  format: 'pdf' | 'html';
  storageKey: string;
  sizeBytes: number;
  pageCount: number | null;
}

function slug(s: string): string {
  const base = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return base || 'packet';
}

function defaultDeps(): ExportDeps {
  const exe = findBrowserExecutable();
  return {
    htmlToPdf: exe ? (html, info) => htmlToPdfWithBrowser(html, { executablePath: exe, footerText: info.footerText, signal: info.signal }) : null,
    browserLabel: exe,
  };
}

function loadPacketRow(id: string): PacketRow {
  const row = db().select().from(schema.exportPackets).where(eq(schema.exportPackets.id, id)).get();
  if (!row || row.status === 'deleted') throw notFound('packet not found');
  return row;
}

/**
 * Build one packet end to end. Separate from the job wrapper so tests can
 * inject a fake `htmlToPdf` and run against an in-memory database.
 */
export async function runPacketExport(packetId: string, ctx: { setProgress: (p: number, text?: string) => void; signal?: AbortSignal }, deps: ExportDeps = defaultDeps()): Promise<ExportRunResult> {
  const t0 = Date.now();
  const row = loadPacketRow(packetId);
  const stored = readStored(row);
  const config = stored.config;
  const readFile = deps.readFile ?? getFile;
  const storeFile = deps.storeFile ?? putFile;
  const now = deps.now ?? nowIso;
  const abort = () => {
    if (ctx.signal?.aborted) throw new Error('cancelled');
  };
  // db() on every write: the browser and append steps can outlast a lock, which
  // closes the handle. A packet deleted meanwhile stays deleted.
  const save = (patch: Partial<typeof schema.exportPackets.$inferInsert>) =>
    db()
      .update(schema.exportPackets)
      .set(patch)
      .where(and(eq(schema.exportPackets.id, packetId), ne(schema.exportPackets.status, 'deleted')))
      .run();

  save({ status: 'running', error: null });
  try {
    ctx.setProgress(0.05, 'collecting the ledger');
    const data = buildPacketData(config, { now: now() });
    abort();

    const footerText = `${config.title} · Casefile packet · ${data.generatedAt.slice(0, 10)}`;
    const htmlToPdf = deps.htmlToPdf === undefined ? defaultDeps().htmlToPdf : deps.htmlToPdf;

    if (!htmlToPdf) {
      ctx.setProgress(0.5, 'no browser found; storing HTML');
      const html = renderPacketHtml(data, { mode: 'html' });
      const bytes = Buffer.from(html, 'utf8');
      const storageKey = storeFile(bytes, `${slug(config.title)}.html`);
      const result: PacketResult = {
        format: 'html',
        browser: null,
        htmlPages: null,
        appended: [],
        note: 'No Edge or Chrome executable was found, so the packet was stored as HTML without the appended originals. Open it in a browser and print to PDF.',
        durationMs: Date.now() - t0,
      };
      const cfg: StoredPacketConfig = { config, result, note: result.note };
      save({ status: 'done', storageKey, sizeBytes: bytes.length, pageCount: null, finishedAt: now(), configJson: JSON.stringify(cfg), error: null });
      ctx.setProgress(1, 'stored as HTML');
      return { packetId, status: 'done', format: 'html', storageKey, sizeBytes: bytes.length, pageCount: null };
    }

    // Originals: read bytes and count pages first so the index can name packet pages.
    const binDocs = data.documents.filter((x) => x.appendix !== 'text');
    const items: AppendItem[] = [];
    const unreadable: Array<{ n: number; title: string; error: string }> = [];
    for (let i = 0; i < binDocs.length; i++) {
      abort();
      const doc = binDocs[i];
      ctx.setProgress(0.08 + (0.12 * i) / Math.max(1, binDocs.length), `reading original ${i + 1}/${binDocs.length}`);
      try {
        const bytes = readFile(doc.storageKey);
        const item: AppendItem = { n: doc.n, documentId: doc.id, title: doc.title, kind: doc.appendix, mime: doc.mime, pageCount: doc.pageCount, bytes };
        doc.appendixPages = await appendixPageCount(item);
        items.push(item);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        unreadable.push({ n: doc.n, title: doc.title, error: message });
        doc.appendixPages = 1;
        items.push({ n: doc.n, documentId: doc.id, title: doc.title, kind: doc.appendix, mime: doc.mime, pageCount: doc.pageCount, bytes: Buffer.alloc(0) });
      }
    }

    // Paginate: render, count, assign start pages, re-render until stable.
    let base: Buffer | null = null;
    let htmlPages = 0;
    let printed: Array<number | null> = [];
    let changed = false;
    for (let round = 0; round < 3; round++) {
      abort();
      ctx.setProgress(0.22 + round * 0.1, round === 0 ? 'printing to PDF' : `re-paginating (${round + 1})`);
      printed = binDocs.map((doc) => doc.packetPage);
      const html = renderPacketHtml(data, { mode: 'pdf' });
      base = await htmlToPdf(html, { title: config.title, footerText, signal: ctx.signal });
      htmlPages = await pdfPageCountOf(base);
      let next = htmlPages + 1;
      changed = false;
      for (const doc of binDocs) {
        if (doc.packetPage !== next) changed = true;
        doc.packetPage = next;
        next += doc.appendixPages ?? 1;
      }
      if (!changed) break;
    }
    if (!base) throw new Error('PDF rendering produced nothing');
    // Never settled: the stored PDF carries the numbers of its own render, so
    // compare those with where the originals land (the drift note below).
    if (changed) binDocs.forEach((doc, i) => (doc.packetPage = printed[i] ?? null));

    abort();
    ctx.setProgress(0.6, items.length ? 'appending originals' : 'finishing');
    const merged = await appendOriginals(base, items, {
      signal: ctx.signal,
      stamp: (item, p, n, packetPage) => `${config.title.slice(0, 48)} · D${item.n} p.${p}/${n} · packet page ${packetPage}`,
      onProgress: (i, total) => ctx.setProgress(0.6 + (0.3 * i) / Math.max(1, total), `appending original ${Math.min(i + 1, total)}/${total}`),
    });
    for (const u of unreadable) {
      const a = merged.appended.find((x) => x.n === u.n);
      if (a) {
        a.how = 'failed';
        a.error = u.error;
      }
    }
    // Reconcile the index with what was actually appended (a failed original still occupies one page).
    const drift = merged.appended.some((a) => {
      const doc = binDocs.find((x) => x.n === a.n);
      return doc && doc.packetPage !== a.startPage;
    });

    abort();
    ctx.setProgress(0.95, 'storing');
    const storageKey = storeFile(merged.bytes, `${slug(config.title)}.pdf`);
    const result: PacketResult = {
      format: 'pdf',
      browser: deps.browserLabel ?? (deps.htmlToPdf === undefined ? findBrowserExecutable() : 'injected'),
      htmlPages,
      appended: merged.appended,
      note: drift ? 'Some appended originals did not occupy the pages the index predicted; the stamp on each appended page is authoritative.' : null,
      durationMs: Date.now() - t0,
    };
    const cfg: StoredPacketConfig = { config, result, note: result.note };
    save({ status: 'done', storageKey, sizeBytes: merged.bytes.length, pageCount: merged.pageCount, finishedAt: now(), configJson: JSON.stringify(cfg), error: null });
    ctx.setProgress(1, `done · ${merged.pageCount} pages`);
    return { packetId, status: 'done', format: 'pdf', storageKey, sizeBytes: merged.bytes.length, pageCount: merged.pageCount };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cancelled = ctx.signal?.aborted || /cancelled/i.test(message);
    try {
      save({ status: cancelled ? 'cancelled' : 'failed', error: message.slice(0, 2000), finishedAt: now() });
    } catch {
      // Locked (database closed) mid-job: the queue leaves the job running and re-queues it on the next
      // unlock, which rebuilds the packet; otherwise the row takes the job's outcome on the next read.
      // Either way the original error is the one to report.
    }
    throw err;
  }
}

/** Job handler registered for `export_packet`. */
export async function exportPacketJob(ctx: JobContext<{ packetId: string }>): Promise<ExportRunResult> {
  const packetId = ctx.payload?.packetId;
  if (!packetId) throw new Error('export_packet job without a packetId');
  return runPacketExport(packetId, ctx);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

function decorate(row: PacketRow): PacketListItem {
  const s = readStored(row);
  const format: 'pdf' | 'html' | null = s.result?.format ?? (row.storageKey ? (row.storageKey.includes('.html') ? 'html' : 'pdf') : null);
  return { ...row, config: s.config, result: s.result ?? null, note: s.note ?? null, recipient: s.config.recipient ?? null, format, documentCount: s.config.documentIds.length };
}

export function createPacket(raw: unknown): { packet: PacketDetail; job: JobRow } {
  const config = parseConfig(raw);
  const { missing } = loadDocuments(config.documentIds);
  if (missing.length) throw badRequest(`unknown or deleted document${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`);
  const id = newId();
  const now = nowIso();
  const stored: StoredPacketConfig = { config };
  db().insert(schema.exportPackets).values({ id, title: config.title, configJson: JSON.stringify(stored), status: 'queued', createdAt: now }).run();
  const job = enqueueJob({ type: 'export_packet', payload: { packetId: id } });
  return { packet: getPacket(id), job };
}

export function listPackets(): PacketListItem[] {
  return db()
    .select()
    .from(schema.exportPackets)
    .where(sql`${schema.exportPackets.status} != 'deleted'`)
    .orderBy(desc(schema.exportPackets.createdAt))
    .all()
    .map((row) => decorate(reconcileWithJob(row)));
}

function jobForPacket(packetId: string): PacketDetail['job'] {
  const j = db()
    .select({ id: schema.jobs.id, status: schema.jobs.status, progress: schema.jobs.progress, progressText: schema.jobs.progressText, error: schema.jobs.error, startedAt: schema.jobs.startedAt, finishedAt: schema.jobs.finishedAt })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.type, 'export_packet'), sql`${schema.jobs.payloadJson} like ${`%"packetId":"${packetId}"%`}`))
    .orderBy(desc(schema.jobs.createdAt))
    .limit(1)
    .get();
  return j ?? null;
}

const ACTIVE_STATUSES: readonly string[] = ['queued', 'running'];

/**
 * Only runPacketExport moves a packet out of queued/running. When its job
 * ended without it (cancelled from the Jobs page while queued, or a failure
 * the packet row could not record) the row would stay active and the page
 * would poll forever, so the packet takes the job's outcome.
 */
function reconcileWithJob(row: PacketRow): PacketRow {
  if (!ACTIVE_STATUSES.includes(row.status)) return row;
  const job = jobForPacket(row.id);
  if (!job || (job.status !== 'cancelled' && job.status !== 'failed')) return row;
  const patch = {
    status: job.status,
    error: (job.error ?? (job.status === 'cancelled' ? 'the export job was cancelled before the packet was built' : 'the export job failed')).slice(0, 2000),
    finishedAt: job.finishedAt ?? nowIso(),
  };
  db()
    .update(schema.exportPackets)
    .set(patch)
    .where(and(eq(schema.exportPackets.id, row.id), inArray(schema.exportPackets.status, [...ACTIVE_STATUSES])))
    .run();
  return { ...row, ...patch };
}

export function getPacket(id: string): PacketDetail {
  const row = reconcileWithJob(loadPacketRow(id));
  return { ...decorate(row), job: jobForPacket(id) };
}

export function getPacketFile(id: string): { bytes: Buffer; mime: string; filename: string } {
  const row = loadPacketRow(id);
  if (!row.storageKey || row.status !== 'done') throw notFound('this packet has no file yet');
  const item = decorate(row);
  const html = item.format === 'html';
  return { bytes: getFile(row.storageKey), mime: html ? 'text/html; charset=utf-8' : 'application/pdf', filename: `${slug(row.title)}-${row.createdAt.slice(0, 10)}.${html ? 'html' : 'pdf'}` };
}

/**
 * Soft delete: the row is hidden and the encrypted file stays in the store.
 * A build still queued or running is cancelled; runPacketExport never writes
 * over a deleted row, so the packet does not come back when the job ends.
 */
export function deletePacket(id: string): { ok: true } {
  loadPacketRow(id);
  db().update(schema.exportPackets).set({ status: 'deleted', finishedAt: nowIso() }).where(eq(schema.exportPackets.id, id)).run();
  const job = jobForPacket(id);
  if (job && ACTIVE_STATUSES.includes(job.status)) cancelJob(job.id);
  return { ok: true };
}

export interface ExportOptions {
  browser: string | null;
  analytes: AnalyteOption[];
  counts: { documents: number; factsConfirmed: number; factsAll: number; findingsConfirmed: number; findingsAll: number; medications: number; intolerances: number; hardStops: number; records: number };
  timelineRange: { min: string | null; max: string | null };
  patient: PacketPatient;
}

/** Everything the builder needs to offer choices, in one call. */
export function exportOptions(): ExportOptions {
  const d = db();
  const one = (q: ReturnType<typeof sql>) => d.get<{ n: number }>(q)?.n ?? 0;
  const liveFacts = sql`from facts f left join documents doc on doc.id = f.source_document_id where f.deleted_at is null and (f.source_document_id is null or (doc.id is not null and doc.deleted_at is null))`;
  const range = listTimeline({ limit: 1 }).range;
  return {
    browser: findBrowserExecutable(),
    analytes: listAnalytes(),
    counts: {
      documents: one(sql`select count(*) as n from documents where deleted_at is null`),
      factsConfirmed: one(sql`select count(*) as n ${liveFacts} and f.status = 'confirmed'`),
      factsAll: one(sql`select count(*) as n ${liveFacts} and f.status != 'superseded'`),
      findingsConfirmed: one(sql`select count(*) as n from findings where deleted_at is null and status = 'confirmed'`),
      findingsAll: one(sql`select count(*) as n from findings where deleted_at is null and status != 'dismissed'`),
      medications: one(sql`select count(*) as n from medications where deleted_at is null`),
      intolerances: one(sql`select count(*) as n from intolerances where deleted_at is null and active = 1`),
      hardStops: one(sql`select count(*) as n from intolerances where deleted_at is null and active = 1 and hard_stop = 1`),
      records: one(sql`select count(*) as n from records_inventory where deleted_at is null`),
    },
    timelineRange: range,
    patient: patientFromSettings(),
  };
}
