/**
 * Conversations read out of records (2026-10-07, large exports): a hospital chart print holds the portal messages,
 * telephone notes, letters and questionnaires of every visit. Calls and messages keeps each one as its own row and
 * shows them as threads, collapsed to one row each, so hundreds of messages never flood the list.
 *
 *   ThreadPane    the right pane for one thread: subject, how many messages and when, the outcome (yours, or worked
 *                 out from the replies), a model summary (labelled), then the messages oldest first as a table
 *                 (j/k move, Esc goes back to the list) and, under it, the selected message in full
 *   MessageBlock  one message: whose words (yours or the care team's), from and to as printed (often a nurse pool
 *                 "supporting" a clinician), when, read receipts, the words exactly as printed, the pages it is on
 *                 (each opens the page), and the copies of it filed separately
 *
 * The server's thread and message views (GET /api/communications/threads/:key, /:id/message) are used when present;
 * until then the same is worked out from the communications list (body, details_json), so the pane never goes
 * blank. Nothing here edits a message: the record's words are never changed.
 */
import { useEffect, useMemo, useRef } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { DataTable, type ColumnDef } from '../../ui/DataTable';
import { DetailHeader, DetailPane, KeyFacts, type KeyFact } from '../../ui/DetailPane';
import { DateText } from '../../ui/DateText';
import { Loading, Section } from '../../ui/PageHeader';
import { Tag, type TagTone } from '../../ui/StatusTag';
import { Kbd } from '../../ui/Kbd';
import { useBindings } from '../../app/shortcuts';
import { useRegisterCommands } from '../../app/commands';
import { detailsOf, isFromRecords, useMessage, useThread, type Communication, type CommunicationDetails, type MessageView, type ThreadListItem, type ThreadView } from '../../api/communications';
import { directionWords, messageKindWords, plural, voiceWords } from '../people/shared';
import { dateSortKey } from '@shared/dates';
import { authorWithRole as withRole } from '@shared/schemas/segments';
import { useSettings } from '../../api/hooks';

/** A message line of a thread, from the server's view or worked out from a communication row. */
export interface ThreadLine {
  id: string;
  occurredAt: string | null;
  occurredAtPrecision?: string;
  occurredAtText: string | null;
  occurredTime: string | null;
  direction: string;
  voice: string | null;
  authorText: string | null;
  recipientText: string | null;
  snippet: string;
  pages: [number, number] | null;
  documentId: string | null;
  readAtText: string | null;
  copies: number;
}

/** The tone of a voice tag: your own words stand apart from the care team's. */
export function voiceTone(v: string | null | undefined): TagTone {
  if (v === 'patient') return 'accent';
  if (v === 'clinician' || v === 'staff') return 'info';
  return 'neutral';
}

