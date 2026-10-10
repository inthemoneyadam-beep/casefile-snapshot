/**
 * Computed lab values (2026-10-09; lead's corrections D1-D9): "Add a computed value" on Labs, and the clinician's
 * proposal to compute one, which always waits for the user's yes.
 *
 * A computed value is a lab_results row with raw_source 'computed', no document and no detail of its own. Its
 * parse_json.computed (src/shared/labcompute.ts ComputedRecord) keeps the formula and its version, every input's value
 * id, value, unit and conversion, its collection date and time, its citation (document, page, quote, verified), the
 * pairing gap, who computed it and how. The result is stored at full precision and shown the way labs print the index.
 *
 * What it never does: compute by itself (only createComputedValue below, from the user's own action or his yes to a proposal);
 * recompute when an input changes (the value says "input changed: compute again"); delete a computed value by itself;
 * change an input. The lab check ignores computed values (they have no page); the reconciliation never sees them (they
 * are not details); the out-of-range and trend rules leave them out (crossref-rules.ts).
 */
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db';
import { badRequest, conflict, notFound, parseOrThrow } from '../util/errors';
import { newId, nowIso, parseJson } from '../util/ids';
import { analyteLabel, effectiveSpecimen, isKnownKey, normalizeAnalyte } from '../../shared/analytes';
import { formatPartialDate } from '../../shared/dates';
import {
  COMPUTED_RECORD_VERSION,
  COMPUTED_SOURCE,
  COMPUTE_ACTION,
  COMPUTE_TARGET,
  DEFAULT_COMPUTER,
  FORMULAS,
  FORMULA_IDS,
  MASS_UNITS,
  collectionOf,
  comparableUnits,
  computeValue,
  computedLabel,
  convertInput,
  findInput,
  fixedText,
  inputProblem,
  pairInputs,
  printedComparison,
  sampleGroup,
  typedRangeLabel,
  type ComputedInput,
  type ComputedRecord,
  type Formula,
  type FormulaId,
  type InputCandidate,
  type Pairing,
  type PrintedBeside,
  type TypedRange,
} from '../../shared/labcompute';
import { fmtNum } from '../../shared/labvalues';
import { getLab, isSetAside, loadLabEntries, type LabEntry } from './labs';
import { projectReading, readingForRow } from './lab-reading';
import { indexEntity } from './search';
import { writeAudit } from './audit';
import { runLabChecks } from './lab-rules';
import { typedRanges, writeTypedRange } from './lab-computed-ranges';

// ---------------------------------------------------------------------------
// Formulas, as the dialog lists them
// ---------------------------------------------------------------------------

export interface FormulaView {
  id: FormulaId;
  name: string;
  expression: string;
  /** Decimals shown; null: chosen (the general formula). */
  decimals: number | null;
  /** The result's test; null: named by the user. */
  analyte: string | null;
  slots: Array<{ id: string; label: string; takes: string | null; anyTest: boolean }>;
}

export function listFormulas(): FormulaView[] {
  return FORMULA_IDS.map((id) => {
    const f = FORMULAS[id];
    return {
      id,
      name: f.name,
      expression: f.expression,
      decimals: f.decimals,
      analyte: f.analyte,
      slots: f.slots.map((s) => ({ id: s.id, label: s.label, takes: s.units.length ? s.units.map((u) => MASS_UNITS[u]?.shown ?? u).join(', ') : null, anyTest: s.keys.length === 0 })),
    };
  });
}

// ---------------------------------------------------------------------------
// Candidates: the printed values a slot can take
// ---------------------------------------------------------------------------

/** A Labs entry as an input candidate (src/shared/labcompute.ts InputCandidate). */
export function candidateOf(e: LabEntry): InputCandidate {
  const v = e.reading;
  return {
    id: e.id,
    labResultId: e.labResultId,
    factId: e.factId,
    analyte: e.analyte,
    analyteKey: e.analyteKey,
    specimen: e.specimen,
    documentId: e.documentId,
    documentTitle: e.documentTitle,
    pageNumber: e.pageNumber,
    citationId: e.citationId,
    citationVerified: e.citationVerified,
    quote: e.quote,
    date: e.date,
    datePrecision: e.datePrecision,
    dateText: e.dateText,
    unit: e.unit,
    role: v.role,
    kind: v.kind,
    measurement: v.measurement,
    valueShown: v.valueShown,
    dateKind: v.dateKind,
    collected: v.collected ? { iso: v.collected.iso, precision: v.collected.precision, text: v.collected.text } : null,
    flagShown: v.flagState === 'flag' || v.flagState === 'not_understood' ? v.flagShown : null,
    lab: v.lab,
    setAside: isSetAside(e),
    inaccurate: e.trust?.trust === 'inaccurate',
  };
}

