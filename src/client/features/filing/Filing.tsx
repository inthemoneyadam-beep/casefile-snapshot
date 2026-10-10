/**
 * The plain-language pieces of automatic filing: an Add documents button,
 * the "not sorted yet" strip, the "where Claude filed this" panel on a
 * document (settled at once, each placement with Undo), the quiet "added
 * automatically" line on an item Claude made, the clinician's suggested
 * moves, and the one-line page intro. Details never wait for an answer here:
 * their automatic check and the user's override are in
 * features/reconcile/TrustOverride.tsx.
 */
import { useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { DOCUMENT_CATEGORIES } from '@shared/enums';
import { Button } from '../../ui/Button';
import { Confirm } from '../../ui/Dialog';
import { useToast } from '../../ui/Toast';
import { errorMessage } from '../../api/client';
import { useUploadDocuments } from '../../api/documents';
import { useMe } from '../../api/users';
import {
  documentTypeLabel,
  DOCUMENT_TYPE_LABELS,
  useFileDocument,
  useFilingDecision,
  useFilings,
  useRefile,
  useSortDocument,
  useUnsorted,
  type Filing,
} from '../../api/filing';
import './filing.css';

export const UPLOAD_ACCEPT =
  '.pdf,.png,.jpg,.jpeg,.tif,.tiff,.webp,.bmp,.gif,.docx,.txt,.md,.csv,.tsv,.json,.dcm,.dicom,.vtt,.srt,application/pdf,image/*,text/*,application/json';

/** Upload files into the case; each is read, named and filed automatically. */
export function useAddDocuments() {
  const upload = useUploadDocuments();
  const toast = useToast();
  const navigate = useNavigate();
  function add(files: File[], opts: { open?: boolean } = {}) {
    if (!files.length) return;
    upload.mutate(
      { files },
      {
        onSuccess: (r) => {
          const dup = r.items.filter((d) => d.duplicate).length;
          const fresh = r.items.length - dup;
          toast(
            fresh
              ? `Added ${fresh} file${fresh === 1 ? '' : 's'}. Claude is reading ${fresh === 1 ? 'it' : 'them'} and will name and file ${fresh === 1 ? 'it' : 'them'}.${dup ? ` ${dup} ${dup === 1 ? 'was' : 'were'} already here.` : ''}`
              : `${dup === 1 ? 'That file is' : 'Those files are'} already in the case.`,
            fresh ? 'ok' : 'info',
          );
          const first = r.items.find((d) => !d.duplicate) ?? r.items[0];
          if (opts.open && first) void navigate({ to: '/documents', search: { id: first.id } });
        },
        onError: (err) => toast(errorMessage(err, 'The upload did not work'), 'bad'),
      },
    );
  }
  return { add, busy: upload.isPending };
}

export function AddDocumentsButton({ label = 'Add documents', variant = 'primary', className, open = true }: { label?: string; variant?: 'primary' | 'default' | 'ghost'; className?: string; open?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const { add, busy } = useAddDocuments();
  const canWrite = useMe().canWrite;
  if (!canWrite) return null;
  return (
    <>
      <Button variant={variant} className={className} disabled={busy} onClick={() => input.current?.click()} title="Choose files from this computer, or drag them anywhere onto the window. Claude reads, names and files each one, and checks its details against your clinical records.">
        {busy ? 'Adding…' : label}
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        accept={UPLOAD_ACCEPT}
        onChange={(e) => {
          add(Array.from(e.target.files ?? []), { open });
          e.target.value = '';
        }}
      />
    </>
  );
}

/** A failure reason in plain words (the raw text stays in the AI usage log). */
export function friendlyReason(reason: string): string {
  if (/401|x-api-key|authentication|invalid api key/i.test(reason)) return 'the API key was not accepted';
  if (/no api key|NoApiKey/i.test(reason)) return 'no API key was stored';
  if (/switched off|AiDisabled|ai\.enabled/i.test(reason)) return 'Claude was switched off in Settings';
  if (/max_tokens/i.test(reason)) return 'Claude ran out of room for its answer';
  if (/429|rate limit|overloaded|529/i.test(reason)) return 'Claude was busy';
  if (/credit|billing|402/i.test(reason)) return 'the Anthropic account is out of credit';
  if (/no page text/i.test(reason)) return 'no readable text was found; try Read as a scan';
  return reason.length > 140 ? `${reason.slice(0, 140)}…` : reason;
}

const TARGET_WORDS: Record<string, string> = {
  document: 'Document type',
  communication: 'Calls and messages',
  encounter: 'Appointments',
  record: 'Records checklist',
  medication: 'Medications',
  intolerance: 'Allergies and intolerances',
};

/** Where each kind of placement is shown, and the view it is in. */
const TARGET_VIEWS: Record<string, Record<string, string>> = {
  encounter: { view: 'past' },
  medication: { view: 'all' },
  intolerance: { view: 'intolerances' },
};

const TARGET_LINKS: Record<string, string> = {
  communication: '/communications',
  encounter: '/encounters',
  record: '/records',
  medication: '/medications',
  intolerance: '/medications',
};

/** The server also says whether the user has worked on the item since it was added (no Undo then). */
type FilingRead = Filing & { workedOn?: boolean };

/** What a placement that stays says on the right instead of Undo. */
function settledWords(f: FilingRead): string {
  if (f.targetGone) return 'deleted since';
  if (f.targetType === 'record' && f.action === 'created') return 'simply true';
  if (f.status === 'confirmed' && f.decidedBy !== 'automatic') return `kept${f.decidedBy ? ` by ${f.decidedBy}` : ' by you'}`;
  if (f.workedOn) return 'change it on its page';
  return '';
}

/**
 * On a document: where Claude filed it. Everything is filed automatically and
 * settled at once; each placement has Undo (the document itself stays). The
 * type has Change type. What still needs the user here: a move the clinician
 * suggested (Move it / Leave it), and a document not sorted yet.
 * `detailsToCheck` is accepted for older callers and no longer shown: details
 * do not wait for a check (their trust comes from reconciliation).
 */
export function DocumentFilingPanel({ documentId, category, classified = false, filingError = null }: { documentId: string; category: string; classified?: boolean; filingError?: string | null; detailsToCheck?: number | null }) {
  const filings = useFilings({ documentId });
  const decide = useFilingDecision();
  const refile = useRefile();
  const unsorted = useUnsorted();
  const sort = useSortDocument();
  const fileNow = useFileDocument();
  const toast = useToast();
  const navigate = useNavigate();
  const canWrite = useMe().canWrite;
  const [changing, setChanging] = useState(false);

  const all = filings.data?.items ?? [];
  const unsortedHere = (unsorted.data?.items ?? []).find((u) => u.id === documentId) ?? null;
  const proposals = all.filter((f) => f.status === 'proposed');
  const standing = all.filter((f) => (f.status === 'confirmed' || f.status === 'pending') && f.action !== 'move');
  // The newest standing type placement (Claude's, or the type the user chose) is the type line; the rest are the places it was filed.
  const typeLine = standing.find((f) => f.targetType === 'document') ?? null;
  const placed = standing.filter((f) => f.targetType !== 'document');
  // The document has a type that stands (Claude's, the user's, or an approved move). A move the user declined, or a
  // type turned down or undone, does not sort it: a never-sorted document keeps its "not sorted yet" panel.
  const typeFiled = all.some((f) => f.targetType === 'document' && f.status !== 'declined' && f.status !== 'rejected' && f.status !== 'undone');

  function act(f: Filing, decision: 'reject' | 'approve' | 'decline') {
    decide.mutate(
      { id: f.id, decision },
      {
        onSuccess: () => toast(decision === 'reject' ? 'Undone. The document itself is untouched.' : decision === 'approve' ? 'Moved, and filed again under the new type' : 'Left where it was', 'ok'),
        onError: (err) => toast(errorMessage(err, 'That did not work'), 'bad'),
      },
    );
  }

  function changeType(toCategory: string) {
    if (!toCategory) {
      setChanging(false);
      return;
    }
    refile.mutate(
      { documentId, toCategory },
      {
        onSuccess: () => {
          toast(toCategory === category ? `Kept as ${documentTypeLabel(toCategory)}` : `Changed to ${documentTypeLabel(toCategory)} and filed again`, 'ok');
          setChanging(false);
        },
        onError: (err) => toast(errorMessage(err, 'Could not change the type'), 'bad'),
      },
    );
  }

  if (filings.isPending) return null;
  // Named by Claude but its type was never filed (a rename, or a filing that failed): say so and offer to file it.
  const unfiledHere = !unsortedHere && classified && !all.some((f) => f.targetType === 'document');
  if (unfiledHere) {
    return (
      <div className="filing-panel waiting">
        <div className="filing-head">
          <span>
            <span className="waiting-dot" aria-hidden />
            Claude named this but has not filed it yet
          </span>
        </div>
        <div className="small muted">
          {filingError ? `The last try did not work (${friendlyReason(filingError)}).` : 'Filing puts it with your calls and messages, appointments and records.'}
          {all.length ? ` ${all.length} other item${all.length === 1 ? ' was' : 's were'} already filed from it (medications).` : ''}
        </div>
        {canWrite ? (
          <div className="filing-foot">
            <Button
              size="sm"
              variant="accent"
              disabled={fileNow.isPending}
              onClick={() =>
                fileNow.mutate(documentId, {
                  onSuccess: (r) => toast(r.error ? `Could not file it: ${friendlyReason(r.error)}` : r.needsSorting ? 'Claude needs to sort it first' : `Filed. ${r.created} item${r.created === 1 ? '' : 's'} placed; each can be undone here.`, r.error ? 'bad' : 'ok'),
                  onError: (err) => toast(errorMessage(err, 'Could not file it'), 'bad'),
                })
              }
            >
              {fileNow.isPending ? 'Filing…' : 'File it now'}
            </Button>
            <span className="small muted">or</span>
            <TypeMenu open={changing} setOpen={setChanging} value={category} onPick={changeType} busy={refile.isPending} label="Choose the type yourself" />
          </div>
        ) : null}
      </div>
    );
  }
  if (unsortedHere && !typeFiled) {
    return (
      <div className="filing-panel waiting">
        <div className="filing-head">
          <span>
            <span className="waiting-dot" aria-hidden />
            {unsortedHere.sorting ? 'Claude is sorting this now…' : 'Claude has not sorted this yet'}
          </span>
        </div>
        {!unsortedHere.sorting ? (
          <div className="small muted">
            {unsortedHere.reason
              ? `The last try did not work (${friendlyReason(unsortedHere.reason)}). Try again, or choose the type yourself.`
              : 'Sorting gives it a clear name, a type, and files it with your calls, appointments and medications.'}
          </div>
        ) : null}
        {canWrite && !unsortedHere.sorting ? (
          <div className="filing-foot">
            <Button size="sm" variant="accent" disabled={sort.isPending} onClick={() => sort.mutate(documentId, { onSuccess: () => toast('Claude is sorting it; it is named and filed when done', 'ok'), onError: (err) => toast(errorMessage(err, 'Could not start'), 'bad') })}>
              Sort it now
            </Button>
            <span className="small muted">or</span>
            <TypeMenu open={changing} setOpen={setChanging} value={category} onPick={changeType} busy={refile.isPending} label="Choose the type yourself" />
          </div>
        ) : null}
      </div>
    );
  }
  if (!all.length) {
    return (
      <div className="filing-panel">
        <div className="filing-head">
          <span>
            Type: <strong>{documentTypeLabel(category)}</strong>
          </span>
          {canWrite ? <TypeMenu open={changing} setOpen={setChanging} value={category} onPick={changeType} busy={refile.isPending} /> : null}
        </div>
        <div className="small muted">Not filed anywhere else yet. Claude files a document after it has read it.</div>
      </div>
    );
  }

  return (
    <div className={`filing-panel${proposals.length ? ' waiting' : ''}`}>
      <div className="filing-head">
        <span>
          {proposals.length ? <span className="waiting-dot" aria-hidden /> : null}
          Filed automatically
        </span>
        <span className="grow" />
        {canWrite && placed.some((f) => f.undoable) ? <span className="faint xs">Undo takes one back; the document itself stays.</span> : null}
      </div>

      {proposals.map((f) => (
        <div key={f.id} className="filing-item proposal">
          <div className="grow">
            <div className="filing-what">{f.source === 'consult' ? 'The clinician suggests a different type' : 'A change of type is waiting'}</div>
            <div className="small">{f.summary}</div>
          </div>
          {canWrite ? (
            <span className="row">
              <Button size="sm" variant="accent" disabled={decide.isPending} onClick={() => act(f, 'approve')}>
                Move it
              </Button>
              <Button size="sm" variant="ghost" disabled={decide.isPending} onClick={() => act(f, 'decline')}>
                Leave it
              </Button>
            </span>
          ) : null}
        </div>
      ))}

      <div className="filing-item">
        <div className="grow">
          <div className="filing-what">Document type</div>
          <div className="small">{typeLine ? typeLine.summary : documentTypeLabel(category)}</div>
        </div>
        {canWrite ? <TypeMenu open={changing} setOpen={setChanging} value={category} onPick={changeType} busy={refile.isPending} /> : null}
      </div>

      {placed.map((f) => {
        const words = settledWords(f);
        return (
          <div key={f.id} className="filing-item">
            <div className="grow">
              <div className="filing-what">{TARGET_WORDS[f.targetType] ?? f.targetType}</div>
              <div className="small">
                {f.summary}
                {TARGET_LINKS[f.targetType] && !f.targetGone ? (
                  <>
                    {' '}
                    <a
                      href={TARGET_LINKS[f.targetType]}
                      onClick={(e) => {
                        e.preventDefault();
                        void navigate({ to: TARGET_LINKS[f.targetType], search: { ...(TARGET_VIEWS[f.targetType] ?? {}), id: f.targetId } });
                      }}
                    >
                      open
                    </a>
                  </>
                ) : null}
              </div>
            </div>
            {f.undoable && canWrite ? (
              <Button size="sm" variant="ghost" disabled={decide.isPending} onClick={() => act(f, 'reject')} title="Take this placement back. The document itself stays, and Claude will not make it again.">
                Undo
              </Button>
            ) : words ? (
              <span className="faint xs">{words}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * At the top of a calendar entry, call, medication or record that Claude
 * added from a document: a quiet line saying where it came from, with Undo.
 * Renders nothing when nothing about this item can be undone (the user
 * confirmed it, or Claude did not make it).
 */
export function FilingNotice({ targetType, targetId }: { targetType: string; targetId: string | null | undefined }) {
  const q = useFilings({ targetType, targetId: targetId ?? undefined }, Boolean(targetId));
  const decide = useFilingDecision();
  const toast = useToast();
  const navigate = useNavigate();
  const canWrite = useMe().canWrite;
  // Undo here takes back the very item on this page: it asks first, naming it.
  const [asking, setAsking] = useState<Filing | null>(null);
  // A medication's history lines show in its own history (each with its source); only the entry itself is listed here.
  const mine = (q.data?.items ?? []).filter((f) => f.targetId === targetId && f.undoable && !(f.targetType === 'medication' && f.action === 'linked'));
  if (!targetId || !mine.length) return null;
  return (
    <div className="filing-panel filing-notice">
      <Confirm
        open={asking !== null}
        onClose={() => setAsking(null)}
        danger
        title="Take this back?"
        confirmLabel="Undo"
        body={
          asking ? (
            <p className="small">
              {asking.summary}. Undo removes it from {TARGET_WORDS[asking.targetType] ?? 'the list'}; the document itself stays, and Claude will not add it again.
            </p>
          ) : null
        }
        onConfirm={() => {
          const f = asking;
          if (f) decide.mutate({ id: f.id, decision: 'reject' }, { onSuccess: () => toast('Undone. The document itself is untouched.', 'ok'), onError: (err) => toast(errorMessage(err, 'That did not work'), 'bad') });
        }}
      />
      {mine.map((f) => (
        <div key={f.id} className="filing-head">
          <span className="small">Added automatically</span>
          <span className="grow small muted">
            {f.summary}
            {f.documentId ? (
              <>
                {' '}
                <a
                  href={`/documents?id=${f.documentId}`}
                  onClick={(e) => {
                    e.preventDefault();
                    // Shown only when the filing names a document (the test around this link).
                    void navigate({ to: '/documents', search: { id: f.documentId! } });
                  }}
                >
                  see the document
                </a>
              </>
            ) : null}
          </span>
          {canWrite ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={decide.isPending}
              title="Take it back. The document itself stays, and Claude will not add it again."
              onClick={() => setAsking(f)}
            >
              Undo
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * Under a clinician answer: the document moves it proposed, each with Move it
 * / Leave it. Nothing changes until the user chooses.
 */
export function ProposedMoves({ ids }: { ids: string[] }) {
  const q = useFilings({ ids: ids.join(',') }, ids.length > 0);
  const decide = useFilingDecision();
  const toast = useToast();
  const navigate = useNavigate();
  const canWrite = useMe().canWrite;
  const items = (q.data?.items ?? []).filter((f) => f.action === 'move');
  if (!items.length) return null;
  return (
    <div className={`filing-panel${items.some((f) => f.status === 'proposed') ? ' waiting' : ''} filing-notice`}>
      <div className="filing-head">
        <span>The clinician suggests filing {items.length === 1 ? 'a document' : 'documents'} differently</span>
      </div>
      {items.map((f) => (
        <div key={f.id} className={`filing-item${f.status === 'proposed' ? ' pending' : ''}`}>
          <div className="grow">
            <div className="small">{f.summary}</div>
            {f.documentId ? (
              <a
                className="small"
                href={`/documents?id=${f.documentId}`}
                onClick={(e) => {
                  e.preventDefault();
                  // Shown only when the filing names a document (the test around this link).
                  void navigate({ to: '/documents', search: { id: f.documentId! } });
                }}
              >
                see the document
              </a>
            ) : null}
          </div>
          {f.status === 'proposed' && canWrite ? (
            <span className="row">
              <Button size="sm" variant="accent" disabled={decide.isPending} onClick={() => decide.mutate({ id: f.id, decision: 'approve' }, { onSuccess: () => toast('Moved, and filed again under the new type', 'ok'), onError: (err) => toast(errorMessage(err, 'Could not move it'), 'bad') })}>
                Move it
              </Button>
              <Button size="sm" variant="ghost" disabled={decide.isPending} onClick={() => decide.mutate({ id: f.id, decision: 'decline' }, { onSuccess: () => toast('Left where it was', 'ok') })}>
                Leave it
              </Button>
            </span>
          ) : (
            <span className="faint xs">{f.status === 'approved' ? 'moved' : f.status === 'declined' ? 'left as it was' : f.status}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function TypeMenu({ open, setOpen, value, onPick, busy, label = 'Change type' }: { open: boolean; setOpen: (v: boolean) => void; value: string; onPick: (v: string) => void; busy: boolean; label?: string }) {
  const [choice, setChoice] = useState(value);
  if (!open)
    return (
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setChoice(value);
          setOpen(true);
        }}
        title="Choose the right type; Claude files it again to match."
      >
        {label}
      </Button>
    );
  return (
    <span className="row">
      <select autoFocus aria-label="Document type" value={choice} disabled={busy} onChange={(e) => setChoice(e.target.value)}>
        {DOCUMENT_CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {DOCUMENT_TYPE_LABELS[c] ?? c}
          </option>
        ))}
      </select>
      <Button size="sm" variant="accent" disabled={busy} onClick={() => onPick(choice)}>
        {choice === value ? 'Keep this type' : 'Move to this type'}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </span>
  );
}