/** A message's first words, on one line. */
export function snippetOf(text: string | null | undefined, max = 160): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Oldest first: the day, the time printed, then (a record prints newest first) the printed order, then as logged. */
export function chronological<T extends Pick<Communication, 'occurredAt' | 'occurredTime' | 'createdAt' | 'id' | 'detailsJson'>>(rows: T[]): T[] {
  const printed = (r: T) => detailsOf(r).printedOrder ?? -1;
  return rows
    .slice()
    .sort(
      (a, b) =>
        dateSortKey(a.occurredAt).localeCompare(dateSortKey(b.occurredAt)) ||
        (a.occurredTime ?? '').localeCompare(b.occurredTime ?? '') ||
        printed(b) - printed(a) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
}

/** A communication row as a thread line. */
export function lineOf(c: Communication): ThreadLine {
  const d = detailsOf(c);
  return {
    id: c.id,
    occurredAt: c.occurredAt,
    occurredAtPrecision: c.occurredAtPrecision,
    occurredAtText: c.occurredAtText,
    occurredTime: c.occurredTime ?? null,
    direction: c.direction,
    voice: d.voice ?? null,
    authorText: d.authorText ?? (c.participants.find((p) => p.role === 'from')?.name ?? null),
    recipientText: d.recipientText ?? (c.participants.find((p) => p.role === 'to')?.name ?? null),
    snippet: snippetOf(c.body ?? c.summary ?? ''),
    pages: d.pages ?? null,
    documentId: c.documentId,
    readAtText: d.readReceipts?.[0]?.atText ?? null,
    copies: d.copies?.length ?? 0,
  };
}

/**
 * The threads of these communications (rows read out of records that carry a thread key), newest activity first: the
 * list the server gives, worked out on the page while the server has none.
 */
export function threadsFromCommunications(rows: Communication[]): ThreadListItem[] {
  const groups = new Map<string, Communication[]>();
  for (const c of rows) {
    if (!c.threadKey) continue;
    const list = groups.get(c.threadKey) ?? [];
    list.push(c);
    groups.set(c.threadKey, list);
  }
  const out: ThreadListItem[] = [];
  for (const [key, list] of groups) {
    const sorted = chronological(list);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    out.push({
      key,
      subject: first.subject,
      documentIds: [...new Set(sorted.map((c) => c.documentId).filter((x): x is string => Boolean(x)))],
      firstAt: first.occurredAt,
      lastAt: last.occurredAt,
      count: sorted.length,
      openFollowUps: sorted.filter((c) => c.followUpPromised && !c.followUpDoneAt).length,
      outcome: null,
      outcomeSource: 'none',
      lastSnippet: snippetOf(last.body ?? last.summary ?? ''),
      fromRecords: sorted.some((c) => isFromRecords(c)),
    });
  }
  return out.sort((a, b) => dateSortKey(b.lastAt).localeCompare(dateSortKey(a.lastAt)) || a.subject.localeCompare(b.subject));
}

/** "3/4 08:15": a date and the time the record printed. */
function When({ at, precision, text, time }: { at: string | null; precision?: string; text?: string | null; time: string | null }) {
  return (
    <span className="cm-when">
      <DateText iso={at} precision={precision} text={text} />
      {time ? <span className="mono"> {time}</span> : null}
    </span>
  );
}

/** "pp.50-51" / "p.48" as links to those pages of the record. */
function PageLinks({ documentId, pages }: { documentId: string | null; pages: [number, number] | null | undefined }) {
  const navigate = useNavigate();
  if (!documentId || !pages) return null;
  const [a, b] = pages;
  const go = (p: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    void navigate({ to: '/documents/$id', params: { id: documentId }, search: { page: p } });
  };
  return (
    <span className="cm-pages mono">
      {a === b ? 'p.' : 'pp.'}
      <a href={`/documents/${documentId}?page=${a}`} onClick={go(a)} title={`Open page ${a} of the record`}>
        {a}
      </a>
      {a !== b ? (
        <>
          -
          <a href={`/documents/${documentId}?page=${b}`} onClick={go(b)} title={`Open page ${b} of the record`}>
            {b}
          </a>
        </>
      ) : null}
    </span>
  );
}

export interface ThreadPaneProps {
  threadKey: string;
  /** The message shown in full under the table, or null. */
  selectedId: string | null;
  onSelectMessage: (id: string | null) => void;
  /** Back to the list on the left (Esc in the messages). */
  onBack: () => void;
  /** Every communication on the page, for working the thread out when the server has no thread view. */
  rows: Communication[];
  /** Changes when the keyboard should land in the messages (Enter on a thread in the list). */
  focusToken?: number;
  /**
   * Called once the messages took the keyboard, so the token is spent: the pane of the next thread (j after Esc) must
   * not take the keyboard again with the old token (2026-10-07 review, rev-comms #11).
   */
  onFocusTaken?: () => void;
}

export function ThreadPane({ threadKey, selectedId, onSelectMessage, onBack, rows, focusToken = 0, onFocusTaken }: ThreadPaneProps) {
  const server = useThread(threadKey);
  const local = useMemo(() => chronological(rows.filter((c) => c.threadKey === threadKey)), [rows, threadKey]);
  const view: ThreadView | null = server.data ?? null;
  const lines: ThreadLine[] = useMemo(() => (view?.messages.length ? view.messages.map((m) => ({ ...m, occurredAtPrecision: 'day', pages: m.pages ?? null })) : local.map(lineOf)), [view, local]);
  const subject = view?.subject ?? local[0]?.subject ?? 'Conversation';
  const fromRecords = local.some((c) => isFromRecords(c)) || Boolean(view?.messages.some((m) => m.documentId));
  const index = selectedId ? lines.findIndex((l) => l.id === selectedId) : -1;
  const first = lines[0];
  const last = lines[lines.length - 1];
  const docId = view?.documentIds[0] ?? local.find((c) => c.documentId)?.documentId ?? null;
  const docTitle = local.find((c) => c.documentId === docId)?.documentTitle ?? null;
  const tableWrap = useRef<HTMLDivElement>(null);
  // A message the patient sent prints no author ("Sent" is his): his name stands there (rev-comms #10).
  const patientLabel = useSettings().data?.['patient.name']?.trim() || 'You';

  const hasLines = lines.length > 0;
  useEffect(() => {
    if (!focusToken) return;
    const el = tableWrap.current?.querySelector<HTMLElement>('.table-wrap');
    if (!el) return;
    el.focus();
    onFocusTaken?.();
  }, [focusToken, hasLines, onFocusTaken]);

  const step = (delta: number) => {
    if (!lines.length) return;
    const next = index < 0 ? (delta > 0 ? 0 : lines.length - 1) : Math.max(0, Math.min(lines.length - 1, index + delta));
    onSelectMessage(lines[next].id);
  };
  useBindings(
    [
      { keys: ']', description: 'Next message in the conversation', group: 'Communications', run: () => step(1) },
      { keys: '[', description: 'Previous message in the conversation', group: 'Communications', run: () => step(-1) },
    ],
    [threadKey, index, lines.length],
  );
  useRegisterCommands(
    [
      { id: 'comms.thread.next', title: 'Next message in the conversation', group: 'Calls and messages', shortcut: ']', run: () => step(1), when: () => lines.length > 0 },
      { id: 'comms.thread.prev', title: 'Previous message in the conversation', group: 'Calls and messages', shortcut: '[', run: () => step(-1), when: () => lines.length > 0 },
    ],
    [threadKey, index, lines.length],
  );

  // Two columns so the pane's width goes to the words: when (date, then the time printed), and who with the start of
  // what they wrote under it.
  const columns = useMemo<ColumnDef<ThreadLine, unknown>[]>(
    () => [
      {
        id: 'when',
        header: 'When',
        accessorFn: (l) => `${dateSortKey(l.occurredAt)} ${l.occurredTime ?? ''}`,
        cell: (c) => (
          <span className="cm-when-stack">
            <DateText iso={c.row.original.occurredAt} precision={c.row.original.occurredAtPrecision} text={c.row.original.occurredAtText} />
            {c.row.original.occurredTime ? <span className="mono muted">{c.row.original.occurredTime}</span> : null}
          </span>
        ),
        meta: { width: 104, shrink: false },
      },
      {
        id: 'message',
        header: 'Message',
        accessorFn: (l) => `${l.authorText ?? ''} ${l.snippet}`,
        cell: (c) => (
          <span className="cm-line">
            <span className="cm-from">
              <span>{c.row.original.authorText ?? (c.row.original.voice === 'patient' ? patientLabel : <span className="faint">Not printed</span>)}</span>
              {c.row.original.voice ? <Tag tone={voiceTone(c.row.original.voice)}>{voiceWords(c.row.original.voice)?.toLowerCase()}</Tag> : null}
            </span>
            <span className="cm-line-words">{c.row.original.snippet}</span>
          </span>
        ),
        meta: { grow: true, minWidth: 220, wrap: false },
      },
    ],
    [patientLabel],
  );

  if (server.isPending && !local.length) return <Loading>Loading the conversation…</Loading>;

  const facts: KeyFact[] = [];
  if (docId)
    facts.push({
      label: 'In',
      wide: true,
      value: (
        <Link to="/documents" search={{ id: docId }}>
          {docTitle ?? 'Open the record'}
        </Link>
      ),
    });
  if (view?.outcome)
    facts.push({ label: view.outcomeSource === 'user' ? 'What came of it' : 'What came of it (from the replies)', wide: true, value: <span className="prewrap">{view.outcome}</span> });

  const selectedLine = index >= 0 ? lines[index] : null;
  return (
    <DetailPane label="Conversation" className="cm-thread">
      <DetailHeader
        eyebrow={
          <>
            <span>Conversation</span>
            {fromRecords ? <Tag tone="neutral">from the record</Tag> : null}
          </>
        }
        title={subject}
        status={[
          plural(lines.length, 'message'),
          first ? (
            <span key="span">
              <DateText iso={first.occurredAt} />
              {last && last.occurredAt !== first.occurredAt ? (
                <>
                  {' to '}
                  <DateText iso={last.occurredAt} />
                </>
              ) : null}
            </span>
          ) : null,
          view?.openFollowUps ? `${view.openFollowUps} follow-up${view.openFollowUps === 1 ? '' : 's'} open` : null,
        ]}
        facts={facts.length ? facts : undefined}
      />
      {view?.modelSummary?.text ? (
        <Section title="Model summary" intro="Written by Claude from the messages below; the messages themselves are the record.">
          <div className="prewrap">{view.modelSummary.text}</div>
        </Section>
      ) : null}
      <Section
        title="Messages"
        count={lines.length}
        intro={
          <>
            Oldest first, as sent. <Kbd>j</Kbd>/<Kbd>k</Kbd> move, <Kbd>[</Kbd>/<Kbd>]</Kbd> from anywhere, <Kbd>Esc</Kbd> back to the list.
          </>
        }
      >
        <div className="cm-thread-table" ref={tableWrap}>
          <DataTable
            columns={columns}
            data={lines}
            rowId={(l) => l.id}
            selectedId={selectedId}
            onSelect={(l) => onSelectMessage(l?.id ?? null)}
            onOpen={(l) => onSelectMessage(l.id)}
            initialSort={[]}
            tableId="communications.thread"
            onKey={(e) => {
              if (e.key === 'Escape') {
                onBack();
                return true;
              }
              return false;
            }}
            emptyText="No messages in this conversation."
          />
        </div>
      </Section>
      {selectedLine ? <MessageBlock key={selectedLine.id} id={selectedLine.id} row={local.find((c) => c.id === selectedLine.id) ?? null} position={{ n: index + 1, of: lines.length }} /> : null}
    </DetailPane>
  );
}

/** A message in full: the server's message view, or the communication row when the server has none. */
export function MessageBlock({ id, row, position }: { id: string; row: Communication | null; position?: { n: number; of: number } }) {
  const q = useMessage(id);
  const m: MessageView | null = q.data ?? null;
  if (q.isPending && !row) return <Loading>Loading the message…</Loading>;
  const d: CommunicationDetails = m?.details ?? detailsOf(row);
  const body = m ? m.body : (row?.body ?? null);
  const docId = m?.documentId ?? row?.documentId ?? null;
  const docTitle = m?.documentTitle ?? row?.documentTitle ?? null;
  const at = m?.occurredAt ?? row?.occurredAt ?? null;
  const time = m?.occurredTime ?? row?.occurredTime ?? null;
  const direction = m?.direction ?? row?.direction ?? '';
  const subject = m?.subject ?? row?.subject ?? '';
  const copies = m?.copies ?? (d.copies ?? []).map((c) => ({ ...c, documentTitle: null as string | null }));
  const facts: KeyFact[] = [];
  if (d.authorText) facts.push({ label: 'From', value: withRole(d.authorText, d.authorRole) });
  if (d.recipientText) facts.push({ label: 'To', value: d.recipientText, title: d.intendedFor ? `Sent to a team that supports ${d.intendedFor}` : undefined });
  if (d.sentLabel) facts.push({ label: 'As printed', value: d.sentText ? `${d.sentLabel} ${d.sentText}` : d.sentLabel });
  if (docId)
    facts.push({
      label: 'In the record',
      wide: true,
      value: (
        <span>
          <Link to="/documents" search={{ id: docId }}>
            {docTitle ?? 'Open the record'}
          </Link>{' '}
          <PageLinks documentId={docId} pages={d.pages ?? null} />
        </span>
      ),
    });
  if (d.encounterHeader) facts.push({ label: 'Visit', wide: true, value: d.encounterHeader });
  return (
    <div className="cm-message">
      <DetailHeader
        eyebrow={
          <>
            <span>{messageKindWords(d.kind) ?? 'Message'}</span>
            {d.voice ? <Tag tone={voiceTone(d.voice)}>{voiceWords(d.voice)?.toLowerCase()}</Tag> : null}
            {d.unverified ? <Tag tone="warn" title="Read from a layout not yet checked against a real file">not checked yet</Tag> : null}
          </>
        }
        title={subject}
        status={[
          <When key="when" at={at} text={m?.occurredAtText ?? row?.occurredAtText ?? null} time={time} />,
          direction ? directionWords(direction) : null,
          position ? `${position.n} of ${position.of}` : null,
        ]}
        facts={facts}
      />
      <Section title="The message, word for word" intro={d.voice === 'patient' ? 'Your own words as the record printed them. What you said here counts as yours, not as the clinical record.' : 'Exactly as the record printed it; nothing is changed.'}>
        {body?.trim() ? <div className="prewrap cm-body">{body}</div> : <p className="muted">No words were printed with it.</p>}
      </Section>
      {d.readReceipts?.length ? (
        <Section title="Read" count={d.readReceipts.length}>
          <ul className="cm-list">
            {d.readReceipts.map((r, i) => (
              <li key={i}>
                Read {r.atText} by {r.byText}{' '}
                <PageLinks documentId={docId} pages={[r.page, r.page]} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {copies.length ? (
        <Section title="Copies of it" count={copies.length} intro="The same message kept elsewhere; one message, not two.">
          <ul className="cm-list">
            {copies.map((c, i) => (
              <li key={i}>
                {c.kind === 'filed_copy' ? 'Filed separately as ' : 'Also printed in '}
                <Link to="/documents" search={{ id: c.documentId }}>
                  {c.documentTitle ?? 'another document'}
                </Link>
                {c.pages ? (
                  <>
                    {' '}
                    <PageLinks documentId={c.documentId} pages={c.pages} />
                  </>
                ) : null}
                {c.minutesApart != null ? <span className="muted"> ({c.minutesApart} minute{c.minutesApart === 1 ? '' : 's'} apart)</span> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {d.mentions?.filter((x) => x.status !== 'declined').length ? (
        <Section title="Linked calls and records" intro="A call record or message that names this one. A suggested link waits for you; nothing is joined on its own.">
          <ul className="cm-list">
            {d.mentions
              .filter((x) => x.status !== 'declined')
              .map((x, i) => (
                <li key={i}>
                  {x.kind === 'mentioned_by' ? 'Named by ' : 'Names '}
                  {x.communicationId ? (
                    <Link to="/communications" search={{ id: x.communicationId }}>
                      {x.text ? `“${x.text}”` : 'a call or message'}
                    </Link>
                  ) : x.documentId ? (
                    <PageLinks documentId={x.documentId} pages={x.page ? [x.page, x.page] : null} />
                  ) : (
                    'another record'
                  )}
                  {x.status === 'suggested' ? <span className="muted"> (suggested)</span> : null}
                </li>
              ))}
          </ul>
        </Section>
      ) : null}
      {d.modelSummary?.text ? (
        <Section title="Model summary" intro="Written by Claude from the message; the words above are the record.">
          <div className="prewrap">{d.modelSummary.text}</div>
        </Section>
      ) : null}
      {m?.summary || row?.summary ? (
        <Section title="What you wrote about it">
          <div className="prewrap">{m?.summary ?? row?.summary}</div>
        </Section>
      ) : null}
    </div>
  );
}
