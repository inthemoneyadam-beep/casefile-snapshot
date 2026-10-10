/**
 * Purge: the one path that removes a document for good, and the only caller
 * of `deleteFile` (src/server/files/store.ts).
 *
 * Order, all synchronous so nothing else runs in between:
 *   1. Checks: the document exists and is already in the trash (soft deleted);
 *      `confirmTitle` equals its title exactly; no job is running for it;
 *      the encrypted original decrypts and its sha256 matches the upload.
 *      Any failure refuses the purge with nothing written and nothing removed.
 *   2. The trash copy: the plaintext original is written to
 *      `<data>/trash/<YYYY-MM-DD>/<title>.<ext>` (never over an existing file,
 *      read back and its sha256 checked), then `<id>.json` beside it with the
 *      document's metadata, its facts with verdicts and citations, the ledger
 *      rows removed with it and every link that was cleared.
 *   3. One transaction removes the document's rows: the document, its pages,
 *      extraction runs and finished jobs, the facts drawn from it with their
 *      citations and merge proposals, every citation into its pages, the
 *      finding evidence pointing at any of those, and the lab and imaging rows
 *      tied to it (they are already hidden while the document is deleted).
 *      Rows the user owns elsewhere stay and only lose the link (recorded in
 *      the manifest): communications, records (a note line names the purged
 *      document), encounters, imaging DICOM links, medications, medication
 *      events and intolerances made from its facts, and other facts that
 *      pointed at its facts (superseded by, overridden by). Tasks are left as
 *      they are (their source simply no longer resolves, as while deleted).
 *   4. Only then the encrypted original leaves the file store, unless another
 *      row still names the same storage key.
 *
 * The trash copy is plaintext by design (CLAUDE.md, data safety): it is the
 * user's way back for 30 days. The app never deletes it; `keepUntil` in the
 * manifest says when it may be removed by hand.
 */
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, inArray, like, ne, or, sql } from 'drizzle-orm';
import { config } from '../config';
import { db, LockedError, schema } from '../db';
import { deleteFile, fileExists, getFile } from '../files/store';
import { clearFileCache } from './documents';
import { heldState } from './patient-check-state';
import { removeDocumentPagesIndex, removeEntityIndex, removeFactIndex } from './search';
import { badRequest, conflict, notFound } from '../util/errors';
import { nowIso, parseJson, sha256 } from '../util/ids';
import { todayIso } from '../../shared/dates';

/** Days a trash copy is meant to be kept (the manifest's keepUntil). */
export const TRASH_KEEP_DAYS = 30;

export interface PurgeActor {
  id: string;
  name: string;
}

export interface PurgeResult {
  ok: true;
  documentId: string;
  title: string;
  trash: {
    /** Absolute folder: <data>/trash/<YYYY-MM-DD>. */
    folder: string;
    /** File name of the plaintext original inside the folder. */
    file: string;
    /** File name of the JSON manifest inside the folder. */
    manifest: string;
    keepUntil: string;
  };
  removed: {
    pages: number;
    facts: number;
    citations: number;
    factMerges: number;
    findingEvidence: number;
    extractionRuns: number;
    jobs: number;
    labResults: number;
    imagingStudies: number;
  };
  unlinked: {
    communications: number;
    records: number;
    encounters: number;
    imagingDicomLinks: number;
    medications: number;
    medicationEvents: number;
    intolerances: number;
    recordSourceFacts: number;
    factPointers: number;
  };
  /** False when another row still names the same stored file, which was then kept. */
  originalRemoved: boolean;
}

const CHUNK = 400;

function chunks<T>(list: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

const RESERVED_WIN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const MIME_EXT: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/tiff': '.tif',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'application/json': '.json',
  'application/dicom': '.dcm',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};

/** The extension the trash copy keeps: the original file name's, else one from the stored type, else .bin. */
export function trashExtension(filename: string, mime: string): string {
  const ext = path.extname(filename || '').toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 12);
  if (ext && ext !== '.') return ext;
  return MIME_EXT[(mime || '').toLowerCase()] ?? '.bin';
}

