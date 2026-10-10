/**
 * Threads and message details of Calls & Messages (2026-10-07, messages read out of records).
 *
 * FROZEN SIGNATURES (WP0): listThreads, getThread, getMessage, threadKeysForDocument. Owner: WP-C. Shapes:
 * src/shared/schemas/segments.ts. Rules:
 * - soft-deleted rows are never listed, nor a message read out of a record that was deleted since;
 * - messages in a thread run oldest first (occurred_at, then occurred_time, then printed order: Epic prints newest
 *   first, so a higher printed order is older);
 * - a row logged by hand has no thread key: it is a thread of its own under the key `c_<id>`;
 * - the outcome of a thread is the user's when written (a row's outcome the user typed), else worked out from the
 *   replies in the thread, with their pages; a model summary is labelled and never mixed with `summary`;
 * - follow-ups of rows read out of records are worked out from the replies (`refreshThreads`): a promise in a
 *   care-team reply ("I will call you ...") is open until a later message or call of the care team in the same thread,
 *   which settles it (with the time it came). Never a field the user edited.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { conflict, notFound } from '../util/errors';
import { z } from 'zod';
import { aiEnabled, callStructured } from '../ai/client';
import { nowIso } from '../util/ids';
import { VISIBLE_WITH_RECORD, insertVerifiedCommunicationCitation, reindexCommunication } from './communications';
import { pageTextFormsLookup } from './segments';
import { sameJson } from './messages-import';
import { descriptionTokens } from './records';
import {
  COPY_TIME_TOLERANCE_MIN, formatPageRanges, minutesBetween, parseCommunicationDetails,
  type CommMention, type CommunicationDetails, type MessageView, type ThreadListItem, type ThreadMessageItem, type ThreadView,
} from '../../shared/schemas/segments';

export interface ThreadFilters {
  personId?: string | null;
  documentId?: string | null;
  /** true: only threads read out of records; false: only ones logged by hand; null/undefined: both. */
  fromRecords?: boolean | null;
  q?: string | null;
  limit?: number;
}

type Row = typeof schema.communications.$inferSelect;

/** The thread a row belongs to: its thread key, or `c_<id>` for a row logged by hand. */
export function threadKeyOfRow(r: Pick<Row, 'id' | 'threadKey'>): string {
  return r.threadKey ?? `c_${r.id}`;
}

const MODEL_PREFIX = 'Model summary of the filed document (not checked): ';

function liveRows(where?: ReturnType<typeof and>): Row[] {
  const c = schema.communications;
  return db()
    .select()
    .from(c)
    .where(and(isNull(c.deletedAt), sql`${VISIBLE_WITH_RECORD}`, where))
    .all();
}

