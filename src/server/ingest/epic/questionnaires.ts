/**
 * Questionnaires the patient filed, in an Epic "Questionnaires" section (no AI):
 *
 *   <Questionnaire name>                                   item indent
 *                                <M/D/YYYY  H:MM AM EDT> -  (right column)
 *   Question                     Filed by Patient           (the answer column is learned from this row)
 *   <question>                   <answer>
 *
 * A question printed over two rows keeps both rows; a row with no answer and the question indent of a parent is kept
 * as a question with an empty answer. Each questionnaire pairs with a "Questionnaire Submission" message receipt at the
 * same minute (the communications side pairs them). Answers are verbatim. Pure.
 */
import { parsePrintedDateTime, type ParsedQuestionnaire } from '../../../shared/schemas/segments';
import { pageRangeOf, spansOf, type ParseContext } from './common';
import type { SegLine } from './lines';
import { ITEM_X, sectionHeading } from './sections';

const RE_TS = /^(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)(?:\s+[A-Z]{2,4})?\s*-?$/i;

export function parseQuestionnaires(lines: readonly SegLine[], ctx: ParseContext): ParsedQuestionnaire[] {
  type Draft = { name: SegLine; ts: SegLine | null; tsText: string; answerX: number | null; rows: Array<{ q: string; a: string; x: number }>; all: SegLine[] };
  const out: Draft[] = [];
  let cur: Draft | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = sectionHeading({ text: line.text, x0: line.x0, parts: line.parts.length });
    if (h) {
      if (h.name !== 'Questionnaires') cur = null;
      continue;
    }
    // The stamp may sit on the next page, past a "Questionnaires (continued)" heading.
    let j = i + 1;
    while (j < lines.length && sectionHeading({ text: lines[j].text, x0: lines[j].x0, parts: lines[j].parts.length })) j++;
    const next = lines[j];
    const tsPart = next?.parts.find((p) => RE_TS.test(p.t.trim()));
    const isName = line.parts.length === 1 && (line.x0 === null || (line.x0 >= ITEM_X[0] && line.x0 <= ITEM_X[1])) && tsPart && next.parts.length === 1;
    if (isName) {
      cur = { name: line, ts: next, tsText: tsPart!.t.trim().replace(/\s*-$/, ''), answerX: null, rows: [], all: [line, next] };
      out.push(cur);
      i = j;
      continue;
    }
    if (!cur) continue;
    const filed = line.parts.find((p) => /^Filed by Patient$/i.test(p.t.trim()));
    if (filed && line.parts.some((p) => /^Question$/i.test(p.t.trim()))) {
      cur.answerX = filed.x0;
      cur.all.push(line);
      continue;
    }
    if (cur.answerX === null) continue;
    const ax = cur.answerX;
    const answer = line.parts.filter((p) => p.x0 >= ax - 6).map((p) => p.t.trim()).join(' ');
    const question = line.parts.filter((p) => p.x0 < ax - 6).map((p) => p.t.trim()).join(' ');
    const x = line.x0 ?? 0;
    const prev = cur.rows[cur.rows.length - 1];
    if (!answer && prev && prev.a && x >= prev.x && question) {
      // The second row of a question whose answer sits on its first row.
      prev.q = `${prev.q} ${question}`;
    } else if (question || answer) {
      cur.rows.push({ q: question, a: answer, x });
    }
    cur.all.push(line);
  }
  return out.map((d) => {
    const dt = parsePrintedDateTime(d.tsText);
    return {
      name: d.name.text.trim(),
      submittedText: d.tsText,
      date: dt.date,
      time: dt.time,
      answers: d.rows.map((r) => ({ question: r.q, answer: r.a })),
      pages: pageRangeOf(d.all, d.name.page),
      encounter: ctx.encounter,
      segmentId: ctx.segmentId,
      spans: spansOf(d.all),
    } satisfies ParsedQuestionnaire;
  });
}
