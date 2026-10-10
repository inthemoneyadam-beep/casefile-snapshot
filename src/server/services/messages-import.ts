/**
 * Messages read out of records into Calls & Messages (2026-10-07; WP-C, findings D.1.6, C.4, B#13-28).
 *
 * After a document is cut into segments, the Epic parsers (WP-A, `parseSegmentContent`, no AI) read its MyChart
 * messages, telephone-encounter notes, letters, questionnaires and attachments. This module turns them into
 * `communications` rows, deterministically:
 * - one row per message, stored (and listed) chronologically; the printed order (Epic prints newest first) is kept in
 *   `details.printedOrder` for citations;
 * - the body verbatim (`body`; `summary` stays empty: it is the user's), the time of day in `occurred_time`;
 * - direction from the label ("Sent" is the patient, "Sent and Delivered" the care team; a staff call to a pharmacy
 *   or an infusion centre is `third_party`), the author and role as printed, the recipient pool and the clinician it
 *   supports, read receipts, voice and tier (`messageTier`: a patient's body is `patient` even inside a clinical record;
 *   a clinician's reply keeps the record's tier);
 * - a thread key (`threadKeyOf`: the printed Encounter # and subject, else the document, encounter start page, type,
 *   department and subject); a telephone note joins its encounter's message thread when that encounter has one;
 * - an external key (`externalKeyOf`) so a re-read never makes a second row: rows read out of this record are updated,
 *   except the fields the user edited (`details.userFields`); a row logged by hand, filed or imported keeps everything
 *   it has and only gains what it lacked (body, thread, time) plus a link to this record's copy;
 * - a separately filed copy (the patient's own "Message to Dr. ..." record, within 10 minutes, the same subject, the
 *   same body) is the same message: never a second row (the filed row gains the record's copy, or the new row the
 *   filed copy);
 * - one citation per printed span (`citations.communication_id`), verified against the stored text and the
 *   reading-order text; a quote that cannot be found is kept and flagged, never dropped;
 * - participants: the author (`from`) and the recipient (`to`): pools become clinics, names printed with a role are
 *   found or added, placeholders are nobody, any other new name is only a suggestion; the patient is implied.
 * Each segment read gets `detail.parse` (counts and the parser version) and its `messages_count`. Nothing is deleted;
 * the source text is never changed.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { newId, nowIso, parseJson } from '../util/ids';
import { getSetting, setSetting } from './settings';
import type { SettingKey } from '../../shared/constants';
import { listSegments, pageTextFormsLookup, parseSegmentContent, readSegmentationMeta, updateSegment, type SegmentRow } from './segments';
import { insertVerifiedCommunicationCitation, reindexCommunication } from './communications';
import { credentialOf, isPlaceholderName, parsePool, peopleByNameKey, resolvePrintedName, type PeopleByKey } from './people';
import {
  COPY_TIME_TOLERANCE_MIN, SEGMENTER_VERSION, bodyHashOf, externalKeyOf, minutesBetween, normalizeForHash, parseCommunicationDetails, parseSegmentDetail,
  personNameKey, routeOf, subjectKey, threadKeyOf, isSettledSegmentStatus,
  type CiteSpan, type CommCopyLink, type CommunicationDetails, type EncounterRef, type ParsedMessage, type ParsedSegmentContent, type ReadReceipt,
} from '../../shared/schemas/segments';
import type { CommDirection, CommMessageKind, MessageVoice, SegmentKind } from '../../shared/enums';
import { messageTier } from '../../shared/trust';
import { isMessagingActText } from '../../shared/messaging-acts';
import { hasUserWork, linkedFactIds } from './fact-holds';
import { INBOX_ACTIVE_STATUSES } from '../../shared/schemas/inbox';
import { liveDocumentRow } from './document-rows';

/** Segment kinds the parsers read (messages and the like by route; notes for telephone encounters; media for attachments). */
export const PARSED_KINDS: ReadonlySet<SegmentKind> = new Set<SegmentKind>(['messages', 'telephone', 'letter', 'questionnaire', 'appointment_request', 'patient_entered', 'note', 'media']);

type CommRow = typeof schema.communications.$inferSelect;

/** What an import did (counts and ids; no record text except names of people made or suggested, as the report needs). */
export interface ImportResult {
  documentId: string;
  skipped?: string;
  segmentsParsed: number;
  messages: number;
  notes: number;
  letters: number;
  questionnaires: number;
  media: number;
  created: number;
  updated: number;
  unchanged: number;
  byKind: Record<string, number>;
  threadsCreated: number;
  threadsTotal: number;
  threadKeys: string[];
  mergedWithFiled: Array<{ threadKey: string; communicationId: string; filedDocumentId: string; pages: [number, number] | null }>;
  peopleCreated: Array<{ personId: string; name: string; kind: string }>;
  peopleSuggested: Array<{ name: string; kind: string; reason: string; matchPersonId: string | null; matchName: string | null }>;
  /** Communication ids made or updated in this import. */
  communicationIds: string[];
  citations: { inserted: number; verified: number };
  /** Messages not read in again because the user deleted their row. */
  removedByYou?: number;
}

function emptyResult(documentId: string): ImportResult {
  return {
    documentId, segmentsParsed: 0, messages: 0, notes: 0, letters: 0, questionnaires: 0, media: 0, created: 0, updated: 0, unchanged: 0, byKind: {},
    threadsCreated: 0, threadsTotal: 0, threadKeys: [], mergedWithFiled: [], peopleCreated: [], peopleSuggested: [], communicationIds: [], citations: { inserted: 0, verified: 0 },
  };
}

