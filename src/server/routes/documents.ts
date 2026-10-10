import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { badRequest, conflict, HttpError, zodIssues } from '../util/errors';
import { AUTHOR_ROLES, DOCUMENT_CATEGORIES, DOCUMENT_KINDS, EXTRACTION_STATUSES, SOURCE_TIERS, TEXT_STATUSES } from '../../shared/enums';
import {
  createDocuments,
  deleteDocument,
  getDocument,
  getDocumentBrief,
  getDocumentFile,
  getPageImage,
  classifyPendingDocuments,
  getPageWindow,
  listDeletedDocuments,
  listDocuments,
  rebuildDocumentBrief,
  reingestDocument,
  requestExtraction,
  requestRetitle,
  restoreDocument,
  updateDocument,
  type UploadFile,
} from '../services/documents';
import { classificationAvailable } from '../ingest/triage';
import { currentUser } from '../auth';
import { config } from '../config';
import { importFolder } from '../services/folder-import';
import { purgeDocument } from '../services/document-purge';
import { keepBothCopies, setAsideCopy } from '../services/duplicates';
import { documentOutline, listSegments, readUploadRecord, toSegmentView, uploadConfirmation } from '../services/segments';
import { currentCoverage, decideResume, estimateRemaining, extractionDiagnostics, liveDocumentIds, requestReprocess } from '../services/reprocess';
import { reprocessRequest, type SegmentEstimate, type UploadConfirmation } from '../../shared/schemas/segments';
import { LONG_TEXT_MAX } from '../../shared/constants';
import { documentCheck, withPatientNote } from '../services/patient-check';
import { quarantinedIds } from '../services/patient-check-state';

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

const listQuery = z.object({
  q: z.string().trim().max(200).optional(),
  category: z.enum(DOCUMENT_CATEGORIES).optional(),
  kind: z.enum(DOCUMENT_KINDS).optional(),
  textStatus: z.enum(TEXT_STATUSES).optional(),
  extractionStatus: z.enum(EXTRACTION_STATUSES).optional(),
  institutionId: z.string().max(64).optional(),
  tier: z.enum(SOURCE_TIERS).optional(),
  sort: z.enum(['date', '-date', 'title', '-title', 'added', '-added', 'pages', '-pages', 'tier', '-tier']).optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
  /** Only the likely copies (services/duplicates.ts). */
  copies: z
    .enum(['1', '0', 'true', 'false'])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
  /** Documents held back as "May be someone else's record": include them (the Documents page) or list only them. */
  patient: z.enum(['include', 'only']).optional(),
});

const patchBody = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    category: z.enum(DOCUMENT_CATEGORIES).optional(),
    documentDateText: z.string().max(120).nullable().optional(),
    documentDate: z.string().max(10).nullable().optional(),
    institutionId: z.string().max(64).nullable().optional(),
    authorPersonId: z.string().max(64).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
    notes: z.string().max(LONG_TEXT_MAX).nullable().optional(),
    sourceTier: z.enum(SOURCE_TIERS).optional(),
    authorRole: z.enum(AUTHOR_ROLES).nullable().optional(),
  })
  .strict();

const pagesQuery = z.object({ from: z.coerce.number().int().min(1).optional(), to: z.coerce.number().int().min(1).optional() });
const imageQuery = z.object({ scale: z.coerce.number().min(0.25).max(4).optional() });
const reingestBody = z.object({ forceOcr: z.boolean().optional() }).partial();
const pageRangeInput = z.tuple([z.number().int().min(1), z.number().int().min(1)]).refine(([a, b]) => b >= a, { message: 'a range ends on or after its first page' });
const extractBody = z
  .object({
    deep: z.boolean().optional(),
    /** missing: carry on; failed: only what failed; whole: everything again; pages: the given ranges. Default: whole for a finished document, else missing. */
    scope: z.enum(['missing', 'failed', 'whole', 'pages']).optional(),
    pages: z.array(pageRangeInput).min(1).max(200).optional(),
  })
  .partial();
/** Continue reading: the rest (default), only what failed, or everything again; `confirm` says yes to an estimate above the ceiling. */
const resumeBody = z
  .object({
    confirm: z.boolean().optional(),
    deep: z.boolean().optional(),
    scope: z.enum(['missing', 'failed', 'whole', 'pages']).optional(),
    pages: z.array(pageRangeInput).min(1).max(200).optional(),
  })
  .strict();
