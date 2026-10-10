/**
 * MyChart messages in an Epic "Messages" section (no AI). Layout, in reading order:
 *
 *   Messages[ (continued)]                         section heading at the margin
 *   <Subject>                                      item indent (x ≈ 33)
 *   From | To | Sent | Sent and Delivered          label row; the columns are learned from it
 *   <from> | <to, may wrap to the next row> | <M/D/YYYY  H:MM AM>
 *   [Last Read in MyChart / <M/D/YYYY  H:MM PM> by <Last, First>]
 *   <body lines, across page breaks>
 *
 * Blocks print newest first; `printedOrder` keeps that order (0 = printed first) for citations, and the communications
 * side stores them chronologically. "Sent" is the patient's own message; "Sent and Delivered" a staff member's, read
 * receipt included. A pool recipient "P <pool> (supporting <clinician>)" is the recipient, the clinician the intended
 * reader. A subject on the last line of a page, a label row at a page's foot, a body across a break and a "(continued)"
 * heading in between are all handled (the lines run across pages with the furniture removed). The MyChart appointment
 * messages ("Appointment scheduled from MyChart", "Appointment canceled") keep the patient's comments verbatim.
 * Another system's "Patient Entered Data" (no real file seen yet) is read as one patient message marked unverified. Pure.
 */
import { parsePrintedDateTime, type ParsedMessage } from '../../../shared/schemas/segments';
import type { CommDirection, MessageVoice } from '../../../shared/enums';
import { credentialOf, isPlaceholderName, joinBody, pageRangeOf, samePerson, spansOf, staffVoice, type ParseContext } from './common';
import type { SegLine } from './lines';
import { ITEM_X, sectionHeading } from './sections';

const RE_SENT_LABEL = /^Sent(?: and Delivered| by batch)?$/;
const RE_DT = /^\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s*[AP]M(?:\s+[A-Z]{2,4})?$/i;
const RE_READ = /^(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s*[AP]M) by (.+)$/i;
export const RE_POOL = /^P (.+?)(?: \(supporting (.+)\))?$/;
const READ_LABEL = 'Last Read in MyChart';

/** Columns of a message header, learned from its label row. */
interface Anchors {
  from: number;
  to: number;
  sent: number;
  label: string;
}

function labelRow(line: SegLine): Anchors | null {
  if (line.x0 === null) return null;
  const find = (re: RegExp) => line.parts.find((p) => re.test(p.t.trim()));
  const from = find(/^From$/);
  const to = find(/^To$/);
  const sent = find(RE_SENT_LABEL);
  if (!from || !to || !sent) return null;
  return { from: from.x0, to: to.x0, sent: sent.x0, label: sent.t.trim() };
}

function isHeading(line: SegLine): boolean {
  return sectionHeading({ text: line.text, x0: line.x0, parts: line.parts.length }) !== null;
}

function isItemLine(line: SegLine): boolean {
  return line.x0 === null || (line.x0 >= ITEM_X[0] && line.x0 <= ITEM_X[1]);
}

interface Draft {
  subjectLine: SegLine | null;
  anchors: Anchors;
  headerLines: SegLine[];
  from: string;
  to: string;
  sentText: string;
  readAt: string | null;
  readBy: string | null;
  readPage: number | null;
  body: SegLine[];
  blockIndex: number;
  printedOrder: number;
  headerPage: number;
  lastValuesY: number;
  lastValuesPage: number;
}

const APPOINTMENT_SUBJECT = /^Appointment (?:scheduled from MyChart|canceled|cancelled|request(?:ed)?|rescheduled)/i;

