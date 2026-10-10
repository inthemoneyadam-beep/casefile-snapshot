/**
 * Words for what the clinician started or proposed under an answer (2026-10-08, lab check). Pure: no React and no
 * other client file (server-project tests import it, TS6307).
 *
 * A card says ONE state per item, from the item's status, never from its stored summary: the user saw "waiting for a yes"
 * and "started" on the same line because the summary written when the clinician proposed a reading kept its words
 * after he approved it.
 *
 *   reading request   waiting -> "waiting for your yes"; approved -> "started" (then what the reading found);
 *                     declined -> "not now"
 *   lab value         waiting -> "waiting for your yes"; approved -> "added"; declined -> "not now";
 *                     undone -> "taken back"
 *   computed value    waiting -> "waiting for your yes"; approved -> "computed"; declined -> "not now" (2026-10-09:
 *                     always a proposal, even when you asked)
 */

export type ProposalTone = 'warn' | 'ok' | 'ash' | 'info';

export interface FilingLike {
  status: string;
  summary: string;
  documentTitle: string | null;
  detail: Record<string, unknown>;
}

/** One state for one item, in the card's words. */
export function proposalState(kind: 'reading' | 'lab_value' | 'compute', status: string): { word: string; tone: ProposalTone } {
  switch (status) {
    case 'waiting':
    case 'proposed':
      return { word: 'waiting for your yes', tone: 'warn' };
    case 'approved':
      return kind === 'reading' ? { word: 'started', tone: 'ok' } : kind === 'compute' ? { word: 'computed', tone: 'ok' } : { word: 'added', tone: 'ok' };
    case 'declined':
      return { word: 'not now', tone: 'ash' };
    case 'undone':
      return { word: 'taken back', tone: 'ash' };
    default:
      return { word: status.replace(/_/g, ' '), tone: 'ash' };
  }
}

/** A summary without the state words an older server wrote into it ("…; waiting for a yes"). */
export function withoutStateWords(summary: string): string {
  return summary.replace(/[;,]?\s*waiting for (?:a|your) yes\.?\s*$/i, '').trim();
}

/** "p.240", "pp.12-14", "pp.12, 88 and 240". */
export function pageWords(ranges: Array<[number, number]>): string {
  const parts = ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`));
  const many = ranges.length > 1 || ranges.some(([a, b]) => a !== b);
  if (!parts.length) return '';
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `${many ? 'pp.' : 'p.'}${list}`;
}

function pagesOf(detail: Record<string, unknown>): Array<[number, number]> {
  const raw = detail.pages;
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is [number, number] => Array.isArray(r) && r.length === 2 && r.every((n) => typeof n === 'number' && Number.isFinite(n)));
}

function dollars(usd: number): string {
  return usd < 0.01 ? 'less than a cent' : `about $${usd.toFixed(2)}`;
}

/**
 * What a reading request asks for, in words, from its own fields: "Read p.240 of "Health summary" again (about
 * $0.04)". Falls back to the stored summary without its state words.
 */
export function readingRequestWords(f: FilingLike): string {
  const scope = f.detail.scope;
  const title = f.documentTitle ? `"${f.documentTitle}"` : 'the document';
  const est = typeof f.detail.estimateUsd === 'number' && Number.isFinite(f.detail.estimateUsd) ? ` (${dollars(f.detail.estimateUsd)})` : '';
  const pages = pagesOf(f.detail);
  switch (scope) {
    case 'pages':
      return pages.length ? `Read ${pageWords(pages)} of ${title} again${est}` : withoutStateWords(f.summary);
    case 'whole':
      return `Read every page of ${title} again${est}`;
    case 'failed':
      return `Read the parts of ${title} that could not be read${est}`;
    case 'missing':
    case undefined:
      return f.documentTitle ? `Read the rest of ${title}${est}` : withoutStateWords(f.summary);
    default:
      return withoutStateWords(f.summary);
  }
}

/** The card's heading for reading requests, from how many wait and how many started. */
export function readingCardHead(waiting: number, started: number, total: number): string {
  if (waiting) return `The clinician suggests reading ${waiting === 1 ? 'this' : `these ${waiting}`} again. Nothing is read until you say yes.`;
  if (started) return started === total ? `Reading again, as you said yes${started > 1 ? ` (${started})` : ''}` : `Reading ${started} of ${total} again`;
  return 'Reading suggested by the clinician';
}

/** The card's heading for lab values the clinician proposed or added. */
export function labValueCardHead(waiting: number, added: number): string {
  if (waiting) return `The clinician suggests adding ${waiting === 1 ? 'a lab value' : `${waiting} lab values`} from the page to your lab table. Nothing is added until you say yes.`;
  if (added) return `${added === 1 ? 'A lab value was' : `${added} lab values were`} added to your lab table from the page`;
  return 'Lab values suggested by the clinician';
}

/** A lab value added at the patient's request, in the card's words, from where it stands now. */
export function addedLabValueState(outcome: 'added' | 'cited_existing' | 'already_on_file', state: 'live' | 'taken_back' | 'replaced' | 'gone' | undefined): { word: string; tone: ProposalTone } {
  if (outcome !== 'added') return { word: 'already on file', tone: 'info' };
  if (state === 'taken_back' || state === 'gone') return { word: 'taken back', tone: 'ash' };
  if (state === 'replaced') return { word: 'replaced by a newer reading', tone: 'ash' };
  return { word: 'added', tone: 'ok' };
}

/**
 * The service's sentence about a value it added, for the card the user reads: its first sentence, without the words
 * meant for the clinician (", as the patient asked"). "Added Albumin Index 7.6 ratio (reference 0.0 - 9.0) from p.240,
 * collected 03/14/2019 10:12 AM".
 */
export function cardWords(words: string): string {
  const first = words.split(/\.\s+(?=[A-Z])/)[0] ?? words;
  return first.replace(/,?\s*as the patient asked\.?$/i, '').replace(/\.$/, '').trim();
}

/** The card's heading for values the clinician proposed to compute (always a proposal, 2026-10-09). */
export function computeCardHead(waiting: number, computed: number): string {
  if (waiting) return `The clinician suggests computing ${waiting === 1 ? 'a value' : `${waiting} values`} from values printed on your lab reports. Nothing is computed until you say yes.`;
  if (computed) return `${computed === 1 ? 'A value was' : `${computed} values were`} computed, as you said yes`;
  return 'Values the clinician suggested computing';
}