export interface CandidateView {
  id: string;
  analyte: string;
  specimen: string;
  valueShown: string;
  unit: string | null;
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  documentId: string | null;
  documentTitle: string | null;
  pageNumber: number | null;
  flagShown: string | null;
  lab: string | null;
  /** Why it cannot be used; null: it can. */
  problem: string | null;
  /** How the formula reads it ("4120 mg/dL = 4.12 g/dL (divided by 1000)"); null when it cannot be used. */
  conversion: string | null;
}

export const candidatesQuery = z.object({
  formula: z.enum(FORMULA_IDS as unknown as [FormulaId, ...FormulaId[]]),
  slot: z.string().trim().min(1).max(40),
  /** The general formula: which test (its key, as the Labs list names it). */
  analyteKey: z.string().trim().max(200).optional(),
  specimen: z.string().trim().max(32).optional(),
});

function slotOf(formula: Formula, slotId: string) {
  const slot = formula.slots.find((s) => s.id === slotId);
  if (!slot) throw badRequest(`slot: ${formula.name} has no input called "${slotId}"`);
  return slot;
}

/**
 * The values a slot can take: only values printed on a lab report (D1: never a summary's, a typed, a computed or an
 * unsorted document's value; never one set aside), of the slot's test and sample (the general formula: the test asked
 * for), newest first. A value that cannot be used (a limit, words, a unit outside the table, no collection date) is
 * listed with the reason (D3).
 */
export function listCandidates(raw: unknown, entries: LabEntry[] = loadLabEntries()): { items: CandidateView[] } {
  const q = parseOrThrow(candidatesQuery, raw, 'query');
  const formula = FORMULAS[q.formula];
  const slot = slotOf(formula, q.slot);
  if (!slot.keys.length && !q.analyteKey) throw badRequest('analyteKey: choose the test for this input first');
  const items = entries
    .filter((e) => e.reading.role === 'printed' && !isSetAside(e))
    .filter((e) => (slot.keys.length ? slot.keys.includes(e.analyteKey) : e.analyteKey === q.analyteKey) && (slot.samples.length ? slot.samples.includes(e.specimen) : !q.specimen || e.specimen === q.specimen))
    .map((e) => {
      const c = candidateOf(e);
      const problem = inputProblem(slot, c);
      const conv = !problem && c.measurement != null ? convertInput(slot, c.measurement, c.unit) : null;
      return {
        id: e.id,
        analyte: e.analyte,
        specimen: e.specimen,
        valueShown: c.valueShown,
        unit: e.unit,
        date: e.date,
        datePrecision: e.datePrecision,
        dateText: e.dateText,
        documentId: e.documentId,
        documentTitle: e.documentTitle,
        pageNumber: e.pageNumber,
        flagShown: c.flagShown,
        lab: c.lab,
        problem,
        conversion: conv && conv.ok ? conv.conversion.words : null,
      };
    });
  items.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.id.localeCompare(b.id));
  return { items };
}

/** The tests the general formula can take values from: tests with values printed on a lab report. */
export function listComputeTests(entries: LabEntry[] = loadLabEntries()): { items: Array<{ analyteKey: string; specimen: string; analyte: string; count: number }> } {
  const map = new Map<string, { analyteKey: string; specimen: string; analyte: string; count: number; names: string[] }>();
  for (const e of entries) {
    if (e.reading.role !== 'printed' || isSetAside(e) || e.reading.kind !== 'number') continue;
    const k = `${e.analyteKey}|${e.specimen}`;
    const cur = map.get(k) ?? { analyteKey: e.analyteKey, specimen: e.specimen, analyte: '', count: 0, names: [] };
    cur.count++;
    cur.names.push(e.analyte);
    map.set(k, cur);
  }
  const items = [...map.values()].map(({ names, ...rest }) => ({ ...rest, analyte: analyteLabel(rest.analyteKey, names[0]) }));
  items.sort((a, b) => a.analyte.localeCompare(b.analyte) || a.specimen.localeCompare(b.specimen));
  return { items };
}

