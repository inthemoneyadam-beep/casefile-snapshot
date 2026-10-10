/**
 * Full-window drop target. Drag a file anywhere in the app and it is added to
 * Documents (POST /api/documents), where Claude names and sorts it like any
 * upload. (Unsorted uploads keeps its own drop area for files the user wants
 * to look at before filing.) Mounted once by the Shell.
 *
 * It also shows the "adding" banner, centred at the top of the window, for
 * every upload made anywhere in the app (features/inbox/uploads.ts): while the
 * file is sent, then until the whole document is stored, every page read and
 * every page analysed, ending with one sentence that confirms it ("All 1,840
 * pages read; every page accounted for: details from 1,790 pages; 211 scanned
 * pages read by OCR; 31 repeat pages skipped; 19 blank pages; ...") or says exactly
 * what is missing, and why details were not pulled out when no reading was
 * queued. Dark-first and quiet: the raised surface, a coloured edge for where
 * it stands, no bright fill (easy on the eyes). A reading still going
 * after a while folds to one line (title, pages so far, Show, Hide) so the
 * page under it stays usable, and opens again when it settles. A finished
 * upload with nothing missing leaves on its own after a while; anything else
 * stays until Hide.
 *
 * Elements that handle their own drops (the documents page list, the inbox
 * drop area, any element carrying `data-own-drop`, and file inputs) are left
 * alone: the overlay stays hidden over them and the drop is not intercepted.
 * A dragover/drop that another handler has already accepted (defaultPrevented)
 * is likewise ignored, so page-level drop zones keep working unchanged.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { type InboxUpload } from '../../api/inbox';
import { SETTLED_STAGES, reprocessWords, useDeclineResume, useResumeReading, useUploadConfirmations, useUploadDocuments, type UploadConfirmation } from '../../api/documents';
import { useMe } from '../../api/users';
import { hasFiles } from '../../app/dom';
import { Button } from '../../ui/Button';
import { useToast } from '../../ui/Toast';
import { formatBytes } from '@shared/schemas/segments';
import { batchBytes, hideUpload, useUploads, type UploadBatch } from './uploads';
import { INBOX_NAME } from './words';
import './inbox.css';

/** True when the event is over something that handles files itself. */
export function isOwnDropTarget(target: EventTarget | null): boolean {
  const el = target as Element | null;
  if (!el || typeof el.closest !== 'function') return false;
  return Boolean(el.closest('[data-own-drop], input[type="file"]'));
}

export function summariseUpload(items: InboxUpload[]): string {
  const fresh = items.filter((i) => !i.duplicate);
  const dupes = items.length - fresh.length;
  const parts: string[] = [];
  if (fresh.length) parts.push(fresh.length === 1 ? `Added to ${INBOX_NAME}: ${fresh[0].filename}` : `${fresh.length} files added to ${INBOX_NAME}`);
  if (dupes) parts.push(dupes === 1 ? `1 was already in the case` : `${dupes} were already in the case`);
  return parts.join(' · ') || 'Nothing added';
}

/**
 * Which uploaded item to show after a drop or paste: a new one, else a
 * duplicate that is in the Inbox, else the first (a plain document already in
 * the case, which the Inbox shows as "not in the Inbox").
 */
export function pickUploadToShow(items: InboxUpload[]): InboxUpload | null {
  return items.find((i) => !i.duplicate) ?? items.find((i) => i.inbox) ?? items[0] ?? null;
}

export function GlobalDropZone() {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const upload = useUploadDocuments();
  const uploadRef = useRef(upload);
  uploadRef.current = upload;

  useEffect(() => {
    function reset() {
      depth.current = 0;
      setOver(false);
    }
    function onEnter(e: DragEvent) {
      if (!hasFiles(e)) return;
      depth.current++;
      if (isOwnDropTarget(e.target)) {
        setOver(false);
        return;
      }
      e.preventDefault();
      setOver(true);
    }
    function onOver(e: DragEvent) {
      if (!hasFiles(e)) return;
      if (isOwnDropTarget(e.target) || e.defaultPrevented) {
        setOver(false);
        return;
      }
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setOver(true);
    }
    function onLeave(e: DragEvent) {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    }
    function onDrop(e: DragEvent) {
      const ours = hasFiles(e) && !isOwnDropTarget(e.target) && !e.defaultPrevented;
      reset();
      if (!ours) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!files.length) return;
      // The banner follows the upload (api/documents.ts records it), errors included.
      uploadRef.current.mutate({ files });
    }
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragend', reset);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', reset);
    };
  }, []);

  return (
    <>
      {over ? (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-card">Drop to add: Claude names and sorts it</div>
        </div>
      ) : null}
      <UploadBanner />
    </>
  );
}

/** How long a finished upload with nothing missing stays before it leaves on its own. */
const DONE_STAYS_MS = 20_000;
/** How long a notice of an upload still being read stays whole before it folds to one line. */
const FOLD_AFTER_MS = 15_000;
/** At most this many uploads show at once (the newest). */
const SHOWN = 3;

