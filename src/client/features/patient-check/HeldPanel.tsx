/**
 * A document held back as "May be someone else's record" (2026-10-09; server: services/patient-check.ts), in the right
 * pane of Documents and of Check before filing: why (the pages and what is printed on them), and the user's two answers,
 * "It's mine" (m) and "Not my record" (w, asks first). Open the original to look before answering.
 *
 * Also here: the "Not my record" confirmation every document's More menu uses, and the offer to add a record number
 * printed on a document the user said is his.
 */
import { useState, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Button } from '../../ui/Button';
import { Confirm } from '../../ui/Dialog';
import { DetailHeader, DetailPane } from '../../ui/DetailPane';
import { Loading, EmptyState, Section } from '../../ui/PageHeader';
import { Tag } from '../../ui/StatusTag';
import { DateTimeText } from '../../ui/DateText';
import { useToast } from '../../ui/Toast';
import { useBindings } from '../../app/shortcuts';
import { useRegisterCommands } from '../../app/commands';
import { useMe } from '../../api/users';
import { useSettings } from '../../api/hooks';
import { useDocument } from '../../api/documents';
import { documentTypeLabel } from '../../api/filing';
import { checkOfDocument, isHeldDocument, useAddRecordNumber, useMarkMine, useMarkNotMine } from '../../api/patient-check';
import { numberKey, heldWords, type PatientCheck } from '@shared/patient-identity';
import { HELD_EXPLAIN, HELD_WORDS, MINE_LABEL, MINE_TITLE, NOT_MINE_LABEL, NOT_MINE_TITLE, PATIENT_KEYS, addNumberLabel, mineToast, notMineBody, notMineToast, takenBackWords } from './words';
import './patient-check.css';

function errText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** "Not my record" with its confirmation, for any document (held or live). */
export function useNotMine(doc: { id: string; title: string } | null, onDone?: (id: string) => void): { ask: () => void; dialog: ReactNode; busy: boolean } {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const notMine = useMarkNotMine();
  const canWrite = useMe().canWrite;
  const dialog = doc ? (
    <Confirm
      open={open}
      onClose={() => setOpen(false)}
      danger
      title={NOT_MINE_LABEL}
      confirmLabel={NOT_MINE_LABEL}
      body={<p>{notMineBody(doc.title)}</p>}
      onConfirm={() =>
        notMine.mutate(doc.id, {
          onSuccess: (r) => {
            toast(notMineToast(r.kept ?? 0), 'ok');
            onDone?.(doc.id);
          },
          onError: (err) => toast(errText(err, 'Could not move it'), 'bad'),
        })
      }
    />
  ) : null;
  return { ask: () => (doc && canWrite ? setOpen(true) : undefined), dialog, busy: notMine.isPending };
}

/** The pages that conflict and what is printed on them (at most 12 rows). */
function PrintedTable({ check, onOpenPage }: { check: PatientCheck; onOpenPage: (page: number) => void }) {
  const rows = check.conflicts.slice(0, 12);
  const sorting = check.sorting && check.sorting.verified && check.sorting.reasons.length ? check.sorting : null;
  if (!rows.length && !sorting) return null;
  return (
    <table className="doc-subtable held-table">
      <thead>
        <tr>
          <th className="num">Page</th>
          <th>Name printed</th>
          <th>Date of birth</th>
          <th>Record number</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((f) => (
          <tr key={f.page}>
            <td className="num">
              <a
                href={`#p${f.page}`}
                onClick={(e) => {
                  e.preventDefault();
                  onOpenPage(f.page);
                }}
              >
                {f.page}
              </a>
            </td>
            <td>{f.name ?? <span className="muted">none</span>}</td>
            <td className="mono">{f.dob ?? <span className="muted">none</span>}</td>
            <td className="mono">{f.mrn ?? <span className="muted">none</span>}</td>
          </tr>
        ))}
        {sorting ? (
          <tr>
            <td className="num">{sorting.page ?? ''}</td>
            <td colSpan={3}>
              {sorting.name ?? ''} <span className="muted small">(read by Claude while sorting it)</span>
            </td>
          </tr>
        ) : null}
      </tbody>
      {check.conflictPages.length > rows.length ? (
        <tfoot>
          <tr>
            <td colSpan={4}>And {check.conflictPages.length - rows.length} more pages.</td>
          </tr>
        </tfoot>
      ) : null}
    </table>
  );
}

