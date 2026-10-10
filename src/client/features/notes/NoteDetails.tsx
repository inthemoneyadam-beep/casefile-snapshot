/**
 * The right-hand panes of My notes: one note with every entry read from it, one drug with what the notes say about it
 * and its timeline by source, and one entry. Each entry shows its quote (opening the page it came from), the date as
 * written and how it stands against the records.
 */
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { NoteEntry } from '@shared/notes';
import { DetailHeader, DetailPane } from '../../ui/DetailPane';
import { EmptyState, Loading, Section } from '../../ui/PageHeader';
import { DateText } from '../../ui/DateText';
import { Tag } from '../../ui/StatusTag';
import { Button } from '../../ui/Button';
import { useNoteDoc, useNoteDrug } from '../../api/notes';
import { errorMessage } from '../../api/client';
import { Lanes } from './Lanes';
import { READ_TONE, STANDING_TONE, dateFromWords, plural, readWords, standingWords } from './words';
import './notes.css';

export function StandingTag({ entry }: { entry: Pick<NoteEntry, 'standing' | 'answer' | 'standingWhy'> }) {
  if (entry.answer) return <Tag tone="accent" title={entry.standingWhy ?? undefined}>{entry.answer}</Tag>;
  return (
    <Tag tone={STANDING_TONE[entry.standing]} title={entry.standingWhy ?? undefined}>
      {standingWords(entry.standing)}
    </Tag>
  );
}

function QuoteLink({ e, children }: { e: Pick<NoteEntry, 'documentId' | 'page' | 'citationId'>; children: ReactNode }) {
  return (
    <Link to="/documents/$id" params={{ id: e.documentId }} search={{ page: e.page ?? undefined, cite: e.citationId ?? undefined }} className="cite" title="Open the page it came from">
      {children}
    </Link>
  );
}

/** Where to settle an entry that differs (or waits for the records): Reconciliation, at the right stage. */
function ReconcileLink({ e }: { e: NoteEntry }) {
  if (e.standing !== 'differs' && e.standing !== 'waiting') return null;
  const stage = e.standing === 'waiting' ? undefined : 'notes';
  if (e.drugKey && e.standing === 'waiting') {
    return (
      <Link to="/reconcile" search={{ tab: 'meds', id: e.drugKey }} title="The records disagree about this drug: settle that first">
        settle the records
      </Link>
    );
  }
  return (
    <Link to="/reconcile" search={{ stage, list: e.standing === 'waiting' ? 'waiting' : undefined, id: e.drugKey ? undefined : `fact:${e.factId}` }} title="Answer it under Records vs my notes">
      answer it
    </Link>
  );
}

export function EntryRow({ e, showNote = false }: { e: NoteEntry; showNote?: boolean }) {
  return (
    <div className="nt-entry">
      <div className="nt-entry-head">
        <Tag tone="neutral">{e.kind}</Tag>
        <DateText iso={e.date} precision={e.precision} text={e.dateText} />
        {showNote ? <span className="muted">{e.documentTitle}</span> : null}
      </div>
      <div>
        <StandingTag entry={e} />
      </div>
      <div className="nt-entry-statement">{e.statement}</div>
      {e.quote ? (
        <blockquote className="nt-quote">
          <QuoteLink e={e}>“{e.quote}”</QuoteLink>
          {e.page ? <span className="faint"> p.{e.page}</span> : null}
          {!e.verified ? <span className="faint"> (not found word for word on the page)</span> : null}
        </blockquote>
      ) : null}
      {e.standingWhy ? (
        <div className={`nt-why ${e.answer ? '' : e.standing}`}>
          {e.standingWhy} <ReconcileLink e={e} />
        </div>
      ) : (
        <div className="nt-why">
          <ReconcileLink e={e} />
        </div>
      )}
    </div>
  );
}