// ---------------------------------------------------------------------------
// Preview and compute
// ---------------------------------------------------------------------------

export const computeInput = z.object({
  formula: z.enum(FORMULA_IDS as unknown as [FormulaId, ...FormulaId[]]),
  /** Each slot's chosen value: the Labs entry id ("<row id>", "fact:<id>", "<id>#n"). */
  inputs: z.record(z.string().trim().min(1).max(40), z.string().trim().min(1).max(200)),
  /** The general formula: k (1 when nothing is multiplied). */
  k: z.number().finite().nullish(),
  /** The general formula: the result's unit, as the user types it. */
  unit: z.string().trim().max(40).nullish(),
  /** The general formula: the result's name. */
  name: z.string().trim().max(120).nullish(),
  /** The general formula: the decimals shown (0-6, default 2). */
  decimals: z.number().int().min(0).max(6).nullish(),
});
export type ComputeInput = z.input<typeof computeInput>;

export interface PreviewInput {
  slot: string;
  slotLabel: string;
  entryId: string | null;
  analyte: string | null;
  valueShown: string | null;
  unit: string | null;
  conversion: string | null;
  date: string | null;
  dateText: string | null;
  /** 'unknown': the document does not say the date is the collection date (said, not refused). */
  dateKind: 'collected' | 'unknown' | null;
  documentId: string | null;
  documentTitle: string | null;
  pageNumber: number | null;
  citationVerified: boolean | null;
  flagShown: string | null;
  problem: string | null;
}

export interface ComputePreview {
  ok: boolean;
  /** Every reason it cannot be computed, in plain words; empty when ok. */
  problems: string[];
  /** Notes that do not stop it (a date not labelled as collected, a quote not found on the page). */
  notes: string[];
  formula: { id: FormulaId; name: string; expression: string };
  inputs: PreviewInput[];
  pairing: Pick<Pairing, 'window' | 'timesKnown' | 'gapMinutes' | 'gapDays' | 'words'> | null;
  result: { full: number; shown: string; decimals: number; unit: string | null; analyte: string; analyteKey: string; specimen: string; day: string; dayText: string | null } | null;
  /** "Computed by you from p.2 and p.3" */
  label: string | null;
  /** The lab's own printed value of this index on that day, when there is one (D5). */
  printedBeside: PrintedBeside[];
}

interface Built {
  preview: ComputePreview;
  record: ComputedRecord | null;
}

/** A known test that is itself worked out from others (an index, a ratio, a quotient, a synthesis rate): a general formula's result may be named so. */
const DERIVED_KEY = /\b(?:index|ratio|quotient|synthesis rate)\b/;

/** The entry an input id names now when it was a value Claude read ("fact:<id>", "fact:<id>#n") since copied into the lab list. */
function movedEntry(id: string, entries: LabEntry[]): LabEntry | undefined {
  if (!id.startsWith('fact:')) return undefined;
  const factId = id.slice(5).split('#')[0];
  const found = findInput({ entryId: id, factId, labResultId: null }, entries.map((e) => ({ id: e.id, labResultId: e.labResultId, factId: e.factId, analyte: e.analyte, date: e.date, unit: e.unit, valueShown: e.reading.valueShown, role: e.reading.role, setAside: isSetAside(e) })));
  return found ? entries.find((e) => e.id === found.id) : undefined;
}