/** Oldest first: day, then printed time, then printed order (higher = printed lower = older), then when it was made. */
function chronological(a: Row, b: Row): number {
  const ad = a.occurredAt ?? '￿';
  const bd = b.occurredAt ?? '￿';
  if (ad !== bd) return ad < bd ? -1 : 1;
  const at = a.occurredTime ?? '';
  const bt = b.occurredTime ?? '';
  if (at !== bt) return at < bt ? -1 : 1;
  const ao = parseCommunicationDetails(a.detailsJson).printedOrder ?? -1;
  const bo = parseCommunicationDetails(b.detailsJson).printedOrder ?? -1;
  if (ao !== bo) return bo - ao;
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

function isCareTeam(r: Row, d: CommunicationDetails): boolean {
  if (d.voice) return d.voice === 'clinician' || d.voice === 'staff';
  return r.direction === 'inbound' || r.direction === 'third_party';
}

function isPatient(r: Row, d: CommunicationDetails): boolean {
  if (d.voice) return d.voice === 'patient';
  return r.direction === 'outbound';
}

function snippet(r: Row): string {
  const t = (r.body ?? r.summary ?? r.outcome ?? '').replace(/\s+/g, ' ').trim();
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
}

function when(r: Row): string {
  return (r.occurredAtText ?? r.occurredAt ?? '').trim();
}

/** The outcome a user wrote on a row (not one a model or filing wrote). */
function userOutcome(r: Row, d: CommunicationDetails): string | null {
  if (!r.outcome?.trim()) return null;
  if (d.userFields?.includes('outcome')) return r.outcome;
  if (d.origin === 'extracted') return null;
  return r.outcome.startsWith(MODEL_PREFIX) ? null : r.outcome;
}

/** The outcome of a thread: the user's, else the replies (who answered, when, on which pages), else none. */
function outcomeOf(rows: Row[]): { outcome: string | null; source: 'user' | 'replies' | 'none' } {
  for (const r of [...rows].reverse()) {
    const u = userOutcome(r, parseCommunicationDetails(r.detailsJson));
    if (u) return { outcome: u, source: 'user' };
  }
  const firstPatient = rows.findIndex((r) => isPatient(r, parseCommunicationDetails(r.detailsJson)));
  const replies = rows.filter((r, i) => i > firstPatient && firstPatient >= 0 && isCareTeam(r, parseCommunicationDetails(r.detailsJson)));
  if (!replies.length) return { outcome: null, source: 'none' };
  const parts = replies.map((r) => {
    const d = parseCommunicationDetails(r.detailsJson);
    const who = d.authorText ?? 'the care team';
    const pages = d.pages ? ` (${formatPageRanges([d.pages])})` : '';
    const read = d.readReceipts?.[0] ? `, read ${d.readReceipts[0].atText}` : '';
    return `${r.channel === 'call' ? 'call' : 'reply'} from ${who} ${when(r)}${read}${pages}`;
  });
  const n = replies.length;
  return { outcome: `${n === 1 ? 'One answer' : `${n} answers`} in the records: ${parts.join('; ')}.`, source: 'replies' };
}

function groupByThread(rows: Row[]): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const r of rows) {
    const k = threadKeyOfRow(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  for (const list of out.values()) list.sort(chronological);
  return out;
}

/**
 * The subject a thread is named by: the subject printed on its first portal message read out of a record, else on its
 * first row read out of a record, else its first row's (a copy filed on its own carries the filing's title, never the
 * printed subject; 2026-10-07 review, rev-comms #10).
 */
export function threadSubject(rows: readonly Pick<Row, 'subject' | 'channel' | 'detailsJson'>[]): string {
  const extracted = rows.filter((r) => parseCommunicationDetails(r.detailsJson).origin === 'extracted');
  const printed = extracted.find((r) => r.channel === 'portal') ?? extracted[0] ?? rows[0];
  return printed?.subject ?? 'Message';
}

function openFollowUps(rows: Row[]): number {
  return rows.filter((r) => r.followUpPromised && !r.followUpDoneAt).length;
}

function documentIdsOf(rows: Row[]): string[] {
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.documentId) ids.add(r.documentId);
    for (const c of parseCommunicationDetails(r.detailsJson).copies ?? []) ids.add(c.documentId);
  }
  return [...ids];
}

function dayTime(r: Row): string {
  return `${r.occurredAt ?? ''}${r.occurredTime ? `T${r.occurredTime}` : ''}`;
}

function modelSummaryOf(rows: Row[]): ThreadView['modelSummary'] {
  for (const r of rows) {
    const m = parseCommunicationDetails(r.detailsJson).modelSummary;
    if (m) return m;
  }
  return null;
}