/** A file name safe on Windows and elsewhere, from the document title. */
export function trashBaseName(title: string, ext: string): string {
  let base = (title || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/g, '');
  if (base.toLowerCase().endsWith(ext.toLowerCase())) base = base.slice(0, -ext.length).replace(/[. ]+$/g, '');
  if (!base) base = 'document';
  if (RESERVED_WIN.test(base)) base = `_${base}`;
  return base;
}

/** Write `data` to a new file in `dir` named `<base><suffix><ext>`, never over an existing one. Returns the name used. */
function writeNew(dir: string, base: string, ext: string, data: Buffer | string): string {
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? `${base}${ext}` : `${base} (${n})${ext}`;
    const full = path.join(dir, name);
    let fd: number | null = null;
    try {
      fd = fs.openSync(full, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    try {
      fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return name;
  }
  throw conflict('could not find a free file name in the trash folder');
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return todayIso(d);
}

function appendNote(notes: string | null, line: string): string {
  return notes && notes.trim() ? `${notes.trimEnd()}\n${line}` : line;
}

type DocRow = typeof schema.documents.$inferSelect;

/** The checks of step 1; returns the plaintext original. */
function checkPurgeable(doc: DocRow, confirmTitle: string): Buffer {
  if (!doc.deletedAt) throw conflict('only a document in the trash can be purged; delete it first');
  // Held back as "May be someone else's record" (2026-10-09): Not my record first, then the trash's purge.
  if (heldState(doc) === 'quarantined') throw conflict("this document may be someone else's record: answer Not my record first; it is then in Deleted documents");
  if ((confirmTitle ?? '').trim() !== doc.title.trim()) throw badRequest('confirmTitle does not match the document title; nothing was purged');
  const busy = db()
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.documentId, doc.id), eq(schema.jobs.status, 'running')))
    .get();
  if (busy) throw conflict('a job is still running for this document; wait for it to stop, then purge');
  if (!fileExists(doc.storageKey)) throw conflict('the encrypted original is missing from the file store, so no trash copy can be written; nothing was purged');
  let plain: Buffer;
  try {
    plain = getFile(doc.storageKey);
  } catch (err) {
    if (err instanceof LockedError) throw err;
    throw conflict('the encrypted original could not be decrypted, so no trash copy can be written; nothing was purged');
  }
  if (sha256(plain) !== doc.sha256) throw conflict('the stored original does not match the uploaded file (sha256 differs); nothing was purged');
  return plain;
}

/**
 * Purge a document that is in the trash. `confirmTitle` must equal its title.
 * The plaintext trash copy and its manifest are written and verified before
 * any row or the encrypted original is removed.
 */
