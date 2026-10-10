/**
 * Notes in an Epic "All Encounter Notes" section (no AI), read in reading order: in the stored stream 127 of 135 note
 * headers come AFTER their own bodies, so a stream reader gives a note to the wrong author. Layout:
 *
 *   <Note type> by <Name[, CRED]> at <M/D/YYYY> <HHMM>          item indent, 24-hour time without a colon
 *   <body lines>; SBAR notes print S / B / A / R at the margin with the text beside them
 *   Electronically signed by <Name[, CRED]> at <M/D/YYYY>  <H:MM AM>
 *
 * Every note type is returned (`isTelephone` for "Telephone Encounter"); the communications side keeps the telephone
 * notes. Direction is read only when the note says it (the patient called; the nurse called the patient; a call to or
 * from someone else is third_party, e.g. an infusion pharmacy); otherwise null. Phone numbers and the other parties
 * named are kept as printed, for suggestions only. Pure.
 */
import { parsePrintedDateTime, toTime24, type ParsedNote } from '../../../shared/schemas/segments';
import type { CommDirection } from '../../../shared/enums';
import { credentialOf, joinBody, pageRangeOf, RE_PHONE, samePerson, spansOf, staffVoice, type ParseContext } from './common';
import type { SegLine } from './lines';
import { sectionHeading } from './sections';

export const RE_NOTE = /^(?<type>[A-Z][A-Za-z&/ -]+?) by (?<author>.+?) at (?<date>\d{1,2}\/\d{1,2}\/\d{4}) (?<hhmm>\d{4})$/;
export const RE_SIGNED = /^Electronically signed by (?<signer>.+?) at (?<date>\d{1,2}\/\d{1,2}\/\d{4})\s+(?<time>\d{1,2}:\d{2}\s*[AP]M)$/i;

const RE_THIRD = /\b(?:[Ss]poke (?:with|to)|[Cc]alled|[Cc]all(?:ed)? from|[Rr]eceived (?:a )?call from|[Ff]axed (?:to|it to)|[Cc]alled back)\s+((?:[A-Z][\w.'&/-]*)(?:\s+(?:[A-Z][\w.'&/-]*|of|from|at|the|for|-))*)/g;
const NOT_A_PARTY = /^(?:pt|patient|him|her|them|back|the patient|Dr\.?)$/i;

function partiesIn(body: string, patientName: string | null): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(RE_THIRD)) {
    let t = m[1].replace(/\s+(?:of|from|at|the|for|-)$/i, '').replace(/\s+(?:of|from|at|the|for|-)$/i, '').trim();
    t = t.replace(/[.,;:]+$/, '');
    if (!t || NOT_A_PARTY.test(t)) continue;
    if (patientName && samePerson(t, patientName)) continue;
    if (!out.includes(t)) out.push(t);
    if (out.length >= 10) break;
  }
  return out;
}

function directionOf(body: string, parties: readonly string[]): CommDirection | null {
  if (/\b(?:pt|patient)\b[^.\n]{0,40}\b(?:called|calling|left (?:a )?(?:vm|voice ?mail|message))/i.test(body)) return 'inbound';
  if (/\b(?:called|spoke (?:with|to)|left (?:a )?(?:vm|voice ?mail|message) for|returned (?:the )?call to|LVM for)\b[^.\n]{0,20}\b(?:pt|patient)\b/i.test(body)) return 'outbound';
  if (parties.length) return 'third_party';
  return null;
}

function isSbarLetter(line: SegLine): boolean {
  const first = line.parts[0]?.t.trim();
  return /^[SBAR]$/.test(first ?? '') && (line.x0 === null || line.x0 < 30) && line.parts.length >= 1;
}

/** Every note of a notes segment, in printed order. */
export function parseNotes(lines: readonly SegLine[], ctx: ParseContext): ParsedNote[] {
  type Draft = { header: SegLine; m: RegExpExecArray; body: SegLine[]; sig: SegLine | null; sigM: RegExpExecArray | null };
  const drafts: Draft[] = [];
  let cur: Draft | null = null;
  for (const line of lines) {
    const t = line.text.trim();
    const h = sectionHeading({ text: line.text, x0: line.x0, parts: line.parts.length });
    if (h && h.name === 'All Encounter Notes') continue;
    if (h && !(cur && !cur.sig)) {
      // Another section: the notes end here. (A heading inside a note not signed yet, "Imaging" in a progress note, is
      // the note's own and stays in its body.)
      cur = null;
      continue;
    }
    const m = line.parts.length === 1 ? RE_NOTE.exec(t) : null;
    if (m && (line.x0 === null || line.x0 >= 28)) {
      cur = { header: line, m, body: [], sig: null, sigM: null };
      drafts.push(cur);
      continue;
    }
    if (!cur) continue;
    const s = RE_SIGNED.exec(t);
    if (s && !cur.sig) {
      cur.sig = line;
      cur.sigM = s;
      continue;
    }
    cur.body.push(line);
  }
  return drafts.map((d) => {
    const g = d.m.groups!;
    const body = joinBody(d.body);
    const parties = partiesIn(body, ctx.patientName);
    const dt = parsePrintedDateTime(`${g.date} ${g.hhmm}`);
    const all = [d.header, ...d.body, ...(d.sig ? [d.sig] : [])];
    const sbarLetters = new Set(d.body.filter(isSbarLetter).map((l) => l.parts[0].t.trim()));
    return {
      noteType: g.type.trim(),
      isTelephone: /^Telephone Encounter$/i.test(g.type.trim()),
      authorText: g.author.trim(),
      authorRole: credentialOf(g.author),
      voice: staffVoice(g.author),
      direction: directionOf(body, parties),
      dateText: `${g.date} ${g.hhmm}`,
      date: dt.date,
      time: toTime24(g.hhmm),
      body,
      signedBy: d.sigM?.groups?.signer.trim() ?? null,
      signedText: d.sig?.text.trim() ?? null,
      sbar: sbarLetters.size >= 3,
      phones: [...new Set(body.match(RE_PHONE) ?? [])].slice(0, 20),
      thirdParties: parties,
      pages: pageRangeOf(all, d.header.page),
      headerPage: d.header.page,
      encounter: ctx.encounter,
      segmentId: ctx.segmentId,
      spans: spansOf(all),
    } satisfies ParsedNote;
  });
}
