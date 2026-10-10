/**
 * The packet form, as numbered steps down one readable column: 1 about the packet, 2 the documents added at the end
 * (a bounded picker: Space ticks a row, a ticks every row shown), 3 details from documents, 4 what Claude noticed,
 * 5 the timeline, 6 other pages, 7 lab charts, 8 the cover summary. A footer that stays in view holds the page's one
 * primary action, Make the packet, with Preview beside it and the rarer actions under More, and says in words what is
 * still missing. State lives in the route; this component is pure UI.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { TIMELINE_KINDS, type TimelineKind } from '@shared/timeline';
import { dateSortKey } from '@shared/dates';
import { ActionBar } from '../../ui/ActionBar';
import { Button } from '../../ui/Button';
import { DataTable, type ColumnDef } from '../../ui/DataTable';
import { DateText, KeepDatesWhole } from '../../ui/DateText';
import { Field, Input, Textarea } from '../../ui/Field';
import { Loading, Section } from '../../ui/PageHeader';
import { KeyHints, SearchField } from '../../ui/Toolbar';
import { documentTypeLabel } from '../../api/filing';
import type { DocumentListItem } from '../../api/documents';
import type { ExportOptions } from '../../api/export';
import { useCareCounts } from '../../api/care-team';
import { sampleWords } from '../labs/tags';
import type { BuilderState, Scope } from './builderState';
import { FACT_SCOPE_WORDS, FINDING_SCOPE_WORDS, TIMELINE_KIND_WORDS, plural } from './words';

export interface PacketBuilderProps {
  state: BuilderState;
  onChange: (patch: Partial<BuilderState>) => void;
  documents: DocumentListItem[];
  documentsLoading: boolean;
  options: ExportOptions | undefined;
  busy: boolean;
  onGenerate: () => void;
  onPreview: () => void;
  onReset: () => void;
  preview: { html: string | null; loading: boolean; error: string | null; open: boolean };
  onClosePreview: () => void;
  /** Renders the preview (POST) and shows it in a new tab. */
  onPreviewTab: () => void;
  /** Viewers: the form can be filled and previewed but not made. */
  readOnly: boolean;
  titleRef: React.RefObject<HTMLInputElement | null>;
}

/** One radio choice with its count (mono) after the words. */
function Choice({ name, value, current, onPick, label, title, count }: { name: string; value: Scope; current: Scope; onPick: (v: Scope) => void; label: ReactNode; title?: string; count?: number }) {
  return (
    <label className="export-option" title={title}>
      <input type="radio" name={name} value={value} checked={current === value} onChange={() => onPick(value)} />
      <span>{label}</span>
      {count !== undefined ? <span className="export-count">{count}</span> : null}
    </label>
  );
}

/** One checkbox with its words and an optional count. */
function Check({ checked, onChange, children, count, disabled, title }: { checked: boolean; onChange: (on: boolean) => void; children: ReactNode; count?: ReactNode; disabled?: boolean; title?: string }) {
  return (
    <label className="export-option" title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
      {count != null && count !== '' ? <span className="export-count">{count}</span> : null}
    </label>
  );
}

/** What the packet will hold, in one line for the footer; or what is still needed. */
export function readinessWords(state: BuilderState, readOnly: boolean): { ready: boolean; words: string } {
  if (readOnly) return { ready: false, words: 'Viewers can fill in and preview a packet; the owner or an editor makes it.' };
  if (!state.title.trim()) return { ready: false, words: 'Give the packet a title (step 1) to make it.' };
  const parts = [
    state.documentIds.length ? `${plural(state.documentIds.length, 'document')} at the end` : 'no documents at the end',
    state.factScope === 'none' ? null : 'details',
    state.findingScope === 'none' ? null : 'what Claude noticed',
    state.includeTimeline ? 'a timeline' : null,
    state.includeLabs.length ? plural(state.includeLabs.length, 'lab chart') : null,
  ].filter(Boolean);
  return { ready: true, words: `Ready: ${parts.join(', ')}.` };
}

