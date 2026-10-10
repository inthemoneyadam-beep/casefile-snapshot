import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Field, Input, Select, Textarea } from '../../ui/Field';
import { DataTable, type ColumnDef } from '../../ui/DataTable';
import { DateText } from '../../ui/DateText';
import { FactStatusTag } from '../../ui/StatusTag';
import { CheckTag } from '../reconcile/CheckTag';
import { Kbd } from '../../ui/Kbd';
import { ASSERTED_BY, FACT_TYPES, OBJECTIVITIES } from '@shared/enums';
import { defaultAssertedBy } from '@shared/schemas/facts';
import { parseAttributes, useFactsList, type DocumentLite, type FactDetail, type FactListItem, type FactPatchInput, type NewFactInput } from '../../api/facts';
import { attributeFields, attributesToForm, formToAttributes } from './attributeFields';
import { useOverrideCandidates, type FactVoiceFields } from './api';
import { OBJECTIVITY_WORDS, VOICE_WORDS, attributeWords, factTypeWords } from './words';
import { Textarea as NoteArea } from '../../ui/Field';

type VoiceInput = { assertedBy?: string | null; objectivity?: string | null };

// ---------------------------------------------------------------------------
// New / edit
// ---------------------------------------------------------------------------

export interface FactFormDialogProps {
  open: boolean;
  onClose: () => void;
  /** When set, the dialog edits this fact; otherwise it creates a new manual fact. */
  fact?: (FactDetail & Partial<FactVoiceFields>) | null;
  documents: DocumentLite[];
  busy: boolean;
  error?: string | null;
  onCreate: (input: NewFactInput & VoiceInput) => void;
  onUpdate: (id: string, patch: FactPatchInput & VoiceInput) => void;
}

