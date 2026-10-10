/**
 * Possible duplicates: two details from different documents that look like the same thing. The list says how alike
 * they are, both statements (each with its document and date) and where the pair stands; the pane shows the two side
 * by side with Keep the first (a), Keep the second (b) and Keep both (r). Nothing is combined until the user chooses.
 */
import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { DataTable, type ColumnDef } from '../../ui/DataTable';
import { Tag, FactStatusTag } from '../../ui/StatusTag';
import { DateText } from '../../ui/DateText';
import { DetailHeader, DetailPane, KeyFacts } from '../../ui/DetailPane';
import { Loading } from '../../ui/PageHeader';
import { parseAttributes, type FactWithDoc, type MergeWithFacts } from '../../api/facts';
import { MERGE_STATUS_WORDS, alikeWords, factTypeWords, shownAttributes } from './words';

function MergeStatusTag({ status }: { status: string }) {
  const s = MERGE_STATUS_WORDS[status] ?? { label: status, tone: 'ash' as const };
  return <Tag tone={s.tone}>{s.label}</Tag>;
}

function MergeCell({ f }: { f: FactWithDoc }) {
  return (
    <div className="merge-cell">
      <span className="clamp2">{f.statement}</span>
      <span className="doc">
        <DateText iso={f.date} precision={f.datePrecision} /> · {f.documentTitle ?? 'added by hand'}
      </span>
    </div>
  );
}

export function MergesTable({ items, selectedId, onSelect, onOpen, loading }: { items: MergeWithFacts[]; selectedId: string | null; onSelect: (m: MergeWithFacts | null) => void; onOpen: (m: MergeWithFacts) => void; loading: boolean }) {
  const columns = useMemo<ColumnDef<MergeWithFacts, unknown>[]>(
    () => [
      { id: 'similarity', header: 'How alike', accessorKey: 'similarity', cell: ({ getValue }) => <span className="mono">{alikeWords(getValue() as number).replace(' alike', '')}</span>, meta: { width: 84, className: 'num' } },
      { id: 'a', header: 'First (a)', accessorFn: (r) => r.a.statement, cell: ({ row }) => <MergeCell f={row.original.a} />, meta: { grow: true, minWidth: 160 } },
      { id: 'b', header: 'Second (b)', accessorFn: (r) => r.b.statement, cell: ({ row }) => <MergeCell f={row.original.b} />, meta: { grow: true, minWidth: 160 } },
      { id: 'status', header: 'Where it stands', accessorKey: 'status', cell: ({ getValue }) => <MergeStatusTag status={String(getValue())} />, meta: { width: 124, shrink: false } },
    ],
    [],
  );
  if (loading && !items.length) return <Loading>Loading possible duplicates…</Loading>;
  return (
    <DataTable
      columns={columns}
      data={items}
      rowId={(r) => r.id}
      selectedId={selectedId}
      onSelect={onSelect}
      onOpen={onOpen}
      initialSort={[{ id: 'similarity', desc: true }]}
      emptyText="No possible duplicates here. Nothing is combined until you choose."
      tableId="facts.merges"
      autoFocus
    />
  );
}

function Side({ label, keyHint, f, kept }: { label: string; keyHint: string; f: FactWithDoc; kept: boolean }) {
  const attrs = parseAttributes(f);
  return (
    <div className={`merge-side${kept ? ' kept' : ''}`}>
      <div className="side-label">
        <span>
          {label} <span className="side-key">{keyHint}</span>
        </span>
        {kept ? <Tag tone="ok">kept</Tag> : <FactStatusTag status={f.status} basis={f.verdictBasis} hideAutomatic />}
      </div>
      <p className="merge-statement">{f.statement}</p>
      <KeyFacts
        items={[
          { label: 'Type', value: factTypeWords(f.type) },
          { label: 'Date', value: <DateText iso={f.date} precision={f.datePrecision} text={f.dateText} /> },
          { label: 'Document', value: f.sourceDocumentId ? <Link to="/documents/$id" params={{ id: f.sourceDocumentId }}>{f.documentTitle ?? 'Open the document'}</Link> : 'added by hand', wide: true },
          ...shownAttributes(attrs, f.type).map((a) => ({ label: a.label, value: a.text, mono: a.data })),
        ]}
      />
    </div>
  );
}

export function MergeDetail({ merge, busy, onAccept, onReject, onOpenFact }: { merge: MergeWithFacts; busy: boolean; onAccept: (keep: 'a' | 'b') => void; onReject: () => void; onOpenFact: (id: string) => void }) {
  const pending = merge.status === 'pending';
  return (
    <DetailPane label="Possible duplicates">
      <DetailHeader
        eyebrow={
          <>
            <MergeStatusTag status={merge.status} />
            <span>Possible duplicates</span>
          </>
        }
        title={merge.a.statement}
        status={[alikeWords(merge.similarity), merge.reason ? `why: ${merge.reason}` : null, merge.decidedAt ? <span key="d">decided <DateText iso={merge.decidedAt.slice(0, 10)} /></span> : null]}
        actions={
          pending
            ? {
                primary: { label: 'Keep the first', onClick: () => onAccept('a'), shortcut: 'a', disabled: busy, title: 'The first stays; the second is marked replaced by it and its quotes are copied across. Nothing is deleted.' },
                secondary: [
                  { label: 'Keep the second', onClick: () => onAccept('b'), shortcut: 'b', disabled: busy, title: 'The second stays; the first is marked replaced by it. Nothing is deleted.' },
                  { label: 'Keep both', onClick: onReject, shortcut: 'r', disabled: busy, title: 'They are not the same thing: both stay as they are' },
                ],
                more: [
                  { label: 'Open the first', onClick: () => onOpenFact(merge.a.id) },
                  { label: 'Open the second', onClick: () => onOpenFact(merge.b.id) },
                ],
              }
            : {
                secondary: [
                  { label: 'Open the first', onClick: () => onOpenFact(merge.a.id) },
                  { label: 'Open the second', onClick: () => onOpenFact(merge.b.id) },
                ],
              }
        }
      />
      <div className="merge-pair">
        <Side label="First" keyHint="(a)" f={merge.a} kept={merge.status === 'accepted' && merge.b.supersededById === merge.a.id} />
        <Side label="Second" keyHint="(b)" f={merge.b} kept={merge.status === 'accepted' && merge.a.supersededById === merge.b.id} />
      </div>
      <p className="section-intro">Keeping one marks the other replaced by it and copies its quotes across. Nothing is deleted.</p>
    </DetailPane>
  );
}
