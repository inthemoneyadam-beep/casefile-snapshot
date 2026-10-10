/**
 * Checked against itself, in the app's words (2026-10-09): the document's line in "How much was read", the dialog
 * that shows the cost before anything is sent, the toasts, and the facility line on People and places. Plain
 * TypeScript (no components) so tests can import it.
 */
import { contradictionStateWords, countsWords, plural } from '@shared/selfcheck';
import type { DocumentEstimate, DocumentSelfCheck, EstimateResponse, QueueResult } from '../../api/self-check';

/** The action, its key and what it does (More on any document; the palette). */
export const SELF_CHECK_LABEL = 'Check it against itself';
export const SELF_CHECK_KEY = 'a';
export const SELF_CHECK_TITLE = "The app checks every lab flag against its own value and range (free); Claude reads each note for places where it contradicts itself. Never against other documents. You see the cost first.";
export const SELF_CHECK_MANY_LABEL = 'Check documents against themselves…';

export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '';
  return `about $${n > 0 && n < 0.01 ? n.toFixed(3) : n.toFixed(2)}`;
}

/** Shown in the document's panel once the document has a record. */
export function selfCheckWorthShowing(d: DocumentSelfCheck | null | undefined): boolean {
  return Boolean(d?.record);
}

/** "Lab flags: 3 of 12 don't match." / "Lab flags: all 12 match." / "Lab flags: none to compare." */
export function flagsLine(d: DocumentSelfCheck): string | null {
  const f = d.record?.flags;
  if (!f) return null;
  if (!f.checked && !f.mismatched) return 'Lab flags: none printed with a range to compare.';
  if (!f.mismatched) return `Lab flags: all ${f.checked.toLocaleString('en-US')} match their values.`;
  const raised = f.alreadyRaised ? ` (${f.alreadyRaised} already noted elsewhere)` : '';
  return `Lab flags: ${f.mismatched.toLocaleString('en-US')} of ${f.checked.toLocaleString('en-US')} ${f.mismatched === 1 ? "doesn't" : "don't"} match the value${raised}.`;
}

/** "Contradictions: 1 found in 4 parts." or where the reading stands. */
export function contradictionsLine(d: DocumentSelfCheck): string | null {
  const c = d.record?.contradictions;
  if (!c) return null;
  const state = contradictionStateWords(c, { dollars: usd });
  if (state) return state;
  const parts = Object.values(c.parts ?? {}).filter((p) => p.status === 'done').length;
  const found = d.counts.contradictions;
  const read = parts ? ` in ${plural(parts, 'part')} read` : '';
  const flagged = c.unverified ? `; ${c.unverified} with a passage not found word for word` : '';
  return found ? `Contradictions: ${found.toLocaleString('en-US')} found${read}${flagged}.` : `Contradictions: none found${read}.`;
}

/** The one-line summary: "Checked against itself: 2 flags don't match, 1 contradiction." */
export function summaryLine(d: DocumentSelfCheck): string {
  return `Checked against itself: ${countsWords(d.counts)}.`;
}

/** What one document would read, for the dialog. */
export function estimateLine(e: DocumentEstimate): string {
  if (e.blocked) return `Nothing for Claude to read: ${e.blocked}.${e.flagsToCheck ? ` ${plural(e.flagsToCheck, 'lab flag')} checked for free.` : ''}`;
  const flags = e.flagsToCheck ? `${plural(e.flagsToCheck, 'lab flag')} checked for free; ` : 'No lab flags to check; ';
  if (!e.calls) return `${flags}every part already read for contradictions${e.checked ? ' (Check again reads them once more)' : ''}.`;
  return `${flags}Claude reads ${plural(e.parts, 'part')} for contradictions in ${plural(e.calls, 'small call')}, ${usd(e.estimateUsd)}.`;
}

/** What many documents would read, for the dialog's summary. */
export function estimateTotalLine(r: EstimateResponse): string {
  const n = r.items.length;
  const reading = r.items.filter((x) => x.calls > 0).length;
  const done = r.items.filter((x) => !x.calls && !x.blocked).length;
  const bits = [`${plural(n, 'document')}: Claude reads ${plural(reading, 'of them', 'of them')} for contradictions in ${plural(r.calls, 'small call')}, ${usd(r.totalUsd)} in all.`];
  if (done) bits.push(`${done.toLocaleString('en-US')} ${done === 1 ? 'is' : 'are'} already read (Check again reads them once more).`);
  bits.push('Lab flags are checked for free.');
  return bits.join(' ');
}

/** The toast after "Check it against itself". */
export function queueResultWords(r: QueueResult): string {
  const flags = r.flags ? (r.flags.mismatched ? `${plural(r.flags.mismatched, 'lab flag')} ${r.flags.mismatched === 1 ? "doesn't" : "don't"} match. ` : r.flags.checked ? 'Every lab flag matches. ' : '') : '';
  switch (r.outcome) {
    case 'queued':
      return `${flags}Claude will read it for contradictions (${usd(r.estimateUsd)}).`;
    case 'nothing':
      return `${flags}Nothing more for Claude to read.`;
    case 'off':
      return `${flags}Claude is off or has no key, so it was not read for contradictions.`;
    case 'asked':
      return `${flags}It costs more than your limit; say yes on the document.`;
    case 'declined':
      return `${flags}Not read for contradictions (you said not now).`;
    default:
      return flags || 'Done.';
  }
}

export function manyResultWords(r: { items: QueueResult[]; missing: string[] }): string {
  const queued = r.items.filter((x) => x.outcome === 'queued').length;
  const off = r.items.some((x) => x.outcome === 'off');
  const usdTotal = r.items.filter((x) => x.outcome === 'queued').reduce((n, x) => n + x.estimateUsd, 0);
  const flags = r.items.reduce((n, x) => n + (x.flags?.mismatched ?? 0), 0);
  const bits = [`${plural(r.items.length, 'document')} checked for lab flags: ${flags ? `${plural(flags, 'flag')} ${flags === 1 ? "doesn't" : "don't"} match` : 'all match'}.`];
  if (queued) bits.push(`Claude will read ${plural(queued, 'of them', 'of them')} for contradictions (${usd(usdTotal)}).`);
  if (off) bits.push('Claude is off or has no key.');
  if (r.missing.length) bits.push(`${plural(r.missing.length, 'document')} not found.`);
  return bits.join(' ');
}
