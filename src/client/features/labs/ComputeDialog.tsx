/**
 * "Add a computed value" (Labs, key c; 2026-10-09): the user chooses a formula, then the printed values it takes, and sees
 * the result before he saves it.
 *
 *   Formula     Albumin index (CSF albumin over serum albumin), IgG index (four inputs), or "A divided by B, times k"
 *               (he names the result, types k and its unit).
 *   Inputs      each lists only values printed on a lab report, of its test and sample, newest first (once one input
 *               is chosen, the others closest to its date first). Values that cannot be used (a limit, words, a unit
 *               the formula does not convert, no collection date) are named below with the reason.
 *   Result      the server's own preview: the value as labs print it, the full number, the conversions used, the gap
 *               between the samples, "Computed by you from p.2 and p.3", the lab's own printed value of the same
 *               index when there is one, and every reason it cannot be computed.
 *
 * Nothing is computed until "Save the computed value" (ctrl+enter). The app never computes one by itself.
 */
import { useEffect, useMemo, useState } from 'react';
import type { FormulaId } from '@shared/labcompute';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Field, Input, Select } from '../../ui/Field';
import { Kbd } from '../../ui/Kbd';
import { Tag } from '../../ui/StatusTag';
import { useComputeCandidates, useComputeFormulas, useComputePreview, useComputeTests, type CandidateView, type ComputeRequest, type FormulaView } from './computed-api';
import './computed.css';

export interface ComputeDialogProps {
  open: boolean;
  onClose: () => void;
  /** Prefill (Compute again): the formula and the values chosen before. */
  initial?: ComputeRequest | null;
  busy?: boolean;
  error?: string | null;
  onSave: (req: ComputeRequest) => void;
}

/** Days between two ISO days (null when either is missing). */
function daysApart(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const da = Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  const db = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(da) && Number.isFinite(db) ? Math.round(Math.abs(da - db) / 86400000) : null;
}

/** One value in a picker: "2030-07-14 · 27 mg/dL · Lab report p.2 · same day". */
export function candidateLabel(c: CandidateView, anchor: string | null): string {
  const apart = daysApart(c.date, anchor);
  const near = anchor && apart != null ? (apart === 0 ? ' · same day' : ` · ${apart} day${apart === 1 ? '' : 's'} apart`) : '';
  const flag = c.flagShown ? ` · flag ${c.flagShown}` : '';
  return `${c.date ?? 'no date'} · ${c.valueShown}${c.unit ? ` ${c.unit}` : ''}${flag} · ${c.documentTitle ?? 'document'}${c.pageNumber ? ` p.${c.pageNumber}` : ''}${near}`;
}

/** Usable values first by closeness to the anchor's date (then newest), the rest kept apart with their reasons. */
export function orderCandidates(items: readonly CandidateView[], anchor: string | null): { usable: CandidateView[]; unusable: CandidateView[] } {
  const usable = items.filter((c) => !c.problem);
  if (anchor) usable.sort((a, b) => (daysApart(a.date, anchor) ?? 1e9) - (daysApart(b.date, anchor) ?? 1e9) || (b.date ?? '').localeCompare(a.date ?? ''));
  return { usable, unusable: items.filter((c) => c.problem) };
}

