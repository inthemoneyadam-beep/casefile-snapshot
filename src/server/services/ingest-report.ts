/**
 * The per-document ingestion report (`documents.metadata_json.coverage.report`, 2026-10-07; WP-C writes it, the
 * document page and the assistant read it) and the records held inside an export.
 *
 * The report says, for the last pass over a document: the pages covered, read by OCR, skipped (with reasons and
 * ranges), failed and still pending; the communications read out of it (made, updated, unchanged, by kind) and its
 * threads (and which were joined with a separately filed copy); people added and suggested; gaps closed by its
 * encounters and the held rows made; trust markers (facts and messages trusted below the document: the patient's own
 * words inside a clinical record); medications filed and medication conflicts flagged; the findings run after it. Counts
 * and ids, plus names of people (the People page shows them anyway); no record text. Written through
 * `patchCoverageMeta` (the report key only; never the whole coverage).
 *
 * Held encounters: one held records row per clinical encounter of an export (records.ts), linked from its segments
 * (`document_segments.record_id`), and every expected or requested row those encounters answer marked received as an
 * automatic filing with Undo (filing.ts). The gaps open before and after are compared to say which closed.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { nowIso, parseJson } from '../util/ids';
import { coverageSummary, listSegments, patchCoverageMeta, readCoverage, updateSegment } from './segments';
import { encounterGroupsOf, encounterHolds, ensureEncounterHeldRow, inferGaps, isHeldEncounter, matchesEncounterHold, openRowsHeldIn, type Gap } from './records';
import { getSetting } from './settings';
import { refreshMessageTiers } from './communications';
import {
  emptyIngestionReport, ingestionReport, parseCommunicationDetails, parseExportInfo, type DocumentCoverage, type IngestionReport, type PageRange,
} from '../../shared/schemas/segments';
import { factTier, normalizeTier } from '../../shared/trust';
import type { ImportResult } from './messages-import';
import { INBOX_ACTIVE_STATUSES } from '../../shared/schemas/inbox';
import { AUTO_CLEARED_PREFIX } from './findings';
import { liveDocumentRow } from './document-rows';

export interface HeldResult {
  /** Held rows made now (one per clinical encounter not listed yet). */
  created: number;
  /** Held encounter rows of this document after the step. */
  rows: number;
  /** Expected or requested rows marked received with this document. */
  received: number;
  closed: IngestionReport['gaps']['closed'];
}

function isExport(doc: typeof schema.documents.$inferSelect): boolean {
  const meta = parseJson<Record<string, unknown>>(doc.metadataJson, {});
  if (parseExportInfo(meta)) return true;
  return (meta.segmentation as { layout?: unknown } | undefined)?.layout === 'epic';
}

function inInbox(doc: typeof schema.documents.$inferSelect): boolean {
  const inbox = parseJson<Record<string, unknown>>(doc.metadataJson, {}).inbox as { status?: string } | undefined;
  return Boolean(inbox && typeof inbox.status === 'string' && (INBOX_ACTIVE_STATUSES as readonly string[]).includes(inbox.status));
}

function autoFilingOn(): boolean {
  try {
    return getSetting('filing.auto') !== false;
  } catch {
    return true;
  }
}

/**
 * One held records row per clinical encounter of an export, linked from its segments, then the expected or requested
 * rows they answer marked received (automatic filings with Undo). Not for a document waiting in Check before filing,
 * nor with automatic filing off. Idempotent. Returns what changed and the gaps that closed.
 */
