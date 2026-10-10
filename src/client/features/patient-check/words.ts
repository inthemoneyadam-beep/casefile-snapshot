/**
 * The wrong-patient guard in plain words (2026-10-09). Short and plain. The labels
 * are the user's own: "May be someone else's record", "It's mine", "Not my record", "Patient not confirmed on document".
 */
import { HELD_WORDS, NOT_CONFIRMED_WORDS, checkWords, pagesWords, type PatientCheck } from '@shared/patient-identity';

export { HELD_WORDS, NOT_CONFIRMED_WORDS, checkWords, pagesWords };

export const MINE_LABEL = "It's mine";
export const NOT_MINE_LABEL = 'Not my record';

/** Keys, the same on Documents and Check before filing (no clash with either page's own keys). */
export const PATIENT_KEYS = { mine: 'm', notMine: 'w' } as const;

export const MINE_TITLE = 'It is yours: it comes back with its details, and is never held back again for these pages';
export const NOT_MINE_TITLE = "Someone else's record: it goes to Deleted documents with the reason \"wrong patient\" (asks first)";

/** One line under the title of a held document. */
export const HELD_EXPLAIN = 'Nothing is read or filed from it, and the clinician, search and packets leave it out, until you answer.';

/** The confirmation of "Not my record". */
export function notMineBody(title: string): string {
  return `"${title}" goes to Deleted documents with the reason "wrong patient". Its details go with it. Restore brings it back to check again.`;
}

/** The toast after "It's mine". */
export function mineToast(carriedOn: 'sorting' | 'reading' | null): string {
  if (carriedOn === 'sorting') return "It's yours. Claude is sorting it now.";
  if (carriedOn === 'reading') return "It's yours. Claude is reading it now.";
  return "It's yours. Its details are back.";
}

export const NOT_MINE_TOAST = 'Moved to Deleted documents (wrong patient).';

/** The toast after "Not my record": with what stays on its pages (allergies, or items you changed). */
export function notMineToast(kept: number): string {
  return kept ? `${NOT_MINE_TOAST} ${keptWords(kept)}` : NOT_MINE_TOAST;
}

/** "2 items it added stay on their pages (allergies, or ones you changed): check them." */
export function keptWords(kept: number): string {
  return `${kept} item${kept === 1 ? '' : 's'} it added stay${kept === 1 ? 's' : ''} on ${kept === 1 ? 'its page' : 'their pages'} (allergies, or ones you changed): check ${kept === 1 ? 'it' : 'them'}.`;
}

/** On a held document: what Claude had filed from it was taken back; what stayed. Null when nothing was filed. */
export function takenBackWords(t: { filingIds: string[]; kept: number } | undefined): string | null {
  if (!t || (!t.filingIds.length && !t.kept)) return null;
  const n = t.filingIds.length;
  const back = n ? `${n} item${n === 1 ? '' : 's'} Claude had filed from it (medications, visits) ${n === 1 ? 'was' : 'were'} taken back; It's mine files ${n === 1 ? 'it' : 'them'} again.` : '';
  return [back, t.kept ? keptWords(t.kept) : ''].filter(Boolean).join(' ');
}

/** "2 documents may be someone else's record." */
export function heldCountWords(n: number): string {
  return `${n} document${n === 1 ? '' : 's'} may be someone else's record.`;
}

/** Home: Patient details still need a name and a date of birth. */
export function missingWords(missing: ReadonlyArray<'name' | 'dob'>): string {
  const what = missing.includes('name') && missing.includes('dob') ? 'your name and date of birth' : missing.includes('name') ? 'your full name' : 'your date of birth';
  return `Add ${what} to Patient details, so each document can be checked for someone else's record.`;
}

/** Home: what a check of the whole case left as it was. */
export function unheldWords(n: number): string {
  return `${n} document${n === 1 ? '' : 's'} name${n === 1 ? 's' : ''} someone else. That is most of your documents, so nothing was held back: check Patient details first.`;
}

/** After Patient details change and every document is checked again. */
export function sweepWords(r: { checked: number; held: number; unheld: number; missing: ReadonlyArray<'name' | 'dob'> }): string {
  if (r.missing.length) return missingWords(r.missing);
  if (r.unheld) return `Checked ${r.checked} documents. ${unheldWords(r.unheld)}`;
  if (r.held) return `Checked ${r.checked} documents. ${heldCountWords(r.held)} Check before filing has them.`;
  return `Checked ${r.checked} documents. None names someone else.`;
}

/** "Robin, Rob" -> ["Robin", "Rob"]. */
export function splitNames(text: string): string[] {
  return [...new Set(text.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean))].slice(0, 20);
}

/** The record numbers a held document printed, offered after "It's mine". */
export function addNumberLabel(number: string): string {
  return `Add ${number} to my record numbers`;
}

/** The short line on a document's page, or null when there is nothing to say (never "not confirmed" on the patient's own notes). */
export function documentLine(c: PatientCheck | null, ownNotes = false): { tone: 'warn' | 'muted'; text: string } | null {
  const w = checkWords(c, { ownNotes });
  if (!w.tone || w.tone === 'confirmed' || w.tone === 'mine' || w.tone === 'held' || w.tone === 'not_mine') return null;
  return { tone: c?.unheld ? 'warn' : 'muted', text: w.text };
}

/** The upload's line for the Patient key fact ("How much was read"). */
export function patientFact(c: PatientCheck | null): string | null {
  const w = checkWords(c);
  return w.tone ? w.text : null;
}
