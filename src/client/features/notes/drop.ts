/**
 * The files of a drop on My notes, folders included (review 2026-10-09). A dropped folder arrives in
 * `dataTransfer.files` as one empty item that cannot be sent (the upload failed with it), so its files are read
 * through the drop's entries: every file inside, at any depth, named by its path in the folder ("Journal/2030/a.txt"),
 * with its own time kept (the date of a note that has no other). Plain TypeScript, no React, so it can be tested.
 */

/** The parts of a FileSystemEntry this reads (the browser's drop entries; tests pass their own). */
export interface DropEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath?: string;
  file?: (ok: (f: File) => void, fail?: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (entries: DropEntry[]) => void, fail?: (e: unknown) => void) => void };
}

/** At most this many files are read out of the folders of one drop (the import takes 10,000 at most). */
export const DROP_MAX_FILES = 10_000;

function fileOf(e: DropEntry): Promise<File | null> {
  return new Promise((resolve) => {
    if (!e.file) return resolve(null);
    e.file(
      (f) => resolve(f),
      () => resolve(null),
    );
  });
}

function readBatch(reader: ReturnType<NonNullable<DropEntry['createReader']>>): Promise<DropEntry[]> {
  return new Promise((resolve) => reader.readEntries((es) => resolve(es), () => resolve([])));
}

/** A file renamed to its path in the dropped folder, keeping its bytes, type and time. */
function withPath(f: File, path: string): File {
  return path && path !== f.name ? new File([f], path, { type: f.type, lastModified: f.lastModified }) : f;
}

/** Every file under these entries (folders walked; their readers answer in batches until an empty one). */
export async function filesFromEntries(entries: readonly DropEntry[], max = DROP_MAX_FILES): Promise<File[]> {
  const out: File[] = [];
  const walk = async (e: DropEntry): Promise<void> => {
    if (out.length >= max) return;
    if (e.isFile) {
      const f = await fileOf(e);
      if (f) out.push(withPath(f, (e.fullPath ?? e.name).replace(/^\/+/, '')));
      return;
    }
    if (!e.isDirectory || !e.createReader) return;
    const reader = e.createReader();
    for (;;) {
      const batch = await readBatch(reader);
      if (!batch.length) break;
      for (const child of batch) await walk(child);
      if (out.length >= max) break;
    }
  };
  for (const e of entries) await walk(e);
  return out.slice(0, max);
}

/**
 * The files of a drop event. The entries are taken at once (the browser empties the drop after the event); a plain
 * file keeps the File the browser gave, a folder is walked. Without the entries API, the files as given.
 */
export function droppedFiles(dt: DataTransfer | null | undefined): Promise<File[]> {
  if (!dt) return Promise.resolve([]);
  const items = Array.from(dt.items ?? []).filter((i) => i.kind === 'file');
  const entries = items.map((i) => (typeof i.webkitGetAsEntry === 'function' ? (i.webkitGetAsEntry() as unknown as DropEntry | null) : null));
  if (!entries.length || entries.some((e) => !e)) return Promise.resolve(Array.from(dt.files ?? []));
  const plain = items.map((i) => i.getAsFile());
  if (entries.every((e) => e!.isFile) && plain.every(Boolean)) return Promise.resolve(plain as File[]);
  return filesFromEntries(entries as DropEntry[]);
}