export function purgeDocument(id: string, confirmTitle: string, actor: PurgeActor | null = null): PurgeResult {
  const d = db();
  const doc = d.select().from(schema.documents).where(eq(schema.documents.id, id)).get();
  if (!doc) throw notFound('document not found');
  const plain = checkPurgeable(doc, confirmTitle);

  // --- What goes, and what loses its link (read before anything changes) ---
  const facts = d.select().from(schema.facts).where(eq(schema.facts.sourceDocumentId, id)).all();
  const factIds = facts.map((f) => f.id);
  const factSet = new Set(factIds);
  const citations = d
    .select()
    .from(schema.citations)
    .where(factIds.length ? or(eq(schema.citations.documentId, id), ...chunks(factIds).map((c) => inArray(schema.citations.factId, c))) : eq(schema.citations.documentId, id))
    .all();
  const citationIds = citations.map((c) => c.id);
  const citationsByFact = new Map<string, typeof citations>();
  for (const c of citations) if (c.factId) citationsByFact.set(c.factId, [...(citationsByFact.get(c.factId) ?? []), c]);
  const runs = d.select().from(schema.extractionRuns).where(eq(schema.extractionRuns.documentId, id)).all();
  const pageCount = d.select({ n: sql<number>`count(*)` }).from(schema.documentPages).where(eq(schema.documentPages.documentId, id)).get()?.n ?? 0;
  const labs = d
    .select()
    .from(schema.labResults)
    .where(or(eq(schema.labResults.documentId, id), ...chunks(factIds).map((c) => inArray(schema.labResults.factId, c))))
    .all();
  const imaging = d
    .select()
    .from(schema.imagingStudies)
    .where(or(eq(schema.imagingStudies.documentId, id), ...chunks(factIds).map((c) => inArray(schema.imagingStudies.factId, c))))
    .all();
  const imagingIds = new Set(imaging.map((r) => r.id));
  const comms = d.select({ id: schema.communications.id, subject: schema.communications.subject }).from(schema.communications).where(eq(schema.communications.documentId, id)).all();
  const records = d.select({ id: schema.recordsInventory.id, title: schema.recordsInventory.title }).from(schema.recordsInventory).where(eq(schema.recordsInventory.documentId, id)).all();
  const encounters = d
    .select({ id: schema.encounters.id, title: schema.encounters.title, documentIdsJson: schema.encounters.documentIdsJson })
    .from(schema.encounters)
    .where(like(schema.encounters.documentIdsJson, `%${id}%`))
    .all()
    .filter((e) => parseJson<string[]>(e.documentIdsJson, []).includes(id));
  const dicomLinked = d
    .select({ id: schema.imagingStudies.id, title: schema.imagingStudies.title, dicomDocumentIdsJson: schema.imagingStudies.dicomDocumentIdsJson })
    .from(schema.imagingStudies)
    .where(like(schema.imagingStudies.dicomDocumentIdsJson, `%${id}%`))
    .all()
    .filter((r) => !imagingIds.has(r.id) && parseJson<string[]>(r.dicomDocumentIdsJson, []).includes(id));
  const byFacts = <T extends { id: string }>(rows: T[], key: (r: T) => string | null) => rows.filter((r) => {
    const k = key(r);
    return k !== null && factSet.has(k);
  });
  const meds = factIds.length ? byFacts(d.select({ id: schema.medications.id, name: schema.medications.name, sourceFactId: schema.medications.sourceFactId }).from(schema.medications).where(sql`${schema.medications.sourceFactId} is not null`).all(), (r) => r.sourceFactId) : [];
  const medEvents = factIds.length ? byFacts(d.select({ id: schema.medicationEvents.id, sourceFactId: schema.medicationEvents.sourceFactId }).from(schema.medicationEvents).where(sql`${schema.medicationEvents.sourceFactId} is not null`).all(), (r) => r.sourceFactId) : [];
  const intol = factIds.length ? byFacts(d.select({ id: schema.intolerances.id, substance: schema.intolerances.substance, sourceFactId: schema.intolerances.sourceFactId }).from(schema.intolerances).where(sql`${schema.intolerances.sourceFactId} is not null`).all(), (r) => r.sourceFactId) : [];
  const recordFacts = factIds.length ? byFacts(d.select({ id: schema.recordsInventory.id, sourceFactId: schema.recordsInventory.sourceFactId }).from(schema.recordsInventory).where(sql`${schema.recordsInventory.sourceFactId} is not null`).all(), (r) => r.sourceFactId) : [];
  const pointerFacts = factIds.length
    ? d
        .select({ id: schema.facts.id, supersededById: schema.facts.supersededById, overriddenByFactId: schema.facts.overriddenByFactId })
        .from(schema.facts)
        .where(or(sql`${schema.facts.supersededById} is not null`, sql`${schema.facts.overriddenByFactId} is not null`))
        .all()
        .filter((f) => !factSet.has(f.id) && ((f.supersededById && factSet.has(f.supersededById)) || (f.overriddenByFactId && factSet.has(f.overriddenByFactId))))
    : [];
  const tasks = d
    .select({ id: schema.tasks.id, title: schema.tasks.title, sourceType: schema.tasks.sourceType, sourceId: schema.tasks.sourceId })
    .from(schema.tasks)
    .where(or(and(eq(schema.tasks.sourceType, 'document'), eq(schema.tasks.sourceId, id)), ...chunks(factIds).map((c) => and(eq(schema.tasks.sourceType, 'fact'), inArray(schema.tasks.sourceId, c)))))
    .all();

  // --- Step 2: the trash copy, then the manifest ---
  const day = todayIso();
  const folder = path.join(config.dataDir, 'trash', day);
  fs.mkdirSync(folder, { recursive: true });
  const ext = trashExtension(doc.filename, doc.mime);
  const file = writeNew(folder, trashBaseName(doc.title, ext), ext, plain);
  const written = fs.readFileSync(path.join(folder, file));
  if (sha256(written) !== doc.sha256) throw conflict(`the trash copy ${file} did not read back intact; nothing was removed (the copy stays in ${folder})`);
  const keepUntil = addDays(day, TRASH_KEEP_DAYS);
  const purgedAt = nowIso();
  const { briefJson: _brief, ...docMeta } = doc;
  const manifest = {
    kind: 'casefile-purge',
    version: 1,
    purgedAt,
    keepUntil,
    purgedBy: actor,
    trashFile: file,
    sha256: doc.sha256,
    sizeBytes: plain.length,
    document: (({ metadataJson, tagsJson, ...rest }) => ({ ...rest, metadata: parseJson<unknown>(metadataJson, null), tags: parseJson<unknown>(tagsJson, []) }))(docMeta),
    pages: pageCount,
    extractionRuns: runs.map((r) => ({ id: r.id, model: r.model, schemaVersion: r.schemaVersion, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, factsCount: r.factsCount })),
    facts: facts.map(({ attributesJson, ...f }) => ({ ...f, attributes: parseJson<unknown>(attributesJson, {}), citations: (citationsByFact.get(f.id) ?? []).map(({ factId: _f, ...c }) => c) })),
    otherCitations: citations.filter((c) => !c.factId || !factSet.has(c.factId)),
    removedRows: { labResults: labs, imagingStudies: imaging },
    clearedLinks: {
      communications: comms,
      records,
      encounters: encounters.map((e) => ({ id: e.id, title: e.title })),
      imagingDicom: dicomLinked.map((r) => ({ id: r.id, title: r.title })),
      medications: meds.map((m) => ({ id: m.id, name: m.name, sourceFactId: m.sourceFactId })),
      medicationEvents: medEvents,
      intolerances: intol.map((i) => ({ id: i.id, substance: i.substance, sourceFactId: i.sourceFactId })),
      recordSourceFacts: recordFacts,
      factPointers: pointerFacts,
    },
    tasksStillReferring: tasks,
  };
  const manifestName = writeNew(folder, id, '.json', `${JSON.stringify(manifest, null, 2)}\n`);

  // --- Step 3: the rows ---
  const now = purgedAt;
  const removed = { pages: 0, facts: 0, citations: 0, factMerges: 0, findingEvidence: 0, extractionRuns: 0, jobs: 0, labResults: 0, imagingStudies: 0 };
  const unlinked = { communications: 0, records: 0, encounters: 0, imagingDicomLinks: 0, medications: 0, medicationEvents: 0, intolerances: 0, recordSourceFacts: 0, factPointers: 0 };
  d.transaction((tx) => {
    for (const c of chunks(citationIds)) {
      removed.findingEvidence += tx.delete(schema.findingEvidence).where(inArray(schema.findingEvidence.citationId, c)).run().changes;
    }
    for (const c of chunks(factIds)) {
      removed.findingEvidence += tx.delete(schema.findingEvidence).where(inArray(schema.findingEvidence.factId, c)).run().changes;
      removed.factMerges += tx.delete(schema.factMerges).where(or(inArray(schema.factMerges.factIdA, c), inArray(schema.factMerges.factIdB, c))).run().changes;
    }
    removed.findingEvidence += tx.delete(schema.findingEvidence).where(eq(schema.findingEvidence.documentId, id)).run().changes;
    for (const c of chunks(citationIds)) removed.citations += tx.delete(schema.citations).where(inArray(schema.citations.id, c)).run().changes;
    for (const c of chunks(labs.map((r) => r.id))) removed.labResults += tx.delete(schema.labResults).where(inArray(schema.labResults.id, c)).run().changes;
    for (const c of chunks([...imagingIds])) removed.imagingStudies += tx.delete(schema.imagingStudies).where(inArray(schema.imagingStudies.id, c)).run().changes;

    for (const c of chunks(comms.map((r) => r.id))) unlinked.communications += tx.update(schema.communications).set({ documentId: null, updatedAt: now }).where(inArray(schema.communications.id, c)).run().changes;
    const recordRows = records.length ? tx.select({ id: schema.recordsInventory.id, notes: schema.recordsInventory.notes }).from(schema.recordsInventory).where(inArray(schema.recordsInventory.id, records.map((r) => r.id))).all() : [];
    for (const r of recordRows) {
      const line = `${day}: the linked document "${doc.title}" was purged (trash copy in trash/${day}/${file}).`;
      unlinked.records += tx.update(schema.recordsInventory).set({ documentId: null, notes: appendNote(r.notes, line), updatedAt: now }).where(eq(schema.recordsInventory.id, r.id)).run().changes;
    }
    for (const e of encounters) {
      const ids = parseJson<string[]>(e.documentIdsJson, []).filter((x) => x !== id);
      unlinked.encounters += tx.update(schema.encounters).set({ documentIdsJson: JSON.stringify(ids), updatedAt: now }).where(eq(schema.encounters.id, e.id)).run().changes;
    }
    for (const r of dicomLinked) {
      const ids = parseJson<string[]>(r.dicomDocumentIdsJson, []).filter((x) => x !== id);
      unlinked.imagingDicomLinks += tx.update(schema.imagingStudies).set({ dicomDocumentIdsJson: JSON.stringify(ids), updatedAt: now }).where(eq(schema.imagingStudies.id, r.id)).run().changes;
    }
    for (const c of chunks(meds.map((r) => r.id))) unlinked.medications += tx.update(schema.medications).set({ sourceFactId: null, updatedAt: now }).where(inArray(schema.medications.id, c)).run().changes;
    for (const c of chunks(medEvents.map((r) => r.id))) unlinked.medicationEvents += tx.update(schema.medicationEvents).set({ sourceFactId: null }).where(inArray(schema.medicationEvents.id, c)).run().changes;
    for (const c of chunks(intol.map((r) => r.id))) unlinked.intolerances += tx.update(schema.intolerances).set({ sourceFactId: null, updatedAt: now }).where(inArray(schema.intolerances.id, c)).run().changes;
    for (const c of chunks(recordFacts.map((r) => r.id))) unlinked.recordSourceFacts += tx.update(schema.recordsInventory).set({ sourceFactId: null, updatedAt: now }).where(inArray(schema.recordsInventory.id, c)).run().changes;
    for (const f of pointerFacts) {
      const set: Partial<typeof schema.facts.$inferInsert> = { updatedAt: now };
      if (f.supersededById && factSet.has(f.supersededById)) set.supersededById = null;
      if (f.overriddenByFactId && factSet.has(f.overriddenByFactId)) {
        set.overriddenByFactId = null;
        set.overrideReason = null;
      }
      unlinked.factPointers += tx.update(schema.facts).set(set).where(eq(schema.facts.id, f.id)).run().changes;
    }

    for (const c of chunks(factIds)) removed.facts += tx.delete(schema.facts).where(inArray(schema.facts.id, c)).run().changes;
    removed.pages = tx.delete(schema.documentPages).where(eq(schema.documentPages.documentId, id)).run().changes;
    removed.extractionRuns = tx.delete(schema.extractionRuns).where(eq(schema.extractionRuns.documentId, id)).run().changes;
    removed.jobs = tx.delete(schema.jobs).where(and(eq(schema.jobs.documentId, id), ne(schema.jobs.status, 'running'))).run().changes;
    tx.delete(schema.documents).where(eq(schema.documents.id, id)).run();

    // Search rows (same connection, so inside this transaction).
    removeDocumentPagesIndex(id);
    removeEntityIndex('document', id);
    for (const fid of factIds) removeFactIndex(fid);
    for (const r of labs) removeEntityIndex('lab', r.id);
    for (const r of imaging) removeEntityIndex('imaging', r.id);
  });

  // --- Step 4: the encrypted original, unless another row still names it ---
  const shared =
    d.select({ id: schema.documents.id }).from(schema.documents).where(eq(schema.documents.storageKey, doc.storageKey)).get() ??
    d.select({ id: schema.exportPackets.id }).from(schema.exportPackets).where(eq(schema.exportPackets.storageKey, doc.storageKey)).get();
  if (!shared) deleteFile(doc.storageKey);
  clearFileCache();

  return {
    ok: true,
    documentId: id,
    title: doc.title,
    trash: { folder, file, manifest: manifestName, keepUntil },
    removed,
    unlinked,
    originalRemoved: !shared,
  };
}
