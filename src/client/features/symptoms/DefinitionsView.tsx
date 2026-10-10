/**
 * Symptoms you track: the symptoms as a dense table (left) and the selected one (right), in the detail pane's order:
 * what it is, one status line, the actions (Chart it, move it, the rest under More), then its name and what 0 and 10
 * mean, editable. Retiring keeps every score; the order here is the order of the diary and the 14-day strip.
 */
import { useEffect, useMemo, useState } from 'react';
import { DataTable, type ColumnDef } from '../../ui/DataTable';
import { Button } from '../../ui/Button';
import { Field, Input, Textarea } from '../../ui/Field';
import { Tag } from '../../ui/StatusTag';
import { Section } from '../../ui/PageHeader';
import { DetailHeader, DetailPane } from '../../ui/DetailPane';
import { Kbd } from '../../ui/Kbd';
import { Dialog } from '../../ui/Dialog';
import type { SymptomDefinition } from '../../api/symptoms';

const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

export function SymptomStateTag({ active }: { active: boolean }) {
  return active ? (
    <Tag tone="ok" title="Scored in the diary and shown in the 14-day strip">
      tracking
    </Tag>
  ) : (
    <Tag tone="ash" title="No longer in the diary; its scores are kept and still chartable">
      retired
    </Tag>
  );
}

export function DefinitionsTable({ items, selectedId, onSelect, onOpen }: { items: SymptomDefinition[]; selectedId: string | null; onSelect: (d: SymptomDefinition | null) => void; onOpen: (d: SymptomDefinition) => void }) {
  // The place in the diary (1, 2, 3 ...), from the stored order, which may have gaps.
  const place = useMemo(() => new Map([...items].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)).map((d, i) => [d.id, i + 1])), [items]);
  const columns = useMemo<ColumnDef<SymptomDefinition, unknown>[]>(
    () => [
      { id: 'order', header: 'Order', accessorKey: 'sortOrder', cell: ({ row }) => <span className="mono">{place.get(row.original.id) ?? ''}</span>, meta: { width: 52, className: 'num' } },
      // The name and what its scores mean share the room (both grow); the meaning wraps to two lines, then "…".
      { id: 'name', header: 'Symptom', accessorKey: 'name', meta: { grow: true, minWidth: 130, maxWidth: 240 } },
      { id: 'description', header: 'What 0 and 10 mean', accessorFn: (r) => r.description ?? '', cell: ({ getValue }) => <span className="muted">{String(getValue())}</span>, meta: { grow: true, minWidth: 120, maxWidth: 360 } },
      { id: 'active', header: 'Status', accessorFn: (r) => (r.active ? 1 : 0), cell: ({ row }) => <SymptomStateTag active={row.original.active} />, meta: { width: 80, shrink: false } },
      { id: 'entries', header: 'Days scored', accessorKey: 'entryCount', cell: ({ getValue }) => <span className="mono">{String(getValue())}</span>, meta: { width: 92, className: 'num' } },
      { id: 'last', header: 'Latest', accessorFn: (r) => r.lastDate ?? '', cell: ({ getValue }) => <span className="mono">{String(getValue())}</span>, meta: { width: 96, shrink: false } },
    ],
    [place],
  );
  return (
    <DataTable
      columns={columns}
      data={items}
      rowId={(r) => r.id}
      selectedId={selectedId}
      onSelect={onSelect}
      onOpen={onOpen}
      initialSort={[{ id: 'order', desc: false }]}
      rowClassName={(r) => (r.active ? undefined : 'dim')}
      emptyText="No symptoms yet."
      footer={<span>Retired symptoms keep their scores; the order is the diary's order.</span>}
      tableId="symptoms.tracked"
      autoFocus
    />
  );
}

export interface DefinitionDetailProps {
  def: SymptomDefinition;
  busy: boolean;
  focusName: number;
  onSave: (patch: { name?: string; description?: string | null }) => void;
  onToggleActive: () => void;
  onMove: (delta: -1 | 1) => void;
  /** Open the chart with only this symptom. */
  onChart: () => void;
  /** Viewers read the definition; the move, retire and save controls are hidden. */
  readOnly?: boolean;
}