export function FactFormDialog({ open, onClose, fact, documents, busy, error, onCreate, onUpdate }: FactFormDialogProps) {
  const editing = Boolean(fact);
  const [type, setType] = useState<string>(fact?.type ?? 'clinician_statement');
  const [statement, setStatement] = useState(fact?.statement ?? '');
  const [dateText, setDateText] = useState(fact?.dateText ?? fact?.date ?? '');
  const [dateEndText, setDateEndText] = useState(fact?.dateEnd ?? '');
  const [attrs, setAttrs] = useState<Record<string, string>>({});
  const [citeDoc, setCiteDoc] = useState('');
  const [citePage, setCitePage] = useState('1');
  const [citeQuote, setCiteQuote] = useState('');
  const [note, setNote] = useState('');
  // Voice: a fact typed by hand without a citation is the patient's own statement; once a document is
  // cited the default follows that document's tier (a primary clinic note speaks for the clinician),
  // until the user picks a voice themselves.
  const [assertedBy, setAssertedBy] = useState<string>(fact?.assertedBy ?? 'patient');
  const [voiceTouched, setVoiceTouched] = useState(false);
  const [objectivity, setObjectivity] = useState<string>(fact?.objectivity && fact.objectivity !== 'unknown' ? fact.objectivity : '');

  // Reset only when the dialog opens or a different fact is loaded: a refetch of the same fact
  // (polling while an extraction runs) must never overwrite what the user is typing.
  const factRef = useRef(fact);
  factRef.current = fact;
  useEffect(() => {
    if (!open) return;
    const f = factRef.current;
    const t = f?.type ?? 'clinician_statement';
    setType(t);
    setStatement(f?.statement ?? '');
    setDateText(f?.dateText ?? f?.date ?? '');
    setDateEndText(f?.dateEnd ?? '');
    setAttrs(attributesToForm(t, f ? parseAttributes(f) : {}));
    setCiteDoc('');
    setCitePage('1');
    setCiteQuote('');
    setNote('');
    setAssertedBy(f?.assertedBy ?? 'patient');
    setVoiceTouched(false);
    setObjectivity(f?.objectivity && f.objectivity !== 'unknown' ? f.objectivity : '');
  }, [open, fact?.id]);

  useEffect(() => {
    if (!open || editing || voiceTouched) return;
    const doc = citeDoc ? documents.find((d) => d.id === citeDoc) : null;
    setAssertedBy(doc ? defaultAssertedBy(doc.sourceTier) : 'patient');
  }, [citeDoc, documents, open, editing, voiceTouched]);

  useEffect(() => {
    if (!open || editing) return;
    setAttrs((prev) => attributesToForm(type, formToAttributes(type, prev)));
  }, [type, open, editing]);

  const fields = useMemo(() => attributeFields(type), [type]);

  function submit() {
    // Editing: fields left as they were keep their stored values exactly (an unchanged save edits nothing).
    const attributes = formToAttributes(type, attrs, editing && fact ? parseAttributes(fact) : null);
    const voice: VoiceInput = { assertedBy: assertedBy || null, objectivity: objectivity || null };
    if (editing && fact) {
      onUpdate(fact.id, { statement, dateText: dateText || null, dateEndText: dateEndText || null, attributes, ...voice });
    } else {
      onCreate({
        type,
        statement,
        dateText: dateText || null,
        dateEndText: dateEndText || null,
        attributes,
        citation: citeDoc && citeQuote.trim() ? { documentId: citeDoc, pageNumber: Math.max(1, Number(citePage) || 1), quote: citeQuote.trim() } : null,
        note: note || null,
        ...voice,
      });
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? 'Edit this detail' : 'Add a detail by hand'}
      width={720}
      footer={
        <>
          <span className="faint xs grow">
            <Kbd>ctrl+enter</Kbd> {editing ? 'save' : 'add'}
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !statement.trim()} onClick={submit}>
            {editing ? 'Save' : 'Add the detail'}
          </Button>
        </>
      }
    >
      <div
        className="stack"
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && statement.trim() && !busy) {
            e.preventDefault();
            submit();
          }
        }}
      >
        {error ? <div className="notice bad small">{error}</div> : null}
        <div className="form-grid">
          <Field label="Type">
            <Select value={type} options={FACT_TYPES.map((t) => ({ value: t, label: factTypeWords(t) }))} disabled={editing} onChange={(e) => setType(e.target.value)} />
          </Field>
          <Field label="Date as written" hint="e.g. 3/11/2024, March 2024, 2023">
            <Input value={dateText} onChange={(e) => setDateText(e.target.value)} placeholder="e.g. March 2024" />
          </Field>
          <Field label="Statement" hint="One sentence that stands on its own, with the value and date if there are any.">
            <Textarea autoFocus value={statement} onChange={(e) => setStatement(e.target.value)} rows={3} />
          </Field>
          <Field label="End date (only for a span of time)">
            <Input value={dateEndText} onChange={(e) => setDateEndText(e.target.value)} />
          </Field>
          <Field
            label="Whose words"
            hint={
              editing
                ? "Your own words, what a clinician recorded, or a summary restating other records."
                : "Your own words unless you cite a document; then it follows the kind of document (a clinician for a clinical record, a summary's writer for a summary) until you choose."
            }
          >
            <Select
              value={assertedBy}
              options={ASSERTED_BY.map((v) => ({ value: v, label: VOICE_WORDS[v] ?? v }))}
              onChange={(e) => {
                setVoiceTouched(true);
                setAssertedBy(e.target.value);
              }}
            />
          </Field>
          <Field label="What kind of statement" hint="A measurement or recorded event stays as recorded; an opinion can be outranked by your own word.">
            <Select value={objectivity} options={OBJECTIVITIES.filter((v) => v !== 'unknown').map((v) => ({ value: v, label: OBJECTIVITY_WORDS[v] ?? v }))} placeholder="Usual for this type" onChange={(e) => setObjectivity(e.target.value)} />
          </Field>
        </div>
        <h4 className="facts-form-head">{factTypeWords(type)}: its fields</h4>
        <div className="form-grid">
          {fields.map((f) => (
            <Field key={f.key} label={`${attributeWords(f.key)}${f.nullable ? '' : ' (needed)'}`} hint={f.description}>
              {f.kind === 'enum' ? (
                <Select value={attrs[f.key] ?? ''} options={f.options ?? []} placeholder={f.nullable ? 'Not given' : 'Choose'} onChange={(e) => setAttrs((a) => ({ ...a, [f.key]: e.target.value }))} />
              ) : f.kind === 'boolean' ? (
                <Select value={attrs[f.key] ?? ''} options={[{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]} placeholder={f.nullable ? 'Not given' : 'Choose'} onChange={(e) => setAttrs((a) => ({ ...a, [f.key]: e.target.value }))} />
              ) : (
                <Input type={f.kind === 'number' ? 'number' : 'text'} step={f.kind === 'number' ? 'any' : undefined} value={attrs[f.key] ?? ''} onChange={(e) => setAttrs((a) => ({ ...a, [f.key]: e.target.value }))} />
              )}
            </Field>
          ))}
        </div>
        {!editing ? (
          <>
            <h4 className="facts-form-head">Where it is written (optional)</h4>
            <div className="form-grid">
              <Field label="Document">
                <Select value={citeDoc} options={documents.map((d) => ({ value: d.id, label: d.title }))} placeholder="None" onChange={(e) => setCiteDoc(e.target.value)} />
              </Field>
              <Field label="Page">
                <Input type="number" min={1} value={citePage} onChange={(e) => setCitePage(e.target.value)} disabled={!citeDoc} />
              </Field>
              <div className="full">
                <Field label="The words on that page, exactly" hint="Checked against the page text; kept either way.">
                  <Textarea value={citeQuote} onChange={(e) => setCiteQuote(e.target.value)} rows={2} disabled={!citeDoc} />
                </Field>
              </div>
              <div className="full">
                <Field label="Where it came from, if not a document">
                  <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Told to me by the infusion nurse on 2024-03-30" />
                </Field>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Supersede picker
// ---------------------------------------------------------------------------

export function SupersedeDialog({ open, onClose, fact, busy, onChoose }: { open: boolean; onClose: () => void; fact: FactDetail | null; busy: boolean; onChoose: (byFactId: string) => void }) {
  const subject = fact?.subjectKey ?? undefined;
  const [showAll, setShowAll] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const list = useFactsList(showAll ? { limit: 500 } : { subject: subject ?? '', limit: 200 }, {});
  const items = useMemo(() => (list.data?.items ?? []).filter((f) => f.id !== fact?.id && f.status !== 'superseded'), [list.data, fact?.id]);
  useEffect(() => {
    if (open) {
      setShowAll(false);
      setSel(null);
    }
  }, [open, fact?.id]);

  const columns = useMemo<ColumnDef<FactListItem, unknown>[]>(
    () => [
      { id: 'date', header: 'Date', accessorFn: (r) => r.date ?? '', cell: ({ row }) => <DateText iso={row.original.date} precision={row.original.datePrecision} />, meta: { width: 92 } },
      { id: 'statement', header: 'Statement', accessorKey: 'statement', cell: ({ getValue }) => <span className="clamp2">{String(getValue())}</span>, meta: { grow: true, minWidth: 220 } },
      { id: 'document', header: 'Document', accessorFn: (r) => r.documentTitle ?? '', cell: ({ getValue }) => <span className="muted">{String(getValue()) || 'added by hand'}</span>, meta: { width: 150, wrap: true } },
      { id: 'status', header: 'Check', accessorKey: 'status', cell: ({ row }) => (row.original.trust ? <CheckTag trust={row.original.trust} /> : <FactStatusTag status={row.original.status} basis={row.original.verdictBasis} />), meta: { width: 96 } },
    ],
    [],
  );

  if (!open) return null;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Replaced by a newer detail"
      width={760}
      footer={
        <>
          <span className="faint xs grow">
            <Kbd>j</Kbd> <Kbd>k</Kbd> move · <Kbd>enter</Kbd> choose · <Kbd>esc</Kbd> cancel
          </span>
          <Button onClick={() => setShowAll((v) => !v)}>{showAll ? 'Only details about the same thing' : 'Show all details'}</Button>
          <Button variant="primary" disabled={!sel || busy} onClick={() => sel && onChoose(sel)}>
            Mark this one replaced
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="small muted">
          <span className="truncate">{fact?.statement}</span>
          <div className="muted small">{showAll ? 'Every detail. Pick the newer one that replaces this one.' : 'Details about the same thing. Pick the newer one that replaces this one.'}</div>
        </div>
        <div className="pick-list">
          {list.isPending ? (
            <div className="list-loading">Loading…</div>
          ) : (
            <DataTable columns={columns} data={items} rowId={(r) => r.id} selectedId={sel} onSelect={(r) => setSel(r?.id ?? null)} onOpen={(r) => onChoose(r.id)} emptyText="No other details about the same thing. Show all details lists every one." autoFocus />
          )}
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Patient precedence picker (key o): choose the patient statement that takes
// precedence over a clinician's or compiler's assessment, or type a new one.
// ---------------------------------------------------------------------------

export interface OverrideDialogProps {
  open: boolean;
  onClose: () => void;
  fact: (FactDetail & Partial<FactVoiceFields>) | null;
  busy: boolean;
  error?: string | null;
  onChoose: (byFactId: string, reason: string | null) => void;
  onNewStatement: (statement: string, dateText: string | null, reason: string | null) => void;
}

export function OverrideDialog({ open, onClose, fact, busy, error, onChoose, onNewStatement }: OverrideDialogProps) {
  const candidates = useOverrideCandidates(fact?.id, open);
  const [sel, setSel] = useState<string | null>(null);
  const [mode, setMode] = useState<'pick' | 'new'>('pick');
  const [statement, setStatement] = useState('');
  const [dateText, setDateText] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) {
      setSel(fact?.overriddenByFactId ?? null);
      setMode('pick');
      setStatement('');
      setDateText('');
      setReason('');
    }
  }, [open, fact?.id, fact?.overriddenByFactId]);
  const items = useMemo(() => (candidates.data?.items ?? []).filter((f) => f.id !== fact?.id), [candidates.data, fact?.id]);
  useEffect(() => {
    if (open && !candidates.isPending && !items.length) setMode('new');
  }, [open, candidates.isPending, items.length]);

  const columns = useMemo<ColumnDef<FactListItem, unknown>[]>(
    () => [
      { id: 'date', header: 'Date', accessorFn: (r) => r.date ?? '', cell: ({ row }) => <DateText iso={row.original.date} precision={row.original.datePrecision} />, meta: { width: 92 } },
      { id: 'statement', header: 'Statement', accessorKey: 'statement', cell: ({ getValue }) => <span className="clamp2">{String(getValue())}</span>, meta: { grow: true, minWidth: 220 } },
      { id: 'document', header: 'Source', accessorFn: (r) => r.documentTitle ?? '', cell: ({ getValue }) => <span className="muted">{String(getValue()) || 'added by hand'}</span>, meta: { width: 150, wrap: true } },
      { id: 'status', header: 'Check', accessorKey: 'status', cell: ({ row }) => (row.original.trust ? <CheckTag trust={row.original.trust} /> : <FactStatusTag status={row.original.status} basis={row.original.verdictBasis} />), meta: { width: 96 } },
    ],
    [],
  );

  if (!open) return null;
  const canSubmit = mode === 'pick' ? Boolean(sel) : statement.trim().length > 0;
  function submit() {
    if (!canSubmit || busy) return;
    if (mode === 'pick' && sel) onChoose(sel, reason.trim() || null);
    else if (mode === 'new') onNewStatement(statement.trim(), dateText.trim() || null, reason.trim() || null);
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Which statement of yours takes precedence?"
      width={760}
      footer={
        <>
          <span className="faint xs grow">
            {mode === 'pick' ? (
              <>
                <Kbd>j</Kbd> <Kbd>k</Kbd> move · <Kbd>enter</Kbd> choose · <Kbd>esc</Kbd> cancel
              </>
            ) : (
              <>
                <Kbd>ctrl+enter</Kbd> save · <Kbd>esc</Kbd> cancel
              </>
            )}
          </span>
          <Button onClick={() => setMode((m) => (m === 'pick' ? 'new' : 'pick'))}>{mode === 'pick' ? 'New statement' : 'Pick an existing statement'}</Button>
          <Button variant="primary" disabled={!canSubmit || busy} onClick={submit}>
            {mode === 'pick' ? 'Takes precedence' : 'Save and take precedence'}
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
        <div className="small muted">
          <span className="truncate">{fact?.statement}</span>
          <div className="muted small">The detail stays exactly as written; the clinician goes by your statement and mentions this one as background.</div>
        </div>
        {mode === 'pick' ? (
          <div className="pick-list">
            {candidates.isPending ? (
              <div className="list-loading">Loading your statements…</div>
            ) : (
              <DataTable columns={columns} data={items as FactListItem[]} rowId={(r) => r.id} selectedId={sel} onSelect={(r) => setSel(r?.id ?? null)} onOpen={(r) => onChoose(r.id, reason.trim() || null)} emptyText="No statement of yours on this subject yet. Type one with New statement." autoFocus />
            )}
          </div>
        ) : (
          <div className="override-new">
            <Field label="Your statement" hint="One sentence in your own words, e.g. “Atorvastatin gave me muscle aches and I stopped it after two weeks.” It is saved as a confirmed patient statement.">
              <NoteArea autoFocus value={statement} onChange={(e) => setStatement(e.target.value)} rows={3} />
            </Field>
            <Field label="Date as written (optional)">
              <Input value={dateText} onChange={(e) => setDateText(e.target.value)} placeholder="e.g. March 2024" />
            </Field>
          </div>
        )}
        <Field label="Why (optional)" hint="One line shown next to the record and in the consult ledger.">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
