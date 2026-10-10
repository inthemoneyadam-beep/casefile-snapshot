/**
 * Inbox: "I have a document but I do not know where it goes."
 *
 * A dropped file becomes an ordinary document (through the documents
 * service, so storage, hashing and ingestion are shared) with
 * `metadata_json.inbox = { status: 'new', receivedAt }` and an ingest job
 * that continues into `triage_document`. Triage (src/server/ingest/triage.ts)
 * stores a proposal under `metadata_json.triage`. Filing applies fields and
 * links only: it never deletes, moves, or re-creates anything, and running it
 * twice leaves the case as it was after the first run.
 */
import { and, desc, eq, getTableColumns, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../db';
import { createDocuments, updateDocument, type DocumentPatch, type DocumentRow, type UploadFile } from './documents';
import { enqueueJob, type JobRow } from '../jobs/queue';
import { createPerson } from './people';
import { createCommunication } from './communications';
import { createFromDocument, receiveRecord } from './records';
import { enqueueExtraction, loadPeopleIndex, type PeopleIndex } from './facts';
import { badRequest, conflict, notFound, zodIssues } from '../util/errors';
import { normalizeKey, nowIso, parseJson } from '../util/ids';
import { parsePartialDate } from '../../shared/dates';
import {
  fileInboxInput,
  INBOX_ACTIVE_STATUSES,
  INBOX_STATUSES,
  type FilingRecord,
  type InboxMeta,
  type InboxStatus,
  type TriageAction,
  type TriageMeta,
} from '../../shared/schemas/inbox';

export type { InboxMeta, InboxStatus, TriageMeta } from '../../shared/schemas/inbox';

export interface InboxItem extends DocumentRow {
  institutionName: string | null;
  authorName: string | null;
  /** Null for a document that is not in the Inbox (a plain upload, e.g. returned as a duplicate of a drop). */
  inbox: InboxMeta | null;
  triage: TriageMeta | null;
  /** Up to 800 characters of page 1, for the ledger and the detail pane. */
  firstPageSnippet: string;
}

export type InboxUpload = InboxItem & { duplicate: boolean; jobId: string | null };

const SNIPPET_CHARS = 800;

// ---------------------------------------------------------------------------
// metadata_json.inbox / .triage
// ---------------------------------------------------------------------------

export function readMeta(doc: Pick<DocumentRow, 'metadataJson'>): Record<string, unknown> {
  return parseJson<Record<string, unknown>>(doc.metadataJson, {});
}

export function readInbox(doc: Pick<DocumentRow, 'metadataJson'>): InboxMeta | null {
  const v = readMeta(doc).inbox;
  if (!v || typeof v !== 'object') return null;
  const m = v as Partial<InboxMeta>;
  if (!m.status || !(INBOX_STATUSES as readonly string[]).includes(m.status)) return null;
  return { receivedAt: m.receivedAt ?? '', ...m, status: m.status };
}

export function readTriage(doc: Pick<DocumentRow, 'metadataJson'>): TriageMeta | null {
  const v = readMeta(doc).triage;
  if (!v || typeof v !== 'object') return null;
  const t = v as Partial<TriageMeta>;
  return typeof t.title === 'string' && typeof t.category === 'string' ? (t as TriageMeta) : null;
}

function loadDocument(id: string): DocumentRow {
  const row = db()
    .select()
    .from(schema.documents)
    .where(and(eq(schema.documents.id, id), isNull(schema.documents.deletedAt)))
    .get();
  if (!row) throw notFound('document not found');
  return row;
}

/**
 * Merge a patch into metadata_json.inbox (and optionally replace .triage),
 * reading the row fresh so concurrent writers of other metadata keys are kept.
 */
export function writeInbox(id: string, patch: Partial<InboxMeta>, extra: { triage?: TriageMeta | null } = {}): InboxMeta {
  const doc = loadDocument(id);
  const meta = readMeta(doc);
  const current = readInbox(doc) ?? { status: 'new' as InboxStatus, receivedAt: doc.createdAt };
  const next: InboxMeta = { ...current, ...patch };
  meta.inbox = next;
  if (extra.triage !== undefined) {
    if (extra.triage === null) delete meta.triage;
    else meta.triage = extra.triage;
  }
  db().update(schema.documents).set({ metadataJson: JSON.stringify(meta), updatedAt: nowIso() }).where(eq(schema.documents.id, id)).run();
  return next;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const institutionNameSql = sql<string | null>`(select p.name from people p where p.id = "documents"."institution_id" and p.deleted_at is null)`;
const authorNameSql = sql<string | null>`(select p.name from people p where p.id = "documents"."author_person_id" and p.deleted_at is null)`;
const firstPageSql = sql<string | null>`(select substr(p.text, 1, ${SNIPPET_CHARS}) from document_pages p where p.document_id = "documents"."id" and p.page_number = 1)`;
const inboxStatusSql = sql`json_extract(${schema.documents.metadataJson}, '$.inbox.status')`;

type RawItem = DocumentRow & { institutionName: string | null; authorName: string | null; firstPage: string | null };

function toItem(r: RawItem): InboxItem {
  const { firstPage, ...doc } = r;
  return {
    ...doc,
    // No default: a document without inbox metadata was never inboxed and must not look like a new arrival.
    inbox: readInbox(doc),
    triage: readTriage(doc),
    firstPageSnippet: (firstPage ?? '').trim(),
  };
}

function baseSelect() {
  return db()
    .select({ ...getTableColumns(schema.documents), institutionName: institutionNameSql, authorName: authorNameSql, firstPage: firstPageSql })
    .from(schema.documents);
}

export interface InboxListFilter {
  /** Defaults to the active statuses (new, triaged, needs_manual). */
  statuses?: InboxStatus[];
  limit?: number;
}

/** Documents in the inbox, newest first. Filed and skipped rows only when asked for. */
export function listInbox(f: InboxListFilter = {}): InboxItem[] {
  const statuses = f.statuses && f.statuses.length ? f.statuses : [...INBOX_ACTIVE_STATUSES];
  const conds: SQL[] = [isNull(schema.documents.deletedAt), sql`${inboxStatusSql} in (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})`];
  const rows = baseSelect()
    .where(and(...conds))
    .orderBy(desc(schema.documents.createdAt))
    .limit(Math.min(Math.max(f.limit ?? 1000, 1), 5000))
    .all() as RawItem[];
  return rows.map(toItem);
}

export function getInboxItem(id: string): InboxItem {
  const row = baseSelect()
    .where(and(eq(schema.documents.id, id), isNull(schema.documents.deletedAt)))
    .get() as RawItem | undefined;
  if (!row) throw notFound('document not found');
  return toItem(row);
}

export function inboxCount(): { count: number; byStatus: Record<InboxStatus, number> } {
  const byStatus = { new: 0, triaged: 0, needs_manual: 0, filed: 0, skipped: 0 } as Record<InboxStatus, number>;
  const rows = db().all<{ status: string | null; n: number }>(
    sql`select json_extract(metadata_json, '$.inbox.status') as status, count(*) as n from documents where deleted_at is null and json_extract(metadata_json, '$.inbox.status') is not null group by status`,
  );
  for (const r of rows) if (r.status && r.status in byStatus) byStatus[r.status as InboxStatus] = r.n;
  return { count: INBOX_ACTIVE_STATUSES.reduce((n, s) => n + byStatus[s], 0), byStatus };
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Store files through the documents service, mark each new one as an inbox
 * item, and make its ingest job continue into triage. A file already in the
 * case (same sha256) is returned with `duplicate: true` and left as it is.
 */
export function createInboxDocuments(files: UploadFile[], opts: { title?: string } = {}): InboxUpload[] {
  const items = createDocuments(files, { category: 'other', title: opts.title, autoExtract: false });
  const d = db();
  const now = nowIso();
  return items.map((it) => {
    if (!it.duplicate) {
      const meta = readMeta(it);
      meta.inbox = { status: 'new', receivedAt: now } satisfies InboxMeta;
      d.update(schema.documents).set({ metadataJson: JSON.stringify(meta), updatedAt: now }).where(eq(schema.documents.id, it.id)).run();
      if (it.jobId) {
        // The ingest job was queued a moment ago by createDocuments and the worker only
        // polls between turns of the event loop, so the payload can still be widened.
        d.update(schema.jobs)
          .set({ payloadJson: JSON.stringify({ documentId: it.id, autoExtract: false, thenTriage: true }) })
          .where(and(eq(schema.jobs.id, it.jobId), eq(schema.jobs.status, 'queued')))
          .run();
      }
    }
    return { ...getInboxItem(it.id), duplicate: Boolean(it.duplicate), jobId: it.jobId ?? null };
  });
}

/** Pasted text becomes a .txt upload. */
export function textToUploadFile(text: string, title?: string | null): UploadFile {
  const body = text.replace(/\r\n?/g, '\n').trim();
  if (!body) throw badRequest('text is empty');
  const base = (title ?? '').trim().replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || `Pasted text ${nowIso().slice(0, 16).replace('T', ' ')}`;
  return { name: `${base}.txt`, mime: 'text/plain', buffer: Buffer.from(`${body}\n`, 'utf8') };
}

// ---------------------------------------------------------------------------
// Skip and re-triage
// ---------------------------------------------------------------------------

/**
 * While these run, the ingest pipeline holds a copy of metadata_json that it
 * writes back when extraction ends, so a skip or a filing made in that window
 * would be silently undone. Refuse instead; the client disables the keys.
 */
const READING = new Set(['extracting', 'ocr_running']);

function assertNotReading(doc: DocumentRow, what: string): void {
  if (READING.has(doc.textStatus)) throw conflict(`text extraction is still running; ${what} it when it has finished`);
}

/** Skip and file act on inbox items only; a plain document joins the Inbox through re-triage. */
function assertInInbox(doc: DocumentRow): void {
  if (!readInbox(doc)) throw conflict('this document is not in the Inbox; re-triage it to classify it and bring it in');
}

export function skipInboxDocument(id: string): InboxItem {
  const doc = loadDocument(id);
  assertInInbox(doc);
  assertNotReading(doc, 'skip');
  writeInbox(id, { status: 'skipped', skippedAt: nowIso() });
  return getInboxItem(id);
}

const INGESTING = new Set(['pending', 'extracting', 'ocr_running']);

/**
 * Queue a fresh triage pass. A document that was never in the inbox joins it
 * (status new), which is how an ordinary upload can be classified later.
 */
export function retriageInboxDocument(id: string): { job: JobRow; item: InboxItem } {
  const doc = loadDocument(id);
  if (INGESTING.has(doc.textStatus)) throw conflict('text extraction is still running; try again when it has finished');
  const current = readInbox(doc);
  const active = current && INBOX_ACTIVE_STATUSES.includes(current.status);
  writeInbox(id, active ? { error: null } : { status: 'new', receivedAt: current?.receivedAt || nowIso(), error: null });
  const job = enqueueJob({ type: 'triage_document', payload: { documentId: id }, documentId: id, dedupe: true });
  return { job, item: getInboxItem(id) };
}

// ---------------------------------------------------------------------------
// Filing
// ---------------------------------------------------------------------------

function personExists(id: string): boolean {
  return Boolean(db().select({ id: schema.people.id }).from(schema.people).where(and(eq(schema.people.id, id), isNull(schema.people.deletedAt))).get());
}

function findOrCreatePerson(name: string, kind: 'institution' | 'clinician', idx: PeopleIndex, created: string[]): string {
  const key = normalizeKey(name);
  const existing = key ? idx.get(key) : undefined;
  if (existing) return existing;
  const row = createPerson({ name: name.trim(), kind });
  if (key) idx.set(key, row.id);
  created.push(row.id);
  return row.id;
}

interface PersonChoice {
  newName: string | null | undefined;
  explicitId: string | null | undefined;
  matchId: string | null | undefined;
  proposedNewName: string | null | undefined;
  kind: 'institution' | 'clinician';
  label: string;
}

/**
 * undefined = leave the field alone, null = clear it, string = set it.
 * Order: an explicit new name, an explicit id, the proposal's match, the
 * proposal's new name (only when the create_person action is on).
 */
function choosePerson(c: PersonChoice, actions: Set<TriageAction>, idx: PeopleIndex, created: string[], warnings: string[]): string | null | undefined {
  if (c.newName && c.newName.trim()) return findOrCreatePerson(c.newName, c.kind, idx, created);
  if (c.explicitId !== undefined) {
    if (!c.explicitId) return null;
    if (!personExists(c.explicitId)) throw badRequest(`${c.label}: no such person ${c.explicitId}`);
    return c.explicitId;
  }
  if (c.matchId) {
    if (personExists(c.matchId)) return c.matchId;
    warnings.push(`${c.label}: proposed match ${c.matchId} no longer exists`);
  }
  if (actions.has('create_person') && c.proposedNewName && c.proposedNewName.trim()) return findOrCreatePerson(c.proposedNewName, c.kind, idx, created);
  return undefined;
}

export function linkEncounter(encounterId: string, documentId: string, warnings: string[]): string | null {
  const enc = db()
    .select({ id: schema.encounters.id, documentIdsJson: schema.encounters.documentIdsJson })
    .from(schema.encounters)
    .where(and(eq(schema.encounters.id, encounterId), isNull(schema.encounters.deletedAt)))
    .get();
  if (!enc) {
    warnings.push(`encounter ${encounterId} not found; not linked`);
    return null;
  }
  const ids = parseJson<string[]>(enc.documentIdsJson, []).filter((x) => typeof x === 'string');
  if (!ids.includes(documentId)) {
    db().update(schema.encounters).set({ documentIdsJson: JSON.stringify([...ids, documentId]), updatedAt: nowIso() }).where(eq(schema.encounters.id, encounterId)).run();
  }
  return encounterId;
}

export function receiveRows(rowIds: string[], documentId: string, warnings: string[]): string[] {
  const done: string[] = [];
  for (const rowId of [...new Set(rowIds)]) {
    const row = db()
      .select({ id: schema.recordsInventory.id, documentId: schema.recordsInventory.documentId, status: schema.recordsInventory.status })
      .from(schema.recordsInventory)
      .where(and(eq(schema.recordsInventory.id, rowId), isNull(schema.recordsInventory.deletedAt)))
      .get();
    if (!row) {
      warnings.push(`inventory row ${rowId} not found; not marked received`);
      continue;
    }
    if (row.documentId === documentId && row.status === 'received') {
      done.push(rowId);
      continue;
    }
    receiveRecord(rowId, { documentId });
    done.push(rowId);
  }
  return done;
}

export function existingCommunicationFor(documentId: string): string | null {
  return (
    db()
      .select({ id: schema.communications.id })
      .from(schema.communications)
      .where(and(eq(schema.communications.documentId, documentId), isNull(schema.communications.deletedAt)))
      .get()?.id ?? null
  );
}

/** Marks a communication summary that was copied from the classification, not written by the user. */
export const MODEL_SUMMARY_PREFIX = 'Model summary of the filed document (not checked): ';
/** Topic on communications created by filing, so their origin can be seen and filtered. */
export const FROM_INBOX_TOPIC = 'from inbox';

function hasPageText(documentId: string): boolean {
  return Boolean(db().get<{ n: number }>(sql`select count(*) as n from document_pages where document_id = ${documentId} and length(trim(text)) > 0`)?.n);
}

/**
 * File an inbox document: apply the (overridden) proposal to the document's
 * fields, create the people it names when asked, and make the requested
 * links. Everything is additive and idempotent.
 */
export function fileInboxDocument(id: string, raw: unknown): InboxItem {
  const r = fileInboxInput.safeParse(raw ?? {});
  if (!r.success) throw badRequest(zodIssues(r.error));
  const input = r.data;
  const doc = loadDocument(id);
  assertInInbox(doc);
  assertNotReading(doc, 'file');
  const triage = readTriage(doc);
  const o = input.overrides ?? {};
  const actions = new Set<TriageAction>(input.actions ?? []);
  const warnings: string[] = [];
  const createdPersonIds: string[] = [];
  const idx = loadPeopleIndex();

  // Fields ---------------------------------------------------------------
  const patch: DocumentPatch = {};
  const title = o.title !== undefined ? o.title : triage?.title;
  if (title && title.trim()) patch.title = title.trim();
  const category = o.category ?? triage?.category;
  if (category) patch.category = category;
  if (o.documentDateText !== undefined) {
    patch.documentDateText = o.documentDateText && o.documentDateText.trim() ? o.documentDateText.trim() : null;
  } else if (triage?.document_date) {
    const p = parsePartialDate(triage.document_date);
    if (p.iso) patch.documentDateText = triage.document_date;
    else if (!doc.documentDate) patch.documentDateText = triage.document_date;
    else warnings.push(`proposed date "${triage.document_date}" could not be parsed; the recorded date was kept`);
  }
  const institutionId = choosePerson(
    { newName: o.newInstitutionName, explicitId: o.institutionId, matchId: triage?.institution.match_id, proposedNewName: triage?.institution.new_name, kind: 'institution', label: 'institution' },
    actions,
    idx,
    createdPersonIds,
    warnings,
  );
  if (institutionId !== undefined) patch.institutionId = institutionId;
  const authorPersonId = choosePerson(
    { newName: o.newAuthorName, explicitId: o.authorPersonId, matchId: triage?.author.match_id, proposedNewName: triage?.author.new_name, kind: 'clinician', label: 'author' },
    actions,
    idx,
    createdPersonIds,
    warnings,
  );
  if (authorPersonId !== undefined) patch.authorPersonId = authorPersonId;
  if (o.sourceTier !== undefined && o.sourceTier !== doc.sourceTier) patch.sourceTier = o.sourceTier;
  if (Object.keys(patch).length) updateDocument(id, patch);
  // updateDocument marks any changed title as typed by the user. The model's title accepted as proposed is still
  // the model's: record it as 'ai' so the brief reports its origin and a later Re-title may replace it.
  const proposedTitle = triage?.title?.trim();
  if (patch.title && proposedTitle && patch.title === proposedTitle && patch.title !== doc.title) {
    db().update(schema.documents).set({ titleSource: 'ai' }).where(eq(schema.documents.id, id)).run();
  }

  // Links ----------------------------------------------------------------
  const encounterWanted = input.encounterId !== undefined ? input.encounterId : actions.has('link_encounter') ? (triage?.suggested_links.encounter_id ?? null) : null;
  const encounterId = encounterWanted ? linkEncounter(encounterWanted, id, warnings) : null;

  const rowIds = input.inventoryRowIds ?? (actions.has('mark_record_received') ? (triage?.suggested_links.inventory_row_ids ?? []) : []);
  const receivedInventoryRowIds = rowIds.length ? receiveRows(rowIds, id, warnings) : [];

  let inventoryRowId: string | null = null;
  if (actions.has('create_inventory_row')) inventoryRowId = createFromDocument({ documentId: id }).id;

  let communicationId: string | null = null;
  if (actions.has('create_communication')) {
    communicationId = existingCommunicationFor(id);
    if (!communicationId) {
      const after = loadDocument(id);
      const cat = after.category;
      const channel = triage?.contains.portal_thread ? 'portal' : triage?.contains.transcript ? 'call' : cat === 'portal_message' ? 'portal' : cat === 'call_transcript' ? 'call' : 'other';
      const participants: Array<{ personId: string; role: 'from' | 'present' }> = [];
      if (after.authorPersonId && personExists(after.authorPersonId)) participants.push({ personId: after.authorPersonId, role: 'from' });
      for (const pid of triage?.suggested_links.person_ids ?? []) {
        if (participants.some((p) => p.personId === pid) || !personExists(pid)) continue;
        participants.push({ personId: pid, role: 'present' });
      }
      const comm = createCommunication({
        subject: after.title,
        channel,
        direction: 'bidirectional',
        occurredAtText: after.documentDateText ?? after.documentDate ?? null,
        // The communications table has no origin column: say in the text itself that the model wrote it.
        summary: triage?.summary?.trim() ? `${MODEL_SUMMARY_PREFIX}${triage.summary.trim()}` : null,
        documentId: id,
        participants,
        topics: [FROM_INBOX_TOPIC],
      });
      communicationId = comm.id;
    }
  }

  let extractionQueued = false;
  if (actions.has('extract_facts')) {
    if (hasPageText(id)) {
      enqueueExtraction({ documentIds: [id] });
      extractionQueued = true;
    } else warnings.push('no page text yet; facts were not queued for extraction');
  }

  const filing: FilingRecord = {
    at: nowIso(),
    fields: patch as Record<string, unknown>,
    actions: [...actions],
    createdPersonIds,
    encounterId,
    receivedInventoryRowIds,
    inventoryRowId,
    communicationId,
    extractionQueued,
    warnings,
    proposal: triage ? { at: triage.at, model: triage.model, callId: triage.callId ?? null, title: triage.title } : null,
  };
  writeInbox(id, { status: 'filed', filedAt: filing.at, error: null, filing });
  return getInboxItem(id);
}

/** Ids of live people, for validating ids the model hands back. */
export function livePersonIds(ids: string[]): Set<string> {
  const want = [...new Set(ids.filter(Boolean))];
  if (!want.length) return new Set();
  return new Set(
    db()
      .select({ id: schema.people.id })
      .from(schema.people)
      .where(and(inArray(schema.people.id, want), isNull(schema.people.deletedAt)))
      .all()
      .map((r) => r.id),
  );
}