export function DefinitionDetail({ def, busy, focusName, onSave, onToggleActive, onMove, onChart, readOnly = false }: DefinitionDetailProps) {
  const [name, setName] = useState(def.name);
  const [description, setDescription] = useState(def.description ?? '');
  useEffect(() => {
    setName(def.name);
    setDescription(def.description ?? '');
  }, [def.id, def.name, def.description]);
  useEffect(() => {
    if (focusName) document.querySelector<HTMLInputElement>('input[data-def-name]')?.focus();
  }, [focusName]);
  const dirty = name.trim() !== def.name || (description.trim() || '') !== (def.description ?? '');
  function save() {
    if (readOnly || !name.trim() || !dirty) return;
    onSave({ name: name.trim(), description: description.trim() || null });
  }
  return (
    <DetailPane label="Symptom">
      <DetailHeader
        eyebrow={
          <>
            <span>Symptom</span>
            <SymptomStateTag active={def.active} />
          </>
        }
        title={def.name}
        status={[
          def.entryCount ? `scored on ${days(def.entryCount)}` : 'not scored yet',
          def.lastDate ? (
            <span key="last">
              last scored <span className="mono">{def.lastDate}</span>
            </span>
          ) : null,
        ]}
        actions={{
          primary: { label: 'Chart this symptom', onClick: onChart, title: 'Open the chart with only this symptom' },
          secondary: readOnly
            ? []
            : [
                { label: 'Move up', onClick: () => onMove(-1), shortcut: 'alt+k', disabled: busy, title: 'Earlier in the diary and the strip' },
                { label: 'Move down', onClick: () => onMove(1), shortcut: 'alt+j', disabled: busy, title: 'Later in the diary and the strip' },
              ],
          more: readOnly
            ? []
            : [
                def.active
                  ? { label: 'Retire this symptom', onClick: onToggleActive, shortcut: 'Delete', danger: true, disabled: busy, title: 'Takes it out of the diary; every score is kept (asks first)' }
                  : { label: 'Track it again', onClick: onToggleActive, disabled: busy, title: 'Puts it back in the diary and the strip' },
              ],
        }}
      />
      <Section title="Name and what the scores mean" intro={readOnly ? undefined : 'Saved with the button or Ctrl+Enter.'}>
        <div
          className="form"
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              save();
            }
          }}
        >
          <Field label="Name" inline>
            <Input data-def-name value={name} readOnly={readOnly} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="What 0 and 10 mean" inline hint="So scores stay comparable over months, e.g. 0 = no joint pain, 10 = the worst you have had.">
            <Textarea value={description} readOnly={readOnly} placeholder="e.g. 0 = none, 5 = hard to walk far, 10 = cannot stand" onChange={(e) => setDescription(e.target.value)} rows={3} />
          </Field>
          {readOnly ? null : (
            <div className="form-actions">
              <Button variant="primary" size="sm" disabled={busy || !dirty || !name.trim()} onClick={save}>
                Save <Kbd>ctrl+enter</Kbd>
              </Button>
            </div>
          )}
        </div>
      </Section>
      <Section title={def.active ? 'If you retire it' : 'Retired'}>
        <p className="sym-prose">
          {def.active
            ? `It leaves the diary and the 14-day strip. Its ${def.entryCount === 1 ? 'score stays' : `${def.entryCount} scores stay`} in the history and on the timeline, and you can track it again here, or by adding a symptom with the same name.`
            : `It is not in the diary or the strip. Its ${def.entryCount === 1 ? 'score is' : `${def.entryCount} scores are`} kept and can still be charted; Track it again (under More) puts it back.`}
        </p>
      </Section>
    </DetailPane>
  );
}

export function NewDefinitionDialog({ open, onClose, busy, error, onCreate }: { open: boolean; onClose: () => void; busy: boolean; error: string | null; onCreate: (input: { name: string; description: string | null }) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
    }
  }, [open]);
  function submit() {
    if (!name.trim() || busy) return;
    onCreate({ name: name.trim(), description: description.trim() || null });
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a symptom to track"
      width={520}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !name.trim()} onClick={submit}>
            Add symptom <Kbd>ctrl+enter</Kbd>
          </Button>
        </>
      }
    >
      <div
        className="stack"
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
      >
        {error ? <div className="notice bad small">{error}</div> : null}
        <Field label="Name" hint="Short, as you would say it.">
          <Input autoFocus value={name} placeholder="e.g. Joint pain, Dizziness, Nausea" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="What 0 and 10 mean" hint="Optional. Scores run from 0 (none) to 10 (the worst).">
          <Textarea value={description} placeholder="e.g. 0 = no joint pain, 10 = the worst you have had" onChange={(e) => setDescription(e.target.value)} rows={3} />
        </Field>
      </div>
    </Dialog>
  );
}