const estimateQuery = z.object({ scope: z.enum(['missing', 'failed', 'whole']).optional(), deep: z.enum(['0', '1', 'true', 'false']).optional() });
const confirmationsQuery = z.object({ ids: z.string().trim().min(1).max(50 * 70) });
const importFolderBody = z
  .object({
    path: z.string().trim().min(1).max(1000),
    recursive: z.boolean().optional(),
    category: z.enum(DOCUMENT_CATEGORIES).optional(),
    autoExtract: z.boolean().optional(),
    toInbox: z.boolean().optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();
const purgeBody = z.object({ confirmTitle: z.string().max(1000) }).strict();
/** Keep both and Set this copy aside take no fields. */
const copyAnswerBody = z.object({}).strict();
const documentId = z.string().trim().min(1).max(64);

/** Drop empty strings so `?category=` means "no filter". */
function cleanQuery(q: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(q).filter(([, v]) => v !== ''));
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw badRequest(zodIssues(r.error));
  return r.data;
}

async function jsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function asBody(buf: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
}

/**
 * Types an original may be shown inline as: none of them can run script.
 * Anything else (HTML, SVG, XML and every type kept from older uploads) goes
 * out as an opaque download, so an uploaded page never runs on the app's
 * origin with the session cookie. Decided here, from the stored type, so rows
 * written before uploads were sanitised are covered too.
 */
export const INLINE_SAFE_MIMES: ReadonlySet<string> = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'text/plain', 'application/json']);

/**
 * A sandboxed, script-free policy for everything served from the file store.
 * PDFs are left without it: the browsers' built-in PDF viewers refuse to run
 * in a sandboxed document, and a PDF served as application/pdf with nosniff
 * cannot run script on the origin anyway.
 */
const FILE_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";

/**
 * Decrypted originals and page renders are never cached by the browser (its
 * disk cache would keep plaintext pages after the case is locked); the server
 * keeps its own in-memory render cache, cleared on lock.
 */
const NO_STORE = 'no-store';

export function fileResponseHeaders(storedMime: string, filename: string, download: boolean, length: number): Record<string, string> {
  const mime = (storedMime || '').toLowerCase().split(';')[0].trim();
  const inline = INLINE_SAFE_MIMES.has(mime);
  const headers: Record<string, string> = {
    'content-type': inline ? mime : 'application/octet-stream',
    'content-length': String(length),
    'content-disposition': contentDisposition(inline && !download ? 'inline' : 'attachment', filename),
    'cache-control': NO_STORE,
    'x-content-type-options': 'nosniff',
  };
  if (mime !== 'application/pdf') headers['content-security-policy'] = FILE_CSP;
  return headers;
}

