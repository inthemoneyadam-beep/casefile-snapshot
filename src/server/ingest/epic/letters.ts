/**
 * Letters in an Epic "Letters" section (no AI):
 *
 *   <Letter title> by <author, may be empty or a placeholder> on <M/D/YYYY>     item indent
 *   Status: Sent | Sent by batch[ | Comments: ...]
 *   Letter body:
 *   <body lines>
 *
 * The author is kept as printed (empty, or a placeholder such as "Historical Provider, MD", is kept and never becomes a
 * person: the communications side decides). Pure.
 */
import { parsePrintedDateTime, type ParsedLetter } from '../../../shared/schemas/segments';
import { joinBody, pageRangeOf, spansOf, type ParseContext } from './common';
import type { SegLine } from './lines';
import { sectionHeading } from './sections';

export const RE_LETTER = /^(?<title>.+?) by (?<author>.*?) on (?<date>\d{1,2}\/\d{1,2}\/\d{4})$/;
const RE_STATUS = /^Status:\s*(?<status>.+?)$/;
const RE_COMMENTS = /^Comments:\s*(?<c>.*)$/;

export function parseLetters(lines: readonly SegLine[], ctx: ParseContext): ParsedLetter[] {
  type Draft = { header: SegLine; m: RegExpExecArray; status: string | null; comments: string | null; meta: SegLine[]; body: SegLine[]; inBody: boolean };
  const drafts: Draft[] = [];
  let cur: Draft | null = null;
  for (const line of lines) {
    const h = sectionHeading({ text: line.text, x0: line.x0, parts: line.parts.length });
    if (h) {
      if (h.name !== 'Letters') cur = null;
      continue;
    }
    const t = line.text.trim();
    const m = line.parts.length === 1 ? RE_LETTER.exec(t) : null;
    if (m && (line.x0 === null || line.x0 < 40)) {
      cur = { header: line, m, status: null, comments: null, meta: [], body: [], inBody: false };
      drafts.push(cur);
      continue;
    }
    if (!cur) continue;
    if (!cur.inBody) {
      let used = false;
      for (const p of line.parts) {
        const pt = p.t.trim();
        const s = RE_STATUS.exec(pt);
        const c = RE_COMMENTS.exec(pt);
        if (s && cur.status === null) {
          cur.status = s.groups!.status.trim();
          used = true;
        } else if (c) {
          cur.comments = c.groups!.c.trim() || null;
          used = true;
        } else if (/^Letter body:?$/i.test(pt)) {
          cur.inBody = true;
          used = true;
        }
      }
      if (used) {
        cur.meta.push(line);
        continue;
      }
      if (cur.status !== null) cur.inBody = true;
    }
    cur.body.push(line);
  }
  return drafts.map((d) => {
    const g = d.m.groups!;
    const dt = parsePrintedDateTime(g.date);
    const all = [d.header, ...d.meta, ...d.body];
    return {
      title: g.title.trim(),
      authorText: g.author.trim() || null,
      dateText: g.date,
      date: dt.date,
      status: d.status,
      batch: /by batch/i.test(d.status ?? ''),
      comments: d.comments,
      body: joinBody(d.body),
      pages: pageRangeOf(all, d.header.page),
      encounter: ctx.encounter,
      segmentId: ctx.segmentId,
      spans: spansOf(all),
    } satisfies ParsedLetter;
  });
}