function build(raw: unknown, who: string, entries: LabEntry[]): Built {
  const input = parseOrThrow(computeInput, raw);
  const formula = FORMULAS[input.formula];
  const byId = new Map(entries.map((e) => [e.id, e] as const));
  const problems: string[] = [];
  const notes: string[] = [];
  const unknown = Object.keys(input.inputs).filter((k) => !formula.slots.some((s) => s.id === k));
  if (unknown.length) problems.push(`${formula.name} has no input called ${unknown.map((k) => `"${k}"`).join(', ')}.`);
  const chosen: Array<{ slot: (typeof formula.slots)[number]; e: LabEntry; c: InputCandidate }> = [];
  const shownInputs: PreviewInput[] = formula.slots.map((slot) => {
    const id = input.inputs[slot.id];
    const empty: PreviewInput = { slot: slot.id, slotLabel: slot.label, entryId: id ?? null, analyte: null, valueShown: null, unit: null, conversion: null, date: null, dateText: null, dateKind: null, documentId: null, documentTitle: null, pageNumber: null, citationVerified: null, flagShown: null, problem: null };
    if (!id) {
      empty.problem = `Choose the ${slot.label} value.`;
      problems.push(empty.problem);
      return empty;
    }
    // A value Claude read ("fact:<id>") copied into the lab list since is the same input under its row's id (a
    // proposal's yes, "Compute again").
    const e = byId.get(id) ?? movedEntry(id, entries);
    if (!e) {
      empty.problem = `${slot.label}: that value is not listed any more.`;
      problems.push(empty.problem);
      return empty;
    }
    const c = candidateOf(e);
    const problem = inputProblem(slot, c);
    const conv = problem || c.measurement == null ? null : convertInput(slot, c.measurement, c.unit);
    const when = collectionOf(c);
    const out: PreviewInput = {
      slot: slot.id,
      slotLabel: slot.label,
      entryId: e.id,
      analyte: e.analyte,
      valueShown: c.valueShown,
      unit: e.unit,
      conversion: conv && conv.ok ? conv.conversion.words : null,
      date: when.ok ? when.day : e.date,
      dateText: when.ok ? when.text : e.dateText,
      dateKind: when.ok ? when.kind : null,
      documentId: e.documentId,
      documentTitle: e.documentTitle,
      pageNumber: e.pageNumber,
      citationVerified: e.citationVerified,
      flagShown: c.flagShown,
      problem: problem ? `${slot.label}: ${problem}` : null,
    };
    if (out.problem) problems.push(out.problem);
    else {
      chosen.push({ slot, e, c });
      if (when.ok && when.kind === 'unknown') notes.push(`${slot.label}: the document does not say whether ${when.day} is when the sample was collected; it is used as the collection date.`);
      if (e.citationVerified === false) notes.push(`${slot.label}: its quote was not found word for word on p.${e.pageNumber}; the citation is kept and marked.`);
      if (c.flagShown) notes.push(`${slot.label}: the flag "${c.flagShown}" printed with it is shown, not used.`);
    }
    return out;
  });
  // The same value twice (one value cannot be both CSF and serum).
  const ids = chosen.map((x) => x.e.id);
  if (new Set(ids).size !== ids.length) problems.push('The same value is chosen twice.');

  if (formula.id === 'ratio') {
    if (!input.name || !input.name.trim()) problems.push('Name the result (for example "CSF/serum glucose ratio").');
    else if (chosen.length) {
      // The result is never filed under a test a lab measures, its inputs' tests first (rule 9): it would join that
      // test's trend and be compared with its printed values. A known index, ratio or quotient (the albumin quotient,
      // the CSF/serum glucose ratio) is a name it may take.
      const name = input.name.trim();
      const key = normalizeAnalyte(name, chosen[0].e.specimen);
      const own = chosen.find((x) => x.e.analyteKey === key || normalizeAnalyte(name, x.e.specimen) === x.e.analyteKey);
      if (own) problems.push(`Name the result differently from its input "${own.e.analyte}" (for example "${own.e.analyte} ratio").`);
      else if (isKnownKey(key) && !DERIVED_KEY.test(key)) problems.push(`"${name}" is a test labs measure; a computed value is never filed under it. Name it as the ratio it is (for example "CSF/serum glucose ratio").`);
    }
    if (input.k == null) problems.push('Type k (1 when nothing is multiplied).');
    // Units as printed, never converted: when A and B differ it is said, and the unit of the result is the user's to type.
    const units = [...new Set(chosen.map((x) => (x.e.unit ?? '').trim()))];
    if (chosen.length === formula.slots.length && units.length > 1) notes.push(`A is in ${units[0] || 'no unit'} and B in ${units[1] || 'no unit'}; nothing is converted, so type the unit of the result to match.`);
  }

  let pairing: ComputePreview['pairing'] = null;
  let pair: Pairing | null = null;
  if (chosen.length === formula.slots.length && !problems.length) {
    pair = pairInputs(
      chosen.map((x) => {
        const when = collectionOf(x.c);
        return { label: x.slot.label, sample: sampleGroup(x.e.specimen), day: when.ok ? when.day : '', minutes: when.ok ? when.minutes : null };
      }),
    );
    pairing = { window: pair.window, timesKnown: pair.timesKnown, gapMinutes: pair.gapMinutes, gapDays: pair.gapDays, words: pair.words };
    if (!pair.ok && pair.reason) problems.push(pair.reason);
  }

  let result: ComputePreview['result'] = null;
  let record: ComputedRecord | null = null;
  let label: string | null = null;
  let printedBeside: PrintedBeside[] = [];
  if (!problems.length && pair) {
    const values: Record<string, number> = {};
    const conversions = new Map<string, ReturnType<typeof convertInput>>();
    for (const x of chosen) {
      const conv = convertInput(x.slot, x.c.measurement!, x.c.unit);
      conversions.set(x.slot.id, conv);
      if (conv.ok) values[x.slot.id] = conv.conversion.value;
    }
    const k = formula.id === 'ratio' ? (input.k ?? null) : null;
    const value = computeValue(formula, values, k);
    if (!value.ok) problems.push(value.reason);
    else {
      const decimals = formula.decimals ?? input.decimals ?? 2;
      const first = chosen[0];
      const when = collectionOf(first.c);
      const day = when.ok ? when.day : first.e.date!;
      const name = formula.analyte ?? (input.name ?? '').trim();
      const specimen0 = formula.specimen ?? first.e.specimen;
      const analyteKey = normalizeAnalyte(name, specimen0);
      const specimen = effectiveSpecimen(analyteKey, specimen0, name);
      const unit = formula.id === 'ratio' ? (input.unit?.trim() || null) : null;
      const inputs: ComputedInput[] = chosen.map((x) => {
        const conv = conversions.get(x.slot.id)!;
        const w = collectionOf(x.c);
        return {
          slot: x.slot.id,
          slotLabel: x.slot.label,
          entryId: x.e.id,
          labResultId: x.e.labResultId,
          factId: x.e.factId,
          analyte: x.e.analyte,
          analyteKey: x.e.analyteKey,
          specimen: x.e.specimen,
          valueShown: x.c.valueShown,
          value: x.c.measurement!,
          unit: x.e.unit,
          conversion: conv.ok ? conv.conversion : { value: x.c.measurement!, from: x.e.unit, to: x.e.unit, factor: 1, words: '' },
          date: w.ok ? { day: w.day, text: w.text, kind: w.kind, minutes: w.minutes } : { day: x.e.date ?? '', text: x.e.dateText, kind: 'unknown', minutes: null },
          flagShown: x.c.flagShown,
          lab: x.c.lab,
          citation: { citationId: x.e.citationId, documentId: x.e.documentId!, documentTitle: x.e.documentTitle, page: x.e.pageNumber!, quote: x.e.quote, verified: Boolean(x.e.citationVerified) },
        };
      });
      label = computedLabel(inputs, who);
      const shown = fixedText(value.value, decimals);
      result = { full: value.value, shown, decimals, unit, analyte: name, analyteKey, specimen, day, dayText: when.ok ? when.text : first.e.dateText };
      record = {
        v: COMPUTED_RECORD_VERSION,
        formula: { id: formula.id, version: formula.version, name: formula.id === 'ratio' ? name : formula.name, expression: formula.id === 'ratio' ? `A divided by B, times ${fmtNum(k ?? 1)}` : formula.expression, k, unit, decimals },
        result: { full: value.value, shown, decimals },
        inputs,
        pairing: { window: pair.window, timesKnown: pair.timesKnown, gapMinutes: pair.gapMinutes, gapDays: pair.gapDays, words: pair.words },
        by: { name: who, at: nowIso(), via: 'labs', proposalId: null },
        label,
      };
      // The lab's own printed value of this index on that day (D5): shown beside the computed one.
      printedBeside = entries
        .filter((p) => p.reading.role === 'printed' && !isSetAside(p) && p.analyteKey === analyteKey && comparableUnits(unit, p.unit) && [p.date, p.reading.collected?.iso, p.reading.resulted?.iso].some((d) => d && d.slice(0, 10) === day))
        .flatMap((p) => {
          const cmp = printedComparison(value.value, p.reading.valueShown);
          return cmp ? [{ entryId: p.id, valueShown: p.reading.valueShown, unit: p.unit, documentId: p.documentId, documentTitle: p.documentTitle, pageNumber: p.pageNumber, differs: cmp.differs, computedAtPrecision: cmp.computedAtPrecision }] : [];
        });
    }
  }
  const preview: ComputePreview = {
    ok: problems.length === 0 && record != null,
    problems,
    notes,
    formula: { id: formula.id, name: formula.name, expression: formula.expression },
    inputs: shownInputs,
    pairing,
    result,
    label,
    printedBeside,
  };
  return { preview, record: preview.ok ? record : null };
}