/** GET /api/communications/threads: newest activity first. */
export function listThreads(filters: ThreadFilters = {}): ThreadListItem[] {
  const groups = groupByThread(liveRows());
  let personThreads: Set<string> | null = null;
  if (filters.personId) {
    const ids = new Set(
      db()
        .select({ id: schema.communicationParticipants.communicationId })
        .from(schema.communicationParticipants)
        .where(eq(schema.communicationParticipants.personId, filters.personId))
        .all()
        .map((x) => x.id),
    );
    personThreads = new Set();
    for (const [k, rows] of groups) if (rows.some((r) => ids.has(r.id))) personThreads.add(k);
  }
  const q = filters.q?.trim().toLowerCase() ?? '';
  const out: Array<ThreadListItem & { sortKey: string }> = [];
  for (const [key, rows] of groups) {
    if (personThreads && !personThreads.has(key)) continue;
    const fromRecords = rows.some((r) => parseCommunicationDetails(r.detailsJson).origin === 'extracted');
    if (filters.fromRecords === true && !fromRecords) continue;
    if (filters.fromRecords === false && fromRecords) continue;
    const docs = documentIdsOf(rows);
    if (filters.documentId && !docs.includes(filters.documentId)) continue;
    if (q) {
      const hay = rows.map((r) => [r.subject, r.body, r.summary, r.outcome, parseCommunicationDetails(r.detailsJson).authorText].filter(Boolean).join(' ')).join(' ').toLowerCase();
      if (!hay.includes(q)) continue;
    }
    const last = rows[rows.length - 1];
    const o = outcomeOf(rows);
    out.push({
      key,
      subject: threadSubject(rows),
      documentIds: docs,
      firstAt: rows[0]?.occurredAt ?? null,
      lastAt: last?.occurredAt ?? null,
      count: rows.length,
      openFollowUps: openFollowUps(rows),
      outcome: o.outcome,
      outcomeSource: o.source,
      lastSnippet: last ? snippet(last) : '',
      fromRecords,
      sortKey: last ? dayTime(last) : '',
    });
  }
  out.sort((a, b) => (a.sortKey === b.sortKey ? a.key.localeCompare(b.key) : a.sortKey < b.sortKey ? 1 : -1));
  const limit = Math.min(Math.max(Number(filters.limit ?? 2000), 1), 10000);
  return out.slice(0, limit).map(({ sortKey: _s, ...rest }) => {
    void _s;
    return rest;
  });
}

function threadRows(key: string): Row[] {
  if (key.startsWith('c_')) {
    const id = key.slice(2);
    return liveRows(and(eq(schema.communications.id, id), isNull(schema.communications.threadKey))).sort(chronological);
  }
  return liveRows(eq(schema.communications.threadKey, key)).sort(chronological);
}

function messageItem(r: Row): ThreadMessageItem {
  const d = parseCommunicationDetails(r.detailsJson);
  return {
    id: r.id,
    occurredAt: r.occurredAt,
    occurredAtText: r.occurredAtText,
    occurredTime: r.occurredTime,
    direction: r.direction,
    voice: d.voice ?? null,
    authorText: d.authorText ?? null,
    recipientText: d.recipientText ?? null,
    snippet: snippet(r),
    pages: d.pages ?? null,
    documentId: r.documentId,
    readAtText: d.readReceipts?.[0]?.atText ?? null,
    copies: d.copies?.length ?? 0,
  };
}

/** GET /api/communications/threads/:key. Throws 404 when no live message has this key. */
export function getThread(key: string): ThreadView {
  const rows = threadRows(key);
  if (!rows.length) throw notFound(`thread ${key.slice(0, 40)} not found`);
  const o = outcomeOf(rows);
  return {
    key,
    subject: threadSubject(rows),
    documentIds: documentIdsOf(rows),
    firstAt: rows[0].occurredAt,
    lastAt: rows[rows.length - 1].occurredAt,
    count: rows.length,
    openFollowUps: openFollowUps(rows),
    outcome: o.outcome,
    outcomeSource: o.source,
    modelSummary: modelSummaryOf(rows),
    messages: rows.map(messageItem),
  };
}

