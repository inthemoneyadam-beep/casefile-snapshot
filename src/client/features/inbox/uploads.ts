/**
 * The uploads the "adding" banner follows (2026-10-07): every upload, from wherever it was started (a drop anywhere,
 * Add documents, Check before filing), is followed from "sending" until each document is stored whole, every page
 * read and every page analysed, or the banner says exactly what is missing. The upload hooks (api/documents.ts,
 * api/inbox.ts) call `beginUpload` / `uploadSent` / `uploadFailed`; the banner (GlobalDropZone, mounted once by the
 * Shell) reads the list with `useUploads` and polls the server's confirmations.
 *
 * A tiny external store (useSyncExternalStore). The documents followed are also kept in sessionStorage (inside
 * try/catch), so a reload keeps following them; the store works without it.
 */
import { useSyncExternalStore } from 'react';

export interface UploadFileInfo {
  name: string;
  size: number;
}

export interface UploadBatch {
  id: string;
  /** sending: the bytes are on their way; sent: the server holds them (documentIds); failed: the upload did not work. */
  state: 'sending' | 'sent' | 'failed';
  files: UploadFileInfo[];
  /** The documents made (new ones; a file already in the case is named in `duplicates`). */
  documentIds: string[];
  duplicates: number;
  error: string | null;
  /** Where it went: Documents (Claude reads and files it) or Check before filing. */
  target: 'documents' | 'inbox';
  startedAt: number;
  /** Hidden by the user (the banner stays away for this batch). */
  hidden: boolean;
}

const KEY = 'casefile.uploads.v1';
const MAX_BATCHES = 6;
/** Batches older than this are not brought back after a reload. */
const KEEP_MS = 24 * 60 * 60 * 1000;

let batches: UploadBatch[] = load();
const listeners = new Set<() => void>();

function load(): UploadBatch[] {
  try {
    if (typeof sessionStorage === 'undefined') return [];
    const raw = sessionStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(arr)) return [];
    const now = Date.now();
    // A batch still "sending" when the page was left never finished from this page: it is not brought back.
    return (arr as UploadBatch[]).filter((b) => b && typeof b.id === 'string' && b.state === 'sent' && Array.isArray(b.documentIds) && now - (b.startedAt ?? 0) < KEEP_MS);
  } catch {
    return [];
  }
}

function save(): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    const keep = batches.filter((b) => b.state === 'sent' && !b.hidden);
    if (keep.length) sessionStorage.setItem(KEY, JSON.stringify(keep));
    else sessionStorage.removeItem(KEY);
  } catch {
    // Storage may be unavailable (private window, blocked site data); the banner still works for this page.
  }
}

function emit(next: UploadBatch[]): void {
  batches = next.slice(-MAX_BATCHES);
  save();
  for (const l of listeners) l();
}

let seq = 0;

/** A new upload is on its way; returns its id for `uploadSent` / `uploadFailed`. */
export function beginUpload(files: Array<{ name: string; size: number }>, target: UploadBatch['target'] = 'documents'): string {
  seq += 1;
  const id = `u${Date.now().toString(36)}${seq}`;
  emit([...batches, { id, state: 'sending', files: files.map((f) => ({ name: f.name, size: f.size })), documentIds: [], duplicates: 0, error: null, target, startedAt: Date.now(), hidden: false }]);
  return id;
}

/** The server holds the files: these documents are followed until they are read and analysed. */
export function uploadSent(id: string, items: Array<{ id: string; duplicate?: boolean }>): void {
  const fresh = items.filter((d) => !d.duplicate).map((d) => d.id);
  emit(batches.map((b) => (b.id === id ? { ...b, state: 'sent', documentIds: fresh, duplicates: items.length - fresh.length } : b)));
}

/** The upload did not work. */
export function uploadFailed(id: string, error: string): void {
  emit(batches.map((b) => (b.id === id ? { ...b, state: 'failed', error } : b)));
}

/** The user closed the banner for this upload. */
export function hideUpload(id: string): void {
  emit(batches.map((b) => (b.id === id ? { ...b, hidden: true } : b)).filter((b) => !(b.hidden && b.state !== 'sending')));
}

/** Forget every upload (tests). */
export function clearUploads(): void {
  emit([]);
}

/** The current list (outside React). */
export function currentUploads(): UploadBatch[] {
  return batches;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The uploads the banner follows (React). */
export function useUploads(): UploadBatch[] {
  return useSyncExternalStore(subscribe, currentUploads, currentUploads);
}

/** Total bytes of a batch. */
export function batchBytes(b: Pick<UploadBatch, 'files'>): number {
  return b.files.reduce((n, f) => n + (Number.isFinite(f.size) ? f.size : 0), 0);
}