export const documentsRoutes = new Hono()
  .post(
    '/',
    bodyLimit({
      maxSize: MAX_UPLOAD_BYTES,
      onError: (c) => c.json({ error: 'upload too large (2 GB limit)' }, 413),
    }),
    async (c) => {
      const body = await c.req.parseBody({ all: true });
      const files: UploadFile[] = [];
      for (const key of ['files', 'files[]', 'file']) {
        const v = body[key];
        const list = Array.isArray(v) ? v : v !== undefined ? [v] : [];
        for (const item of list) {
          if (typeof item === 'string' || !item) continue;
          files.push({ name: item.name, mime: item.type || null, buffer: Buffer.from(await item.arrayBuffer()) });
        }
      }
      if (!files.length) throw badRequest('send one or more files in the "files" field');
      const opts = parse(
        z.object({
          category: z.enum(DOCUMENT_CATEGORIES).optional(),
          title: z.string().trim().max(500).optional(),
          autoExtract: z.enum(['0', '1', 'true', 'false']).optional(),
        }),
        cleanQuery(Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === 'string')) as Record<string, string>),
      );
      const items = createDocuments(files, { category: opts.category, title: opts.title, autoExtract: !(opts.autoExtract === '0' || opts.autoExtract === 'false') });
      return c.json({ items }, 201);
    },
  )
  .get('/', (c) => {
    const f = parse(listQuery, cleanQuery(c.req.query()));
    return c.json({ items: listDocuments(f) });
  })
  // Registered before '/:id' so "trash" is never read as a document id.
  .get('/trash', (c) => c.json({ items: listDeletedDocuments() }))
  // Also before '/:id': queue a classification for every document that never had one (uploaded before
  // classification ran for every upload, or while AI was off). Never re-extracts.
  .post('/classify-pending', (c) => {
    if (!classificationAvailable()) throw conflict('AI is switched off or no API key is stored; classifying documents needs the model');
    return c.json(classifyPendingDocuments(), 202);
  })
  // Large exports (2026-10-07). Before '/:id' too. The "adding" banner polls what each upload has become: stored whole,
  // every page read, every page analysed (at most 50 ids).
  .get('/confirmations', (c) => {
    const q = parse(confirmationsQuery, cleanQuery(c.req.query()));
    const ids = [...new Set(q.ids.split(',').map((s) => s.trim()).filter(Boolean))];
    if (ids.length > 50) throw badRequest('at most 50 ids');
    for (const id of ids) parse(documentId, id);
    const items: UploadConfirmation[] = [];
    const live = liveDocumentIds(ids);
    // Held back as "May be someone else's record" (2026-10-09): settled, and the banner says why.
    const held = quarantinedIds(ids);
    for (const id of ids) {
      if (!live.has(id) && !held.has(id)) continue;
      try {
        items.push(withPatientNote(uploadConfirmation(id)));
      } catch {
        // a document deleted meanwhile is simply left out
      }
    }
    return c.json({ items });
  })
  // Read many documents (again) at once: the Documents page, or the clinician when the user asked. User requests go ahead
  // up to ai.autoResumeCeilingUsd; above it they wait for a yes (askFirst) unless confirmAboveCeiling.
  .post('/reprocess', async (c) => {
    const body = parse(reprocessRequest, await jsonBody(c));
    const user = currentUser(c);
    return c.json(requestReprocess(body, { by: user?.name ?? null }), 202);
  })
  .get('/:id/coverage', (c) => {
    const id = parse(documentId, c.req.param('id'));
    getDocument(id);
    let estimate: SegmentEstimate | null = null;
    try {
      const e = estimateRemaining(id, 'missing');
      estimate = e.calls ? e : null;
    } catch {
      estimate = null;
    }
    return c.json({ coverage: currentCoverage(id), upload: readUploadRecord(id), confirmation: withPatientNote(uploadConfirmation(id)), estimate, patient: documentCheck(id) });
  })
  .get('/:id/outline', (c) => {
    const id = parse(documentId, c.req.param('id'));
    getDocument(id);
    return c.json({ entries: documentOutline(id) });
  })
  .get('/:id/segments', (c) => {
    const id = parse(documentId, c.req.param('id'));
    getDocument(id);
    return c.json({ segments: listSegments(id).map(toSegmentView) });
  })
  // Read-only: the rows that say how a reading went (runs, jobs, model calls by page range, statuses), now and as kept
  // before the first repair. Counts, ids, page numbers and error messages; no page text.
  .get('/:id/diagnostics', (c) => c.json(extractionDiagnostics(parse(documentId, c.req.param('id')))))
  .get('/:id/confirmation', (c) => {
    const id = parse(documentId, c.req.param('id'));
    getDocument(id);
    return c.json(uploadConfirmation(id));
  })
  .get('/:id/estimate', (c) => {
    const id = parse(documentId, c.req.param('id'));
    const q = parse(estimateQuery, cleanQuery(c.req.query()));
    return c.json(estimateRemaining(id, q.scope ?? 'missing', q.deep === '1' || q.deep === 'true'));
  })
  .post('/:id/resume', async (c) => {
    const id = parse(documentId, c.req.param('id'));
    const body = parse(resumeBody, await jsonBody(c));
    if (body.scope === 'pages' && !body.pages?.length) throw badRequest('pages: say which pages to read again');
    const user = currentUser(c);
    const r = requestReprocess(
      { documentIds: [id], scope: body.scope ?? 'missing', pages: body.pages, deep: Boolean(body.deep), requestedBy: 'user', confirmAboveCeiling: Boolean(body.confirm) },
      { by: user?.name ?? null },
    );
    if (r.skipped.length && !r.queued.length && !r.askFirst.length) throw conflict(r.skipped[0].reason);
    return c.json(r, 202);
  })
  .post('/:id/resume/decline', (c) => {
    const id = parse(documentId, c.req.param('id'));
    const user = currentUser(c);
    return c.json(decideResume(id, 'declined', { by: user?.name ?? null }));
  })
  // The yes to the question waiting on the document (2026-10-09: the lab check's "read again the pages with lab lines no
  // value holds?", or reading the rest), at the cost it showed.
  .post('/:id/resume/approve', (c) => {
    const id = parse(documentId, c.req.param('id'));
    const user = currentUser(c);
    return c.json(decideResume(id, 'approved', { by: user?.name ?? null }));
  })
  .get('/:id/pages', (c) => {
    const q = parse(pagesQuery, cleanQuery(c.req.query()));
    return c.json(getPageWindow(c.req.param('id'), q.from ?? 1, q.to));
  })
  .get('/:id/file', (c) => {
    const { buffer, mime, filename } = getDocumentFile(c.req.param('id'));
    const download = c.req.query('download') === '1';
    return c.body(asBody(buffer), 200, fileResponseHeaders(mime, filename, download, buffer.length));
  })
  .get('/:id/page/:n/image', (c) => {
    const n = Number(c.req.param('n'));
    if (!Number.isInteger(n) || n < 1) throw badRequest('page must be a positive integer');
    const q = parse(imageQuery, cleanQuery(c.req.query()));
    const { bytes, mime } = getPageImage(c.req.param('id'), n, q.scale ?? 1.5);
    return c.body(asBody(bytes), 200, {
      'content-type': mime,
      'content-length': String(bytes.length),
      'cache-control': NO_STORE,
      'x-content-type-options': 'nosniff',
      'content-security-policy': FILE_CSP,
    });
  })
  .get('/:id/brief', (c) => c.json(getDocumentBrief(c.req.param('id'))))
  .post('/:id/brief/rebuild', (c) => c.json(rebuildDocumentBrief(c.req.param('id'))))
  .post('/:id/retitle', (c) => {
    if (!classificationAvailable()) throw conflict('AI is switched off or no API key is stored; a re-title needs the model');
    return c.json({ job: requestRetitle(c.req.param('id')) }, 202);
  })
  // A document held back as "May be someone else's record" opens too, so the user can decide (services/patient-check.ts).
  .get('/:id', (c) => c.json(getDocument(c.req.param('id'), { held: true })))
  .patch('/:id', async (c) => {
    const patch = parse(patchBody, await jsonBody(c));
    if (!Object.keys(patch).length) throw new HttpError(400, 'nothing to update');
    return c.json(updateDocument(c.req.param('id'), patch));
  })
  .delete('/:id', (c) => c.json(deleteDocument(c.req.param('id'))))
  .post('/:id/restore', (c) => c.json(restoreDocument(c.req.param('id'))))
  // Likely copies (services/duplicates.ts). Viewers are refused by the auth layer like every other POST here.
  .post('/:id/not-a-copy', async (c) => {
    parse(copyAnswerBody, await jsonBody(c));
    return c.json(keepBothCopies(parse(documentId, c.req.param('id')), currentUser(c)?.name ?? null));
  })
  .post('/:id/set-aside-copy', async (c) => {
    parse(copyAnswerBody, await jsonBody(c));
    return c.json(setAsideCopy(parse(documentId, c.req.param('id')), currentUser(c)?.name ?? null));
  })
  .post('/:id/reingest', async (c) => {
    const body = parse(reingestBody, await jsonBody(c));
    return c.json({ job: reingestDocument(c.req.param('id'), { forceOcr: body.forceOcr }) }, 202);
  })
  .post('/:id/extract', async (c) => {
    const body = parse(extractBody, await jsonBody(c));
    if (body.scope === 'pages' && !body.pages?.length) throw badRequest('pages: say which pages to read again');
    return c.json({ job: requestExtraction(c.req.param('id'), { deep: body.deep, scope: body.scope, pages: body.pages as Array<[number, number]> | undefined }) }, 202);
  })
  // Slice P: folder import and purge (services/folder-import.ts, services/document-purge.ts).
  // Folder import reads files on this computer, so it is the owner's (like purging); an editor gets the role 403 shape.
  .post('/import-folder', async (c) => {
    // Hosted, a path would name a folder on the server, which holds no records of the user's: refused plainly (the
    // client hides the folder import then; dropping or choosing files still works).
    if (config.hosted) {
      return c.json({ error: 'Importing a folder by its path only works when CaseFile runs on your own computer. Drop the files on the page or choose them instead.', code: 'hosted' }, 403);
    }
    const user = currentUser(c);
    if (user && user.role !== 'owner') return c.json({ error: user.role, role: user.role, detail: 'importing a folder from this computer is owner only' }, 403);
    const body = parse(importFolderBody, await jsonBody(c));
    return c.json(await importFolder(body));
  })
  .post('/:id/purge', async (c) => {
    const body = parse(purgeBody, await jsonBody(c));
    const user = currentUser(c);
    return c.json(purgeDocument(c.req.param('id'), body.confirmTitle, user ? { id: user.id, name: user.name } : null));
  });