/** Parses the MyChart appointment template out of a message body ("Patient comments:" kept verbatim). */
export function parseAppointmentBody(body: string): ParsedMessage['appointment'] {
  const lines = body.split('\n').map((l) => l.trim());
  let visitType: string | null = null;
  let whenText: string | null = null;
  let minutes: number | null = null;
  let provider: string | null = null;
  let department: string | null = null;
  let comments: string | null = null;
  const ci = lines.findIndex((l) => /^Patient comments:/i.test(l));
  if (ci >= 0) {
    const first = lines[ci].replace(/^Patient comments:\s*/i, '');
    const rest = lines.slice(ci + 1);
    comments = [first, ...rest].join('\n').replace(/^\n+|\n+$/g, '').trim() || null;
  }
  const head = (ci >= 0 ? lines.slice(0, ci) : lines).filter(Boolean);
  for (let i = 0; i < head.length; i++) {
    const l = head[i];
    const vt = /^Visit type:\s*(.+?)(?:\s*\(\d+\))?$/i.exec(l);
    if (vt) {
      visitType = vt[1].trim();
      continue;
    }
    const w = /^(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s*[AP]M)\s*\((\d+)\s*minutes?\)\s*with\s+(.+?)(?:\s+in\s+(.+))?$/i.exec(l);
    if (w) {
      whenText = w[1];
      minutes = Number(w[2]);
      provider = w[3].trim();
      // The department can wrap onto the next lines until the comments.
      const more = head.slice(i + 1).filter((x) => !/^(?:Appointment for|Visit type):/i.test(x));
      department = [w[4]?.trim(), ...more].filter(Boolean).join(' ') || null;
      break;
    }
  }
  return { visitType, whenText, minutes, provider, department, comments };
}

function voiceAndDirection(fromText: string, toText: string, label: string, patientName: string | null): { voice: MessageVoice; direction: CommDirection } {
  const fromPatient = patientName ? samePerson(fromText, patientName) : false;
  const toPatient = patientName ? samePerson(toText, patientName) : false;
  let voice: MessageVoice;
  if (fromPatient) voice = 'patient';
  else if (isPlaceholderName(fromText)) voice = 'system';
  else if (/^Sent and Delivered$/i.test(label) || credentialOf(fromText)) voice = staffVoice(fromText);
  else if (/^Sent$/i.test(label)) voice = patientName ? 'unknown' : 'patient';
  else voice = 'unknown';
  let direction: CommDirection;
  if (voice === 'patient') direction = 'outbound';
  else if (toPatient || voice === 'system' || /^Sent and Delivered$/i.test(label)) direction = 'inbound';
  else if (voice === 'clinician' || voice === 'staff') direction = 'internal';
  else direction = 'bidirectional';
  return { voice, direction };
}

