/**
 * Pickers for the composer: a dialog to choose the documents the clinician
 * looks at (a table with a tick per row; Space ticks, Enter uses them), the
 * person a drafted message is for ("To:") and the visit a briefing prepares
 * ("Visit:"; with no appointments on file the briefing uses the whole case).
 */
import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Select } from '../../ui/Field';
import { FilterGroup, KeyHints, SearchField } from '../../ui/Toolbar';
import { DataTable, type ColumnDef } from '../../ui/DataTable';
import { DateText } from '../../ui/DateText';
import { Loading } from '../../ui/PageHeader';
import { useDocuments, type DocumentListItem } from '../../api/documents';
import { documentTypeLabel } from '../../api/filing';
import { usePeople } from '../../api/people';
import { useEncountersLite } from '../../api/ask';
import { dateSortKey, formatPartialDate } from '@shared/dates';

export function DocumentPickerDialog({ open, onClose, selected, onApply }: { open: boolean; onClose: () => void; selected: string[]; onApply: (ids: string[]) => void }) {
  const docs = useDocuments({});
  const [picked, setPicked] = useState<Set<string>>(() => new Set(selected));
  const [filter, setFilter] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setPicked(new Set(selected));
      setFilter('');
    }
  }, [open, selected]);
  const items = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = docs.data?.items ?? [];
    return q ? all.filter((d) => `${d.title} ${documentTypeLabel(d.category)} ${d.institutionName ?? ''}`.toLowerCase().includes(q)) : all;
  }, [docs.data, filter]);
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const columns = useMemo<ColumnDef<DocumentListItem, unknown>[]>(
    () => [
      {
        id: 'on',
        header: '',
        accessorFn: (r) => (picked.has(r.id) ? 1 : 0),
        cell: ({ row }) => <input type="checkbox" checked={picked.has(row.original.id)} onChange={() => toggle(row.original.id)} onClick={(e) => e.stopPropagation()} aria-label={`Look at ${row.original.title}`} />,
        meta: { width: 36 },
      },
      { id: 'date', header: 'Date', accessorFn: (r) => (r.documentDate ? dateSortKey(r.documentDate) : undefined), sortUndefined: 'last', cell: ({ row }) => <DateText iso={row.original.documentDate} precision={row.original.documentDatePrecision} />, meta: { width: 100 } },
      { id: 'title', header: 'Document', accessorKey: 'title', cell: ({ getValue }) => String(getValue()), meta: { grow: true, minWidth: 240 } },
      { id: 'category', header: 'Type', accessorFn: (r) => documentTypeLabel(r.category), meta: { maxWidth: 180 } },
      { id: 'pages', header: 'Pages', accessorKey: 'pageCount', meta: { width: 64, className: 'num' } },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [picked],
  );
  if (!open) return null;
  const apply = () => {
    onApply([...picked]);
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Choose the documents to look at"
      width={860}
      footer={
        <>
          <span className="muted small grow">
            <span className="mono">{picked.size}</span> chosen
          </span>
          <KeyHints items={[['space', 'tick'], ['enter', 'use them']]} />
          <Button variant="ghost" onClick={() => setPicked(new Set())} disabled={!picked.size}>
            Clear the ticks
          </Button>
          <Button variant="primary" onClick={apply}>
            {picked.size ? `Look at ${picked.size === 1 ? 'this document' : `these ${picked.size}`}` : 'Look at everything'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="muted small">The clinician answers from the ticked documents only. With none ticked it looks at the whole case.</p>
        <SearchField label="Find" placeholder="Name, type or where it came from" value={filter} onChange={setFilter} width={320} />
        <div className="ask-pick-list">
          {docs.isPending ? (
            <Loading>Loading documents…</Loading>
          ) : (
            <DataTable
              columns={columns}
              data={items}
              rowId={(r) => r.id}
              selectedId={sel}
              onSelect={(r) => setSel(r?.id ?? null)}
              onOpen={apply}
              initialSort={[{ id: 'date', desc: true }]}
              tableId="ask.pick-documents"
              onKey={(e, row) => {
                if (e.key === ' ' && row) {
                  toggle(row.id);
                  return true;
                }
                return false;
              }}
              emptyText={filter.trim() ? 'No document matches.' : 'No documents yet. Add documents first.'}
              autoFocus
            />
          )}
        </div>
      </div>
    </Dialog>
  );
}

export function PersonSelect({ value, onChange, enabled = true }: { value: string | null; onChange: (id: string | null) => void; enabled?: boolean }) {
  const people = usePeople({});
  const items = (people.data?.items ?? []).filter((p) => p.kind !== 'patient');
  if (!enabled) return null;
  return (
    <FilterGroup label="To">
      <Select
        aria-label="Who the message is for"
        value={value ?? ''}
        placeholder={items.length ? 'Choose a person' : 'No people on file yet'}
        options={items.map((p) => ({ value: p.id, label: `${p.name}${p.role ? ` · ${p.role}` : p.kind !== 'clinician' ? ` · ${p.kind.replace(/_/g, ' ')}` : ''}` }))}
        onChange={(e) => onChange(e.target.value || null)}
        style={{ maxWidth: 260 }}
      />
    </FilterGroup>
  );
}

export function EncounterSelect({ value, onChange, enabled = true }: { value: string | null; onChange: (id: string | null) => void; enabled?: boolean }) {
  const enc = useEncountersLite(enabled);
  const items = enc.data ?? [];
  if (!enabled) return null;
  return (
    <FilterGroup label="Visit">
      <Select
        aria-label="The visit to prepare for"
        value={value ?? ''}
        placeholder={items.length ? 'Choose a visit' : 'No appointments on file: uses the whole case'}
        options={items.map((e) => ({ value: e.id, label: `${e.occurredAt ? `${formatPartialDate(e.occurredAt, (e.occurredAtPrecision as 'day' | 'month' | 'year') ?? 'day')} · ` : ''}${e.title}` }))}
        onChange={(e) => onChange(e.target.value || null)}
        style={{ maxWidth: 300 }}
      />
    </FilterGroup>
  );
}