/** GET /api/communications/:id/message: the message detail (body, voice, read receipts, pages, copies). Throws 404. */
export function getMessage(communicationId: string): MessageView {
  const r = liveRows(eq(schema.communications.id, communicationId))[0];
  if (!r) throw notFound(`communication ${communicationId.slice(0, 40)} not found`);
  const d = parseCommunicationDetails(r.detailsJson);
  const docIds = [...new Set([r.documentId, ...(d.copies ?? []).map((c) => c.documentId)].filter((x): x is string => Boolean(x)))];
  const titles = new Map(
    docIds.length
      ? db().select({ id: schema.documents.id, title: schema.documents.title }).from(schema.documents).where(and(inArray(schema.documents.id, docIds), isNull(schema.documents.deletedAt))).all().map((x) => [x.id, x.title])
      : [],
  );
  const participants = db()
    .select({ personId: schema.communicationParticipants.personId, role: schema.communicationParticipants.role, name: schema.people.name, kind: schema.people.kind })
    .from(schema.communicationParticipants)
    .innerJoin(schema.people, and(eq(schema.people.id, schema.communicationParticipants.personId), isNull(schema.people.deletedAt)))
    .where(eq(schema.communicationParticipants.communicationId, r.id))
    .all();
  const citations = db()
    .select()
    .from(schema.citations)
    .where(eq(schema.citations.communicationId, r.id))
    .orderBy(schema.citations.pageNumber, schema.citations.createdAt)
    .all()
    .map((c) => ({ id: c.id, documentId: c.documentId, pageNumber: c.pageNumber, quote: c.quote, verified: Boolean(c.verified), matchKind: c.matchKind }));
  const key = threadKeyOfRow(r);
  const rows = r.threadKey ? threadRows(key) : [r];
  const position = rows.findIndex((x) => x.id === r.id) + 1;
  return {
    id: r.id,
    threadKey: r.threadKey,
    subject: r.subject,
    occurredAt: r.occurredAt,
    occurredAtPrecision: r.occurredAtPrecision,
    occurredAtText: r.occurredAtText,
    occurredTime: r.occurredTime,
    direction: r.direction,
    channel: r.channel,
    body: r.body,
    summary: r.summary,
    outcome: r.outcome,
    documentId: r.documentId,
    documentTitle: r.documentId ? (titles.get(r.documentId) ?? null) : null,
    details: d,
    participants,
    citations,
    copies: (d.copies ?? []).map((c) => ({ ...c, documentTitle: titles.get(c.documentId) ?? null })),
    thread: { key, position: Math.max(1, position), count: Math.max(1, rows.length) },
  };
}

/** The thread keys of the messages read out of one document (for the document page and the assistant). */
export function threadKeysForDocument(documentId: string): string[] {
  const rows = liveRows(eq(schema.communications.documentId, documentId));
  return [...new Set(rows.map((r) => r.threadKey).filter((k): k is string => Boolean(k)))].sort();
}

// ---------------------------------------------------------------------------
// Follow-ups worked out from the replies (rows read out of records only)
// ---------------------------------------------------------------------------

/** A care-team sentence that promises a next step ("I will call you tomorrow", "We'll send the order"). */
const PROMISE = /\b(?:i|we)(?:'ll|’ll| will| am going to| are going to| plan to| can)\s+(?:call|send|order|place|put in|schedule|refer|follow up|get back|let you know|reach out|check|review|fax|forward|contact|talk|discuss|arrange|request|see you|have (?:the|a|our|someone))\b/i;

/** The first promise sentence of a body, verbatim (trimmed), or null. */
export function promiseIn(body: string | null | undefined): string | null {
  const text = body ?? '';
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const s = sentence.trim();
    if (s.length >= 8 && PROMISE.test(s)) return s.slice(0, 2000);
  }
  return null;
}

/** Words of a promise that say nothing of what was promised ("I will call you tomorrow ..."). */
const PROMISE_FILLER = new Set([
  'will', 'call', 'calls', 'called', 'calling', 'you', 'your', 'yours', 'send', 'sent', 'order', 'place', 'put', 'schedule', 'refer', 'follow',
  'get', 'back', 'let', 'know', 'reach', 'out', 'check', 'review', 'fax', 'forward', 'contact', 'talk', 'discuss', 'arrange', 'request',
  'see', 'have', 'someone', 'our', 'going', 'plan', 'can', 'today', 'tomorrow', 'tonight', 'morning', 'afternoon', 'evening', 'week',
  'next', 'soon', 'later', 'when', 'once', 'this', 'that', 'them', 'they', 'him', 'her', 'with', 'about', 'for', 'and', 'the', 'from',
  'thanks', 'thank', 'hello', 'dear', 'again', 'let\'s', 'we\'ll', 'i\'ll', 'shortly', 'asap', 'some', 'more', 'information', 'info', 'update',
]);

/** The words of a promise that name what it is about ("MRI", "infusion", "taper"). */
function promiseWords(promise: string): Set<string> {
  const out = new Set<string>();
  for (const t of descriptionTokens(promise)) if (!PROMISE_FILLER.has(t)) out.add(t);
  return out;
}

