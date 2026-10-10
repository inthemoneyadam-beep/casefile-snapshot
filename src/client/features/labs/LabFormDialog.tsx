/**
 * Add or edit a lab value by hand (2026-10, lab values as printed):
 *   Value                   as written ("62", "<5", "Negative", "1:160"); a line under it says how it is read ("a
 *                           limit, not a measurement: below 5"). The text decides: "<5" never stores the number 5.
 *   Normal range as printed one text field ("15-45", "<50", "Negative") with the way it is read under it ("Read as:
 *                           15 to 45", "Read as: below 50", "Not read as numbers; kept as written"); its bounds are
 *                           read from it, never typed apart.
 *   Flag as printed         Not recorded, No flag printed, H, L, HH, LL, N, A, C, "*": what the report printed beside
 *                           the value; nothing is worked out here (the value's detail says what its range says).
 *   Collected on, Resulted on   both optional, kept apart (rule 7).
 * Editing sends only the fields you changed, so a value is never "changed by hand" by opening and saving it.
 */
import { useEffect, useRef, useState } from 'react';
import { SPECIMENS } from '@shared/enums';
import { fmtNum, limitWords, parseLabValue, parseRefRange } from '@shared/labvalues';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Field, Input, Select, Textarea } from '../../ui/Field';
import { Kbd } from '../../ui/Kbd';
import type { DocumentLite, LabEntry, LabInput, PersonLite } from '../../api/labs';
import { SAMPLE_WORDS } from './tags';
import { readingOf } from './reading';

/** The flag choices: the select's value, what is sent as flagRaw (null: not recorded; '': no flag printed), and the words. */
const NOT_RECORDED = '__not_recorded';
const NONE_PRINTED = '__none_printed';
export const FLAG_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: NOT_RECORDED, label: 'Not recorded' },
  { value: NONE_PRINTED, label: 'No flag printed' },
  { value: 'H', label: 'H (high)' },
  { value: 'L', label: 'L (low)' },
  { value: 'HH', label: 'HH (critical high)' },
  { value: 'LL', label: 'LL (critical low)' },
  { value: 'N', label: 'N (normal)' },
  { value: 'A', label: 'A (abnormal)' },
  { value: 'C', label: "C (the report's own letter)" },
  { value: '*', label: '* (a star)' },
];

/** The flag as sent: null not recorded, '' no flag printed, else as chosen. */
export function flagRawOf(choice: string): string | null {
  if (choice === NOT_RECORDED) return null;
  if (choice === NONE_PRINTED) return '';
  return choice;
}

/** The select's choice for a value's flag as recorded. */
export function flagChoiceOf(e: LabEntry | null | undefined): string {
  if (!e) return NOT_RECORDED;
  const v = readingOf(e);
  if (v.flagState === 'not_recorded') return NOT_RECORDED;
  if (v.flagState === 'no_flag_printed') return NONE_PRINTED;
  return (v.flagRaw ?? '').trim() || NOT_RECORDED;
}

/** How a range as written is read, in plain words, for the line under the field. */
export function rangeReadWords(text: string): string | null {
  if (!text.trim()) return null;
  const r = parseRefRange(text);
  if (r.status === 'none') return 'Read as: no range.';
  if (r.status === 'unparsed') return `Not read as numbers; kept as written${r.reason ? ` (${r.reason})` : ''}.`;
  if (r.kind === 'text') return `Read as: the expected answer "${r.text ?? text.trim()}".`;
  if (r.kind === 'interval' && r.low != null && r.high != null) return `Read as: ${fmtNum(r.low)} to ${fmtNum(r.high)}.`;
  if (r.kind === 'upper' && r.high != null) return `Read as: ${r.highComparator === '<=' ? `${fmtNum(r.high)} or below` : `below ${fmtNum(r.high)}`}.`;
  if (r.kind === 'lower' && r.low != null) return `Read as: ${r.lowComparator === '>=' ? `${fmtNum(r.low)} or above` : `above ${fmtNum(r.low)}`}.`;
  return null;
}

/** How a value as written is read, when that needs saying: a limit, words, a range of values. */
export function valueReadWords(text: string): string | null {
  if (!text.trim()) return null;
  const v = parseLabValue(text);
  if (v.kind === 'censored') return `Read as a limit, not a measurement: ${limitWords(v) ?? text.trim()}.`;
  if (v.kind === 'text') return 'Read as words, never as a number.';
  if (v.kind === 'range') return 'Read as a range of values, not one measurement.';
  return null;
}

/** The value's own range as it is to be edited: the text as shown, without the app's "(not read as numbers)" words. */
function rangeTextOf(e: LabEntry): string {
  const v = readingOf(e);
  if (v.rangeStatus === 'none' || !v.rangeShown) return '';
  if (v.rangeFromNumbersOnly) return '';
  const quoted = v.rangeShown.match(/^"([\s\S]*)" \(not read as numbers\)$/);
  return quoted ? quoted[1] : v.rangeShown;
}