/** What computing these inputs would give, and every reason it cannot (nothing is written). */
export function previewCompute(raw: unknown, who: string | null = null, entries: LabEntry[] = loadLabEntries()): ComputePreview {
  return build(raw, who || DEFAULT_COMPUTER, entries).preview;
}

export interface ComputeOptions {
  /** The person computing it (the session user's name; "you" when not known). */
  by?: string | null;
  userId?: string | null;
  /** 'clinician': the user said yes to the clinician's proposal. */
  via?: 'labs' | 'clinician';
  proposalId?: string | null;
}

/**
 * An input as one printed value, whatever its entry id is now: its detail (and part of a line), else its row. A value
 * Claude read ("fact:<id>") and the row it became when copied into the lab list are the same input.
 */
function inputIdentity(i: Pick<ComputedInput, 'entryId' | 'factId' | 'labResultId'>): string {
  const part = i.entryId.includes('#') ? i.entryId.slice(i.entryId.indexOf('#')) : '';
  return i.factId ? `f:${i.factId}${part}` : i.labResultId ? `r:${i.labResultId}${part}` : `e:${i.entryId}`;
}

/** A live computed value of the same formula, inputs (as printed now) and result: computing it again adds nothing. */
function sameComputed(record: ComputedRecord): string | null {
  const rows = db().select({ id: schema.labResults.id, parseJson: schema.labResults.parseJson }).from(schema.labResults).where(and(eq(schema.labResults.rawSource, COMPUTED_SOURCE), isNull(schema.labResults.deletedAt))).all();
  const key = (r: ComputedRecord) => `${r.formula.id}|${r.formula.k ?? ''}|${r.formula.unit ?? ''}|${r.result.shown}|${r.inputs.map((i) => `${i.slot}=${inputIdentity(i)}:${i.valueShown}`).join(',')}`;
  const want = key(record);
  for (const r of rows) {
    const rec = parseJson<{ computed?: ComputedRecord }>(r.parseJson, {}).computed;
    if (rec && rec.formula && Array.isArray(rec.inputs) && key(rec) === want) return r.id;
  }
  return null;
}