/**
 * Does a later row of the thread keep a care-team promise? It comes from the care team, is addressed to the patient
 * (a portal reply, or a call with him: never a call to a pharmacy or another office, `third_party`), and says something
 * about what was promised (shares a word of it, "MRI", "results"). A promise that names nothing ("I will call you
 * back") is kept by the next care-team message or call to the patient. 2026-10-07 review, rev-comms #4.
 */
export function keepsPromise(promise: string, later: Pick<Row, 'direction' | 'channel' | 'body' | 'summary' | 'subject'>, det: CommunicationDetails): boolean {
  const careTeam = det.voice ? det.voice === 'clinician' || det.voice === 'staff' : later.direction === 'inbound' || later.direction === 'third_party';
  if (!careTeam) return false;
  if (later.direction === 'third_party' || later.direction === 'outbound') return false;
  if (later.channel === 'call' ? !['bidirectional', 'inbound'].includes(later.direction) : later.direction !== 'inbound') return false;
  const words = promiseWords(promise);
  if (!words.size) return true;
  const theirs = descriptionTokens([later.body, later.summary].filter(Boolean).join(' '));
  for (const w of words) if (theirs.has(w)) return true;
  return false;
}

/** The person who wrote a row (its `from` participant), or null. */
function authorPersonId(commId: string): string | null {
  return (
    db()
      .select({ personId: schema.communicationParticipants.personId })
      .from(schema.communicationParticipants)
      .where(and(eq(schema.communicationParticipants.communicationId, commId), eq(schema.communicationParticipants.role, 'from')))
      .get()?.personId ?? null
  );
}

/**
 * Works out the follow-ups of the rows read out of records in these threads: a care-team promise is `follow_up_promised`
 * (cited on its page), done when a later care-team message or call of the thread came (`follow_up_done_at`, with the
 * row that settled it); a stale model summary (made before the thread's newest message arrived) is cleared so it can be
 * written again. Never a field the user changed, never a row logged by hand or filed. Returns rows changed.
 */
export function refreshThreads(keys: readonly string[]): number {
  let changed = 0;
  const d = db();
  for (const key of new Set(keys)) {
    if (!key || key.startsWith('c_')) continue;
    const rows = threadRows(key);
    if (!rows.length) continue;
    const newest = rows.reduce((m, r) => (r.createdAt > m ? r.createdAt : m), '');
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const det = parseCommunicationDetails(r.detailsJson);
      let next: CommunicationDetails = det;
      const set: Partial<typeof schema.communications.$inferInsert> = {};
      if (det.modelSummary && det.modelSummary.at < newest) next = { ...next, modelSummary: null };
      if (det.origin === 'extracted' && isCareTeam(r, det) && !det.userFields?.includes('followUpPromised')) {
        const promise = promiseIn(r.body);
        if (promise) {
          const later = rows.slice(i + 1).find((x) => keepsPromise(promise, x, parseCommunicationDetails(x.detailsJson)));
          const doneAt = later ? `${later.occurredAt ?? ''}${later.occurredTime ? `T${later.occurredTime}` : ''}` || later.createdAt : null;
          const userDone = Boolean(det.userFields?.includes('followUpDone'));
          if (r.followUpPromised !== promise) set.followUpPromised = promise;
          if (!userDone && (r.followUpDoneAt ?? null) !== doneAt) set.followUpDoneAt = doneAt;
          if (!det.userFields?.includes('followUpOwnerPersonId') && !r.followUpOwnerPersonId) {
            const owner = authorPersonId(r.id);
            if (owner) set.followUpOwnerPersonId = owner;
          }
          // The user's word on it outranks the replies: a follow-up he reopened names no row that settled it (rev-comms #9).
          const prevDoneBy = ((det as Record<string, unknown>).followUp as { doneByCommunicationId?: string | null } | undefined)?.doneByCommunicationId ?? null;
          const doneBy = userDone ? (r.followUpDoneAt ? prevDoneBy : null) : (later?.id ?? null);
          next = { ...next, followUp: { source: 'replies', promise, doneByCommunicationId: doneBy } } as CommunicationDetails;
          if (set.followUpPromised && r.documentId) {
            // The promise is cited on the page that prints it.
            const page = (det.pages && det.pages[0]) || det.headerPage || 1;
            const forms = pageTextFormsLookup(r.documentId);
            insertVerifiedCommunicationCitation(r.id, { documentId: r.documentId, pageNumber: page, quote: promise.slice(0, 1000) }, (n) => forms(n)?.stored, [(n) => forms(n)?.visual ?? undefined]);
          }
        } else if ((det as Record<string, unknown>).followUp && r.followUpPromised) {
          // A promise worked out before that the body no longer holds (a re-read): taken back.
          set.followUpPromised = null;
          if (!det.userFields?.includes('followUpDone')) set.followUpDoneAt = null;
          const { followUp: _f, ...rest } = det as Record<string, unknown>;
          void _f;
          next = rest as CommunicationDetails;
        }
      }
      const nextJson = JSON.stringify(next);
      if (!sameJson(nextJson, r.detailsJson)) set.detailsJson = nextJson;
      if (Object.keys(set).length) {
        d.update(schema.communications).set({ ...set, updatedAt: nowIso() }).where(eq(schema.communications.id, r.id)).run();
        reindexCommunication(r.id);
        changed++;
      }
    }
  }
  return changed;
}


