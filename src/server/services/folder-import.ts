/**
 * Folder import: bring every supported file in a folder on this computer into
 * the case, the way an upload would, without touching the folder.
 *
 * - Read only. Each file is read into memory and stored through the documents
 *   service (encrypted copy in the file store, sha256 dedup, ingest job). The
 *   source file is never moved, renamed, written or deleted; nothing is ever
 *   opened for writing under the chosen folder.
 * - Refused: the case data folder (the configured one and `data/` next to the
 *   app), the backups folder, any folder holding a Casefile keyring or
 *   database (a data folder set aside by a restore, another data dir) or lying
 *   inside one, and the app folder itself. A recursive walk steps over those
 *   folders, the app folder, hidden and system folders and links, and says so.
 * - Supported: the extensions the ingest pipeline reads (PDF, images, DOCX,
 *   text, Markdown, CSV/TSV, JSON, DICOM, VTT/SRT); a file with another or no
 *   extension only when its first bytes say PDF, DICOM or a raster image
 *   (DICOM files often carry no extension). Everything else is listed as
 *   skipped with the reason.
 * - Duplicates (same sha256 as a live document) are counted, not stored again.
 *   A file whose copy sits in the trash is skipped with a pointer to Restore,
 *   so re-running an import never brings back what the user deleted.
 * - Provenance: each new document records where it came from in
 *   `metadata_json.import` (folder, relative path, file time, size).
 * - `dryRun` reads and hashes everything and reports what an import would do,
 *   writing nothing.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { config, projectRoot } from '../config';
import { db, LockedError, schema } from '../db';
import { createDocuments, type UploadFile } from './documents';
import { createInboxDocuments } from './inbox';
import { detectKind, kindFromMagic } from '../ingest/detect';
import { badRequest, conflict } from '../util/errors';
import { nowIso, parseJson, sha256 } from '../util/ids';
import type { DocumentCategory } from '../../shared/enums';

/** The most files one import stores (or previews); a larger folder is imported in further runs (duplicates are skipped). */
export const FOLDER_IMPORT_MAX_FILES = 2000;
/** Upper bound on files listed in one walk (paths only; cheap). New imports per run are capped by FOLDER_IMPORT_MAX_FILES. */
export const FOLDER_IMPORT_MAX_WALK = 100_000;
/** How deep a recursive walk goes below the chosen folder. */
export const FOLDER_IMPORT_MAX_DEPTH = 12;
/** Same ceiling as an upload. */
export const FOLDER_IMPORT_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
/** The skipped list is cut at this length; `skippedTotal` keeps the full count. */
export const FOLDER_IMPORT_MAX_SKIPPED_LISTED = 1000;

export interface FolderImportOptions {
  /** Absolute, or relative to the app folder ("Files"). */
  path: string;
  /** Walk subfolders too. Default false. */
  recursive?: boolean;
  /** Category for the new documents (ignored with toInbox: triage proposes one). */
  category?: DocumentCategory;
  /** Queue fact extraction after ingestion (model calls). Default false for a folder. */
  autoExtract?: boolean;
  /** Put the new documents in the Inbox and triage them. */
  toInbox?: boolean;
  /** Read and hash only; store nothing. */
  dryRun?: boolean;
}

export interface FolderImportItem {
  /** Path relative to the chosen folder, with forward slashes. */
  file: string;
  /** The new document, or the live document holding the same file; null in a dry run for a new file. */
  documentId: string | null;
  title: string | null;
  duplicate: boolean;
  sizeBytes: number;
}

export interface FolderImportSkip {
  file: string;
  reason: string;
}

export interface FolderImportResult {
  /** The folder actually read (absolute, links resolved). */
  folder: string;
  recursive: boolean;
  dryRun: boolean;
  toInbox: boolean;
  autoExtract: boolean;
  /** New documents stored (in a dry run: files that would be). */
  imported: number;
  /** Files already in the case (same sha256 as a live document, or repeated in this folder). */
  duplicates: number;
  skipped: FolderImportSkip[];
  /** Every skipped file, also when the list above was cut. */
  skippedTotal: number;
  items: FolderImportItem[];
  /** True when the folder held more files than one import takes; run it again for the rest. */
  truncated: boolean;
  /** Bytes read. */
  bytes: number;
}