export function PacketBuilder(p: PacketBuilderProps) {
  const { state, onChange, documents, options } = p;
  const picked = useMemo(() => new Set(state.documentIds), [state.documentIds]);
  const [docFilter, setDocFilter] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);

  function toggleDoc(id: string) {
    const next = picked.has(id) ? state.documentIds.filter((x) => x !== id) : [...state.documentIds, id];
    onChange({ documentIds: next });
  }
  function setAll(ids: string[], on: boolean) {
    const set = new Set(state.documentIds);
    for (const id of ids) (on ? set.add(id) : set.delete(id));
    // Keep the original order for already-picked documents, append new ones in list order.
    const ordered = [...state.documentIds.filter((id) => set.has(id)), ...ids.filter((id) => set.has(id) && !state.documentIds.includes(id))];
    onChange({ documentIds: ordered });
  }
  const shownIds = useMemo(() => {
    const q = docFilter.trim().toLowerCase();
    return documents.filter((d) => !q || `${d.title} ${d.filename} ${documentTypeLabel(d.category)} ${d.institutionName ?? ''}`.toLowerCase().includes(q)).map((d) => d.id);
  }, [documents, docFilter]);
  const allShownPicked = shownIds.length > 0 && shownIds.every((id) => picked.has(id));

  const columns = useMemo<ColumnDef<DocumentListItem, unknown>[]>(
    () => [
      {
        id: 'pick',
        header: () => <span title="Tick a document to add it at the end of the packet (Space ticks the row)">Add</span>,
        accessorFn: (r) => (picked.has(r.id) ? 0 : 1),
        cell: ({ row }) => (
          <input type="checkbox" aria-label={`Add ${row.original.title}`} checked={picked.has(row.original.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggleDoc(row.original.id)} />
        ),
        meta: { width: 48, shrink: false, className: 'export-pick' },
      },
      {
        // The label the packet gives the document (D1, D2…): the order it was ticked in. Empty until ticked.
        id: 'order',
        header: () => <span title="The packet numbers the documents in the order you tick them">Order</span>,
        accessorFn: (r) => {
          const i = state.documentIds.indexOf(r.id);
          return i < 0 ? 9999 : i + 1;
        },
        cell: ({ row }) => {
          const i = state.documentIds.indexOf(row.original.id);
          return i < 0 ? null : <span className="mono">D{i + 1}</span>;
        },
        meta: { width: 60, shrink: false },
      },
      {
        id: 'date',
        header: 'Date',
        accessorFn: (r) => (r.documentDate ? dateSortKey(r.documentDate) : undefined),
        sortUndefined: 'last',
        cell: ({ row }) => <DateText iso={row.original.documentDate} precision={row.original.documentDatePrecision} text={row.original.documentDateText} />,
        meta: { width: 96, shrink: false },
      },
      { id: 'title', header: 'Document', accessorKey: 'title', cell: ({ row }) => <KeepDatesWhole text={row.original.title} />, meta: { grow: true, minWidth: 220 } },
      { id: 'category', header: 'Type', accessorFn: (r) => documentTypeLabel(r.category), cell: ({ getValue }) => <span className="muted">{String(getValue())}</span>, meta: { width: 110, maxWidth: 170 } },
      { id: 'pages', header: 'Pages', accessorKey: 'pageCount', meta: { className: 'num', width: 60 } },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [picked, state.documentIds],
  );

  const c = options?.counts;
  // How many are on the Care team list (2026-10-09, request 6: the Care team summary page).
  const care = useCareCounts();
  const ready = readinessWords(state, p.readOnly);
  const analyteName = useMemo(() => new Map((options?.analytes ?? []).map((a) => [a.analyteKey, a.analyte])), [options]);

  return (
    <div className="export-builder">
      <div className="export-steps">
        <Section title="1. About the packet" intro="The title and purpose are printed on the cover page.">
          <div className="export-row">
            <Field label="Title (needed)">
              <input ref={p.titleRef} type="text" value={state.title} placeholder="e.g. Second-opinion packet for Dr. X" onChange={(e) => onChange({ title: e.target.value })} aria-required="true" />
            </Field>
            <Field label="Prepared for">
              <Input type="text" value={state.recipient} placeholder="e.g. Dr. A. Example, neurology" onChange={(e) => onChange({ recipient: e.target.value })} />
            </Field>
            <div className="full">
              <Field label="Purpose">
                <Textarea rows={2} value={state.purpose} placeholder="Why this packet exists and what the reader should do with it" onChange={(e) => onChange({ purpose: e.target.value })} />
              </Field>
            </div>
          </div>
        </Section>

        <Section
          title="2. Documents to add at the end"
          count={`${state.documentIds.length} of ${documents.length}`}
          intro="Each ticked document is added after the summary pages as the original file, numbered in the order you tick them (D1, D2…)."
        >
          <div className="export-docs-bar">
            <SearchField label="Find" placeholder="Name or type, e.g. MRI" value={docFilter} onChange={setDocFilter} width={240} />
            <Button size="sm" onClick={() => setAll(shownIds, !allShownPicked)} disabled={!shownIds.length}>
              {allShownPicked ? 'Untick all shown' : docFilter.trim() ? 'Tick all shown' : 'Tick all'}
            </Button>
            {state.documentIds.length ? (
              <Button size="sm" variant="ghost" onClick={() => onChange({ documentIds: [] })}>
                Untick every document
              </Button>
            ) : null}
          </div>
          <div className="export-docs">
            {p.documentsLoading ? (
              <Loading>Loading documents…</Loading>
            ) : (
              <DataTable
                columns={columns}
                data={documents}
                rowId={(r) => r.id}
                selectedId={cursor}
                onSelect={(r) => setCursor(r?.id ?? null)}
                onOpen={(r) => toggleDoc(r.id)}
                globalFilter={docFilter}
                initialSort={[{ id: 'date', desc: true }]}
                rowClassName={(r) => (picked.has(r.id) ? 'picked' : undefined)}
                emptyText={documents.length ? 'No document matches this search.' : 'No documents yet. Add them on the Documents page first.'}
                tableId="export.documents"
                onKey={(e, row) => {
                  if (e.key === ' ' && row) {
                    toggleDoc(row.id);
                    return true;
                  }
                  if (e.key === 'a' && !e.ctrlKey && !e.metaKey) {
                    setAll(shownIds, !allShownPicked);
                    return true;
                  }
                  return false;
                }}
                footer={
                  <span className="export-docs-foot">
                    <span>{plural(state.documentIds.length, 'document')} ticked</span>
                    <KeyHints items={[['space', 'tick the row'], ['a', 'tick all shown'], ['enter', 'tick']]} />
                  </span>
                }
              />
            )}
          </div>
        </Section>

        <Section title="3. Details from documents" intro="The lab values, diagnoses, procedures and other details Claude pulled out, each with its page.">
          <div className="export-choices" role="radiogroup" aria-label="Details from documents">
            {(['confirmed', 'all', 'none'] as const).map((v) => (
              <Choice key={v} name="facts" value={v} current={state.factScope} onPick={(x) => onChange({ factScope: x })} label={FACT_SCOPE_WORDS[v].label} title={FACT_SCOPE_WORDS[v].title} count={v === 'confirmed' ? c?.factsConfirmed : v === 'all' ? c?.factsAll : undefined} />
            ))}
            {state.factIdList.length ? <Choice name="facts" value="chosen" current={state.factScope} onPick={(x) => onChange({ factScope: x })} label={FACT_SCOPE_WORDS.chosen.label} title={FACT_SCOPE_WORDS.chosen.title} count={state.factIdList.length} /> : null}
          </div>
          <Check checked={state.factsFromPacketDocumentsOnly} disabled={state.factScope === 'none'} onChange={(on) => onChange({ factsFromPacketDocumentsOnly: on })}>
            Only details from the documents ticked in step 2
          </Check>
        </Section>

        <Section title="4. What Claude noticed" intro="Contradictions, gaps and patterns Claude found across the records.">
          <div className="export-choices" role="radiogroup" aria-label="What Claude noticed">
            {(['confirmed', 'all', 'none'] as const).map((v) => (
              <Choice key={v} name="findings" value={v} current={state.findingScope} onPick={(x) => onChange({ findingScope: x })} label={FINDING_SCOPE_WORDS[v].label} title={FINDING_SCOPE_WORDS[v].title} count={v === 'confirmed' ? c?.findingsConfirmed : v === 'all' ? c?.findingsAll : undefined} />
            ))}
            {state.findingIdList.length ? <Choice name="findings" value="chosen" current={state.findingScope} onPick={(x) => onChange({ findingScope: x })} label={FINDING_SCOPE_WORDS.chosen.label} title={FINDING_SCOPE_WORDS.chosen.title} count={state.findingIdList.length} /> : null}
          </div>
        </Section>

        <Section
          title="5. Timeline"
          intro={
            options?.timelineRange.min ? (
              <>
                A dated list of what happened. The case runs from <span className="mono">{options.timelineRange.min}</span> to <span className="mono">{options.timelineRange.max}</span>.
              </>
            ) : (
              'A dated list of what happened.'
            )
          }
        >
          <Check checked={state.includeTimeline} onChange={(on) => onChange({ includeTimeline: on })}>
            Add a timeline
          </Check>
          {state.includeTimeline ? (
            <>
              <div className="export-row narrow">
                <Field label="From" hint="A year, a month or a day; empty starts at the beginning">
                  <Input type="text" className="mono" value={state.timelineFrom} placeholder={options?.timelineRange.min ? `e.g. ${options.timelineRange.min}` : 'e.g. 2024-03'} onChange={(e) => onChange({ timelineFrom: e.target.value })} />
                </Field>
                <Field label="To" hint="Empty runs to the end">
                  <Input type="text" className="mono" value={state.timelineTo} placeholder={options?.timelineRange.max ? `e.g. ${options.timelineRange.max}` : 'e.g. 2025-01'} onChange={(e) => onChange({ timelineTo: e.target.value })} />
                </Field>
              </div>
              <div className="filter-group export-kinds" role="group" aria-label="Kinds of entries in the timeline (none ticked: all)">
                <span className="filter-label">Show:</span>
                <span className="export-kind-list">
                  {TIMELINE_KINDS.map((k: TimelineKind) => {
                    const on = state.timelineKinds.includes(k);
                    return (
                      <button key={k} type="button" className="btn sm export-kind" aria-pressed={on} onClick={() => onChange({ timelineKinds: on ? state.timelineKinds.filter((x) => x !== k) : [...state.timelineKinds, k] })}>
                        {TIMELINE_KIND_WORDS[k]}
                      </button>
                    );
                  })}
                </span>
                <span className="muted small">{state.timelineKinds.length ? `${plural(state.timelineKinds.length, 'kind')} chosen` : 'Nothing chosen: every kind is shown'}</span>
              </div>
            </>
          ) : null}
        </Section>

        <Section title="6. Other pages">
          <div className="export-choices column">
            <Check checked={state.includeEmergencyCard} onChange={(on) => onChange({ includeEmergencyCard: on })} count={c ? plural(c.hardStops, 'drug', 'drugs') + ' never to give' : undefined}>
              Emergency card
            </Check>
            <Check checked={state.includeRecordsIndex} onChange={(on) => onChange({ includeRecordsIndex: on })} count={c ? plural(c.records, 'record') : undefined}>
              Records checklist, with the records that seem to be missing
            </Check>
            <Check checked={state.includeMedications} onChange={(on) => onChange({ includeMedications: on })} count={c ? plural(c.medications, 'medication') : undefined}>
              Medications and allergies
            </Check>
            <Check checked={Boolean(state.includeCareTeam)} onChange={(on) => onChange({ includeCareTeam: on })} count={care.data ? plural(care.data.all, 'candidate') : undefined}>
              Care team summary: one page, by step, with the flare test verdicts and costs
            </Check>
          </div>
        </Section>

        <Section
          title="7. Lab charts"
          count={options?.analytes.length ? `${state.includeLabs.length} of ${options.analytes.length}` : undefined}
          intro="Each chosen test gets a table of its values and a chart."
          actions={
            options?.analytes.length ? (
              <>
                <Button size="sm" variant="ghost" onClick={() => onChange({ includeLabs: options.analytes.map((a) => a.analyteKey) })}>
                  Choose all
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onChange({ includeLabs: [] })} disabled={!state.includeLabs.length}>
                  Choose none
                </Button>
              </>
            ) : null
          }
        >
          {options && options.analytes.length ? (
            <div className="export-labs">
              {options.analytes.map((a) => {
                const on = state.includeLabs.includes(a.analyteKey);
                return (
                  <label key={a.analyteKey} className="export-lab">
                    <input type="checkbox" checked={on} onChange={() => onChange({ includeLabs: on ? state.includeLabs.filter((k) => k !== a.analyteKey) : [...state.includeLabs, a.analyteKey] })} />
                    <span className="export-lab-name">{a.analyte}</span>
                    <span className="export-lab-meta">
                      <span className="mono">{plural(a.count, 'value')}</span>
                      {a.specimens.length ? ` · ${a.specimens.map(sampleWords).join(', ')}` : ''}
                      {a.unit ? <span className="mono"> · {a.unit}</span> : null}
                    </span>
                  </label>
                );
              })}
              {state.includeLabs
                .filter((k) => !analyteName.has(k))
                .map((k) => (
                  // A test chosen before the tests were listed apart (a reused packet): kept, and still includes what it did then.
                  <label key={k} className="export-lab">
                    <input type="checkbox" checked onChange={() => onChange({ includeLabs: state.includeLabs.filter((x) => x !== k) })} />
                    <span className="export-lab-name">{k.charAt(0).toUpperCase() + k.slice(1)}</span>
                    <span className="export-lab-meta">chosen in an earlier packet</span>
                  </label>
                ))}
            </div>
          ) : (
            <p className="muted">No lab values yet; once there are some, each test can be charted here.</p>
          )}
        </Section>

        <Section title="8. Cover summary" intro={options?.patient.summary ? 'Leave it empty to use the patient summary from Settings.' : 'A short paragraph for the cover page. Empty: the patient summary from Settings is used (it is empty too).'}>
          <Textarea rows={4} value={state.coverSummary} placeholder="e.g. Joint pain and fatigue since 2021; what I would like you to look at" onChange={(e) => onChange({ coverSummary: e.target.value })} aria-label="Cover summary" />
        </Section>
      </div>

      {p.preview.open ? (
        <Section
          title="Preview"
          id="export-preview"
          intro="The summary pages as they will be printed. The original documents are added after them when the packet is made."
          actions={
            <Button size="sm" variant="ghost" onClick={p.onClosePreview}>
              Close the preview
            </Button>
          }
        >
          {p.preview.loading ? (
            <Loading>Making the preview…</Loading>
          ) : p.preview.error ? (
            <div className="notice bad">The preview could not be made: {p.preview.error}</div>
          ) : p.preview.html ? (
            <div className="export-preview">
              <iframe title="Packet preview" srcDoc={p.preview.html} sandbox="" />
            </div>
          ) : null}
        </Section>
      ) : null}

      <div className="export-footer" role="group" aria-label="Make the packet">
        <ActionBar
          primary={{ label: 'Make the packet', onClick: p.onGenerate, shortcut: 'ctrl+enter', disabled: !ready.ready || p.busy, title: 'Make the PDF in the background; it is listed under Past packets when ready' }}
          secondary={[{ label: p.preview.loading ? 'Previewing…' : 'Preview', onClick: p.onPreview, shortcut: 'p', disabled: p.busy || p.preview.loading, title: 'See the summary pages here, before making the packet' }]}
          more={[
            { label: 'Open the preview in a new tab', onClick: p.onPreviewTab, disabled: p.busy, title: 'The same preview, in a browser tab of its own' },
            'separator',
            { label: 'Clear the form', onClick: p.onReset, disabled: p.busy, title: 'Empty every step and start again' },
          ]}
        />
        <span className={ready.ready ? 'export-ready' : 'export-ready needs'} role="status">
          {ready.words}
        </span>
      </div>
    </div>
  );
}