// ---------------------------------------------------------------------------
// Calls that name a message ("Dr. Example messaged 9:05 am")
// ---------------------------------------------------------------------------

const MENTION = /\b(messag\w*|sent|replied|reply|wrote|offered|portal|mychart|responded|answered)\b[^.\n]{0,60}?\(?\b(\d{1,2}:\d{2}\s*[ap]\.?\s*m\.?)/gi;

function toHm(t: string): string | null {
  const m = t.trim().match(/^(\d{1,2}):(\d{2})\s*([ap])/i);
  if (!m) return null;
  let h = Number(m[1]);
  const pm = m[3].toLowerCase() === 'p';
  if (h < 1 || h > 12) return null;
  if (h === 12) h = pm ? 12 : 0;
  else if (pm) h += 12;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

function addMention(commId: string, m: CommMention): boolean {
  const row = db().select({ detailsJson: schema.communications.detailsJson }).from(schema.communications).where(eq(schema.communications.id, commId)).get();
  if (!row) return false;
  const det = parseCommunicationDetails(row.detailsJson);
  const list = [...(det.mentions ?? [])];
  if (list.some((x) => x.kind === m.kind && x.communicationId === m.communicationId)) return false;
  list.push(m);
  db().update(schema.communications).set({ detailsJson: JSON.stringify({ ...det, mentions: list }) }).where(eq(schema.communications.id, commId)).run();
  return true;
}

/**
 * A call record the patient filed (a call logged from a document, not read out of a record) that names a message by
 * its time ("messaged 9:05 am", "offered (3:40 pm)") is linked to the message sent within 10 minutes on the call's day
 * (or the day before): `mentions` on both rows, status `suggested` (the user confirms). Returns links added.
 */
export function linkCallMentions(opts: { documentId?: string | null } = {}): number {
  void opts;
  let added = 0;
  const calls = liveRows(and(eq(schema.communications.channel, 'call'), sql`coalesce(json_extract(${schema.communications.detailsJson}, '$.origin'), 'manual') <> 'extracted'`)).filter((r) => r.documentId && r.occurredAt && r.occurredAt.length === 10);
  if (!calls.length) return 0;
  // Portal messages whose time of day a record printed (read out of a record, or a filed copy that gained it).
  const messages = liveRows(eq(schema.communications.channel, 'portal')).filter((r) => r.occurredAt && r.occurredTime);
  if (!messages.length) return 0;
  for (const call of calls) {
    const pages = db().select({ pageNumber: schema.documentPages.pageNumber, text: schema.documentPages.text }).from(schema.documentPages).where(eq(schema.documentPages.documentId, call.documentId!)).orderBy(schema.documentPages.pageNumber).all();
    for (const p of pages) {
      for (const m of p.text.matchAll(MENTION)) {
        const hm = toHm(m[2]);
        if (!hm) continue;
        for (const msg of messages) {
          const gap = minutesBetween({ date: msg.occurredAt, time: msg.occurredTime }, { date: call.occurredAt, time: hm });
          // The call names a time on its own day, or the day before (a call in the morning about last night's message).
          const gapDayBefore = minutesBetween({ date: msg.occurredAt, time: msg.occurredTime }, { date: shiftDay(call.occurredAt!, -1), time: hm });
          const ok = (gap !== null && Math.abs(gap) <= COPY_TIME_TOLERANCE_MIN) || (gapDayBefore !== null && Math.abs(gapDayBefore) <= COPY_TIME_TOLERANCE_MIN);
          if (!ok) continue;
          const text = m[2].trim();
          const det = parseCommunicationDetails(msg.detailsJson);
          if (addMention(msg.id, { kind: 'mentioned_by', communicationId: call.id, documentId: call.documentId, page: p.pageNumber, text, status: 'suggested' })) added++;
          addMention(call.id, { kind: 'mentions', communicationId: msg.id, documentId: msg.documentId, page: det.headerPage ?? det.pages?.[0] ?? null, text, status: 'suggested' });
        }
      }
    }
  }
  return added;
}

function shiftDay(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}



/** All rows of a thread (live), oldest first (for the report and the assistant). */
export function threadMessages(key: string): Row[] {
  return threadRows(key);
}



// ---------------------------------------------------------------------------
// The model's summary of a thread (labelled "Model summary"; never written into `summary`)
// ---------------------------------------------------------------------------

const threadSummarySchema = z.object({ summary: z.string().min(1).max(2000) });

const SUMMARY_SYSTEM = [
  'You summarise one thread of messages and calls from a patient\'s medical records for the patient and his chief of staff.',
  'Write two to four plain sentences: what was asked, what the care team answered or did, what was decided, and what is still open.',
  'Say who wrote what (the patient, or the named clinician or staff member). Use only what the messages say: no advice, no guesses, no diagnosis.',
  'Keep dates and times as written. Do not copy long passages.',
].join('\n');

/**
 * Asks the model for a short summary of a thread (on request: the user opens a thread and asks, or the clinician
 * does). Stored as `details.modelSummary` on the thread's first message, labelled as the model's (never in `summary`);
 * cleared again by refreshThreads when a newer message arrives, so it is written again from all the sources. Throws
 * 404 for an unknown thread and 409 when the model is switched off.
 */
export async function summarizeThread(key: string, opts: { deep?: boolean; signal?: AbortSignal } = {}): Promise<ThreadView> {
  const rows = threadRows(key);
  if (!rows.length) throw notFound(`thread ${key.slice(0, 40)} not found`);
  if (!aiEnabled()) throw conflict('Claude is switched off (Settings), so it cannot summarise this thread');
  const lines = rows.map((r, i) => {
    const det = parseCommunicationDetails(r.detailsJson);
    const who = det.voice === 'patient' ? 'the patient' : (det.authorText ?? (r.channel === 'call' ? 'a call' : 'unknown author'));
    const to = det.recipientText ? ` to ${det.recipientText}` : '';
    const when = [r.occurredAtText ?? r.occurredAt, r.occurredTime].filter(Boolean).join(' ');
    const text = (r.body ?? r.summary ?? '').slice(0, 6000);
    return `[${i + 1}] ${when} - ${r.channel} from ${who}${to}${det.voice ? ` (${det.voice})` : ''}\n${text}`;
  });
  const { data, callId, model } = await callStructured({
    purpose: 'briefing',
    system: SUMMARY_SYSTEM,
    messages: [{ role: 'user', content: `Subject: ${rows[0].subject}\n\n${lines.join('\n\n')}`.slice(0, 120_000) }],
    schema: threadSummarySchema,
    deep: Boolean(opts.deep),
    maxTokens: 800,
    documentIds: documentIdsOf(rows).slice(0, 20),
    requestSummary: `thread summary (${rows.length} messages)`,
    signal: opts.signal,
  });
  const first = rows[0];
  const det = parseCommunicationDetails(first.detailsJson);
  const next: CommunicationDetails = { ...det, modelSummary: { text: data.summary.trim(), runId: callId, model, at: nowIso() } };
  db().update(schema.communications).set({ detailsJson: JSON.stringify(next) }).where(eq(schema.communications.id, first.id)).run();
  return getThread(key);
}