/** The upload confirmation banner: one block per upload, newest last. */
export function UploadBanner() {
  const batches = useUploads();
  const visible = useMemo(() => batches.filter((b) => !b.hidden).slice(-SHOWN), [batches]);
  const ids = useMemo(() => [...new Set(visible.flatMap((b) => b.documentIds))], [visible]);
  const confirmations = useUploadConfirmations(ids);
  const byId = useMemo(() => new Map((confirmations.data ?? []).map((c) => [c.documentId, c])), [confirmations.data]);
  if (!visible.length) return null;
  return (
    <div className="upload-banner" role="status" aria-live="polite" aria-label="Uploads">
      {visible.map((b) => (
        <UploadBlock key={b.id} batch={b} confirmations={b.documentIds.map((id) => byId.get(id)).filter((c): c is UploadConfirmation => Boolean(c))} />
      ))}
    </div>
  );
}

export type UploadTone = 'working' | 'ok' | 'warn' | 'bad';

/** Where one upload stands, as a heading and a tone (pure: tests call it). */
export function uploadHeading(
  b: Pick<UploadBatch, 'state' | 'files' | 'documentIds' | 'duplicates' | 'target'>,
  confirmations: Array<Pick<UploadConfirmation, 'stage' | 'complete' | 'problems'>>,
): { title: string; tone: UploadTone } {
  const n = b.files.length;
  const what = n === 1 ? b.files[0].name : `${n} files`;
  if (b.state === 'sending') return { title: `Adding ${what} (${formatBytes(batchBytes(b))})…`, tone: 'working' };
  if (b.state === 'failed') return { title: `${what} could not be added`, tone: 'bad' };
  if (!b.documentIds.length) return { title: b.duplicates ? `${what}: already in the case, nothing new to add` : 'Nothing was added', tone: 'ok' };
  if (confirmations.length < b.documentIds.length) return { title: `Stored ${what}; checking it…`, tone: 'working' };
  const stages = confirmations.map((c) => c.stage);
  if (stages.some((s) => s === 'failed')) return { title: n === 1 ? 'Something did not work' : 'Something did not work for one of them', tone: 'bad' };
  // The wrong-patient guard (2026-10-09): held back before anything was read or filed.
  if (confirmations.some((c) => (c as { held?: boolean }).held)) return { title: n === 1 ? "Held back: it may be someone else's record" : "Held back: one may be someone else's record", tone: 'warn' };
  if (confirmations.some((c) => c.problems.length)) return { title: 'Added, but not everything arrived whole', tone: 'bad' };
  if (stages.some((s) => !SETTLED_STAGES.has(s))) {
    const reading = stages.some((s) => s === 'stored' || s === 'reading');
    // "Pulling out" only while a reading is queued or running (the server says `analysing`; rev-comms #7).
    if (reading || !stages.some((s) => s === 'analysing')) return { title: `Stored whole; reading the pages of ${what}…`, tone: 'working' };
    return { title: `Claude is pulling out the details of ${what}…`, tone: 'working' };
  }
  if (stages.some((s) => s === 'waiting_for_you')) return { title: 'Waiting for your go-ahead to read the rest', tone: 'warn' };
  if (stages.some((s) => s === 'partial')) return { title: 'Added, but not every page was read', tone: 'warn' };
  if (stages.every((s) => s === 'not_requested')) {
    // Waiting in Check before filing is the plan; anywhere else, details that were not pulled out stay on show (the
    // sentence says why) until Hide.
    if (b.target === 'inbox') return { title: `Added to ${INBOX_NAME}; every page stored and read`, tone: 'ok' };
    return { title: 'Added; every page stored and read, details not pulled out', tone: 'warn' };
  }
  if (confirmations.every((c) => c.complete)) return { title: n === 1 ? 'Done: the whole document was uploaded and analysed' : `Done: all ${n} documents were uploaded and analysed`, tone: 'ok' };
  return { title: 'Added; every page stored', tone: 'ok' };
}

/** Pages analysed of the pages stored, over the documents still being analysed (null when none is). */
export function analysingShare(confirmations: Array<Pick<UploadConfirmation, 'stage' | 'pagesAnalysed' | 'pagesInFile' | 'pagesStored'>>): { done: number; total: number } | null {
  const going = confirmations.filter((c) => c.stage === 'analysing');
  if (!going.length) return null;
  const total = going.reduce((n, c) => n + (c.pagesInFile ?? c.pagesStored), 0);
  const done = going.reduce((n, c) => n + c.pagesAnalysed, 0);
  return total > 0 ? { done, total } : null;
}

