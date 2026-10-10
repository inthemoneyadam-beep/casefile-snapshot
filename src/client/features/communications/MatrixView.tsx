import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import type { MatrixData } from '../../api/communications';
import { DataTable, type ColumnDef } from '../../ui/DataTable';
import { DateText } from '../../ui/DateText';
import { DetailHeader, DetailPane } from '../../ui/DetailPane';
import { Section } from '../../ui/PageHeader';
import { Tag } from '../../ui/StatusTag';
import { formatPartialDate } from '@shared/dates';
import { plural } from '../people/shared';
import { NO_TOPIC_WORDS, pivot, topicWords, type MatrixRow } from './matrix';

/**
 * By person: one row per person, one column per topic. Each cell shows how
 * many calls and messages, the last date and any open follow-ups; clicking a
 * cell lists them. j/k move between people, Enter lists every call and message
 * with the selected person.
 */
export function MatrixView({ data, selectedPersonId, onSelectPerson, onOpenCell }: { data: MatrixData; selectedPersonId: string | null; onSelectPerson: (personId: string | null) => void; onOpenCell: (personId: string, topic?: string) => void }) {
  const { rows, topics } = useMemo(() => pivot(data), [data]);

  const columns = useMemo<ColumnDef<MatrixRow, unknown>[]>(() => {
    const fixed: ColumnDef<MatrixRow, unknown>[] = [
      { id: 'name', header: 'Person', accessorKey: 'name', cell: (c) => <span>{c.row.original.name}</span>, meta: { grow: true, minWidth: 180 } },
      { id: 'total', header: 'All', accessorKey: 'total', meta: { className: 'num', width: 56 } },
      { id: 'open', header: 'Open follow-ups', accessorKey: 'open', cell: (c) => (c.row.original.open ? <Tag tone="warn">{c.row.original.open}</Tag> : <span className="faint">0</span>), meta: { className: 'num', width: 120 } },
      { id: 'last', header: 'Last contact', accessorFn: (r) => r.lastAt ?? '', cell: (c) => <DateText iso={c.row.original.lastAt} />, meta: { width: 110 } },
    ];
    const dynamic: ColumnDef<MatrixRow, unknown>[] = topics.map((t) => ({
      id: `t:${t.topic}`,
      header: () => <span title={`${plural(t.total, 'call or message', 'calls and messages')} about ${topicWords(t.topic)}`}>{topicWords(t.topic)}</span>,
      accessorFn: (r) => r.byTopic.get(t.topic)?.count ?? 0,
      cell: (c) => {
        const cell = c.row.original.byTopic.get(t.topic);
        if (!cell) return <div className="matrix-empty" aria-label="none" />;
        return (
          <div
            className="matrix-cell"
            role="button"
            tabIndex={-1}
            title={`${plural(cell.count, 'call or message', 'calls and messages')} with ${cell.name} about ${t.topic || 'no topic'}; last ${formatPartialDate(cell.lastAt)}${cell.openFollowUps ? `; ${plural(cell.openFollowUps, 'open follow-up')}` : ''}. Click to list them.`}
            onClick={(e) => {
              e.stopPropagation();
              onOpenCell(cell.personId, t.topic);
            }}
          >
            <span className="n">{cell.count}</span>
            <span className="when">{formatPartialDate(cell.lastAt)}</span>
            {cell.openFollowUps ? <span className="open">{cell.openFollowUps} open</span> : null}
          </div>
        );
      },
      meta: { className: 'cell num', width: 128 },
    }));
    return [...fixed, ...dynamic];
  }, [topics, onOpenCell]);

  return (
    <div className="matrix" style={{ display: 'contents' }}>
      <DataTable
        columns={columns}
        data={rows}
        rowId={(r) => r.personId}
        selectedId={selectedPersonId}
        onSelect={(r) => onSelectPerson(r?.personId ?? null)}
        onOpen={(r) => onOpenCell(r.personId)}
        initialSort={[{ id: 'total', desc: true }]}
        tableId="communications.by-person"
        autoFocus
        emptyText="No calls or messages name a person yet. Add who took part when you log one; this view fills in from there."
      />
    </div>
  );
}

/** The right pane of By person: the selected person's topics, each a link to the calls and messages behind it. */
export function PersonTopicsPane({ row, onOpenCell }: { row: MatrixRow; onOpenCell: (personId: string, topic?: string) => void }) {
  const cells = [...row.byTopic.values()].sort((a, b) => b.count - a.count || (a.topic === '' ? 1 : b.topic === '' ? -1 : a.topic.localeCompare(b.topic)));
  return (
    <DetailPane label="Calls and messages with this person">
      <DetailHeader
        eyebrow={<span>Person</span>}
        title={row.name}
        status={[plural(row.total, 'call or message', 'calls and messages'), row.lastAt ? <span key="last">last <DateText iso={row.lastAt} /></span> : null, row.open ? <Tag key="open" tone="warn">{plural(row.open, 'open follow-up')}</Tag> : null]}
        actions={{
          primary: { label: 'List them all', onClick: () => onOpenCell(row.personId), shortcut: 'enter', title: `Every call and message with ${row.name}` },
          secondary: [],
        }}
      />
      <Section title="By topic" count={cells.length} intro="Pick a topic to list the calls and messages about it.">
        <div className="ledger">
          {cells.map((cell) => (
            <button key={cell.topic} type="button" className="ledger-row cm-topic-row" onClick={() => onOpenCell(cell.personId, cell.topic)}>
              <span className="ledger-date">
                <DateText iso={cell.lastAt} />
              </span>
              <span className="cm-topic-name">{cell.topic ? cell.topic : <span className="muted">{NO_TOPIC_WORDS}</span>}</span>
              <span className="cm-topic-count">
                <span className="mono">{cell.count}</span>
                {cell.openFollowUps ? <Tag tone="warn">{cell.openFollowUps} open</Tag> : null}
              </span>
            </button>
          ))}
        </div>
      </Section>
      <p className="cm-logged">
        <Link to="/people" search={{ id: row.personId }}>
          Open {row.name} on People and places
        </Link>
      </p>
    </DetailPane>
  );
}