function SlotPicker({ formula, slot, value, onChange, anchor, test, onTest }: { formula: FormulaView; slot: FormulaView['slots'][number]; value: string; onChange: (id: string, date: string | null) => void; anchor: string | null; test: string; onTest: (key: string) => void }) {
  const tests = useComputeTests(slot.anyTest);
  const [analyteKey, specimen] = test ? test.split('::') : ['', ''];
  const q = useComputeCandidates(formula.id, slot.id, { analyteKey: analyteKey || undefined, specimen: specimen || undefined });
  const { usable, unusable } = orderCandidates(q.data ?? [], anchor);
  const chosen = (q.data ?? []).find((c) => c.id === value) ?? null;
  return (
    <div className="computed-slot">
      {slot.anyTest ? (
        <Field label={`${slot.label}: test`}>
          <Select
            value={test}
            placeholder={tests.isPending ? 'Loading the tests…' : 'Choose a test'}
            options={(tests.data ?? []).map((t) => ({ value: `${t.analyteKey}::${t.specimen}`, label: `${t.analyte} (${t.specimen === 'csf' ? 'CSF' : t.specimen.replace(/_/g, ' ')}) · ${t.count}` }))}
            onChange={(e) => {
              onTest(e.target.value);
              onChange('', null);
            }}
          />
        </Field>
      ) : null}
      <Field label={slot.label} hint={slot.takes ? `Read in ${slot.takes}; only these units convert.` : 'Taken as printed, in its own unit.'}>
        <Select
          value={value}
          disabled={slot.anyTest && !test}
          placeholder={q.isPending && (!slot.anyTest || test) ? 'Loading the values…' : usable.length ? 'Choose a value printed on a lab report' : 'No printed value can be used'}
          options={usable.map((c) => ({ value: c.id, label: candidateLabel(c, anchor) }))}
          onChange={(e) => onChange(e.target.value, usable.find((c) => c.id === e.target.value)?.date ?? null)}
        />
      </Field>
      {chosen?.conversion ? <p className="computed-small">{chosen.conversion}</p> : null}
      {unusable.length ? (
        <details className="computed-unusable">
          <summary>
            {unusable.length} value{unusable.length === 1 ? '' : 's'} of this test cannot be used
          </summary>
          <ul>
            {unusable.slice(0, 12).map((c) => (
              <li key={c.id}>
                <span className="mono">
                  {c.date ?? 'no date'} · {c.valueShown}
                  {c.unit ? ` ${c.unit}` : ''}
                </span>
                : {c.problem}
              </li>
            ))}
            {unusable.length > 12 ? <li>and {unusable.length - 12} more</li> : null}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export function ComputeDialog({ open, onClose, initial, busy, error, onSave }: ComputeDialogProps) {
  const formulas = useComputeFormulas(open);
  const [formulaId, setFormulaId] = useState<FormulaId>('albumin_index');
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [tests, setTests] = useState<Record<string, string>>({});
  const [dates, setDates] = useState<Record<string, string | null>>({});
  const [name, setName] = useState('');
  const [k, setK] = useState('1');
  const [unit, setUnit] = useState('');
  const [decimals, setDecimals] = useState('2');

  useEffect(() => {
    if (!open) return;
    setFormulaId(initial?.formula ?? 'albumin_index');
    setInputs(initial?.inputs ?? {});
    setTests({});
    setDates({});
    setName(initial?.name ?? '');
    setK(initial?.k != null ? String(initial.k) : '1');
    setUnit(initial?.unit ?? '');
    setDecimals(initial?.decimals != null ? String(initial.decimals) : '2');
  }, [open, initial]);

  const formula = (formulas.data ?? []).find((f) => f.id === formulaId) ?? null;
  const kNum = k.trim() === '' ? null : Number(k);
  const request: ComputeRequest | null = useMemo(() => {
    if (!formula) return null;
    const chosen = formula.slots.every((s) => inputs[s.id]);
    if (!chosen) return null;
    return {
      formula: formula.id,
      inputs: Object.fromEntries(formula.slots.map((s) => [s.id, inputs[s.id]])),
      ...(formula.id === 'ratio' ? { name: name.trim() || null, k: kNum != null && Number.isFinite(kNum) ? kNum : null, unit: unit.trim() || null, decimals: Number(decimals) } : {}),
    };
  }, [formula, inputs, name, kNum, unit, decimals]);
  const preview = useComputePreview(open ? request : null);
  const p = request ? preview.data : undefined;
  const canSave = Boolean(request && p?.ok && !preview.isFetching && !busy);
  // The first chosen input's date: the other pickers list the values closest to it first.
  const anchorFor = (slotId: string): string | null => {
    for (const s of formula?.slots ?? []) if (s.id !== slotId && inputs[s.id] && dates[s.id]) return dates[s.id] ?? null;
    return null;
  };

  function save() {
    if (canSave && request) onSave(request);
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a computed value"
      width={760}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canSave} onClick={save} title="Saves the value with its formula, its inputs and their pages">
            Save the computed value <Kbd>ctrl+enter</Kbd>
          </Button>
        </>
      }
    >
      <div
        className="stack computed-dialog"
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            save();
          }
        }}
      >
        <p className="computed-small">Only values printed on a lab report can be used. The app does the arithmetic; nothing is saved until you press Save.</p>
        {error ? <div className="notice bad small">{error}</div> : null}
        {formulas.isPending ? (
          <p className="computed-small">Loading the formulas…</p>
        ) : (
          <Field label="Formula" hint={formula?.expression}>
            <Select
              data-autofocus=""
              value={formulaId}
              options={(formulas.data ?? []).map((f) => ({ value: f.id, label: f.name }))}
              onChange={(e) => {
                setFormulaId(e.target.value as FormulaId);
                setInputs({});
                setTests({});
                setDates({});
              }}
            />
          </Field>
        )}
        {formula?.id === 'ratio' ? (
          <div className="computed-grid">
            <Field label="Name of the result" hint='For example "CSF/serum glucose ratio".'>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="k" hint="1 when nothing is multiplied.">
              <Input type="number" step="any" value={k} onChange={(e) => setK(e.target.value)} />
            </Field>
            <Field label="Unit of the result" hint="Empty for a ratio with no unit.">
              <Input value={unit} onChange={(e) => setUnit(e.target.value)} />
            </Field>
            <Field label="Decimals shown">
              <Select value={decimals} options={['0', '1', '2', '3', '4'].map((d) => ({ value: d, label: d }))} onChange={(e) => setDecimals(e.target.value)} />
            </Field>
          </div>
        ) : null}
        {formula
          ? formula.slots.map((slot) => (
              <SlotPicker
                key={`${formula.id}-${slot.id}`}
                formula={formula}
                slot={slot}
                value={inputs[slot.id] ?? ''}
                anchor={anchorFor(slot.id)}
                onChange={(id, date) => {
                  setInputs((prev) => ({ ...prev, [slot.id]: id }));
                  setDates((prev) => ({ ...prev, [slot.id]: date }));
                }}
                test={tests[slot.id] ?? ''}
                onTest={(t) => setTests((prev) => ({ ...prev, [slot.id]: t }))}
              />
            ))
          : null}
        <ComputePreviewView preview={p} pending={Boolean(request) && preview.isFetching && !p} waiting={!request} />
      </div>
    </Dialog>
  );
}

