/**
 * Run hooks between the ingestion packages (2026-10-07, large exports and the messages inside them).
 *
 * FROZEN SIGNATURES (WP0). WP-A calls `afterSegmentation` at the end of every segmentation that wrote segments
 * (segments service); WP-B calls `afterPass` at the end of every extraction pass (done, partial, failed or cancelled),
 * after its own afterExtraction, registers `rulesAfterIngestJob` as the handler of the `rules_after_ingest` job, and
 * calls `afterUnlock` once per unlock. WP-C (this file) fills the bodies:
 * - afterSegmentation: the messages, telephone notes, letters and questionnaires read into Calls & Messages (no AI;
 *   services/messages-import.ts), people found or added (suggestions otherwise), one held records row per clinical
 *   encounter of an export and the gaps those rows close (expected rows received as automatic filings with Undo), the
 *   document's old messaging-act facts set aside, then the ingestion report;
 * - afterPass: the same catch-up (idempotent), trust markers counted with effectiveTier, medication filings counted,
 *   and the report for the pass;
 * - afterUnlock: the one-time messaging-act clean-up (`migration.messagingActsV1`), a fresh read of documents parsed by
 *   an older parser, and calls linked to the messages they name;
 * - rulesAfterIngestJob: one unscoped rules-only Findings run (gaps, follow-ups, disagreements; stale ones cleared),
 *   then each document's report gets the counts and the medication conflicts that involve it.
 *
 * Every hook is best effort: it never throws into its caller (errors are caught, logged without record text, and kept
 * in the report's notes), gets the database with db() at call time, and is safe to run twice (idempotent by
 * `communications.external_key`, segment parse versions, segment record links and finding fingerprints). Heavier
 * modules are imported when a hook runs, so this file adds no import cycle to the segments service.
 */
import type { JobContext } from '../jobs/queue';
import type { DocumentCoverage, IngestionReport } from '../../shared/schemas/segments';

/** What a segmentation did (passed by the segments service). */
export interface SegmentationSummary {
  documentId: string;
  reason: 'ingest' | 'unlock' | 'reprocess' | 'user';
  segmenterVersion: number;
  segments: { created: number; superseded: number; kept: number; total: number };
  /** Live segments whose route parses (messages, notes, letters, questionnaires) and whose parse is missing or older than the segmenter. */
  toParse: string[];
  /** Pages whose text changed in this run (OCR appended): their citations were re-verified. */
  ocrPages: number[];
}

export interface AfterSegmentationResult {
  messages: number;
  notes: number;
  letters: number;
  questionnaires: number;
  communicationsCreated: number;
  communicationsUpdated: number;
  /** Set when nothing was done, in words ("not wired yet"). */
  skipped?: string;
}

/** What an extraction pass did (passed by the extraction engine). */
export interface PassEndInfo {
  documentId: string;
  runId: string;
  outcome: 'done' | 'partial' | 'failed' | 'cancelled';
  /** Segments read (settled or failed) in this pass. */
  segmentIds: string[];
  factsCreated: number;
  /** The coverage after the pass, already written to metadata_json.coverage. */
  coverage: DocumentCoverage;
}

export interface AfterPassResult {
  /** The report written to metadata_json.coverage.report, or null when nothing was written. */
  report: IngestionReport | null;
}

/** Payload of the `rules_after_ingest` job (debounced and de-duplicated by the queue owner). */
export interface RulesAfterIngestPayload {
  /** The documents whose passes triggered the run; the rules themselves run over the whole ledger (unscoped). */
  documentIds: string[];
  trigger: 'ingestion' | 'unlock' | 'reprocess';
}

