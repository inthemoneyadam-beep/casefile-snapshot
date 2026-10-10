/**
 * What the Epic parsers share: the context of the segment they read, names and credentials, citation spans, and the
 * body joiner. Parsers read the segment's lines in reading order (reflow.ts), never the stored stream. Bodies are
 * verbatim: lines joined across page breaks, furniture gone, a blank line where the printed paragraph had one. Pure.
 */
import type { CiteSpan, EncounterRef } from '../../../shared/schemas/segments';
import { personNameKey } from '../../../shared/schemas/segments';
import type { MessageVoice } from '../../../shared/enums';
import type { SegLine } from './lines';

export interface ParseContext {
  encounter: EncounterRef;
  segmentId: string | null;
  /** The patient's name as the running header prints it ("Last, First Middle"); null when unknown. */
  patientName: string | null;
  /** Pages carrying an image of 10% or more (media items). */
  imagePages?: ReadonlySet<number>;
}

/** Credentials printed after a name. */
export const RE_CREDENTIAL = /,\s*(MD|M\.D\.|DO|RN|BSN|MSN|LPN|MA|CMA|RMA|PA-C|PA|NP|FNP|APRN|DNP|PharmD|RPh|LMSW|LCSW|PT|DPT|OT|OTR\/L|CNA|CRNA|PhD)\.?\s*$/i;
const CLINICIAN_CREDENTIALS = new Set(['MD', 'M.D.', 'DO', 'NP', 'FNP', 'APRN', 'DNP', 'PA-C', 'PA', 'PHD', 'CRNA']);

/** System users and placeholders Epic prints in name fields: never a person (findings: never create people for these). */
const PLACEHOLDERS = [
  /^Lab, Background User$/i, /^Cadence, User$/i, /^Mychart, Generic$/i, /^Care, Preventive$/i, /^Default Tx Provider$/i,
  /^Historical Provider(?:, MD)?$/i, /^Unassigned Unassigned(?:, \w+)?$/i, /^Declined Primary Care Provider$/i, /^Background, /i,
  /^Interface, /i, /^Epic, /i,
];

export function isPlaceholderName(name: string | null | undefined): boolean {
  const t = (name ?? '').trim();
  return !t || PLACEHOLDERS.some((re) => re.test(t));
}

/** The credential printed after a name ("Robin Example, RN" -> "RN"), or null. */
export function credentialOf(name: string | null | undefined): string | null {
  const m = RE_CREDENTIAL.exec((name ?? '').trim());
  return m ? m[1] : null;
}

/** Whether two printed names are the same person by key ("Example, Pat Q" and "Pat Q Example"). */
export function samePerson(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = personNameKey(a);
  const kb = personNameKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  // "Example, Pat Quinn" vs "Pat Example": first and last words agree.
  const wa = ka.split(' ');
  const wb = kb.split(' ');
  return wa[0] === wb[0] && wa[wa.length - 1] === wb[wb.length - 1];
}

/** A staff member's voice from the credential (clinician for prescribers; staff otherwise; system for placeholders). */
export function staffVoice(name: string | null | undefined): MessageVoice {
  if (isPlaceholderName(name)) return 'system';
  const c = credentialOf(name);
  if (c && CLINICIAN_CREDENTIALS.has(c.toUpperCase())) return 'clinician';
  return 'staff';
}

/** Body lines as one text: across pages a plain line break; on one page a blank line where the print left a gap. */
export function joinBody(lines: readonly SegLine[]): string {
  let out = '';
  let prev: SegLine | null = null;
  for (const l of lines) {
    if (prev) {
      const height = Math.max(1, prev.y1 - prev.y);
      const paragraph = l.page === prev.page && l.x0 !== null && l.y - prev.y1 > height * 0.6;
      out += paragraph ? '\n\n' : '\n';
    }
    out += l.text;
    prev = l;
  }
  return out.trim();
}

/** Verbatim quotes, one per page the lines touch (at most 1,000 characters, cut at a line or word boundary). */
export function spansOf(lines: readonly SegLine[]): CiteSpan[] {
  const byPage = new Map<number, string[]>();
  for (const l of lines) {
    const t = l.text.trim();
    if (!t) continue;
    const list = byPage.get(l.page) ?? [];
    list.push(t);
    byPage.set(l.page, list);
  }
  const out: CiteSpan[] = [];
  for (const [page, texts] of [...byPage].sort((a, b) => a[0] - b[0])) {
    let quote = '';
    for (const t of texts) {
      const next = quote ? `${quote}\n${t}` : t;
      if (next.length > 1000) {
        if (!quote) quote = cutAtWord(t, 1000);
        break;
      }
      quote = next;
    }
    if (quote) out.push({ page, quote });
  }
  return out;
}

function cutAtWord(t: string, max: number): string {
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const i = cut.lastIndexOf(' ');
  return (i > max / 2 ? cut.slice(0, i) : cut).trim();
}

/** First and last page of some lines. */
export function pageRangeOf(lines: readonly SegLine[], fallback: number): [number, number] {
  if (!lines.length) return [fallback, fallback];
  return [Math.min(...lines.map((l) => l.page)), Math.max(...lines.map((l) => l.page))];
}

export const RE_PHONE = /\(?\b\d{3}\)?[ .-]?\d{3}-\d{4}\b/g;