/** The server's preview, in plain words: the result or every reason it cannot be computed. */
export function ComputePreviewView({ preview: p, pending, waiting }: { preview: ReturnType<typeof useComputePreview>['data']; pending?: boolean; waiting?: boolean }) {
  if (waiting) return <p className="computed-small">Choose every input to see the result.</p>;
  if (pending || !p) return <p className="computed-small">Working it out…</p>;
  return (
    <section className="computed-preview" aria-label="Result">
      {p.ok && p.result ? (
        <>
          <div className="computed-result">
            <span className="computed-result-name">{p.result.analyte}</span>
            <span className="mono computed-result-value">
              {p.result.shown}
              {p.result.unit ? ` ${p.result.unit}` : ''}
            </span>
            <Tag tone="neutral" title="Worked out by the app from values printed on lab reports; never red, never judged by a range">
              computed
            </Tag>
          </div>
          <p className="computed-small mono">{fullWords(p.result.full, p.result.shown)}</p>
          <p className="computed-label">{p.label}</p>
        </>
      ) : (
        <div className="notice warn small">
          <strong>It cannot be computed yet.</strong>
          <ul className="computed-list">
            {p.problems.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      <ul className="computed-list">
        {p.inputs
          .filter((i) => i.entryId && !i.problem)
          .map((i) => (
            <li key={i.slot}>
              {i.slotLabel}: <span className="mono">{i.conversion ?? `${i.valueShown ?? ''}${i.unit ? ` ${i.unit}` : ''}`}</span>
              {/* A date the report does not label as collected is said as a date, never as "collected" (rule 7). */}
              {i.date ? ` · ${i.dateKind === 'collected' ? 'collected' : 'dated'} ${i.dateText && i.dateText !== i.date ? i.dateText : i.date}` : ''}
              {i.pageNumber ? ` · p.${i.pageNumber}` : ''}
              {i.citationVerified === false ? ' (quote not found on the page)' : ''}
            </li>
          ))}
      </ul>
      {p.pairing?.words ? <p className="computed-small">Pairing: {p.pairing.words}.</p> : null}
      {p.notes.map((n) => (
        <p key={n} className="computed-small">
          {n}
        </p>
      ))}
      {p.printedBeside.map((x) => (
        <p key={x.entryId} className={x.differs ? 'notice warn small' : 'computed-small'}>
          The lab printed {x.valueShown}
          {x.unit ? ` ${x.unit}` : ''} for this collection{x.documentTitle ? ` (${x.documentTitle}${x.pageNumber ? `, p.${x.pageNumber}` : ''})` : ''}.{' '}
          {x.differs ? `It differs from ${x.computedAtPrecision} at the lab's precision; saving adds a finding.` : 'It matches at the lab’s precision.'}
        </p>
      ))}
    </section>
  );
}

/** "6.553398 before rounding", or nothing when the shown value is the whole number. */
export function fullWords(full: number, shown: string): string {
  const exact = String(Number(full.toPrecision(10)));
  return exact === shown ? 'Exact, no rounding.' : `${exact} before rounding; shown as labs print it.`;
}