export function EntryList({ entries, showNote = false, empty }: { entries: NoteEntry[]; showNote?: boolean; empty: string }) {
  if (!entries.length) return <p className="nt-line">{empty}</p>;
  return (
    <div className="nt-entries">
      {entries.map((e) => (
        <EntryRow key={e.factId} e={e} showNote={showNote} />
      ))}
    </div>
  );
}

export function NoteDocPane({ id, onRead, canRead }: { id: string; onRead?: () => void; canRead: boolean }) {
  const q = useNoteDoc(id);
  if (q.isPending) return <Loading>Loading the note…</Loading>;
  if (q.isError) return <EmptyState title="That note is not here any more">{errorMessage(q.error)}</EmptyState>;
  const { note, entries } = q.data;
  const read = readWords(note);
  const from = dateFromWords(note.dateFrom);
  return (
    <DetailPane label={note.title}>
      <DetailHeader
        eyebrow="Your note"
        title={note.title}
        status={[
          <DateText key="d" iso={note.date} precision={note.precision} text={note.dateText} />,
          from ? <span key="f" className="faint">{from}</span> : null,
          <Tag key="r" tone={READ_TONE[read] ?? 'neutral'}>{read}</Tag>,
          note.likelyCopyOf ? <span key="c" className="muted">looks like a copy of {note.likelyCopyOf.title}</span> : null,
        ]}
        actions={
          <div className="row">
            <Link to="/documents/$id" params={{ id: note.id }} className="btn sm">
              Open the note
            </Link>
            {canRead && onRead && read === 'not read yet' ? (
              <Button size="sm" variant="accent" onClick={onRead} shortcut="r">
                Read it
              </Button>
            ) : null}
          </div>
        }
      />
      <Section title="What it says" count={entries.length}>
        <EntryList entries={entries} empty={read === 'read' ? 'Claude found nothing to note in it.' : 'Nothing read from it yet.'} />
      </Section>
    </DetailPane>
  );
}

export function DrugPane({ drugKey }: { drugKey: string }) {
  const q = useNoteDrug(drugKey);
  if (q.isPending) return <Loading>Loading what your notes say…</Loading>;
  if (q.isError) return <EmptyState title="Nothing here for that drug">{errorMessage(q.error)}</EmptyState>;
  const { name, entries, timeline } = q.data;
  const open = timeline?.disagreements.filter((d) => d.open).length ?? 0;
  const differ = timeline?.notes.filter((n) => n.standing === 'differs' && !n.answer).length ?? 0;
  return (
    <DetailPane label={name}>
      <DetailHeader
        eyebrow="What your notes say"
        title={name}
        status={[plural(entries.length, 'entry', 'entries'), open ? <span key="o" className="nt-bad">the records disagree</span> : null, differ ? <span key="d" className="nt-bad">{plural(differ, 'difference')} with the records</span> : null]}
        actions={
          timeline ? (
            <Link to="/reconcile" search={open ? { tab: 'meds', id: drugKey } : { stage: 'notes' }} className="btn sm">
              {open ? 'Settle the records' : 'Records vs my notes'}
            </Link>
          ) : null
        }
      />
      {timeline ? (
        <Section title="Timeline by source" intro="Each record and each of your notes, with the start, stop and doses it gives.">
          <Lanes timeline={timeline} />
        </Section>
      ) : null}
      <Section title="Your notes about it" count={entries.length}>
        <EntryList entries={entries} showNote empty="Nothing yet." />
      </Section>
    </DetailPane>
  );
}

export function EntryPane({ entry }: { entry: NoteEntry }) {
  return (
    <DetailPane label={entry.subject}>
      <DetailHeader eyebrow={entry.kind} title={entry.subject} status={[<DateText key="d" iso={entry.date} precision={entry.precision} text={entry.dateText} />, <StandingTag key="s" entry={entry} />]} />
      <Section title="From your note">
        <p className="nt-line">
          <Link to="/documents/$id" params={{ id: entry.documentId }}>
            {entry.documentTitle}
          </Link>
        </p>
        <EntryRow e={entry} />
      </Section>
    </DetailPane>
  );
}