/** The right pane for a held document. `onAnswered` runs after either answer (the list moves on). */
export function HeldPanel({ id, onAnswered, group = 'Documents' }: { id: string; onAnswered?: (id: string, answer: 'mine' | 'not_mine') => void; group?: string }) {
  const doc = useDocument(id);
  const navigate = useNavigate();
  const toast = useToast();
  const canWrite = useMe().canWrite;
  const mine = useMarkMine();
  const d = doc.data ?? null;
  const notMine = useNotMine(d, (x) => onAnswered?.(x, 'not_mine'));
  const held = isHeldDocument(d);
  const check = checkOfDocument(d);

  function runMine() {
    if (!d || !held || !canWrite || mine.isPending) return;
    mine.mutate(d.id, {
      onSuccess: (r) => {
        toast(mineToast(r.carriedOn), 'ok');
        onAnswered?.(d.id, 'mine');
      },
      onError: (err) => toast(errText(err, 'Could not bring it back'), 'bad'),
    });
  }
  const openPage = (page?: number) => d && void navigate({ to: '/documents/$id', params: { id: d.id }, search: page ? { page } : { tab: 'original' } });

  useBindings(
    [
      { keys: PATIENT_KEYS.mine, description: `${MINE_LABEL}: the selected document is yours`, group, when: () => held && canWrite, run: runMine },
      { keys: PATIENT_KEYS.notMine, description: `${NOT_MINE_LABEL}: the selected document is someone else's (asks first)`, group, when: () => held && canWrite, run: notMine.ask },
    ],
    [d?.id, held, canWrite, mine.isPending],
  );
  useRegisterCommands(
    [
      { id: 'patient.mine', title: `${MINE_LABEL} (the selected document is yours)`, group, shortcut: PATIENT_KEYS.mine, keywords: "someone else's record wrong patient twin mine quarantine held", when: () => held && canWrite, run: runMine },
      { id: 'patient.notMine', title: `${NOT_MINE_LABEL} (the selected document is someone else's)`, group, shortcut: PATIENT_KEYS.notMine, keywords: "someone else's record wrong patient twin delete trash held", when: () => held && canWrite, run: notMine.ask },
    ],
    [d?.id, held, canWrite, mine.isPending],
  );

  if (doc.isPending) return <Loading>Loading the document…</Loading>;
  if (!d) return <EmptyState title="That document is not available">It may have been answered already. Pick another from the list.</EmptyState>;
  if (!held || !check) return <EmptyState title="Answered">This document is no longer held back.</EmptyState>;
  return (
    <div className="doc-detail" tabIndex={-1}>
      <DetailPane label="Document held back">
        <DetailHeader
          eyebrow={
            <>
              <Tag tone="warn">{HELD_WORDS}</Tag>
              <span>{documentTypeLabel(d.category)}</span>
            </>
          }
          title={d.title}
          titleHint={d.title !== d.filename ? `File: ${d.filename}` : undefined}
          status={[
            <span key="pages">
              {d.pageCount.toLocaleString('en-US')} page{d.pageCount === 1 ? '' : 's'}
            </span>,
            check.quarantine?.at ? (
              <span key="at">
                held back <DateTimeText iso={check.quarantine.at} />
              </span>
            ) : null,
          ]}
          actions={
            canWrite
              ? {
                  primary: { label: mine.isPending ? 'Bringing it back…' : MINE_LABEL, onClick: runMine, shortcut: PATIENT_KEYS.mine, disabled: mine.isPending, title: MINE_TITLE },
                  secondary: [
                    { label: `${NOT_MINE_LABEL}…`, onClick: notMine.ask, shortcut: PATIENT_KEYS.notMine, disabled: notMine.busy, title: NOT_MINE_TITLE },
                    { label: 'Open original', onClick: () => openPage(), title: 'The file exactly as it was added, to see whose it is' },
                  ],
                }
              : { secondary: [{ label: 'Open original', onClick: () => openPage(), title: 'The file exactly as it was added' }] }
          }
        />
        <div className="held-why notice warn" role="status">
          <strong>{heldWords(check)}</strong> {HELD_EXPLAIN}
        </div>
        {takenBackWords(check.takenBack) ? <p className="muted small">{takenBackWords(check.takenBack)}</p> : null}
        <Section title="What is printed on it">
          <PrintedTable check={check} onOpenPage={(p) => openPage(p)} />
          {!canWrite ? <p className="muted small">The owner or an editor answers this.</p> : null}
        </Section>
      </DetailPane>
      {notMine.dialog}
    </div>
  );
}

/**
 * On a document the user said is his: each record number it prints from a place not on his list, with one button to add it
 * (the lead's C1). Nothing when there is none, or for viewers.
 */
export function AddNumberOffer({ check }: { check: PatientCheck | null }) {
  const settings = useSettings();
  const add = useAddRecordNumber();
  const toast = useToast();
  const canWrite = useMe().canWrite;
  if (!check || check.state !== 'mine' || !check.newNumbers.length || !canWrite || !settings.data) return null;
  const known = new Set((settings.data['patient.recordNumbers'] ?? []).map((n) => numberKey(n.number)));
  const offers = check.newNumbers.filter((n) => !known.has(numberKey(n.number))).slice(0, 3);
  if (!offers.length) return null;
  return (
    <div className="held-offer">
      {offers.map((n) => (
        <span key={n.number} className="held-offer-row">
          <span>
            It prints record number <span className="mono">{n.number}</span>
            {check.system ? ` (${check.system})` : ''}, not on your list.
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={add.isPending}
            onClick={() => add.mutate({ number: n.number, system: check.system ?? '' }, { onSuccess: () => toast('Added to your record numbers', 'ok'), onError: (err) => toast(errText(err, 'Could not add it'), 'bad') })}
            title="Patient details then hold back a document from the same place with another number"
          >
            {addNumberLabel(n.number)}
          </Button>
        </span>
      ))}
    </div>
  );
}