export async function fileHeldEncounters(documentId: string): Promise<HeldResult> {
  const out: HeldResult = { created: 0, rows: 0, received: 0, closed: [] };
  const doc = liveDocumentRow(documentId);
  if (!doc || inInbox(doc) || !isExport(doc) || !autoFilingOn()) return out;
  const before = inferGaps({ resolveLikely: false });
  const segs = listSegments(documentId);
  for (const g of encounterGroupsOf(segs)) {
    if (!isHeldEncounter(g)) continue;
    const r = ensureEncounterHeldRow(g, doc);
    if (r.created) out.created++;
    if (!r.recordId) continue;
    out.rows++;
    for (const id of g.segmentIds) {
      const s = segs.find((x) => x.id === id);
      if (s && s.recordId !== r.recordId) updateSegment(id, { recordId: r.recordId });
    }
  }
  const open = openRowsHeldIn(documentId);
  if (open.length) {
    const filing = await import('./filing');
    out.received = filing.receiveRowsHeldInExport(documentId, open.map((o) => ({ rowId: o.rowId, title: o.title, heldRowId: o.hold.recordId, segmentIds: o.hold.segmentIds, pages: o.hold.pages }))).length;
  }
  const after = new Set(inferGaps({ resolveLikely: false }).map((g) => `${g.kind}:${g.id}`));
  const holds = encounterHolds(documentId);
  for (const g of before) {
    if (after.has(`${g.kind}:${g.id}`)) continue;
    const hold = holds.find((h) => matchesEncounterHold(gapRef(g), h));
    if (!hold) continue; // closed by something else meanwhile
    out.closed.push({ recordId: g.kind === 'inventory' ? g.id : hold.recordId, title: g.title.slice(0, 300), segmentId: hold.segmentIds[0] ?? null, pages: hold.pages });
  }
  return out;
}

function gapRef(g: Gap) {
  return { recordType: g.recordType, description: g.title, institution: g.institution, institutionId: g.institutionId, date: g.date, datePrecision: g.datePrecision };
}

/** Facts and messages of a document trusted below it (the patient's own words inside a clinical record). */
export function passagesBelowDocument(documentId: string): number {
  const doc = liveDocumentRow(documentId);
  if (!doc) return 0;
  const tier = normalizeTier(doc.sourceTier);
  let n = 0;
  for (const f of db()
    .select({ assertedBy: schema.facts.assertedBy, attributesJson: schema.facts.attributesJson })
    .from(schema.facts)
    .where(and(eq(schema.facts.sourceDocumentId, documentId), isNull(schema.facts.deletedAt), sql`${schema.facts.status} <> 'superseded'`))
    .all())
    if (factTier(tier, f) !== tier) n++;
  for (const c of db().select({ detailsJson: schema.communications.detailsJson }).from(schema.communications).where(and(eq(schema.communications.documentId, documentId), isNull(schema.communications.deletedAt))).all()) {
    const t = parseCommunicationDetails(c.detailsJson).tier;
    if (t && t !== tier) n++;
  }
  return n;
}

/** Open medication disagreements (dose, effect) that involve a detail of this document. */
export function medicationConflicts(documentId: string): number {
  const r = db().get<{ n: number }>(sql`
    select count(distinct fi.id) as n from findings fi
    join finding_evidence fe on fe.finding_id = fi.id
    join facts f on f.id = fe.fact_id
    where fi.deleted_at is null and fi.status in ('new', 'confirmed') and fi.rule_id in ('dose_disagreement', 'effect_disagreement')
      and f.source_document_id = ${documentId}`);
  return Number(r?.n ?? 0);
}

function medicationsFiled(documentId: string): number {
  const r = db().get<{ n: number }>(sql`
    select count(*) as n from filings
    where document_id = ${documentId} and target_type in ('medication', 'intolerance') and action in ('created', 'linked') and status in ('pending', 'confirmed')`);
  return Number(r?.n ?? 0);
}

function rangesOfPages(pages: number[]): PageRange[] {
  const out: PageRange[] = [];
  for (const p of [...new Set(pages)].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && p === last[1] + 1) last[1] = p;
    else out.push([p, p]);
  }
  return out;
}

/** The report's pages section from a coverage. */
function pagesSection(cov: DocumentCoverage): IngestionReport['pages'] {
  const byReason = new Map<string, number[]>();
  for (const [a, b, reason] of cov.skipRanges) {
    const list = byReason.get(reason) ?? [];
    for (let p = a; p <= b; p++) list.push(p);
    byReason.set(reason, list);
  }
  const covered = cov.pagesDone + cov.pagesParsed + cov.pagesSkipped.duplicate + cov.pagesSkipped.boilerplate + cov.pagesSkipped.blank + cov.pagesSkipped.no_text;
  return {
    total: cov.pagesTotal,
    covered,
    ocr: cov.pagesOcr,
    skipped: [...byReason.entries()].map(([reason, pages]) => ({ reason: reason as IngestionReport['pages']['skipped'][number]['reason'], count: pages.length, ranges: rangesOfPages(pages).slice(0, 200) })),
    failed: cov.failures.slice(0, 50).map((f) => ({ pages: f.pages, reason: f.reason.slice(0, 300) })),
    pending: cov.pagesPending + cov.pagesRunning,
  };
}