export interface RulesAfterIngestResult {
  runId: string | null;
  newFindings: number;
  cleared: number;
  skipped?: string;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** After a document's segments were written: parse its messages and notes into Calls & Messages (no AI). */
export async function afterSegmentation(documentId: string, summary: SegmentationSummary): Promise<AfterSegmentationResult> {
  const out: AfterSegmentationResult = { messages: 0, notes: 0, letters: 0, questionnaires: 0, communicationsCreated: 0, communicationsUpdated: 0 };
  const notes: string[] = [];
  // The wrong-patient guard (2026-10-09): a document whose pages name someone else is held back before its messages,
  // held records or people are filed ("It's mine" runs this hook again).
  if ((await import('./patient-check')).holdsBeforeDetails(documentId)) return { ...out, skipped: "held back: it may be someone else's record" };
  try {
    const mi = await import('./messages-import');
    const force = summary.reason === 'reprocess' || summary.reason === 'user';
    let imported: Awaited<ReturnType<typeof mi.importDocumentMessages>> | null = null;
    if (force || summary.toParse.length || mi.needsImport(documentId)) {
      imported = await mi.importDocumentMessages(documentId, { force });
      if (imported.skipped) out.skipped = imported.skipped;
      out.messages = imported.messages;
      out.notes = imported.notes;
      out.letters = imported.letters;
      out.questionnaires = imported.questionnaires;
      out.communicationsCreated = imported.created;
      out.communicationsUpdated = imported.updated;
    } else out.skipped = mi.parsedSegmentsOf(documentId).length ? 'already read' : 'nothing to read';
    const report = await import('./ingest-report');
    const held = await safely(() => report.fileHeldEncounters(documentId), notes, 'records held inside the export');
    if (imported && !imported.skipped) await safely(() => mi.supersedeMessagingActs({ documentId }), notes, 'old messaging-act details');
    await safely(() => report.writeIngestionReport(documentId, { runId: null, imported, held, notes }), notes, 'the report');
  } catch (err) {
    console.warn(`[ingest-hooks] after segmentation of ${documentId}: ${messageOf(err)}`);
    out.skipped = `could not read the messages: ${messageOf(err)}`.slice(0, 300);
  }
  return out;
}

async function safely<T>(fn: () => T | Promise<T>, notes: string[], what: string): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[ingest-hooks] ${what}: ${messageOf(err)}`);
    notes.push(`Could not finish ${what}: ${messageOf(err)}`.slice(0, 300));
    return null;
  }
}

/** After an extraction pass: trust markers, held records per encounter, people suggestions, the ingestion report. */
export async function afterPass(documentId: string, info: PassEndInfo): Promise<AfterPassResult> {
  const notes: string[] = [];
  try {
    const mi = await import('./messages-import');
    const report = await import('./ingest-report');
    // A document read before its messages were (filed from Check before filing, or cut by an older parser).
    const imported = mi.needsImport(documentId) ? await safely(() => mi.importDocumentMessages(documentId), notes, 'the messages') : null;
    const held = await safely(() => report.fileHeldEncounters(documentId), notes, 'records held inside the export');
    await safely(() => mi.supersedeMessagingActs({ documentId }), notes, 'old messaging-act details');
    if (info.outcome === 'partial') notes.push('The reading stopped part-way; the rest is read when it carries on.');
    if (info.outcome === 'failed') notes.push('The reading failed before any page was done.');
    if (info.outcome === 'cancelled') notes.push('The reading was stopped.');
    const written = await report.writeIngestionReport(documentId, { runId: info.runId, imported: imported && !imported.skipped ? imported : null, held, notes, afterExtraction: info.outcome !== 'cancelled' });
    return { report: written };
  } catch (err) {
    console.warn(`[ingest-hooks] after the pass of ${documentId}: ${messageOf(err)}`);
    return { report: null };
  }
}

/** What the after-unlock step of the communications side did. */
export interface AfterUnlockResult {
  /** Documents whose messages were parsed again (parse version older than the segmenter's). */
  reparsed: number;
  /** One-time clean-ups that ran (by their setting key, e.g. "migration.messagingActsV1"). */
  cleanups: string[];
  skipped?: string;
}

/**
 * Called once per unlock by the after-unlock sequence (WP-B, src/server/index.ts), after the evidence snapshot, the
 * repair and segmentation have been queued, before any resume: one-time clean-ups guarded by their own setting (the
 * "sent a portal message" event facts are superseded, never deleted, and linked to their communication), a fresh
 * message import for documents parsed by an older segmenter, and calls linked to the messages they name.
 */
export async function afterUnlock(): Promise<AfterUnlockResult> {
  const out: AfterUnlockResult = { reparsed: 0, cleanups: [] };
  try {
    const mi = await import('./messages-import');
    const { db, schema } = await import('../db');
    const { isNull, sql } = await import('drizzle-orm');
    const docs = db()
      .selectDistinct({ id: schema.documentSegments.documentId })
      .from(schema.documentSegments)
      .innerJoin(schema.documents, sql`${schema.documents.id} = ${schema.documentSegments.documentId} and ${schema.documents.deletedAt} is null`)
      .where(isNull(schema.documentSegments.supersededAt))
      .all();
    for (const { id } of docs) {
      try {
        if (!mi.needsImport(id)) continue;
        const r = await mi.importDocumentMessages(id);
        if (!r.skipped) {
          out.reparsed++;
          mi.supersedeMessagingActs({ documentId: id });
          const report = await import('./ingest-report');
          const held = await report.fileHeldEncounters(id);
          await report.writeIngestionReport(id, { runId: null, imported: r, held, notes: [] });
        }
      } catch (err) {
        console.warn(`[ingest-hooks] reading the messages of ${id} after unlock: ${messageOf(err)}`);
      }
    }
    const once = mi.supersedeMessagingActsOnce();
    if (once) out.cleanups.push(mi.MESSAGING_ACTS_SETTING);
    const threads = await import('./threads');
    threads.linkCallMentions();
  } catch (err) {
    console.warn(`[ingest-hooks] after unlock: ${messageOf(err)}`);
    out.skipped = messageOf(err).slice(0, 300);
  }
  return out;
}

/** The `rules_after_ingest` job: one unscoped rules-only Findings run (gaps, follow-ups, disagreements), stale ones cleared. */
export async function rulesAfterIngestJob(ctx: JobContext<RulesAfterIngestPayload>): Promise<RulesAfterIngestResult> {
  const ids = Array.isArray(ctx.payload?.documentIds) ? ctx.payload.documentIds.filter((x): x is string => typeof x === 'string') : [];
  const trigger = ctx.payload?.trigger ?? 'ingestion';
  if (ctx.signal?.aborted) return { runId: null, newFindings: 0, cleared: 0, skipped: 'stopped' };
  const findings = await import('./findings');
  ctx.setProgress?.(0.05, 'checking the case after reading');
  // The run reads the whole ledger (unscoped), so gaps a new document closed and findings it settled are cleared.
  const run = findings.createRun({ rulesOnly: true, scope: { trigger, rule: 'after_ingest', triggeredByDocumentIds: ids.slice(0, 50) } as never });
  let rules: ReturnType<typeof findings.runRulesForRun>;
  try {
    rules = findings.runRulesForRun(run.id);
    findings.finishRun(run.id, { status: 'done' });
  } catch (err) {
    findings.finishRun(run.id, { status: 'failed', error: `The rules stopped with an error: ${messageOf(err)}` });
    throw err;
  }
  ctx.setProgress?.(0.8, 'noting what changed');
  try {
    const report = await import('./ingest-report');
    for (const id of ids) {
      if (ctx.stillOwned && !ctx.stillOwned()) break;
      report.noteFindingsRun(id, { runId: run.id, created: rules.created, cleared: rules.retired });
    }
  } catch (err) {
    console.warn(`[ingest-hooks] findings counts: ${messageOf(err)}`);
  }
  ctx.setProgress?.(1, `${rules.created} new, ${rules.retired} cleared`);
  return { runId: run.id, newFindings: rules.created, cleared: rules.retired };
}