/**
 * The user computes a value (D2-D7): the inputs are checked again here, the result is written as a lab_results row
 * (raw_source 'computed', no document, no detail) with its record, its search entry and an audit line; then the lab
 * checks run once so a printed index that differs becomes a finding at once. Refused (400) with every reason when it
 * cannot be computed; 409 when the same value is already on file.
 */
export function createComputedValue(raw: unknown, opts: ComputeOptions = {}): LabEntry {
  const who = (opts.by ?? '').trim() || DEFAULT_COMPUTER;
  const { preview, record } = build(raw, who, loadLabEntries());
  if (!preview.ok || !record || !preview.result) throw badRequest(preview.problems.join(' ') || 'This value cannot be computed.');
  record.by = { name: who, at: nowIso(), via: opts.via ?? 'labs', proposalId: opts.proposalId ?? null };
  const twin = sameComputed(record);
  if (twin) throw conflict('This value is already computed from these inputs; it is in your lab table.');
  const r = preview.result;
  const id = newId();
  const now = nowIso();
  const dayText = r.dayText && r.dayText.trim() ? r.dayText : r.day;
  const first = record.inputs[0];
  const row: typeof schema.labResults.$inferInsert = {
    id,
    analyte: r.analyte,
    analyteKey: r.analyteKey,
    valueNum: Number(r.shown),
    valueText: r.shown,
    unit: r.unit,
    refLow: null,
    refHigh: null,
    refText: null,
    flag: null,
    flagRaw: null,
    specimen: r.specimen,
    collectedAt: r.day,
    collectedAtPrecision: 'day',
    collectedAtText: dayText,
    // The first input's kind: a date the document did not label as collected stays of unknown kind (rule 7).
    dateKind: first.date.kind === 'collected' ? 'collected' : 'unknown',
    labName: null,
    institutionId: null,
    documentId: null,
    factId: null,
    notes: null,
    rawSource: COMPUTED_SOURCE,
    valueRaw: r.shown,
    createdAt: now,
    updatedAt: now,
  };
  const d = db();
  d.transaction(() => {
    d.insert(schema.labResults).values(row).run();
    const stored = d.select().from(schema.labResults).where(eq(schema.labResults.id, id)).get()!;
    const reading = readingForRow(stored, { hasDocument: false });
    const p = projectReading(reading, { rawSource: COMPUTED_SOURCE, parsedFrom: 'user', rawFrom: null, dateKind: row.dateKind as 'collected' | 'unknown' });
    const pj = { ...parseJson<Record<string, unknown>>(p.parseJson ?? null, {}), computed: record };
    d.update(schema.labResults).set({ ...p, rawSource: COMPUTED_SOURCE, parseJson: JSON.stringify(pj) }).where(eq(schema.labResults.id, id)).run();
    indexEntity('lab', id, `${r.analyte} ${r.shown}${r.unit ? ` ${r.unit}` : ''}`, [record.label, 'computed', formatPartialDate(r.day, 'day'), r.specimen].join(' · '));
  });
  writeAudit({ userId: opts.userId ?? null, userName: who, action: 'create', entityType: 'lab_computed', entityId: id, summary: `${record.formula.name} computed (${record.label})${opts.via === 'clinician' ? ', proposed by the clinician' : ''}` });
  // A printed index of the same collection that differs is a finding at once (never throws: the value is written).
  try {
    runLabChecks({ trigger: 'manual' });
  } catch (err) {
    console.warn(`[labs] checks after a computed value: ${err instanceof Error ? err.message : String(err)}`);
  }
  return getLab(id);
}