/** Extensions the ingest pipeline reads (see src/server/ingest/detect.ts). */
export function supportedByExtension(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  if (!ext) return false;
  return detectKind(`x${ext}`, null, Buffer.alloc(0)).kind !== 'other';
}

/** A file with an unknown or missing extension is taken only when its first bytes say PDF, DICOM or a raster image. */
export function supportedByMagic(head: Buffer): boolean {
  const k = kindFromMagic(head);
  return k !== null && (k.kind === 'pdf' || k.kind === 'dicom' || k.kind === 'image');
}

const SYSTEM_FILES = new Set(['thumbs.db', 'desktop.ini', '.ds_store', 'ehthumbs.db', 'icon\r']);
const SYSTEM_DIRS = new Set(['node_modules', '$recycle.bin', 'system volume information', '__macosx']);

function isSystemFile(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith('.') || n.startsWith('~$') || SYSTEM_FILES.has(n);
}

function isSystemDir(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith('.') || SYSTEM_DIRS.has(n);
}

const caseFold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);

/** True when `child` is `parent` or lies inside it. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(caseFold(path.resolve(parent)), caseFold(path.resolve(child)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realOrResolved(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** A Casefile data folder: it holds the encrypted database, or the keyring next to a file store. */
export function isCaseDataFolder(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'casefile.db')) || (fs.existsSync(path.join(dir, 'keyring.json')) && fs.existsSync(path.join(dir, 'files')));
}

interface Guarded {
  path: string;
  label: string;
}

/** Folders an import never reads: the data folders and the backups folders, real paths. */
export function protectedFolders(): Guarded[] {
  const list: Guarded[] = [
    { path: config.dataDir, label: 'the case data folder' },
    { path: path.join(projectRoot, 'data'), label: 'the case data folder' },
    { path: config.backupsDir, label: 'the backups folder' },
    { path: path.join(projectRoot, 'backups'), label: 'the backups folder' },
  ];
  const seen = new Set<string>();
  const out: Guarded[] = [];
  for (const g of list) {
    const p = realOrResolved(g.path);
    const key = caseFold(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: p, label: g.label });
  }
  return out;
}

/** Why a folder may not be read, or null when it may. `target` is a real path. */
export function refusalFor(target: string): string | null {
  for (const g of protectedFolders()) {
    if (isInside(target, g.path)) return `${g.label} is never imported from; choose a folder of documents, such as the Files folder next to the app`;
  }
  if (caseFold(target) === caseFold(realOrResolved(projectRoot))) return 'this is the app folder; choose the folder of documents inside it (Files)';
  // The folder itself or one above it holds a Casefile keyring or database: a data folder (a set-aside copy, another data dir).
  let dir = target;
  for (let i = 0; i < 64; i++) {
    if (isCaseDataFolder(dir)) return 'this folder is (or lies inside) a Casefile data folder; its files are the encrypted case, not documents';
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** Why the walk steps over this subfolder, or null to enter it. `dir` is a real path. */
function skipDirReason(dir: string, name: string, guarded: Guarded[], appFolder: string): string | null {
  if (isSystemDir(name)) return 'hidden or system folder';
  for (const g of guarded) if (isInside(dir, g.path)) return `${g.label} (never imported)`;
  if (caseFold(dir) === caseFold(appFolder)) return 'the app folder (never imported)';
  if (isCaseDataFolder(dir)) return 'a Casefile data folder (never imported)';
  return null;
}

interface Candidate {
  full: string;
  rel: string;
}

function relOf(root: string, full: string): string {
  return path.relative(root, full).split(path.sep).join('/');
}

/** Walk the folder (read-only, links not followed) and collect candidate files in name order. */
export async function collect(root: string, recursive: boolean, skip: (s: FolderImportSkip) => void): Promise<{ files: Candidate[]; truncated: boolean }> {
  const guarded = protectedFolders();
  const appFolder = realOrResolved(projectRoot);
  const files: Candidate[] = [];
  let truncated = false;
  const byName = (a: fs.Dirent, b: fs.Dirent) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  async function visit(dir: string, depth: number): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      skip({ file: relOf(root, dir) || '.', reason: `folder could not be read (${(err as NodeJS.ErrnoException).code ?? 'error'})` });
      return;
    }
    entries.sort(byName);
    const subdirs: string[] = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = relOf(root, full);
      if (e.isSymbolicLink()) {
        skip({ file: rel, reason: 'link or junction (not followed)' });
        continue;
      }
      if (e.isDirectory()) {
        if (!recursive) continue;
        const why = skipDirReason(full, e.name, guarded, appFolder);
        if (why) skip({ file: `${rel}/`, reason: why });
        else if (depth >= FOLDER_IMPORT_MAX_DEPTH) skip({ file: `${rel}/`, reason: `more than ${FOLDER_IMPORT_MAX_DEPTH} folders deep` });
        else subdirs.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (isSystemFile(e.name)) {
        skip({ file: rel, reason: 'hidden or system file' });
        continue;
      }
      if (files.length >= FOLDER_IMPORT_MAX_WALK) {
        truncated = true;
        return;
      }
      files.push({ full, rel });
    }
    for (const sub of subdirs) {
      if (truncated) return;
      await visit(sub, depth + 1);
    }
  }
  await visit(root, 0);
  return { files, truncated };
}

