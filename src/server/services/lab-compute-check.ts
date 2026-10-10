/**
 * A printed index against the one the patient computed (2026-10-09, D5), worded like lab rule 12: when the lab prints the same
 * index (an albumin index, an IgG index) for the same collection day as a value the patient computed from the printed inputs,
 * and the two differ at the lab's own precision, one finding names both, their pages and the inputs. Nothing is chosen
 * or changed: the lab's printed value is the record; the computed value is the patient's own arithmetic.
 *
 * The drafts come from the lab checks' one loader (labs.ts loadLabReadings, through lab-rules.ts labCheckDrafts), so
 * they run where rules 10 and 12 run: at every unlock, in every full Findings run and after every reading (the rules
 * run after ingest), and once more when a value is computed.
 */
import { inArray } from 'drizzle-orm';
import { db, schema } from '../db';
import { dateSortKey } from '../../shared/dates';
import { COMPUTED_DIFFERS_RULE, comparableUnits, computedDay, printedComparison, readComputedRecord, type ComputedRecord } from '../../shared/labcompute';
import { fmtNum } from '../../shared/labvalues';
import type { LabReadingRecord } from './lab-reading';
import type { CrossrefScope, DraftEvidence, FindingDraft } from './crossref-rules';

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

/** The days a printed value can be matched on: its own date, its collected and its resulted days. */
function daysOf(r: LabReadingRecord): Set<string> {
  const out = new Set<string>();
  const d = r.reading.dates;
  for (const x of [d.reading?.iso, d.collected?.iso, d.resulted?.iso]) if (x && /^\d{4}-\d{2}-\d{2}/.test(x)) out.add(x.slice(0, 10));
  return out;
}

/** The stored records of these computed rows (parse_json.computed), by row id. */
function recordsOf(ids: string[]): Map<string, ComputedRecord> {
  const out = new Map<string, ComputedRecord>();
  for (let i = 0; i < ids.length; i += 400) {
    const rows = db().select({ id: schema.labResults.id, parseJson: schema.labResults.parseJson }).from(schema.labResults).where(inArray(schema.labResults.id, ids.slice(i, i + 400))).all();
    for (const r of rows) {
      const rec = readComputedRecord(r.parseJson);
      if (rec) out.set(r.id, rec);
    }
  }
  return out;
}

function inWindow(day: string | null, scope: CrossrefScope): boolean {
  if (!day) return true;
  const key = dateSortKey(day);
  if (scope.from && key < dateSortKey(scope.from)) return false;
  if (scope.to && key.slice(0, scope.to.length) > scope.to) return false;
  return true;
}

function valueWords(shown: string, unit: string | null): string {
  return `${shown || 'no value'}${unit ? ` ${unit}` : ''}`;
}

/**
 * One finding per (computed value, the lab's printed value of the same index and day) that differ at the printed
 * precision. A scope keeps those with a document in scope (the lab report's, or an input's) and, with a date window,
 * those dated inside it.
 */
export function computedDiffersDrafts(records: readonly LabReadingRecord[], scope: CrossrefScope | null = null): FindingDraft[] {
  const computed = records.filter((r) => r.reading.role === 'computed' && r.labResultId);
  if (!computed.length) return [];
  const printed = records.filter((r) => r.reading.role === 'printed' && !r.passSetAside);
  if (!printed.length) return [];
  const stored = recordsOf(computed.map((r) => r.labResultId!));
  const docs = scope?.documentIds?.length ? new Set(scope.documentIds) : null;
  const out: FindingDraft[] = [];
  for (const c of computed) {
    const rec = stored.get(c.labResultId!);
    if (!rec) continue;
    const day = computedDay(rec, c.reading.dates.reading?.iso ?? null);
    if (!day || !inWindow(day, scope ?? {})) continue;
    for (const p of printed) {
      // The same index, day and unit (or no unit, or a ratio word, on both sides): never a value in another unit (rule 5).
      if (p.analyteKey !== c.analyteKey || !daysOf(p).has(day) || !comparableUnits(rec.formula.unit, p.reading.unit.unit)) continue;
      const cmp = printedComparison(rec.result.full, p.reading.valueShown);
      if (!cmp || !cmp.differs) continue;
      const inputDocs = rec.inputs.map((i) => i.citation.documentId);
      if (docs && !(p.documentId && docs.has(p.documentId)) && !inputDocs.some((d) => docs.has(d))) continue;
      const printedDoc = p.documentTitle ?? 'the lab report';
      const printedValue = valueWords(p.reading.valueShown, p.reading.unit.unit);
      const page = p.pageNumber != null ? ` (page ${p.pageNumber})` : '';
      const mine = valueWords(rec.result.shown, rec.formula.unit);
      const evidence: DraftEvidence[] = [
        { labResultId: c.labResultId, note: `computed by ${rec.by.name || 'you'}: ${mine} (${rec.label.replace(/^Computed by [^ ]+ /, '')})` },
        { factId: p.factId, labResultId: p.labResultId, citationId: p.citationId, documentId: p.documentId, note: `the lab report: ${printedValue}${page}` },
        ...rec.inputs.map((i) => ({ citationId: i.citation.citationId, documentId: i.citation.documentId, note: `input, ${i.slotLabel}: ${valueWords(i.valueShown, i.unit)} (page ${i.citation.page})` })),
      ];
      out.push({
        ruleId: COMPUTED_DIFFERS_RULE,
        category: 'discrepancy',
        severity: 'medium',
        title: clip(`${c.analyte} on ${day}: "${printedDoc}" prints ${printedValue}; computed ${mine}`, 140),
        whyItMatters:
          "The lab printed this index for the same collection, and the value computed by the patient from the printed inputs differs at the lab's own precision. The lab's printed value is the record; the computed value is the patient's own arithmetic from other printed values. Nothing was changed. Worth checking which samples were paired, their units and the lab's own formula before either is relied on.",
        detail: [
          `"${printedDoc}" prints ${printedValue}${page}.`,
          `Computed by ${rec.by.name || 'you'}: ${mine}; ${cmp.computedAtPrecision} at the lab's precision (${fmtNum(rec.result.full)} before rounding). ${rec.formula.expression}.`,
          ...rec.inputs.map((i) => `${i.slotLabel}: ${i.conversion.words}, p.${i.citation.page} of "${i.citation.documentTitle ?? 'a document'}".`),
          rec.pairing.words ? `Pairing: ${rec.pairing.words}.` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        evidence,
        key: [c.labResultId!, p.id],
      });
    }
  }
  return out;
}