function UploadBlock({ batch: b, confirmations }: { batch: UploadBatch; confirmations: UploadConfirmation[] }) {
  const { title, tone } = uploadHeading(b, confirmations);
  const nothingNew = b.state === 'sent' && !b.documentIds.length;
  const finished = tone === 'ok' && b.state === 'sent' && confirmations.length === b.documentIds.length && confirmations.every((c) => c.complete || c.stage === 'not_requested');
  useEffect(() => {
    if (!finished && !nothingNew) return;
    const t = setTimeout(() => hideUpload(b.id), DONE_STAYS_MS);
    return () => clearTimeout(t);
  }, [finished, nothingNew, b.id]);
  // A long reading (hours for a large export) folds to one line after a while, so the page's own title and toolbar
  // stay usable; it opens again by itself when it settles or needs an answer (2026-10-07 review, rev-comms #7).
  const working = tone === 'working';
  const [folded, setFolded] = useState(false);
  const [keptOpen, setKeptOpen] = useState(false);
  useEffect(() => {
    if (!working) {
      setFolded(false);
      return;
    }
    if (keptOpen) return;
    const t = setTimeout(() => setFolded(true), FOLD_AFTER_MS);
    return () => clearTimeout(t);
  }, [working, keptOpen]);
  const first = b.documentIds[0];
  if (folded && working) {
    const share = analysingShare(confirmations);
    return (
      <section className={`upload-banner-item folded ${tone}`} aria-label={title}>
        <div className="upload-banner-head">
          <strong className="upload-banner-title">{title}</strong>
          {share ? (
            <span className="upload-banner-count">
              {share.done.toLocaleString('en-US')} of {share.total.toLocaleString('en-US')} pages
            </span>
          ) : null}
          <span className="upload-banner-actions">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setKeptOpen(true);
                setFolded(false);
              }}
              title="Show the whole notice again"
            >
              Show
            </Button>
            <Button size="sm" variant="ghost" onClick={() => hideUpload(b.id)} title="Hide this notice; the document's own page keeps the details">
              Hide
            </Button>
          </span>
        </div>
      </section>
    );
  }
  return (
    <section className={`upload-banner-item ${tone}`} aria-label={title}>
      <div className="upload-banner-head">
        <strong className="upload-banner-title">{title}</strong>
        <Button size="sm" variant="ghost" onClick={() => hideUpload(b.id)} title="Hide this notice; the document's own page keeps the details">
          Hide
        </Button>
      </div>
      {b.state === 'failed' ? <p className="upload-banner-sentence">{b.error ?? 'The upload did not work.'} Nothing was stored; try again.</p> : null}
      {confirmations.map((c) => (
        <ConfirmationLine key={c.documentId} c={c} several={confirmations.length > 1} target={b.target} />
      ))}
      {b.duplicates ? <p className="upload-banner-note">{b.duplicates === 1 ? 'One file was already in the case and was not added again.' : `${b.duplicates} files were already in the case and were not added again.`}</p> : null}
      {first && confirmations.length > 1 ? (
        <div className="upload-banner-links">
          <Link to={b.target === 'inbox' ? '/inbox' : '/documents'} search={{ id: first }}>
            {b.target === 'inbox' ? `Open ${INBOX_NAME}` : 'Show them in Documents'}
          </Link>
        </div>
      ) : null}
    </section>
  );
}

function ConfirmationLine({ c, several, target }: { c: UploadConfirmation; several: boolean; target: UploadBatch['target'] }) {
  const toast = useToast();
  const canWrite = useMe().canWrite;
  const resume = useResumeReading();
  const decline = useDeclineResume();
  const total = c.pagesInFile ?? c.pagesStored;
  const analysing = c.stage === 'analysing' && total > 0;
  const share = analysing ? Math.max(0.02, Math.min(1, c.pagesAnalysed / total)) : 0;
  return (
    <div className="upload-banner-doc">
      {several ? <div className="upload-banner-doctitle">{c.title}</div> : null}
      <p className="upload-banner-sentence">{c.sentence}</p>
      {c.patientNote ? <p className="upload-banner-note">{c.patientNote}</p> : null}
      {analysing ? (
        <div className="upload-banner-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={c.pagesAnalysed} aria-label="Pages analysed">
          <i style={{ width: `${Math.round(share * 100)}%` }} />
        </div>
      ) : null}
      {c.problems.length ? (
        <ul className="upload-banner-problems">
          {c.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      <div className="upload-banner-links">
        {c.held ? (
          <Link to="/inbox" search={{ view: 'patient', id: c.documentId }}>
            Answer in {INBOX_NAME}
          </Link>
        ) : (
          <Link to={target === 'inbox' ? '/inbox' : '/documents'} search={{ id: c.documentId }}>
            {target === 'inbox' ? `Open it in ${INBOX_NAME}` : 'Show it in Documents'}
          </Link>
        )}
        {c.stage === 'waiting_for_you' && canWrite ? (
          <>
            <Button
              size="sm"
              variant="accent"
              disabled={resume.isPending}
              onClick={() => resume.mutate({ id: c.documentId, confirm: true }, { onSuccess: (r) => toast(reprocessWords(r), 'ok'), onError: (err) => toast(err instanceof Error ? err.message : 'Could not start', 'bad') })}
              title="Claude reads the pages not read yet; details you checked are kept"
            >
              Continue reading{c.estimateUsd != null ? ` (about $${c.estimateUsd.toFixed(2)})` : ''}
            </Button>
            <Button size="sm" variant="ghost" disabled={decline.isPending} onClick={() => decline.mutate(c.documentId, { onSuccess: () => toast('Claude will not read the rest until you ask', 'ok') })}>
              Not now
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