export interface LabFormDialogProps {
  open: boolean;
  onClose: () => void;
  /** When set, the dialog edits this row; otherwise it creates one. */
  entry?: LabEntry | null;
  /** Prefill for a new row (analyte and specimen from the selected analyte). */
  preset?: { analyte?: string; specimen?: string; unit?: string | null } | null;
  documents: DocumentLite[];
  institutions: PersonLite[];
  busy: boolean;
  error?: string | null;
  onCreate: (input: LabInput) => void;
  onUpdate: (id: string, patch: Partial<LabInput>) => void;
}

interface FormState {
  analyte: string;
  specimen: string;
  value: string;
  unit: string;
  refText: string;
  flag: string;
  collected: string;
  resulted: string;
  labName: string;
  institutionId: string;
  documentId: string;
  notes: string;
}

function initialState(entry: LabEntry | null | undefined, preset: LabFormDialogProps['preset']): FormState {
  const v = entry ? readingOf(entry) : null;
  return {
    analyte: entry?.analyte ?? preset?.analyte ?? '',
    specimen: entry?.specimen ?? preset?.specimen ?? 'serum',
    value: entry ? (entry.valueText ?? (entry.valueNum != null ? String(entry.valueNum) : '')) : '',
    unit: entry?.unit ?? preset?.unit ?? '',
    refText: entry ? rangeTextOf(entry) : '',
    flag: flagChoiceOf(entry),
    // The reading's date: a collected one, or one whose kind is not printed (kept that way unless changed here).
    collected: entry ? (v?.collected?.text ?? v?.collected?.iso ?? (v?.dateKind === 'unknown' ? (entry.dateText ?? entry.date ?? '') : '')) : '',
    resulted: entry ? (v?.resulted?.text ?? v?.resulted?.iso ?? '') : '',
    labName: entry?.labName ?? '',
    institutionId: entry?.institutionId ?? '',
    documentId: entry?.documentId ?? '',
    notes: entry?.notes ?? '',
  };
}