// ---------------------------------------------------------------------------
// The range the patient types (D6)
// ---------------------------------------------------------------------------

export const typedRangeInput = z
  .object({ low: z.number().finite().nullish(), high: z.number().finite().nullish() })
  .refine((r) => r.low != null || r.high != null, { message: 'type a lower or an upper limit (or both)' })
  .refine((r) => r.low == null || r.high == null || r.low <= r.high, { message: 'the lower limit is above the upper limit' });

/** The computed tests (by key) a range can be typed for: the ones with a computed value. */
function computedKeys(): Set<string> {
  const rows = db().select({ analyte: schema.labResults.analyte, specimen: schema.labResults.specimen }).from(schema.labResults).where(and(eq(schema.labResults.rawSource, COMPUTED_SOURCE), isNull(schema.labResults.deletedAt))).all();
  return new Set(rows.map((r) => normalizeAnalyte(r.analyte, r.specimen)));
}

export function listTypedRanges(): Record<string, TypedRange & { label: string }> {
  const out: Record<string, TypedRange & { label: string }> = {};
  for (const [k, v] of Object.entries(typedRanges())) out[k] = { ...v, label: typedRangeLabel(v) };
  return out;
}

/** The user types (or clears, with null) his own range for a computed test: drawn dashed, never making a value red. */
export function setTypedRange(analyteKey: string, raw: unknown | null, opts: { by?: string | null; userId?: string | null } = {}): Record<string, TypedRange & { label: string }> {
  const key = analyteKey.trim();
  if (!key) throw badRequest('analyteKey: which computed test');
  if (raw === null) {
    writeTypedRange(key, null);
  } else {
    if (!computedKeys().has(key)) throw notFound('no computed value of that test; compute one first');
    const r = parseOrThrow(typedRangeInput, raw);
    writeTypedRange(key, { low: r.low ?? null, high: r.high ?? null, by: (opts.by ?? '').trim() || DEFAULT_COMPUTER, at: nowIso() });
  }
  writeAudit({ userId: opts.userId ?? null, userName: opts.by ?? null, action: 'settings', entityType: 'lab_computed_range', entityId: key, summary: raw === null ? 'range typed for a computed test cleared' : 'range typed for a computed test' });
  return listTypedRanges();
}