async function readHead(full: string, n = 512): Promise<Buffer> {
  const fh = await fsp.open(full, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** The live document holding this file, or a deleted one (the trash) when none is live. */
function existingBySha(sha: string): { live: { id: string; title: string } | null; trashed: { id: string; title: string } | null } {
  const d = db();
  const live = d
    .select({ id: schema.documents.id, title: schema.documents.title })
    .from(schema.documents)
    .where(and(eq(schema.documents.sha256, sha), isNull(schema.documents.deletedAt)))
    .get();
  if (live) return { live, trashed: null };
  const trashed = d
    .select({ id: schema.documents.id, title: schema.documents.title })
    .from(schema.documents)
    .where(and(eq(schema.documents.sha256, sha), isNotNull(schema.documents.deletedAt)))
    .get();
  return { live: null, trashed: trashed ?? null };
}

/** Record where the document came from. Same tick as the insert, so the ingest job has not read the metadata yet. */
function recordProvenance(id: string, info: { folder: string; rel: string; mtime: Date; size: number }): void {
  const d = db();
  const row = d.select({ metadataJson: schema.documents.metadataJson }).from(schema.documents).where(eq(schema.documents.id, id)).get();
  if (!row) return;
  const meta = parseJson<Record<string, unknown>>(row.metadataJson, {});
  meta.import = { kind: 'folder', folder: info.folder, path: info.rel, modifiedAt: info.mtime.toISOString(), sizeBytes: info.size, at: nowIso() };
  d.update(schema.documents).set({ metadataJson: JSON.stringify(meta) }).where(eq(schema.documents.id, id)).run();
}

let running = false;

/** Resolve and check the requested folder; throws the refusal. Returns the real path. */
export function resolveImportFolder(input: string): string {
  const raw = (input ?? '').trim().replace(/^"(.*)"$/, '$1');
  if (!raw) throw badRequest('path is required');
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(projectRoot, raw);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    // 400, not 404: the first-run screen reads a 404 as "this build has no folder import".
    throw badRequest(`folder not found: ${resolved}`);
  }
  if (!stat.isDirectory()) throw badRequest(`not a folder: ${resolved}`);
  const real = realOrResolved(resolved);
  const why = refusalFor(real);
  if (why) throw badRequest(why);
  return real;
}

export async function importFolder(opts: FolderImportOptions): Promise<FolderImportResult> {
  const folder = resolveImportFolder(opts.path);
  if (running) throw conflict('a folder import is already running; wait for it to finish');
  running = true;
  try {
    return await runImport(folder, opts);
  } finally {
    running = false;
  }
}

async function runImport(folder: string, opts: FolderImportOptions): Promise<FolderImportResult> {
  const recursive = Boolean(opts.recursive);
  const dryRun = Boolean(opts.dryRun);
  const toInbox = Boolean(opts.toInbox);
  const autoExtract = !toInbox && Boolean(opts.autoExtract);
  const skipped: FolderImportSkip[] = [];
  let skippedTotal = 0;
  const skip = (s: FolderImportSkip) => {
    skippedTotal++;
    if (skipped.length < FOLDER_IMPORT_MAX_SKIPPED_LISTED) skipped.push(s);
  };
  // The cap counts NEW files stored, not files seen, so a second run moves past what the first imported.
  const walk = await collect(folder, recursive, skip);
  const files = walk.files;
  let truncated = walk.truncated;
  const items: FolderImportItem[] = [];
  const seenInRun = new Map<string, FolderImportItem>();
  let imported = 0;
  let duplicates = 0;
  let bytes = 0;

  for (const f of files) {
    if (imported >= FOLDER_IMPORT_MAX_FILES) {
      truncated = true;
      break;
    }
    try {
      const st = await fsp.stat(f.full);
      if (!st.isFile()) continue;
      if (st.size === 0) {
        skip({ file: f.rel, reason: 'empty file' });
        continue;
      }
      if (st.size > FOLDER_IMPORT_MAX_FILE_BYTES) {
        skip({ file: f.rel, reason: 'larger than 2 GB' });
        continue;
      }
      if (!supportedByExtension(f.rel)) {
        const head = await readHead(f.full);
        if (!supportedByMagic(head)) {
          const ext = path.extname(f.rel).toLowerCase();
          skip({ file: f.rel, reason: ext ? `unsupported type (${ext})` : 'unsupported type (no extension)' });
          continue;
        }
      }
      // Read only: the source is never opened for writing.
      const buffer = await fsp.readFile(f.full);
      bytes += buffer.length;
      const sha = sha256(buffer);
      const earlier = seenInRun.get(sha);
      if (earlier) {
        duplicates++;
        items.push({ file: f.rel, documentId: earlier.documentId, title: earlier.title, duplicate: true, sizeBytes: buffer.length });
        continue;
      }
      const existing = existingBySha(sha);
      if (existing.live) {
        duplicates++;
        const item = { file: f.rel, documentId: existing.live.id, title: existing.live.title, duplicate: true, sizeBytes: buffer.length };
        seenInRun.set(sha, item);
        items.push(item);
        continue;
      }
      if (existing.trashed) {
        skip({ file: f.rel, reason: `in the trash as "${existing.trashed.title}"; restore it from Documents, Trash` });
        continue;
      }
      if (dryRun) {
        imported++;
        const item = { file: f.rel, documentId: null, title: null, duplicate: false, sizeBytes: buffer.length };
        seenInRun.set(sha, item);
        items.push(item);
        continue;
      }
      const upload: UploadFile = { name: path.basename(f.full), mime: null, buffer };
      // Synchronous from here to recordProvenance: the ingest job cannot start in between.
      const [doc] = toInbox ? createInboxDocuments([upload]) : createDocuments([upload], { category: opts.category, autoExtract });
      if (doc.duplicate) {
        duplicates++;
      } else {
        imported++;
        recordProvenance(doc.id, { folder, rel: f.rel, mtime: st.mtime, size: st.size });
      }
      const item = { file: f.rel, documentId: doc.id, title: doc.title, duplicate: Boolean(doc.duplicate), sizeBytes: buffer.length };
      seenInRun.set(sha, item);
      items.push(item);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // A locked case stops the whole import; the files stored so far stay.
      if (err instanceof LockedError) throw err;
      skip({ file: f.rel, reason: e?.code ? `could not be read (${e.code})` : `could not be imported: ${e?.message ?? String(err)}` });
    }
  }
  return { folder, recursive, dryRun, toInbox, autoExtract, imported, duplicates, skipped, skippedTotal, items, truncated, bytes };
}