/** Two JSON texts with the same content, whatever the order of their keys. */
export function sameJson(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return stableStringify(JSON.parse(a)) === stableStringify(JSON.parse(b));
  } catch {
    return false;
  }
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + stableStringify((v as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}

/** One communication about to be written. */
interface Draft {
  kind: CommMessageKind;
  segment: SegmentRow;
  order: number;
  encounter: EncounterRef;
  subject: string;
  threadSubject: string;
  body: string;
  channel: 'portal' | 'call' | 'letter' | 'email';
  direction: CommDirection;
  occurredAt: string | null;
  occurredAtPrecision: string;
  occurredAtText: string | null;
  occurredTime: string | null;
  authorText: string | null;
  authorRole: string | null;
  voice: MessageVoice;
  recipientText: string | null;
  intendedFor: string | null;
  sentLabel: string | null;
  sentText: string | null;
  readReceipts: ReadReceipt[];
  pages: [number, number];
  headerPage: number;
  printedOrder: number | null;
  spans: CiteSpan[];
  unverified: boolean;
  extra: Record<string, unknown>;
  participants: Array<{ text: string; role: 'from' | 'to'; kind: 'clinician' | 'clinic' }>;
  /** The parsed message (portal messages only), for the filed-copy match. */
  parsed: ParsedMessage | null;
  attachments: Array<{ documentId: string; page: number; atText: string | null; kindText: string | null }>;
  threadKey: string;
  externalKey: string;
}

function inInbox(doc: typeof schema.documents.$inferSelect): boolean {
  const inbox = parseJson<Record<string, unknown>>(doc.metadataJson, {}).inbox as { status?: string } | undefined;
  return Boolean(inbox && typeof inbox.status === 'string' && (INBOX_ACTIVE_STATUSES as readonly string[]).includes(inbox.status));
}

/** The segments a document's messages are read from (live, of a kind the parsers read). */
export function parsedSegmentsOf(documentId: string): SegmentRow[] {
  return listSegments(documentId).filter((s) => PARSED_KINDS.has(s.kind as SegmentKind) && s.status !== 'skipped');
}

/** True when some segment that the parsers read has no current parse (never read, or read by an older parser). */
export function needsImport(documentId: string): boolean {
  return parsedSegmentsOf(documentId).some((s) => (parseSegmentDetail(s.detailJson).parse?.version ?? 0) < SEGMENTER_VERSION);
}

function trimTo(s: string | null | undefined, n: number): string | null {
  const t = (s ?? '').trim();
  return t ? t.slice(0, n) : null;
}

function pageRangeOf(spans: readonly CiteSpan[], fallback: [number, number]): [number, number] {
  if (!spans.length) return fallback;
  return [Math.min(...spans.map((s) => s.page)), Math.max(...spans.map((s) => s.page))];
}

/** A care-team voice from a printed name: a credential means clinician or staff; nothing printed means system. */
function voiceOfAuthor(author: string | null): MessageVoice {
  if (!author || isPlaceholderName(author)) return 'system';
  const cred = credentialOf(author);
  if (!cred) return 'staff';
  return /^(MD|M\.D\.|DO|NP|FNP|APRN|DNP|PA|PA-C|PharmD|PhD|CRNA)$/i.test(cred) ? 'clinician' : 'staff';
}

const ATTACHMENT_KIND = /patient entered attachment|patient-entered attachment|attachment/i;

/** Drafts of one document's messages, notes, letters and questionnaires, in printed order, plus counts. */
function draftsOf(documentId: string, segs: readonly SegmentRow[], patientKey: string): { drafts: Draft[]; contents: Map<string, ParsedSegmentContent> } {
  const drafts: Draft[] = [];
  const contents = new Map<string, ParsedSegmentContent>();
  const questionnaires: Array<{ seg: SegmentRow; q: ParsedSegmentContent['questionnaires'][number] }> = [];
  const media: Array<{ seg: SegmentRow; m: ParsedSegmentContent['media'][number] }> = [];
  let order = 0;
  const isPatient = (name: string | null | undefined) => Boolean(name && patientKey && personNameKey(name) === patientKey);

  for (const seg of segs) {
    let content: ParsedSegmentContent;
    try {
      content = parseSegmentContent(documentId, seg.id);
    } catch (err) {
      console.warn(`[messages] could not read part ${seg.id}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    contents.set(seg.id, content);
    const msgs = [...content.messages].sort((a, b) => a.blockIndex - b.blockIndex || a.printedOrder - b.printedOrder);
    for (const m of msgs) {
      const participants: Draft['participants'] = [];
      if (m.voice !== 'patient' && !isPatient(m.fromText)) {
        const pool = parsePool(m.fromText);
        if (pool) participants.push({ text: pool.pool, role: 'from', kind: 'clinic' });
        else participants.push({ text: m.fromText, role: 'from', kind: 'clinician' });
      }
      if (m.toText && !isPatient(m.toText)) {
        const pool = parsePool(m.toText);
        if (pool) participants.push({ text: pool.pool, role: 'to', kind: 'clinic' });
        else participants.push({ text: m.toText, role: 'to', kind: 'clinician' });
      }
      if (m.intendedFor && !isPatient(m.intendedFor)) participants.push({ text: m.intendedFor, role: 'to', kind: 'clinician' });
      drafts.push({
        kind: m.kind,
        segment: seg,
        order: order++,
        encounter: m.encounter,
        subject: trimTo(m.subject, 500) ?? 'Message',
        threadSubject: m.subject || 'message',
        body: m.body,
        channel: m.kind === 'email' ? 'email' : 'portal',
        direction: m.direction,
        occurredAt: m.sentDate,
        occurredAtPrecision: m.sentDate ? 'day' : 'unknown',
        occurredAtText: trimTo(m.sentText, 200),
        occurredTime: m.sentTime,
        authorText: m.fromText || null,
        authorRole: m.authorRole,
        voice: m.voice,
        recipientText: m.toText || null,
        intendedFor: m.intendedFor,
        sentLabel: m.sentLabel || null,
        sentText: m.sentText || null,
        readReceipts: m.readReceipt ? [m.readReceipt] : [],
        pages: m.pages,
        headerPage: m.headerPage,
        printedOrder: m.printedOrder,
        spans: m.spans,
        unverified: m.unverified,
        extra: m.appointment ? { appointment: m.appointment } : {},
        participants,
        parsed: m,
        attachments: [],
        threadKey: '',
        externalKey: '',
      });
    }
    for (const n of content.notes) {
      if (!n.isTelephone) continue;
      const participants: Draft['participants'] = [];
      if (n.authorText && !isPatient(n.authorText)) participants.push({ text: n.authorText, role: 'from', kind: 'clinician' });
      drafts.push({
        kind: 'telephone_encounter',
        segment: seg,
        order: order++,
        encounter: n.encounter,
        subject: trimTo(`${n.noteType} by ${n.authorText}`, 500) ?? 'Telephone encounter',
        threadSubject: 'telephone encounter',
        body: n.body,
        channel: 'call',
        direction: n.direction ?? 'bidirectional',
        occurredAt: n.date,
        occurredAtPrecision: n.date ? 'day' : 'unknown',
        occurredAtText: trimTo(n.dateText, 200),
        occurredTime: n.time,
        authorText: n.authorText || null,
        authorRole: n.authorRole,
        voice: n.voice,
        recipientText: null,
        intendedFor: null,
        sentLabel: n.noteType,
        sentText: n.dateText,
        readReceipts: [],
        pages: n.pages,
        headerPage: n.headerPage,
        printedOrder: null,
        spans: n.spans,
        unverified: false,
        extra: { sbar: n.sbar, phones: n.phones, thirdParties: n.thirdParties, signedText: n.signedText },
        participants,
        parsed: null,
        attachments: [],
        threadKey: '',
        externalKey: '',
      });
    }
    for (const l of content.letters) {
      const author = l.authorText && !isPlaceholderName(l.authorText) ? l.authorText : null;
      drafts.push({
        kind: 'letter',
        segment: seg,
        order: order++,
        encounter: l.encounter,
        subject: trimTo(l.title, 500) ?? 'Letter',
        threadSubject: l.title || 'letter',
        body: l.body,
        channel: 'letter',
        direction: 'inbound',
        occurredAt: l.date,
        occurredAtPrecision: l.date ? 'day' : 'unknown',
        occurredAtText: trimTo(l.dateText, 200),
        occurredTime: null,
        authorText: l.authorText,
        authorRole: l.authorText ? credentialOf(l.authorText) : null,
        voice: voiceOfAuthor(l.authorText),
        recipientText: null,
        intendedFor: null,
        sentLabel: l.status,
        sentText: l.dateText,
        readReceipts: [],
        pages: l.pages,
        headerPage: l.pages[0],
        printedOrder: null,
        spans: l.spans,
        unverified: false,
        extra: { batch: l.batch, comments: l.comments },
        participants: author ? [{ text: author, role: 'from', kind: 'clinician' }] : [],
        parsed: null,
        attachments: [],
        threadKey: '',
        externalKey: '',
      });
    }
    for (const q of content.questionnaires) questionnaires.push({ seg, q });
    for (const m of content.media) media.push({ seg, m });
  }

  // A questionnaire goes with its "Questionnaire Submission" receipt (same encounter, same day, within 2 minutes);
  // without one it is a communication of its own (the answers as printed, question then answer).
  for (const { seg, q } of questionnaires) {
    // Two questionnaires sent in the same minute have two receipts: each takes the first receipt not taken yet.
    // The nearest receipt not taken yet: in its encounter within 10 minutes (the receipt can print a few minutes apart),
    // else in any encounter that day within 2 minutes (an encounter printed twice).
    const gap = (d: Draft) => Math.abs(minutesBetween({ date: d.occurredAt, time: d.occurredTime }, { date: q.date, time: q.time }) ?? 99);
    const open = drafts.filter((d) => d.kind === 'questionnaire' && !d.extra.questionnaire && d.occurredAt === q.date).sort((a, b) => gap(a) - gap(b));
    const receipt = open.find((d) => d.encounter.key === q.encounter.key && gap(d) <= COPY_TIME_TOLERANCE_MIN) ?? open.find((d) => gap(d) <= 2);
    const info = { name: q.name, submittedText: q.submittedText, answers: q.answers.length, pages: q.pages, segmentId: seg.id };
    if (receipt) {
      receipt.extra.questionnaire = info;
      receipt.spans = [...receipt.spans, ...q.spans];
      continue;
    }
    drafts.push({
      kind: 'questionnaire',
      segment: seg,
      order: order++,
      encounter: q.encounter,
      subject: trimTo(q.name, 500) ?? 'Questionnaire',
      threadSubject: q.name || 'questionnaire',
      body: q.answers.map((a) => (a.answer ? `${a.question}\n${a.answer}` : a.question)).join('\n'),
      channel: 'portal',
      direction: 'outbound',
      occurredAt: q.date,
      occurredAtPrecision: q.date ? 'day' : 'unknown',
      occurredAtText: trimTo(q.submittedText, 200),
      occurredTime: q.time,
      authorText: null,
      authorRole: null,
      voice: 'patient',
      recipientText: null,
      intendedFor: null,
      sentLabel: 'Filed by Patient',
      sentText: q.submittedText,
      readReceipts: [],
      pages: q.pages,
      headerPage: q.pages[0],
      printedOrder: null,
      spans: q.spans,
      unverified: false,
      extra: { questionnaire: info },
      participants: [],
      parsed: null,
      attachments: [],
      threadKey: '',
      externalKey: '',
    });
  }

  // A patient's attachment ("Patient Entered Attachment - Scan on <time>") goes with the message sent at that time (or
  // within 5 minutes) in the same encounter.
  for (const { m } of media) {
    if (!ATTACHMENT_KIND.test(m.kindText) || !m.date) continue;
    let best: Draft | null = null;
    let bestGap = Infinity;
    for (const d of drafts) {
      if (d.channel !== 'portal' || d.encounter.key !== m.encounter.key || d.occurredAt !== m.date) continue;
      const gap = Math.abs(minutesBetween({ date: d.occurredAt, time: d.occurredTime }, { date: m.date, time: m.time }) ?? Infinity);
      if (gap <= 5 && gap < bestGap) {
        best = d;
        bestGap = gap;
      }
    }
    if (best) best.attachments.push({ documentId, page: m.imagePages[0] ?? m.pages[0], atText: m.atText, kindText: m.kindText });
  }

  // Threads. Messages: the printed Encounter # and subject, else the document, encounter start page, type, department
  // and subject. A telephone note joins its encounter's one message thread; otherwise the encounter's calls are a thread.
  const keyFor = (d: Draft, subject: string) =>
    threadKeyOf({ documentId, subject, encounterNumber: d.encounter.number, encounterStartPage: d.encounter.startPage, encounterType: d.encounter.type, department: d.encounter.department });
  const threadsByEncounter = new Map<string, Set<string>>();
  for (const d of drafts) {
    if (d.channel !== 'portal' || d.kind === 'questionnaire') continue;
    d.threadKey = keyFor(d, d.threadSubject);
    const set = threadsByEncounter.get(d.encounter.key) ?? new Set<string>();
    set.add(d.threadKey);
    threadsByEncounter.set(d.encounter.key, set);
  }
  for (const d of drafts) {
    if (d.threadKey) continue;
    if (d.kind === 'telephone_encounter') {
      const own = threadsByEncounter.get(d.encounter.key);
      d.threadKey = own && own.size === 1 ? [...own][0] : keyFor(d, d.threadSubject);
    } else d.threadKey = keyFor(d, d.threadSubject);
  }

  // Identity: kind, author, day, time and body hash; identical ones in one document numbered in printed order.
  const seen = new Map<string, number>();
  for (const d of drafts) {
    const base = `${d.kind}|${personNameKey(d.authorText)}|${d.occurredAt ?? ''}|${d.occurredTime ?? ''}|${bodyHashOf(d.body)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    d.externalKey = externalKeyOf({ kind: d.kind, authorText: d.authorText, date: d.occurredAt, time: d.occurredTime, body: d.body }, n);
  }
  return { drafts, contents };
}

/** The details a draft writes (merged over a row's own on an update: userFields, copies, mentions, the model summary are kept). */
function draftDetails(d: Draft, docTier: string, peopleIdx: PeopleByKey): CommunicationDetails {
  const receipts = d.readReceipts.map((r) => ({ ...r, byPersonId: peopleIdx.byKey.get(personNameKey(r.byText))?.id ?? null }));
  return {
    kind: d.kind,
    origin: 'extracted',
    voice: d.voice,
    tier: messageTier(docTier, d.voice),
    sentLabel: d.sentLabel,
    sentText: d.sentText,
    authorText: d.authorText,
    authorRole: d.authorRole,
    recipientText: d.recipientText,
    intendedFor: d.intendedFor,
    encounterHeader: d.encounter.headerText,
    encounterNumber: d.encounter.number,
    encounterKey: d.encounter.key,
    segmentId: d.segment.id,
    pages: pageRangeOf(d.spans, d.pages),
    headerPage: d.headerPage,
    ...(d.printedOrder !== null ? { printedOrder: d.printedOrder } : {}),
    bodyHash: bodyHashOf(d.body),
    readReceipts: receipts,
    unverified: d.unverified,
    parseVersion: SEGMENTER_VERSION,
    ...d.extra,
  } as CommunicationDetails;
}

function mergeDetails(prev: CommunicationDetails, next: CommunicationDetails, attachments: Draft['attachments']): CommunicationDetails {
  const merged: CommunicationDetails = { ...prev, ...next };
  // What the user and the links added stays.
  if (prev.userFields) merged.userFields = prev.userFields;
  if (prev.copies) merged.copies = prev.copies;
  if (prev.mentions) merged.mentions = prev.mentions;
  if (prev.modelSummary !== undefined) merged.modelSummary = prev.modelSummary;
  const att = new Map<string, NonNullable<CommunicationDetails['attachments']>[number]>();
  for (const a of [...(prev.attachments ?? []), ...attachments]) att.set(`${a.documentId}:${a.page}`, a);
  if (att.size) merged.attachments = [...att.values()];
  return merged;
}

function addCopy(details: CommunicationDetails, link: CommCopyLink): CommunicationDetails {
  const copies = [...(details.copies ?? [])];
  const i = copies.findIndex((c) => c.kind === link.kind && c.documentId === link.documentId);
  if (i >= 0) {
    const old = copies[i];
    if (old.pages?.[0] === link.pages?.[0] && old.pages?.[1] === link.pages?.[1] && old.communicationId === link.communicationId) return details;
    copies[i] = { ...link, linkedAt: old.linkedAt };
  } else copies.push(link);
  return { ...details, copies };
}

const USER = (details: CommunicationDetails, field: string) => Boolean(details.userFields?.includes(field));

/** What the record prints about a message that a row filed or logged on its own may lack (who, to whom, when, where). */
const RECORD_DETAIL_KEYS = [
  'kind', 'authorText', 'authorRole', 'recipientText', 'intendedFor', 'sentLabel', 'sentText', 'pages', 'headerPage', 'printedOrder',
  'encounterHeader', 'encounterNumber', 'encounterKey', 'readReceipts',
] as const;

/**
 * A row filed or logged on its own that is the same message as one a record prints gains only what it lacks from the
 * record (2026-10-07 review, rev-comms #10: the merged row read "Not printed" for its author and had no page); what it
 * has, and any field the user changed, stays.
 */
export function fillFromRecord(prev: CommunicationDetails, record: CommunicationDetails): CommunicationDetails {
  const out: Record<string, unknown> = { ...prev };
  const rec = record as Record<string, unknown>;
  for (const k of RECORD_DETAIL_KEYS) {
    if (USER(prev, k)) continue;
    const have = out[k];
    const empty = have === undefined || have === null || have === '' || (Array.isArray(have) && have.length === 0);
    const value = rec[k];
    if (empty && value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)) out[k] = value;
  }
  return out as CommunicationDetails;
}

/** A small document filed on its own (the patient's own message record) and its text, for the filed-copy match. */
interface FiledDoc {
  id: string;
  text: string;
  /** Its live communication not read out of a record (filed automatically, or logged by hand), when it has one. */
  comm: CommRow | null;
}

function filedDocuments(exceptId: string): FiledDoc[] {
  const m = schema.documents.metadataJson;
  const rows = db().all<{ id: string }>(sql`
    select id from documents
    where deleted_at is null and id <> ${exceptId} and page_count between 1 and 5 and text_status in ('extracted', 'ocr_done')
      and (case when json_valid(${m}) then json_extract(${m}, '$.export') end) is null`);
  const out: FiledDoc[] = [];
  for (const r of rows) {
    const pages = db().select({ text: schema.documentPages.text }).from(schema.documentPages).where(eq(schema.documentPages.documentId, r.id)).orderBy(schema.documentPages.pageNumber).all();
    const comm = db()
      .select()
      .from(schema.communications)
      .where(and(eq(schema.communications.documentId, r.id), isNull(schema.communications.deletedAt), sql`coalesce(json_extract(${schema.communications.detailsJson}, '$.origin'), 'manual') <> 'extracted'`))
      .get() ?? null;
    out.push({ id: r.id, text: pages.map((p) => p.text).join('\n'), comm });
  }
  return out;
}

/** The pages a small document has (for a copy link). */
function docPages(id: string): [number, number] | null {
  const n = db().select({ n: schema.documents.pageCount }).from(schema.documents).where(eq(schema.documents.id, id)).get()?.n ?? 0;
  return n > 0 ? [1, n] : null;
}

/** Participants a draft resolves to (people found or added; suggestions noted). */
function resolveParticipants(d: Draft, idx: PeopleByKey, origin: string, out: ImportResult): Array<{ personId: string; role: string }> {
  const list: Array<{ personId: string; role: string }> = [];
  for (const p of d.participants) {
    const r = resolvePrintedName(p.text, { idx, kind: p.kind, origin });
    if (r.created) out.peopleCreated.push(r.created);
    if (r.suggested && !out.peopleSuggested.some((s) => personNameKey(s.name) === personNameKey(r.suggested!.name))) out.peopleSuggested.push(r.suggested);
    if (r.personId && !list.some((x) => x.personId === r.personId)) list.push({ personId: r.personId, role: p.role });
  }
  return list;
}

function writeParticipantsIfChanged(commId: string, list: Array<{ personId: string; role: string }>): boolean {
  const d = db();
  const now = d.select({ personId: schema.communicationParticipants.personId, role: schema.communicationParticipants.role }).from(schema.communicationParticipants).where(eq(schema.communicationParticipants.communicationId, commId)).all();
  const a = now.map((x) => `${x.personId}:${x.role}`).sort().join(',');
  const b = list.map((x) => `${x.personId}:${x.role}`).sort().join(',');
  if (a === b) return false;
  d.delete(schema.communicationParticipants).where(eq(schema.communicationParticipants.communicationId, commId)).run();
  for (const p of list) d.insert(schema.communicationParticipants).values({ id: newId(), communicationId: commId, personId: p.personId, role: p.role }).run();
  return true;
}

/** Adds the participants a row lacks (a filed or hand-logged row: never removes the user's). */
function addMissingParticipants(commId: string, list: Array<{ personId: string; role: string }>): void {
  const d = db();
  const have = new Set(d.select({ personId: schema.communicationParticipants.personId }).from(schema.communicationParticipants).where(eq(schema.communicationParticipants.communicationId, commId)).all().map((x) => x.personId));
  for (const p of list) if (!have.has(p.personId)) d.insert(schema.communicationParticipants).values({ id: newId(), communicationId: commId, personId: p.personId, role: p.role }).run();
}

function automaticFilingOn(): boolean {
  try {
    return getSetting('filing.auto') !== false;
  } catch {
    return true;
  }
}

/**
 * Reads every message, telephone note, letter and questionnaire of a document into Calls & Messages (see the module
 * comment). Idempotent: a second run with nothing new changes nothing. `force` reads again segments already read by
 * the current parser. Never throws for one bad segment; throws only when the database is gone.
 */
export async function importDocumentMessages(documentId: string, opts: { force?: boolean } = {}): Promise<ImportResult> {
  const out = emptyResult(documentId);
  const doc = liveDocumentRow(documentId);
  if (!doc) return { ...out, skipped: 'document not found' };
  if (inInbox(doc)) return { ...out, skipped: 'waiting in Check before filing' };
  const segs = parsedSegmentsOf(documentId);
  if (!segs.length) return { ...out, skipped: 'nothing to read' };
  if (!opts.force && !segs.some((s) => (parseSegmentDetail(s.detailJson).parse?.version ?? 0) < SEGMENTER_VERSION)) return { ...out, skipped: 'already read' };

  const meta = readSegmentationMeta(documentId);
  const patientKey = personNameKey(meta?.furniture.patientName ?? '');
  const { drafts, contents } = draftsOf(documentId, segs, patientKey);
  for (const c of contents.values()) {
    out.messages += c.messages.length;
    out.notes += c.notes.filter((n) => n.isTelephone).length;
    out.letters += c.letters.length;
    out.questionnaires += c.questionnaires.length;
    out.media += c.media.length;
  }
  out.segmentsParsed = contents.size;

  const d = db();
  // Existing rows by external key (this document's earlier read, another export's copy, a filed copy linked before).
  // A message whose only row the user deleted is not made again (2026-10-07 review, rev-engine F4), as held records rows.
  const byExternal = new Map<string, CommRow>();
  const deletedOnly = new Set<string>();
  const keys = [...new Set(drafts.map((x) => x.externalKey))];
  for (let i = 0; i < keys.length; i += 400) {
    for (const r of d.select().from(schema.communications).where(inArray(schema.communications.externalKey, keys.slice(i, i + 400))).all()) {
      if (!r.externalKey) continue;
      if (r.deletedAt) {
        if (!byExternal.has(r.externalKey)) deletedOnly.add(r.externalKey);
      } else if (!byExternal.has(r.externalKey)) {
        byExternal.set(r.externalKey, r);
        deletedOnly.delete(r.externalKey);
      }
    }
  }
  // A parsed thread adopts the key of an existing row it shares a message with.
  const adopt = new Map<string, string>();
  for (const x of drafts) {
    const e = byExternal.get(x.externalKey);
    if (e?.threadKey && e.threadKey !== x.threadKey && !adopt.has(x.threadKey)) adopt.set(x.threadKey, e.threadKey);
  }
  for (const x of drafts) x.threadKey = adopt.get(x.threadKey) ?? x.threadKey;

  const threadKeys = [...new Set(drafts.map((x) => x.threadKey))];
  const existingThreads = new Set<string>();
  for (let i = 0; i < threadKeys.length; i += 400) {
    for (const r of d.select({ k: schema.communications.threadKey }).from(schema.communications).where(and(inArray(schema.communications.threadKey, threadKeys.slice(i, i + 400)), isNull(schema.communications.deletedAt))).all()) if (r.k) existingThreads.add(r.k);
  }
  out.threadKeys = threadKeys;
  out.threadsTotal = threadKeys.length;
  out.threadsCreated = threadKeys.filter((k) => !existingThreads.has(k)).length;

  const forms = pageTextFormsLookup(documentId);
  const stored = (n: number) => forms(n)?.stored;
  const visual = (n: number) => forms(n)?.visual ?? undefined;
  const peopleIdx = peopleByNameKey();
  const origin = `Read from "${doc.title}".`;
  let filed: FiledDoc[] | null = null;
  const filedNow = () => (filed ??= filedDocuments(documentId));
  const dup = await import('./duplicates');
  const touched = new Set<string>();
  const perSegment = new Map<string, number>();
  const at = nowIso();

  d.transaction(() => {
    for (const x of drafts) {
      if (deletedOnly.has(x.externalKey)) {
        out.removedByYou = (out.removedByYou ?? 0) + 1;
        continue;
      }
      const details = draftDetails(x, doc.sourceTier, peopleIdx);
      const participants = resolveParticipants(x, peopleIdx, `${origin} p.${x.headerPage}.`, out);
      let commId: string | null = null;
      let changed = false;
      const existing = byExternal.get(x.externalKey);
      const recordCopy: CommCopyLink = { kind: 'record_copy', documentId, pages: pageRangeOf(x.spans, x.pages), communicationId: null, similarity: 1, minutesApart: 0, linkedAt: at };

      if (existing && existing.documentId === documentId && parseCommunicationDetails(existing.detailsJson).origin === 'extracted') {
        // This record's own row from an earlier read: refreshed, except what the user changed.
        const prev = parseCommunicationDetails(existing.detailsJson);
        const next = mergeDetails(prev, details, x.attachments);
        const set: Partial<typeof schema.communications.$inferInsert> = {};
        if (!USER(prev, 'occurredAt') && (existing.occurredAt !== x.occurredAt || existing.occurredAtText !== x.occurredAtText)) {
          set.occurredAt = x.occurredAt;
          set.occurredAtPrecision = x.occurredAtPrecision;
          set.occurredAtText = x.occurredAtText;
        }
        if (existing.occurredTime !== x.occurredTime) set.occurredTime = x.occurredTime;
        if (!USER(prev, 'direction') && existing.direction !== x.direction) set.direction = x.direction;
        if (!USER(prev, 'channel') && existing.channel !== x.channel) set.channel = x.channel;
        if (!USER(prev, 'subject') && existing.subject !== x.subject) set.subject = x.subject;
        if (existing.body !== x.body) set.body = x.body;
        if (existing.threadKey !== x.threadKey) set.threadKey = x.threadKey;
        if (!USER(prev, 'encounterId') && !existing.encounterId && x.segment.encounterId) set.encounterId = x.segment.encounterId;
        const nextJson = JSON.stringify(next);
        if (!sameJson(nextJson, existing.detailsJson)) set.detailsJson = nextJson;
        if (Object.keys(set).length) {
          d.update(schema.communications).set({ ...set, updatedAt: at }).where(eq(schema.communications.id, existing.id)).run();
          changed = true;
        }
        if (!USER(prev, 'participants') && writeParticipantsIfChanged(existing.id, participants)) changed = true;
        commId = existing.id;
        if (changed) out.updated++;
        else out.unchanged++;
      } else if (existing) {
        // The same message already has a row: read out of another record, filed, or logged by hand. It keeps what it
        // has and gains this record's copy (and what it lacked).
        const prev = parseCommunicationDetails(existing.detailsJson);
        let next = fillFromRecord(addCopy(prev, recordCopy), details);
        if (!prev.voice) next = { ...next, voice: x.voice, tier: messageTier(doc.sourceTier, x.voice) };
        else if (!prev.tier || prev.tier === 'unknown') next = { ...next, tier: messageTier(doc.sourceTier, prev.voice) };
        const set: Partial<typeof schema.communications.$inferInsert> = {};
        if (prev.origin === 'filed' && !USER(prev, 'direction') && existing.direction !== x.direction) set.direction = x.direction;
        if (!existing.body) set.body = x.body;
        if (!existing.threadKey) set.threadKey = x.threadKey;
        if (!existing.occurredTime && x.occurredTime) set.occurredTime = x.occurredTime;
        if (!existing.occurredAt && x.occurredAt) {
          // The record's timestamp fills a row that had none (it never replaces one the row has).
          set.occurredAt = x.occurredAt;
          set.occurredAtPrecision = x.occurredAtPrecision;
          set.occurredAtText = existing.occurredAtText ?? x.occurredAtText;
        }
        const nextJson = JSON.stringify(next);
        if (!sameJson(nextJson, existing.detailsJson)) set.detailsJson = nextJson;
        if (Object.keys(set).length) {
          d.update(schema.communications).set({ ...set, updatedAt: at }).where(eq(schema.communications.id, existing.id)).run();
          changed = true;
        }
        if (prev.origin !== 'extracted') addMissingParticipants(existing.id, participants);
        commId = existing.id;
        if (changed) out.updated++;
        else out.unchanged++;
        if (prev.origin !== 'extracted' && existing.documentId && existing.documentId !== documentId && changed) {
          out.mergedWithFiled.push({ threadKey: existing.threadKey ?? x.threadKey, communicationId: existing.id, filedDocumentId: existing.documentId, pages: recordCopy.pages });
        }
      } else {
        // A copy filed on its own (the patient's own record of the message): the same message, never a second row.
        let match: { doc: FiledDoc; minutes: number } | null = null;
        if (x.parsed && normalizeForHash(x.body).length >= dup.CONTAINED_BODY_MIN) {
          for (const f of filedNow()) {
            const m = dup.matchFiledMessage(f.text, [x.parsed]);
            if (!m || Math.abs(m.minutesApart) > COPY_TIME_TOLERANCE_MIN) continue;
            // The sender is the same person: the filed copy is the patient's own record, or names the same author.
            const sameSender = x.voice === 'patient' || (f.comm ? sameAuthor(f.comm.id, x.authorText) : false);
            if (!sameSender) continue;
            if (f.comm && f.comm.threadKey && f.comm.threadKey !== x.threadKey && subjectKey(f.comm.subject) !== subjectKey(x.subject)) continue;
            match = { doc: f, minutes: m.minutesApart };
            break;
          }
        }
        if (match?.doc.comm) {
          const row = match.doc.comm;
          const prev = parseCommunicationDetails(row.detailsJson);
          let next = fillFromRecord(addCopy(prev, { ...recordCopy, minutesApart: match.minutes }), details);
          const voice = prev.voice ?? x.voice;
          next = { ...next, origin: prev.origin ?? 'filed', voice, tier: prev.tier && prev.tier !== 'unknown' ? prev.tier : messageTier(doc.sourceTier, voice), kind: prev.kind ?? x.kind, bodyHash: prev.bodyHash ?? bodyHashOf(x.body) };
          const set: Partial<typeof schema.communications.$inferInsert> = { detailsJson: JSON.stringify(next), updatedAt: at };
          // A row automatic filing made takes the record's direction (the record prints who sent it); the user's stays.
          if ((prev.origin ?? 'filed') === 'filed' && !USER(prev, 'direction') && row.direction !== x.direction) set.direction = x.direction;
          if (!row.body) set.body = x.body;
          if (!row.threadKey) set.threadKey = x.threadKey;
          if (!row.externalKey) set.externalKey = x.externalKey;
          if (!row.occurredTime && x.occurredTime) set.occurredTime = x.occurredTime;
          if (!row.occurredAt && x.occurredAt) {
            set.occurredAt = x.occurredAt;
            set.occurredAtPrecision = x.occurredAtPrecision;
            set.occurredAtText = row.occurredAtText ?? x.occurredAtText;
          }
          d.update(schema.communications).set(set).where(eq(schema.communications.id, row.id)).run();
          addMissingParticipants(row.id, participants);
          match.doc.comm = { ...row, ...set } as CommRow;
          commId = row.id;
          out.updated++;
          out.mergedWithFiled.push({ threadKey: (set.threadKey as string | undefined) ?? row.threadKey ?? x.threadKey, communicationId: row.id, filedDocumentId: match.doc.id, pages: recordCopy.pages });
          changed = true;
        } else {
          const id = newId();
          let det = mergeDetails({}, details, x.attachments);
          if (match) det = addCopy(det, { kind: 'filed_copy', documentId: match.doc.id, pages: docPages(match.doc.id), communicationId: null, similarity: 1, minutesApart: match.minutes, linkedAt: at });
          d.insert(schema.communications)
            .values({
              id,
              occurredAt: x.occurredAt,
              occurredAtPrecision: x.occurredAtPrecision,
              occurredAtText: x.occurredAtText,
              occurredTime: x.occurredTime,
              direction: x.direction,
              channel: x.channel,
              subject: x.subject,
              summary: null,
              outcome: null,
              body: x.body,
              threadKey: x.threadKey,
              externalKey: x.externalKey,
              documentId,
              encounterId: x.segment.encounterId ?? null,
              detailsJson: JSON.stringify(det),
              createdAt: at,
              updatedAt: at,
            })
            .run();
          for (const p of participants) d.insert(schema.communicationParticipants).values({ id: newId(), communicationId: id, personId: p.personId, role: p.role }).run();
          byExternal.set(x.externalKey, d.select().from(schema.communications).where(eq(schema.communications.id, id)).get()!);
          commId = id;
          out.created++;
          changed = true;
          if (match) out.mergedWithFiled.push({ threadKey: x.threadKey, communicationId: id, filedDocumentId: match.doc.id, pages: recordCopy.pages });
        }
      }
      if (!commId) continue;
      for (const s of x.spans) {
        const c = insertVerifiedCommunicationCitation(commId, { documentId, pageNumber: s.page, quote: s.quote }, stored, [visual]);
        if (c.inserted) {
          out.citations.inserted++;
          if (c.verified) out.citations.verified++;
        }
      }
      if (changed) touched.add(commId);
      out.communicationIds.push(commId);
      out.byKind[x.kind] = (out.byKind[x.kind] ?? 0) + 1;
      perSegment.set(x.segment.id, (perSegment.get(x.segment.id) ?? 0) + 1);
      const qs = x.extra.questionnaire as { segmentId?: string } | undefined;
      if (qs?.segmentId && qs.segmentId !== x.segment.id) perSegment.set(qs.segmentId, (perSegment.get(qs.segmentId) ?? 0) + 1);
    }

    // Each segment read records what the parsers found; a segment read only by the parsers is settled.
    for (const seg of segs) {
      const c = contents.get(seg.id);
      if (!c) continue;
      const parse = { at, version: c.version, messages: c.messages.length, notes: c.notes.length, letters: c.letters.length, questionnaires: c.questionnaires.length, media: c.media.length };
      const detail = parseSegmentDetail(seg.detailJson);
      const route = routeOf({ kind: seg.kind, detail });
      updateSegment(seg.id, {
        messagesCount: perSegment.get(seg.id) ?? 0,
        detail: { parse },
        ...(route === 'parse' && !isSettledSegmentStatus(seg.status) ? { status: 'parsed' as const } : {}),
      });
    }
  });
  for (const id of touched) reindexCommunication(id);
  // Threads: follow-ups worked out from the replies, calls linked to the messages they name.
  try {
    const threads = await import('./threads');
    threads.refreshThreads(threadKeys);
    threads.linkCallMentions({ documentId });
  } catch (err) {
    console.warn(`[messages] threads of ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // An export no longer stands as one "portal message" row (filed before its messages were read): taken back when
  // automatic filing made it and nobody worked on it since.
  if (automaticFilingOn() && out.communicationIds.length) {
    try {
      const filing = await import('./filing');
      filing.retireWholeDocumentCommunication(documentId);
    } catch (err) {
      console.warn(`[messages] single communication of ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

/** True when the communication's `from` participant (or its details' author) is the person printed as `author`. */
function sameAuthor(commId: string, author: string | null): boolean {
  const key = personNameKey(author);
  if (!key) return false;
  const rows = db()
    .select({ name: schema.people.name, aliasesJson: schema.people.aliasesJson })
    .from(schema.communicationParticipants)
    .innerJoin(schema.people, eq(schema.people.id, schema.communicationParticipants.personId))
    .where(and(eq(schema.communicationParticipants.communicationId, commId), eq(schema.communicationParticipants.role, 'from')))
    .all();
  return rows.some((r) => [r.name, ...parseJson<string[]>(r.aliasesJson, [])].some((n) => personNameKey(n) === key));
}

// ---------------------------------------------------------------------------
// Messaging acts read as facts before 2026-10-07 ("Patient sent a MyChart message to Dr. X")
// ---------------------------------------------------------------------------

const CALL_WORDS = /\b(called|calls|phoned|telephone|phone|voicemail|voice mail|returned)\b/i;

/**
 * The same test the extraction engine applies to new facts (src/shared/messaging-acts.ts): an event that only says a
 * message, call or letter happened, with nothing clinical in it.
 */
export function isMessagingActFact(f: { type: string; statement: string; attributes: Record<string, unknown> }): boolean {
  return isMessagingActText(f.type, typeof f.attributes.name === 'string' ? f.attributes.name : null, f.statement);
}

/** The setting that records the one-time clean-up over the whole ledger (cast key: not in DEFAULT_SETTINGS). */
export const MESSAGING_ACTS_SETTING = 'migration.messagingActsV1';
/** The setting that records the one-time restore of facts the first version of the clean-up set aside wrongly. */
export const MESSAGING_ACTS_RESTORE_SETTING = 'migration.messagingActsV1Restore';

export interface MessagingActsResult {
  /** Facts set aside (status superseded, linked to their communication). */
  superseded: number;
  /** Messaging-act facts left alone: user work, a link, no date, or no message read out of a record that day. */
  kept: number;
}

/** True when a document is an institutional export (its messages are read out of it). */
function exportDocument(documentId: string, cache: Map<string, boolean>): boolean {
  let v = cache.get(documentId);
  if (v === undefined) {
    const m = db().select({ m: schema.documents.metadataJson }).from(schema.documents).where(eq(schema.documents.id, documentId)).get()?.m;
    v = Boolean(parseJson<Record<string, unknown>>(m, {}).export);
    cache.set(documentId, v);
  }
  return v;
}

/**
 * Event facts that only say a message, call or letter happened ("Patient sent a portal message on 10/5"), read
 * before the extraction stopped making them, are set aside now that the messages themselves are in Calls & Messages:
 * status `superseded` (never deleted), `attributes._messagingAct = { communicationId, at }` naming the message read
 * out of the same record on the same day that stands for it. Only (2026-10-07 review, rev-engine F3 and rev-comms #8):
 * - facts whose message was read out of the record: a communication of the same document, the same day, read out of a
 *   record (`origin: 'extracted'`, an export's messages). A call record or message the patient filed himself keeps its
 *   facts: nothing stands for them;
 * - unverified facts the model made with no user work (the extraction engine's own test: an edit, a verdict or verdict
 *   note, "unsure", an override by hand, "Not the same event") and no link (another ledger, a merge, a task, finding
 *   evidence);
 * - statements with nothing clinical beyond the act (shared test, src/shared/messaging-acts.ts).
 * `documentId` limits it to one document (run after that document's messages were read). Idempotent.
 */
export function supersedeMessagingActs(opts: { documentId?: string | null } = {}): MessagingActsResult {
  const out: MessagingActsResult = { superseded: 0, kept: 0 };
  const d = db();
  const f = schema.facts;
  const rows = d
    .select({ id: f.id, type: f.type, statement: f.statement, date: f.date, attributesJson: f.attributesJson, verdictNote: f.verdictNote, verdictBasis: f.verdictBasis, verdictAt: f.verdictAt, sourceDocumentId: f.sourceDocumentId })
    .from(f)
    .where(and(eq(f.type, 'event'), eq(f.status, 'unverified'), eq(f.origin, 'ai'), isNull(f.deletedAt), opts.documentId ? eq(f.sourceDocumentId, opts.documentId) : sql`${f.sourceDocumentId} is not null`))
    .all();
  if (!rows.length) return out;
  const commsByDocDay = new Map<string, CommRow[]>();
  const commsOf = (documentId: string, day: string): CommRow[] => {
    const k = `${documentId}|${day}`;
    let list = commsByDocDay.get(k);
    if (!list) {
      list = d
        .select()
        .from(schema.communications)
        .where(and(eq(schema.communications.documentId, documentId), eq(schema.communications.occurredAt, day), isNull(schema.communications.deletedAt)))
        .all()
        .filter((c) => parseCommunicationDetails(c.detailsJson).origin === 'extracted')
        .sort((a, b) => (a.occurredTime ?? '').localeCompare(b.occurredTime ?? ''));
      commsByDocDay.set(k, list);
    }
    return list;
  };
  const linkedByDoc = new Map<string, Set<string>>();
  const linkedOf = (documentId: string): Set<string> => {
    let s = linkedByDoc.get(documentId);
    if (!s) {
      s = linkedFactIds(documentId);
      linkedByDoc.set(documentId, s);
    }
    return s;
  };
  const merged = (id: string) => Boolean(d.get(sql`select 1 from fact_merges where fact_id_a = ${id} or fact_id_b = ${id} limit 1`) || d.get(sql`select 1 from finding_evidence where fact_id = ${id} limit 1`));
  const now = nowIso();
  for (const r of rows) {
    const attributes = parseJson<Record<string, unknown>>(r.attributesJson, {});
    if (!isMessagingActFact({ type: r.type, statement: r.statement, attributes })) continue;
    if (attributes._messagingAct) continue;
    const userWork = hasUserWork(r, attributes) || Boolean(r.verdictAt);
    if (userWork || !r.date || r.date.length !== 10 || !r.sourceDocumentId || linkedOf(r.sourceDocumentId).has(r.id) || merged(r.id)) {
      out.kept++;
      continue;
    }
    // Only a message read out of the record stands for the fact (an export's messages); a record the patient filed keeps it.
    const comms = commsOf(r.sourceDocumentId, r.date);
    const wantCall = CALL_WORDS.test(`${typeof attributes.name === 'string' ? attributes.name : ''} ${r.statement}`);
    const comm = comms.find((c) => (wantCall ? c.channel === 'call' : c.channel !== 'call')) ?? comms[0];
    if (!comm) {
      out.kept++;
      continue;
    }
    d.update(f)
      .set({ status: 'superseded', attributesJson: JSON.stringify({ ...attributes, _messagingAct: { communicationId: comm.id, at: now } }), updatedAt: now })
      .where(and(eq(f.id, r.id), eq(f.status, 'unverified')))
      .run();
    out.superseded++;
  }
  return out;
}

/**
 * Puts back what the first version of the clean-up set aside wrongly (2026-10-07 review, rev-comms #8 and rev-engine F3):
 * a fact it set aside whose message was not read out of a record (a call record or message the patient filed), one with
 * something clinical in it, or one the user had answered or linked. Back to `unverified`; `_messagingAct` stays as
 * history with `restoredAt`, and the clean-up never sets it aside again. Only facts still `superseded` by that clean-up
 * (nothing the user did since). Returns how many were put back.
 */
export function restoreMessagingActs(): number {
  const d = db();
  const f = schema.facts;
  const rows = d
    .select({ id: f.id, type: f.type, statement: f.statement, attributesJson: f.attributesJson, verdictNote: f.verdictNote, verdictBasis: f.verdictBasis, verdictAt: f.verdictAt, sourceDocumentId: f.sourceDocumentId, supersededById: f.supersededById })
    .from(f)
    .where(and(eq(f.status, 'superseded'), eq(f.origin, 'ai'), isNull(f.deletedAt), sql`json_valid(${f.attributesJson}) and json_extract(${f.attributesJson}, '$._messagingAct') is not null`))
    .all();
  const exports = new Map<string, boolean>();
  const linkedByDoc = new Map<string, Set<string>>();
  const now = nowIso();
  let n = 0;
  for (const r of rows) {
    if (r.supersededById) continue;
    const attributes = parseJson<Record<string, unknown>>(r.attributesJson, {});
    const act = attributes._messagingAct as { communicationId?: string; restoredAt?: string } | undefined;
    if (!act || act.restoredAt) continue;
    const comm = act.communicationId ? d.select({ detailsJson: schema.communications.detailsJson }).from(schema.communications).where(eq(schema.communications.id, act.communicationId)).get() : undefined;
    const fromRecord = (comm ? parseCommunicationDetails(comm.detailsJson).origin === 'extracted' : false) || (r.sourceDocumentId ? exportDocument(r.sourceDocumentId, exports) : false);
    let linked = false;
    if (r.sourceDocumentId) {
      let s = linkedByDoc.get(r.sourceDocumentId);
      if (!s) {
        // linkedFactIds reads unverified facts only: these are superseded, so their links are checked here directly.
        s = new Set(
          d.all<{ id: string }>(sql`
            select f.id from facts f where f.source_document_id = ${r.sourceDocumentId} and f.status = 'superseded' and f.deleted_at is null and (
                 exists (select 1 from tasks t where t.deleted_at is null and t.source_type = 'fact' and t.source_id = f.id)
              or exists (select 1 from finding_evidence fe where fe.fact_id = f.id)
              or exists (select 1 from fact_merges m where m.fact_id_a = f.id or m.fact_id_b = f.id))`).map((x) => x.id),
        );
        linkedByDoc.set(r.sourceDocumentId, s);
      }
      linked = s.has(r.id);
    }
    const wrong = !fromRecord || !isMessagingActFact({ type: r.type, statement: r.statement, attributes }) || hasUserWork(r, attributes) || Boolean(r.verdictAt) || linked;
    if (!wrong) continue;
    d.update(f)
      .set({ status: 'unverified', attributesJson: JSON.stringify({ ...attributes, _messagingAct: { ...act, restoredAt: now } }), updatedAt: now })
      .where(and(eq(f.id, r.id), eq(f.status, 'superseded')))
      .run();
    n++;
  }
  return n;
}

/**
 * The whole-ledger clean-up, once (guarded by MESSAGING_ACTS_SETTING); later documents are cleaned as they are read.
 * Before it, once (MESSAGING_ACTS_RESTORE_SETTING), whatever the first version of the clean-up set aside wrongly is put
 * back (it ran on test copies; it may have run on the ledger).
 */
export function supersedeMessagingActsOnce(): MessagingActsResult | null {
  try {
    if (getSetting(MESSAGING_ACTS_RESTORE_SETTING as SettingKey) !== true) {
      const restored = restoreMessagingActs();
      if (restored) console.log(`[messages] ${restored} detail${restored === 1 ? '' : 's'} set aside by the first clean-up put back`);
      setSetting(MESSAGING_ACTS_RESTORE_SETTING as SettingKey, true as never);
    }
  } catch (err) {
    console.warn(`[messages] messaging-act restore: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    if (getSetting(MESSAGING_ACTS_SETTING as SettingKey) === true) return null;
    const r = supersedeMessagingActs();
    setSetting(MESSAGING_ACTS_SETTING as SettingKey, true as never);
    return r;
  } catch (err) {
    console.warn(`[messages] messaging-act clean-up: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