// ---------------------------------------------------------------------------
// The clinician's proposal (D8): always waits for the user's yes
// ---------------------------------------------------------------------------

type FilingRow = typeof schema.filings.$inferSelect;

/**
 * The clinician proposes computing a value: a filings row (target lab_compute) that waits for the user's yes, whatever his
 * message said. The inputs are checked now; a refusal says every reason (the tool reads it).
 */
export function proposeComputedValue(raw: unknown, ctx: { askMessageId?: string | null; reason?: string | null } = {}): { filingId: string; words: string; preview: ComputePreview } {
  const input = parseOrThrow(computeInput, raw, 'input');
  const { preview } = build(input, DEFAULT_COMPUTER, loadLabEntries());
  if (!preview.ok || !preview.result) throw badRequest(preview.problems.join(' ') || 'This value cannot be computed.');
  const id = newId();
  const r = preview.result;
  const summary = `Compute the ${preview.formula.id === 'ratio' ? r.analyte : preview.formula.name.toLowerCase()} of ${r.day}: ${r.shown}${r.unit ? ` ${r.unit}` : ''} (${(preview.label ?? '').replace(/^Computed by [^ ]+ /, '')})`.slice(0, 500);
  db().insert(schema.filings).values({
    id,
    documentId: null,
    targetType: COMPUTE_TARGET,
    targetId: id,
    action: COMPUTE_ACTION,
    status: 'waiting',
    source: 'consult',
    summary,
    detailJson: JSON.stringify({ input, preview: { shown: r.shown, unit: r.unit, day: r.day, label: preview.label, pairing: preview.pairing?.words ?? null, analyte: r.analyte }, reason: ctx.reason ?? null, labResultId: null }),
    askMessageId: ctx.askMessageId ?? null,
    createdAt: nowIso(),
  }).run();
  return { filingId: id, words: `Proposed to the patient: ${summary}. Nothing is computed until he presses "Yes, compute it" under the answer.`, preview };
}

function proposalRow(filingId: string): FilingRow {
  const row = db().select().from(schema.filings).where(and(eq(schema.filings.id, filingId), eq(schema.filings.targetType, COMPUTE_TARGET))).get();
  if (!row) throw notFound('no such proposal to compute a value');
  return row;
}

/**
 * The user's yes: computed now from the proposal's inputs as they read now. When an input changed since it was proposed
 * (the result would differ from what the card showed), nothing is computed: he computes it again from Labs.
 */
export function approveComputeProposal(filingId: string, opts: { by?: string | null; userId?: string | null } = {}): { filing: FilingRow; entry: LabEntry } {
  const row = proposalRow(filingId);
  if (row.status !== 'waiting') throw conflict(`this proposal is already ${row.status === 'approved' ? 'computed' : row.status === 'declined' ? 'answered "not now"' : row.status}`);
  const d = parseJson<{ input?: unknown; preview?: { shown?: string } }>(row.detailJson, {});
  const now = previewCompute(d.input, opts.by ?? null);
  if (!now.ok || !now.result) throw conflict(`It cannot be computed now: ${now.problems.join(' ')}`);
  if (d.preview?.shown && now.result.shown !== d.preview.shown) throw conflict(`An input changed since the clinician proposed this (it would now be ${now.result.shown}, not ${d.preview.shown}). Compute it again from Labs.`);
  const entry = createComputedValue(d.input, { by: opts.by, userId: opts.userId, via: 'clinician', proposalId: filingId });
  db()
    .update(schema.filings)
    .set({ status: 'approved', decidedAt: nowIso(), decidedBy: opts.by ?? 'user', detailJson: JSON.stringify({ ...d, labResultId: entry.labResultId }) })
    .where(eq(schema.filings.id, filingId))
    .run();
  return { filing: proposalRow(filingId), entry };
}

export function declineComputeProposal(filingId: string, opts: { by?: string | null } = {}): FilingRow {
  const row = proposalRow(filingId);
  if (row.status !== 'waiting') throw conflict(`this proposal is already ${row.status}`);
  db().update(schema.filings).set({ status: 'declined', decidedAt: nowIso(), decidedBy: opts.by ?? 'user' }).where(eq(schema.filings.id, filingId)).run();
  return proposalRow(filingId);
}
