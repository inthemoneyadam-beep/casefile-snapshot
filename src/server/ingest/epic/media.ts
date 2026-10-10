/**
 * Media items in an Epic "Media (Encounter and Order)" section (no AI):
 *
 *   <Kind> - Scan | Document | Electronic signature on <M/D/YYYY  H:MM PM>      item indent
 *   Clinical date/time: <...> | Description: <...>
 *   Status: Received
 *   Scan (below)
 *   <the scanned image, on this page and maybe the next ones>
 *
 * "Patient Entered Attachment" items are the photos sent with a portal message (same or nearest minute); "After Hours
 * Nurse Line" is a call record readable only by OCR. The item's image pages are those of its range that carry an
 * image of 10% or more of the page. Pure.
 */
import { parsePrintedDateTime, type ParsedMediaItem } from '../../../shared/schemas/segments';
import { pageRangeOf, type ParseContext } from './common';
import type { SegLine } from './lines';
import { sectionHeading } from './sections';

export const RE_MEDIA = /^(?<kind>.+?) - (?<how>Scan|Document|Electronic signature) on (?<dt>\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s*[AP]M)(?<rest>\s+\(.*)?$/i;

export function parseMediaItems(lines: readonly SegLine[], ctx: ParseContext): ParsedMediaItem[] {
  type Draft = { header: SegLine; m: RegExpExecArray; lines: SegLine[]; description: string | null };
  const drafts: Draft[] = [];
  let cur: Draft | null = null;
  for (const line of lines) {
    const h = sectionHeading({ text: line.text, x0: line.x0, parts: line.parts.length });
    if (h && h.name !== 'Media (Encounter and Order)') {
      cur = null;
      continue;
    }
    const m = line.parts.length === 1 ? RE_MEDIA.exec(line.text.trim()) : null;
    if (m) {
      cur = { header: line, m, lines: [line], description: null };
      drafts.push(cur);
      continue;
    }
    if (!cur) continue;
    cur.lines.push(line);
    for (const p of line.parts) {
      const d = /^Description:\s*(.*)$/i.exec(p.t.trim());
      if (d && cur.description === null) cur.description = d[1].trim() || null;
    }
  }
  return drafts.map((d) => {
    const g = d.m.groups!;
    const dt = parsePrintedDateTime(g.dt);
    const pages = pageRangeOf(d.lines, d.header.page);
    const imagePages: number[] = [];
    for (let p = pages[0]; p <= pages[1]; p++) if (ctx.imagePages?.has(p)) imagePages.push(p);
    return {
      kindText: g.kind.trim(),
      how: g.how,
      atText: g.dt,
      date: dt.date,
      time: dt.time,
      description: d.description,
      pages,
      imagePages,
      encounter: ctx.encounter,
      segmentId: ctx.segmentId,
    } satisfies ParsedMediaItem;
  });
}