/** Threads of this document joined with a separately filed copy of one of their messages. */
function mergedWithFiled(documentId: string): IngestionReport['threads']['mergedWithFiled'] {
  const out: IngestionReport['threads']['mergedWithFiled'] = [];
  const rows = db()
    .select({ id: schema.communications.id, threadKey: schema.communications.threadKey, documentId: schema.communications.documentId, detailsJson: schema.communications.detailsJson })
    .from(schema.communications)
    .where(and(isNull(schema.communications.deletedAt), sql`(${schema.communications.documentId} = ${documentId} or instr(${schema.communications.detailsJson}, ${documentId}) > 0)`))
    .all();
  for (const r of rows) {
    const det = parseCommunicationDetails(r.detailsJson);
    for (const c of det.copies ?? []) {
      // The record's row gained a filed copy, or a filed row gained this record's copy.
      if (r.documentId === documentId && c.kind === 'filed_copy') out.push({ threadKey: r.threadKey ?? `c_${r.id}`, communicationId: r.id, filedDocumentId: c.documentId, pages: det.pages ?? null });
      else if (c.kind === 'record_copy' && c.documentId === documentId && r.documentId && r.documentId !== documentId && det.origin !== 'extracted') out.push({ threadKey: r.threadKey ?? `c_${r.id}`, communicationId: r.id, filedDocumentId: r.documentId, pages: c.pages });
    }
  }
  return out.slice(0, 200);
}

function communicationCounts(documentId: string): { byKind: Record<string, number>; threads: number } {
  const byKind: Record<string, number> = {};
  const threads = new Set<string>();
  for (const r of db()
    .select({ threadKey: schema.communications.threadKey, detailsJson: schema.communications.detailsJson })
    .from(schema.communications)
    .where(and(eq(schema.communications.documentId, documentId), isNull(schema.communications.deletedAt)))
    .all()) {
    const det = parseCommunicationDetails(r.detailsJson);
    if (det.origin !== 'extracted') continue;
    const k = det.kind ?? 'portal_message';
    byKind[k] = (byKind[k] ?? 0) + 1;
    if (r.threadKey) threads.add(r.threadKey);
  }
  return { byKind, threads: threads.size };
}

function heldRows(documentId: string): number {
  const r = db().get<{ n: number }>(sql`
    select count(distinct s.record_id) as n from document_segments s join records_inventory r on r.id = s.record_id and r.deleted_at is null
    where s.document_id = ${documentId} and s.superseded_at is null`);
  return Number(r?.n ?? 0);
}

/**
 * Writes the report of the last pass over a document (see the module comment), carrying over what this pass did not
 * redo (the communications counts of the last read, the people made, the gaps closed, the last findings run).
 */