export function LabFormDialog({ open, onClose, entry, preset, documents, institutions, busy, error, onCreate, onUpdate }: LabFormDialogProps) {
  const editing = Boolean(entry);
  const [f, setF] = useState<FormState>(() => initialState(entry, preset));
  const [citePage, setCitePage] = useState('1');
  const [citeQuote, setCiteQuote] = useState('');
  const set = (patch: Partial<FormState>) => setF((cur) => ({ ...cur, ...patch }));

  // Fill the fields when the dialog opens or switches to another row, never on a parent re-render:
  // a fresh `preset` object or a refetched `entry` must not wipe what the user typed (or the
  // form under a server error). The latest props are read through refs.
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const presetRef = useRef(preset);
  presetRef.current = preset;
  const startRef = useRef<FormState>(f);
  const entryId = entry?.id ?? null;

  useEffect(() => {
    if (!open) return;
    const start = initialState(entryRef.current, presetRef.current);
    startRef.current = start;
    setF(start);
    setCitePage('1');
    setCiteQuote('');
  }, [open, entryId]);

  const canSubmit = f.analyte.trim().length > 0 && !busy;
  const dateKindUnknown = Boolean(entry && readingOf(entry).dateKind === 'unknown' && (entry.date || entry.dateText));

  function submit() {
    if (!canSubmit) return;
    const all: Partial<LabInput> = {
      analyte: f.analyte.trim(),
      specimen: f.specimen,
      value: f.value.trim() || null,
      unit: f.unit.trim() || null,
      // The range as printed; its bounds are read from it by the server (never typed apart).
      refText: f.refText.trim() || null,
      flagRaw: flagRawOf(f.flag),
      collectedAtText: f.collected.trim() || null,
      resultedAtText: f.resulted.trim() || null,
      labName: f.labName.trim() || null,
      institutionId: f.institutionId || null,
      documentId: f.documentId || null,
      notes: f.notes.trim() || null,
    };
    if (editing && entry) {
      // Only what was changed: opening and saving a value never makes it "changed by hand".
      const start = startRef.current;
      const changed: Partial<LabInput> = {};
      const keys: Array<[keyof FormState, keyof LabInput]> = [
        ['analyte', 'analyte'],
        ['specimen', 'specimen'],
        ['value', 'value'],
        ['unit', 'unit'],
        ['refText', 'refText'],
        ['flag', 'flagRaw'],
        ['collected', 'collectedAtText'],
        ['resulted', 'resultedAtText'],
        ['labName', 'labName'],
        ['institutionId', 'institutionId'],
        ['documentId', 'documentId'],
        ['notes', 'notes'],
      ];
      for (const [field, key] of keys) if (f[field] !== start[field]) (changed as Record<string, unknown>)[key] = all[key];
      if (!Object.keys(changed).length) {
        onClose();
        return;
      }
      onUpdate(entry.id, changed);
    } else {
      onCreate({
        ...(all as LabInput),
        citation: f.documentId && citeQuote.trim() ? { documentId: f.documentId, pageNumber: Math.max(1, Number(citePage) || 1), quote: citeQuote.trim() } : null,
      });
    }
  }

  const valueRead = valueReadWords(f.value);
  const rangeRead = rangeReadWords(f.refText);
  const flagOptions = FLAG_CHOICES.some((c) => c.value === f.flag) ? FLAG_CHOICES : [...FLAG_CHOICES, { value: f.flag, label: `${f.flag} (as printed)` }];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? 'Edit this lab value' : 'Add a lab value'}
      width={720}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canSubmit} onClick={submit}>
            {editing ? 'Save changes' : 'Add lab value'} <Kbd>ctrl+enter</Kbd>
          </Button>
        </>
      }
    >
      <div
        className="stack"
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canSubmit) {
            e.preventDefault();
            submit();
          }
        }}
      >
        {error ? <div className="notice bad small">{error}</div> : null}
        <div className="labs-form-grid">
          <Field label="Test" hint="As written on the report; other names for the same test are grouped with it.">
            <Input autoFocus value={f.analyte} onChange={(e) => set({ analyte: e.target.value })} placeholder="e.g. CRP, HbA1c, ESR" />
          </Field>
          <Field label="Sample">
            <Select value={f.specimen} options={SPECIMENS.map((s) => ({ value: s, label: SAMPLE_WORDS[s] ?? s }))} onChange={(e) => set({ specimen: e.target.value })} />
          </Field>
          <Field label="Value as printed" hint={valueRead ?? 'As written: "62", "<5", "Negative", "1:160".'}>
            <Input value={f.value} onChange={(e) => set({ value: e.target.value })} />
          </Field>
          <Field label="Unit as printed">
            <Input value={f.unit} onChange={(e) => set({ unit: e.target.value })} placeholder="e.g. mg/dL" />
          </Field>
          <Field label="Normal range as printed" hint={rangeRead ?? 'As written: "15-45", "<50", "Negative". Empty when none is printed.'}>
            <Input value={f.refText} onChange={(e) => set({ refText: e.target.value })} placeholder="e.g. 15-45" />
          </Field>
          <Field label="Flag as printed" hint="What the report printed beside the value. Nothing is worked out here; the value's detail says what its range says.">
            <Select value={f.flag} options={flagOptions} onChange={(e) => set({ flag: e.target.value })} />
          </Field>
          <Field label="Collected on" hint={dateKindUnknown && f.collected === startRef.current.collected ? 'The report does not say whether this date is when the sample was taken or when the result came back; it stays that way unless you change it here.' : 'When the sample was taken: 2024-03-18, March 2024, 2023. Empty if not known.'}>
            <Input value={f.collected} onChange={(e) => set({ collected: e.target.value })} placeholder="Empty if not known" />
          </Field>
          <Field label="Resulted on" hint="When the result came back (Resulted, Reported), if printed.">
            <Input value={f.resulted} onChange={(e) => set({ resulted: e.target.value })} placeholder="Empty if not printed" />
          </Field>
          <Field label="Lab" hint="The laboratory that performed the test, as printed.">
            <Input value={f.labName} onChange={(e) => set({ labName: e.target.value })} />
          </Field>
          <Field label="Institution">
            <Select value={f.institutionId} options={institutions.map((p) => ({ value: p.id, label: p.name }))} placeholder="None" onChange={(e) => set({ institutionId: e.target.value })} />
          </Field>
          <div className="full">
            <Field label="Document it came from" hint={editing ? undefined : 'With a page and a quote copied word for word, the value is linked to that page and checked against it.'}>
              <Select value={f.documentId} options={documents.map((d) => ({ value: d.id, label: d.title }))} placeholder="None" onChange={(e) => set({ documentId: e.target.value })} />
            </Field>
          </div>
          {!editing ? (
            <>
              <Field label="Page">
                <Input type="number" min={1} value={citePage} onChange={(e) => setCitePage(e.target.value)} disabled={!f.documentId} />
              </Field>
              <Field label="Quote, word for word from that page" hint="Checked against the page text; kept either way.">
                <Textarea value={citeQuote} onChange={(e) => setCiteQuote(e.target.value)} rows={2} disabled={!f.documentId} />
              </Field>
            </>
          ) : null}
          <div className="full">
            <Field label="Notes">
              <Textarea value={f.notes} onChange={(e) => set({ notes: e.target.value })} rows={2} />
            </Field>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