/** Every message of a Messages segment, in printed order. */
export function parseMessages(lines: readonly SegLine[], ctx: ParseContext): ParsedMessage[] {
  const drafts: Draft[] = [];
  let cur: Draft | null = null;
  let phase: 'values' | 'read' | 'body' = 'body';
  let blockIndex = -1;
  let order = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = sectionHeading({ text: line.text, x0: line.x0, parts: line.parts.length });
    if (h) {
      if (h.name === 'Messages') {
        if (!h.continued || blockIndex < 0) {
          blockIndex++;
          order = 0;
          if (!h.continued) cur = null;
        }
        continue;
      }
      cur = null;
      continue;
    }
    const anchors = labelRow(line);
    if (anchors) {
      // The subject is the line before the label row (it may sit on the previous page, past a "(continued)" heading).
      let k = i - 1;
      while (k >= 0 && isHeading(lines[k])) k--;
      const cand = k >= 0 ? lines[k] : null;
      let subjectLine: SegLine | null = null;
      if (cand && isItemLine(cand) && !labelRow(cand)) {
        subjectLine = cand;
        if (cur && cur.body[cur.body.length - 1] === cand) cur.body.pop();
      }
      if (blockIndex < 0) blockIndex = 0;
      cur = {
        subjectLine,
        anchors,
        headerLines: subjectLine ? [subjectLine, line] : [line],
        from: '',
        to: '',
        sentText: '',
        readAt: null,
        readBy: null,
        readPage: null,
        body: [],
        blockIndex,
        printedOrder: order++,
        headerPage: line.page,
        lastValuesY: line.y,
        lastValuesPage: line.page,
      };
      drafts.push(cur);
      phase = 'values';
      continue;
    }
    if (!cur) continue;
    if (phase === 'values') {
      if (line.text.trim() === READ_LABEL) {
        cur.headerLines.push(line);
        phase = 'read';
        continue;
      }
      const a = cur.anchors;
      const near = (x: number, at: number, tol: number) => Math.abs(x - at) <= tol;
      const firstValues = !cur.from && !cur.to && !cur.sentText;
      const wrapRow = !firstValues && line.page === cur.lastValuesPage && line.y - cur.lastValuesY <= 12;
      let used = false;
      if (firstValues || wrapRow) {
        for (const p of line.parts) {
          const t = p.t.trim();
          if (near(p.x0, a.sent, 6) && RE_DT.test(t) && !cur.sentText) {
            cur.sentText = t;
            used = true;
          } else if (near(p.x0, a.to, 6)) {
            cur.to = cur.to ? `${cur.to} ${t}` : t;
            used = true;
          } else if (near(p.x0, a.from, 3)) {
            cur.from = cur.from ? `${cur.from} ${t}` : t;
            used = true;
          }
        }
      }
      if (used) {
        cur.headerLines.push(line);
        cur.lastValuesY = line.y;
        cur.lastValuesPage = line.page;
        continue;
      }
      phase = 'body';
    }
    if (phase === 'read') {
      const m = RE_READ.exec(line.text.trim());
      if (m) {
        cur.readAt = m[1];
        cur.readBy = m[2].trim();
        cur.readPage = line.page;
        cur.headerLines.push(line);
        phase = 'body';
        continue;
      }
      phase = 'body';
    }
    cur.body.push(line);
  }

  return drafts.map((d) => {
    const subject = d.subjectLine?.text.trim() ?? '';
    const body = joinBody(d.body);
    const sent = parsePrintedDateTime(d.sentText);
    const { voice, direction } = voiceAndDirection(d.from, d.to, d.anchors.label, ctx.patientName);
    const pool = RE_POOL.exec(d.to.trim());
    const kind = APPOINTMENT_SUBJECT.test(subject) ? 'appointment_request' : /^Questionnaire Submission$/i.test(subject) ? 'questionnaire' : 'portal_message';
    const read = d.readAt ? parsePrintedDateTime(d.readAt) : null;
    const all = [...d.headerLines, ...d.body];
    const pages = pageRangeOf(all, d.headerPage);
    return {
      kind,
      subject,
      fromText: d.from.trim(),
      toText: d.to.trim(),
      sentLabel: d.anchors.label,
      sentText: d.sentText,
      sentDate: sent.date,
      sentTime: sent.time,
      voice,
      direction,
      authorRole: credentialOf(d.from),
      intendedFor: pool?.[2]?.trim() ?? null,
      readReceipt: d.readAt && d.readBy ? { atText: d.readAt, date: read?.date ?? null, time: read?.time ?? null, byText: d.readBy, page: d.readPage ?? d.headerPage } : null,
      body,
      pages,
      headerPage: d.headerPage,
      printedOrder: d.printedOrder,
      blockIndex: d.blockIndex,
      encounter: ctx.encounter,
      segmentId: ctx.segmentId,
      appointment: kind === 'appointment_request' ? parseAppointmentBody(body) : null,
      spans: spansOf(all),
      unverified: false,
    } satisfies ParsedMessage;
  });
}

const RE_ANY_DT = /\b(\d{1,2}\/\d{1,2}\/\d{4})(?:\s+(\d{1,2}:\d{2}\s*[AP]M|\d{4}))?/i;

/**
 * Another system's "Patient Entered Data" (layout not yet seen in a real file): the section's lines as one message in the
 * patient's voice, marked unverified so the screens say so.
 */
export function parsePatientEntered(lines: readonly SegLine[], ctx: ParseContext): ParsedMessage[] {
  const content = lines.filter((l) => !isHeading(l));
  if (!content.length) return [];
  const heading = lines.find((l) => isHeading(l));
  const dtLine = content.find((l) => RE_ANY_DT.test(l.text));
  const m = dtLine ? RE_ANY_DT.exec(dtLine.text) : null;
  const sentText = m ? `${m[1]}${m[2] ? ` ${m[2]}` : ''}` : '';
  const sent = parsePrintedDateTime(sentText);
  const pages = pageRangeOf(content, content[0].page);
  return [{
    kind: 'patient_entered_data',
    subject: heading?.text.replace(/ \(continued\)$/, '') ?? 'Patient Entered Data',
    fromText: ctx.patientName ?? '',
    toText: '',
    sentLabel: 'Patient Entered Data',
    sentText,
    sentDate: sent.date,
    sentTime: sent.time,
    voice: 'patient',
    direction: 'outbound',
    authorRole: null,
    intendedFor: null,
    readReceipt: null,
    body: joinBody(content),
    pages,
    headerPage: pages[0],
    printedOrder: 0,
    blockIndex: 0,
    encounter: ctx.encounter,
    segmentId: ctx.segmentId,
    appointment: null,
    spans: spansOf(content),
    unverified: true,
  }];
}