export async function writeIngestionReport(
  documentId: string,
  input: { runId: string | null; imported: ImportResult | null; held: HeldResult | null; notes: string[]; afterExtraction?: boolean },
): Promise<IngestionReport | null> {
  const doc = liveDocumentRow(documentId);
  if (!doc) return null;
  const stored = readCoverage(documentId);
  const cov = stored ?? coverageSummary(documentId);
  const prev = stored?.report ?? null;
  const at = nowIso();
  // The document may have been sorted (its tier set) since its messages were read.
  refreshMessageTiers(documentId);
  const r = emptyIngestionReport(at, input.runId ?? prev?.runId ?? null);
  r.pages = pagesSection(cov);
  const counts = communicationCounts(documentId);
  const imp = input.imported;
  r.communications = imp
    ? { created: imp.created, updated: imp.updated, unchanged: imp.unchanged, byKind: counts.byKind }
    : { created: prev?.communications.created ?? 0, updated: prev?.communications.updated ?? 0, unchanged: prev?.communications.unchanged ?? 0, byKind: counts.byKind };
  r.threads = { created: imp ? imp.threadsCreated : (prev?.threads.created ?? 0), total: counts.threads, mergedWithFiled: mergedWithFiled(documentId) };
  const madeBefore = prev?.people.created ?? [];
  const made = [...madeBefore];
  for (const p of imp?.peopleCreated ?? []) if (!made.some((m) => m.personId === p.personId)) made.push(p);
  r.people = { created: made.slice(0, 200), suggested: (imp ? imp.peopleSuggested : (prev?.people.suggested ?? [])).slice(0, 200) };
  const closed = [...(prev?.gaps.closed ?? [])];
  for (const c of input.held?.closed ?? []) if (!closed.some((x) => x.recordId === c.recordId && x.title === c.title)) closed.push(c);
  let open = prev?.gaps.open ?? 0;
  try {
    open = inferGaps({ resolveLikely: false }).length;
  } catch {
    // keep the last count
  }
  r.gaps = { closed: closed.slice(0, 200), heldRowsCreated: heldRows(documentId), open };
  const below = passagesBelowDocument(documentId);
  r.trust = { passagesBelowDocument: below, changed: Math.abs(below - (prev?.trust.passagesBelowDocument ?? 0)) };
  r.medications = { filed: medicationsFiled(documentId), conflicts: medicationConflicts(documentId), reconciled: input.afterExtraction ? true : (prev?.medications.reconciled ?? false) };
  r.findings = prev?.findings ?? { new: 0, cleared: 0, runId: null };
  const notes: string[] = [];
  if (imp && !imp.skipped) {
    const n = imp.created + imp.updated + imp.unchanged;
    notes.push(`${n} ${n === 1 ? 'message, call or letter' : 'messages, calls and letters'} read into Calls & Messages (${imp.created} new) in ${counts.threads} ${counts.threads === 1 ? 'thread' : 'threads'}.`);
  }
  if (input.held?.created) notes.push(`${input.held.created} ${input.held.created === 1 ? 'encounter' : 'encounters'} listed in the records checklist as held inside this document.`);
  if (input.held?.received) notes.push(`${input.held.received} expected ${input.held.received === 1 ? 'record' : 'records'} marked received (Undo is on the document's filings).`);
  r.notes = [...notes, ...input.notes].slice(0, 30);
  const valid = ingestionReport.safeParse(r);
  if (!valid.success) {
    console.warn(`[ingest-report] report of ${documentId} did not validate: ${valid.error.issues.map((i) => i.path.join('.')).join(', ')}`);
    return null;
  }
  patchCoverageMeta(documentId, { report: valid.data });
  return valid.data;
}

/**
 * The findings a rules run made new or cleared whose evidence involves a document (cited in it, or a fact, message or
 * lab value read from it). The run itself is unscoped: its totals are the whole case's.
 */
export function findingsOfRunFor(runId: string, documentId: string): { created: number; cleared: number } {
  const started = db().select({ at: schema.crossrefRuns.startedAt }).from(schema.crossrefRuns).where(eq(schema.crossrefRuns.id, runId)).get()?.at ?? '';
  const row = db().get<{ created: number | null; cleared: number | null }>(sql`
    select
      sum(case when f.status = 'new' and f.created_at >= ${started} then 1 else 0 end) as created,
      sum(case when f.status = 'resolved' and f.verdict_note like ${`${AUTO_CLEARED_PREFIX}%`} and f.verdict_at >= ${started} then 1 else 0 end) as cleared
    from findings f
    where f.run_id = ${runId} and f.deleted_at is null and exists (
      select 1 from finding_evidence fe
      left join facts x on x.id = fe.fact_id
      left join communications c on c.id = fe.communication_id
      left join lab_results l on l.id = fe.lab_result_id
      where fe.finding_id = f.id
        and (fe.document_id = ${documentId} or x.source_document_id = ${documentId} or c.document_id = ${documentId} or l.document_id = ${documentId}))`);
  return { created: Number(row?.created ?? 0), cleared: Number(row?.cleared ?? 0) };
}

/** After the rules ran: the report gets the run's counts, the medication conflicts that involve the document and the open gaps. */
export function noteFindingsRun(documentId: string, run: { runId: string; created: number; cleared: number }): void {
  const cov = readCoverage(documentId);
  const prev = cov?.report;
  if (!prev) return;
  let open = prev.gaps.open;
  try {
    open = inferGaps({ resolveLikely: false }).length;
  } catch {
    // keep
  }
  const mine = findingsOfRunFor(run.runId, documentId);
  const next: IngestionReport = {
    ...prev,
    findings: { new: mine.created, cleared: mine.cleared, runId: run.runId, caseNew: run.created, caseCleared: run.cleared },
    medications: { ...prev.medications, conflicts: medicationConflicts(documentId) },
    gaps: { ...prev.gaps, open },
  };
  const valid = ingestionReport.safeParse(next);
  if (valid.success) patchCoverageMeta(documentId, { report: valid.data });
}

