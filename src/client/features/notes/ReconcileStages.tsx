/**
 * Reconciliation in two stages (2026-10-09). The page keeps everything it had; on top:
 *
 *   Compare: Records vs records (1) | Records vs my notes (2)
 *
 * Records vs records holds the lists that were there (Needs a source, Inaccurate, Settled, Not backed yet) and one
 * more, Medications: each drug's timeline by source (every record and every note), where two records give a
 * different start, stop or dose. The user answers: This record is right, Both happened, This record is wrong.
 *
 * Records vs my notes: his notes against the records, for a topic only once the records' side of it is settled. To
 * answer: My notes are right (n), The records are right (r), Both are true (b), Not the same thing (x). Waiting on the
 * records: settle those first. Answered: each with Undo (z).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { dateSortKey } from '@shared/dates';
import { NOTES_ANSWERS, NOTES_ANSWER_KEYS, NOTES_ANSWER_WORDS, POINT_KIND_WORDS, RECORDS_ANSWER_WORDS, whenWords, type DrugSummary, type DrugTimeline, type NotesAnswer, type NotesItem, type RecordsDisagreement, type TimelinePoint } from '@shared/notes';
import { useDrugList, useDrugTimeline, useNotesCounts, useNotesItems, useTimelineMutations } from '../../api/notes';
import { useMe } from '../../api/users';
import { errorMessage } from '../../api/client';
import { useBindings } from '../../app/shortcuts';
import { useRegisterCommands } from '../../app/commands';
import { useDebouncedSearch } from '../../app/useDebouncedSearch';
import { dialogOpen } from '../../app/dom';
import { DataTable, type ColumnDef } from '../../ui/DataTable';
import { SplitView } from '../../ui/SplitView';
import { DetailHeader, DetailPane } from '../../ui/DetailPane';
import { EmptyState, Loading, PageHeader, Section } from '../../ui/PageHeader';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { DateText } from '../../ui/DateText';
import { Tag } from '../../ui/StatusTag';
import { useToast } from '../../ui/Toast';
import { SearchField, Segmented, Toolbar, ToolbarKeys, type SegmentOption } from '../../ui/Toolbar';
import { Lanes } from './Lanes';
import { plural } from './words';
import './notes.css';

export type Stage = 'records' | 'notes';
export const STAGE_WORDS: Record<Stage, string> = { records: 'Records vs records', notes: 'Records vs my notes' };
const STAGE_TITLE: Record<Stage, string> = {
  records: 'Where your clinical records disagree with each other. Settle these first.',
  notes: 'Your own notes against the records, once the records are settled.',
};

export interface ReconcileNav {
  stage?: Stage;
  tab?: 'needs' | 'inaccurate' | 'settled' | 'unbacked' | 'meds';
  list?: 'answer' | 'waiting' | 'answered';
  id?: string;
  q?: string;
  page?: number;
}

const INTRO = 'Every lab value, scan, procedure, event and medication date is checked against your clinical records automatically. Only what may need you is listed here.';

/** The switch between the two stages, with keys 1 and 2 (also in the palette). */
export function StageSwitch({ stage }: { stage: Stage }) {
  const navigate = useNavigate({ from: '/reconcile' });
  const counts = useNotesCounts();
  const go = (s: Stage) => void navigate({ search: () => (s === 'records' ? {} : { stage: 'notes' as const }) });
  useBindings(
    [
      { keys: '1', description: 'Records vs records', group: 'Lists', run: () => !dialogOpen() && go('records') },
      { keys: '2', description: 'Records vs my notes', group: 'Lists', run: () => !dialogOpen() && go('notes') },
    ],
    [],
  );
  useRegisterCommands(
    [
      { id: 'reconcile.stage.records', title: 'Reconciliation: records vs records', group: 'Reconciliation', shortcut: '1', keywords: 'reconcile records disagree stage', run: () => go('records') },
      { id: 'reconcile.stage.notes', title: 'Reconciliation: records vs my notes', group: 'Reconciliation', shortcut: '2', keywords: 'reconcile notes personal differ stage', run: () => go('notes') },
    ],
    [],
  );
  const c = counts.data;
  return (
    <Segmented<Stage>
      label="Compare"
      value={stage}
      onChange={go}
      options={[
        { value: 'records', label: STAGE_WORDS.records, title: STAGE_TITLE.records },
        { value: 'notes', label: STAGE_WORDS.notes, count: c ? c.toAnswer : undefined, title: STAGE_TITLE.notes },
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// Stage 1, Medications
// ---------------------------------------------------------------------------

function PointLine({ p, children }: { p: TimelinePoint; children?: ReactNode }) {
  return (
    <div className={`nt-point${p.answer?.answer === 'wrong' ? ' wrong' : ''}`}>
      <span className="nt-point-title">
        <Link to="/documents/$id" params={{ id: p.documentId }} search={{ page: p.page ?? undefined, cite: p.citationId ?? undefined }} title="Open the page it came from">
          {p.documentTitle}
        </Link>
      </span>
      {p.page ? <span className="faint">p.{p.page}</span> : null}
      {p.quote ? <span className="muted">“{p.quote}”</span> : null}
      {p.answer ? <Tag tone={p.answer.answer === 'wrong' ? 'ash' : 'accent'}>{p.answer.stage === 1 ? RECORDS_ANSWER_WORDS[p.answer.answer as 'right'] : NOTES_ANSWER_WORDS[p.answer.answer as NotesAnswer]}</Tag> : null}
      {children}
    </div>
  );
}

function disagreementTitle(d: RecordsDisagreement): string {
  return `${POINT_KIND_WORDS[d.kind]}${d.date ? ` on ${whenWords(d.date)}` : ''}: ${d.open ? 'the records disagree' : d.how === 'chosen' ? 'you chose one record' : d.how === 'both' ? 'you said both happened' : 'you said a record is wrong'}`;
}

/** Every answer id written on this drug's points (Undo takes the newest back). */
function answerIds(t: DrugTimeline): Array<{ id: string; at: string }> {
  const seen = new Map<string, string>();
  for (const l of t.lanes) for (const p of l.points) if (p.answer) seen.set(p.answer.id, p.answer.at);
  return [...seen.entries()].map(([id, at]) => ({ id, at })).sort((a, b) => b.at.localeCompare(a.at));
}

export function DrugTimelinePane({ drugKey, keys = false }: { drugKey: string; keys?: boolean }) {
  const q = useDrugTimeline(drugKey);
  const m = useTimelineMutations();
  const toast = useToast();
  const canWrite = useMe().canWrite;
  const t = q.data;
  const latest = useRef(t);
  latest.current = t;
  const answer = (d: RecordsDisagreement, a: 'right' | 'both' | 'wrong', p?: TimelinePoint) =>
    m.records.mutate({ disagreementKey: d.key, answer: a, pointId: p?.id ?? null }, { onSuccess: (r) => toast(r.words, 'ok'), onError: (err) => toast(errorMessage(err), 'bad') });
  const undoLast = () => {
    const ids = latest.current ? answerIds(latest.current) : [];
    if (!ids.length) return;
    m.undoRecords.mutate(ids[0].id, { onSuccess: () => toast('Your last answer on this drug is taken back.', 'ok'), onError: (err) => toast(errorMessage(err), 'bad') });
  };
  const bothOnFirst = () => {
    const d = latest.current?.disagreements.find((x) => x.open);
    if (d) answer(d, 'both');
  };
  useBindings(
    keys
      ? [
          { keys: 'b', description: 'Both happened (the first open disagreement)', group: 'Page', when: () => canWrite && !dialogOpen() && Boolean(latest.current?.disagreements.some((x) => x.open)), run: bothOnFirst },
          { keys: 'z', description: 'Undo my last answer on this drug', group: 'Page', when: () => canWrite && !dialogOpen() && Boolean(latest.current && answerIds(latest.current).length), run: undoLast },
        ]
      : [],
    [keys, canWrite],
  );
  if (q.isPending) return <Loading>Loading the timeline…</Loading>;
  if (q.isError || !t) return <EmptyState title="Nothing here for that drug">{q.error ? errorMessage(q.error) : 'Pick another.'}</EmptyState>;
  const open = t.disagreements.filter((d) => d.open);
  const answered = answerIds(t).length > 0;
  return (
    <DetailPane label={t.name}>
      <DetailHeader
        eyebrow="Medication timeline"
        title={t.name}
        status={[open.length ? <span key="o" className="nt-bad">{plural(open.length, 'disagreement')} to settle</span> : <span key="s">the records agree</span>, `${plural(t.lanes.filter((l) => l.tier === 'record').length, 'record')}, ${plural(t.lanes.filter((l) => l.tier === 'note').length, 'note')} of yours`]}
        actions={
          canWrite && answered ? (
            <Button size="sm" onClick={undoLast} disabled={m.busy} shortcut="z">
              Undo my last answer
            </Button>
          ) : null
        }
      />
      <Section title="Each source" intro="Every record and every note of yours that gives a start, stop or dose.">
        <Lanes timeline={t} />
      </Section>
      {t.disagreements.length ? (
        <Section title="Where the records disagree" count={open.length || undefined}>
          {t.disagreements.map((d) => (
            <div key={d.key} className={`nt-dis${d.open ? ' open' : ''}`}>
              <div className="nt-dis-title">{disagreementTitle(d)}</div>
              {d.groups.map((g, i) => (
                <div key={i} className="nt-group">
                  <div className="nt-group-says">{g.says}</div>
                  <div className="nt-group-points">
                    {g.points.map((p) => (
                      <PointLine key={p.id} p={p}>
                        {canWrite && !p.answer ? (
                          <span className="row">
                            <Button size="sm" variant={d.open ? 'accent' : 'default'} onClick={() => answer(d, 'right', p)} disabled={m.busy} title="This record gives the right date; the other stays as written">
                              This record is right
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => answer(d, 'wrong', p)} disabled={m.busy} title="This record is wrong here; it stays as written and is marked">
                              This record is wrong
                            </Button>
                          </span>
                        ) : null}
                      </PointLine>
                    ))}
                  </div>
                </div>
              ))}
              {canWrite && d.open ? (
                <div className="row nt-gap-top">
                  <Button size="sm" onClick={() => answer(d, 'both')} disabled={m.busy} shortcut={keys ? 'b' : undefined} title="Both are right: two courses, or two doses">
                    Both happened
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </Section>
      ) : null}
      <Section title="Settled timeline" intro="What Medications shows once you answered, with who said each date. The records stay as written.">
        {t.settled.starts.length || t.settled.stops.length ? (
          <ul className="nt-lanes-words">
            {[...t.settled.starts, ...t.settled.stops].map((s, i) => (
              <li key={i}>
                <strong>{s.kind === 'start' ? 'Started' : 'Stopped'} {whenWords(s.date, s.precision)}</strong> {s.who}
                {s.recordsSaid ? <span className="muted"> (the records say {whenWords(s.recordsSaid.date)})</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="nt-line">{open.length ? 'Nothing settled while the records disagree.' : 'No record gives a start or stop.'}</p>
        )}
      </Section>
      {t.notes.length ? (
        <Section title="Your notes against it">
          <ul className="nt-lanes-words">
            {t.notes.map((n) => (
              <li key={n.key}>
                <strong>{POINT_KIND_WORDS[n.point.kind]}</strong> {n.point.kind === 'dose' ? `${n.point.dose ?? ''} on ` : ''}
                {whenWords(n.point.date, n.point.precision)}: {n.answer ? NOTES_ANSWER_WORDS[n.answer.answer as NotesAnswer] : n.standing === 'waiting' ? 'waits for the records' : n.standing === 'differs' ? <Link to="/reconcile" search={{ stage: 'notes', id: n.key }}>differs: answer it</Link> : n.standing === 'agrees' ? 'agrees' : 'nothing to compare'}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </DetailPane>
  );
}

export function MedsTab({ search, recordsTabs, onRecordsTab }: { search: ReconcileNav; recordsTabs: SegmentOption<string>[]; onRecordsTab: (t: string) => void }) {
  const navigate = useNavigate({ from: '/reconcile' });
  const [only, setOnly] = useState<'open' | 'all'>('all');
  const list = useDrugList(only, search.q || undefined);
  const rows = useMemo(() => list.data?.items ?? [], [list.data]);
  const selectedId = search.id ?? null;
  const [qLocal, setQLocal] = useDebouncedSearch(search.q, (q) => void navigate({ search: (prev: ReconcileNav) => ({ ...prev, q, id: undefined }), replace: true }));
  const select = (key: string | null) => void navigate({ search: (prev: ReconcileNav) => ({ ...prev, id: key ?? undefined }), replace: true });
  const onTab = useRef(onRecordsTab);
  onTab.current = onRecordsTab;
  useBindings(
    [
      { keys: 'v o', description: 'Only drugs with records that disagree, or all', group: 'Lists', run: () => !dialogOpen() && setOnly((o) => (o === 'open' ? 'all' : 'open')) },
      // The other lists of Records vs records keep their keys here too.
      ...(['needs', 'inaccurate', 'settled', 'unbacked'] as const).map((t) => ({ keys: `v ${t[0]}`, description: `Show ${String(recordsTabs.find((x) => x.value === t)?.label ?? t).toLowerCase()}`, group: 'Lists', run: () => !dialogOpen() && onTab.current(t) })),
    ],
    [],
  );
  const columns = useMemo<ColumnDef<DrugSummary, unknown>[]>(
    () => [
      { id: 'name', header: 'Drug', accessorKey: 'name', meta: { grow: true, minWidth: 160 } },
      {
        id: 'state',
        header: 'Where it stands',
        accessorFn: (d) => d.open * 1000 + d.notesToAnswer,
        cell: ({ row }) => {
          const d = row.original;
          if (d.open) return <Tag tone="warn">records disagree</Tag>;
          if (d.notesToAnswer) return <Tag tone="bad">{plural(d.notesToAnswer, 'difference')} with your notes</Tag>;
          return <span className="muted">{d.settledWords || 'agrees'}</span>;
        },
        meta: { width: 230, maxWidth: 320, wrap: true },
      },
      { id: 'sources', header: 'Sources', accessorFn: (d) => d.records + d.notes, cell: ({ row }) => <span className="mono">{row.original.records} + {row.original.notes}</span>, meta: { width: 80, shrink: false } },
    ],
    [],
  );
  const left = list.isPending ? (
    <Loading>Loading the medications…</Loading>
  ) : list.isError ? (
    <Loading>Could not load them: {errorMessage(list.error)}</Loading>
  ) : (
    <DataTable columns={columns} data={rows} rowId={(d) => d.key} selectedId={selectedId} onSelect={(d) => select(d?.key ?? null)} onOpen={(d) => select(d.key)} initialSort={[{ id: 'state', desc: true }]} tableId="reconcile.meds" autoFocus emptyText={only === 'open' ? 'No drug whose records disagree.' : 'No drug with a start, stop or dose from two sources yet.'} />
  );
  const right = selectedId ? <DrugTimelinePane key={selectedId} drugKey={selectedId} keys /> : rows.length ? <EmptyState title="Pick a drug">See each record and each of your notes side by side, and settle where the records disagree. Move with j and k.</EmptyState> : null;
  return (
    <div className="page">
      <PageHeader title="Reconciliation" intro={INTRO} />
      <Toolbar label="Lists and search">
        <StageSwitch stage="records" />
        <Segmented label="Show" value="meds" onChange={onRecordsTab} options={recordsTabs} />
        <Segmented<'open' | 'all'> label="Drugs" value={only} onChange={setOnly} options={[{ value: 'all', label: 'All' }, { value: 'open', label: 'Records disagree' }]} />
        <SearchField label="Find" placeholder="Drug" value={qLocal} onChange={setQLocal} width={180} />
        <ToolbarKeys items={[['j/k', 'move'], ['esc', 'clear'], ['1/2', 'stage'], ['v o', 'only disagreements'], ['b', 'both happened'], ['z', 'undo']]} />
      </Toolbar>
      <p className="nt-intro warn">
        <strong>Medications.</strong> Each drug's start, stop and doses as every record and every note of yours gives them. Where two records disagree, say which is right, that both happened, or that one is wrong. Nothing in a record is changed.
      </p>
      <div className="page-body flush">
        <SplitView storageKey="reconcile.meds" defaultLeft={45} minLeft={360} minRight={460} left={left} right={right} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stage 2, Records vs my notes
// ---------------------------------------------------------------------------

const LISTS = ['answer', 'waiting', 'answered'] as const;
type List = (typeof LISTS)[number];
const LIST_WORDS: Record<List, string> = { answer: 'To answer', waiting: 'Waiting on the records', answered: 'Answered' };
const LIST_KEYS: Record<List, string> = { answer: 'v a', waiting: 'v w', answered: 'v d' };
const LIST_INTRO: Record<List, string> = {
  answer: 'Your notes give something else than the settled records. Say which is right; the records stay as written either way.',
  waiting: 'The records disagree with each other about these first. Settle that under Records vs records, then they come here.',
  answered: 'What you answered, with Undo.',
};

function NotesSides({ item }: { item: NotesItem }) {
  return (
    <div className="nt-sides">
      <div className="nt-side mine">
        <div className="nt-side-label">Your notes say</div>
        <div className="nt-side-says">{item.notes.says}</div>
        {item.notes.documentId ? (
          <div className="small">
            <Link to="/documents/$id" params={{ id: item.notes.documentId }} search={{ page: item.notes.page ?? undefined, cite: item.notes.citationId ?? undefined }}>
              {item.notes.documentTitle}
            </Link>
            {item.notes.quote ? <div className="muted">“{item.notes.quote}”</div> : null}
          </div>
        ) : null}
      </div>
      <div className="nt-side records">
        <div className="nt-side-label">The records say</div>
        <div className="nt-side-says">{item.records?.says || '—'}</div>
        {item.records?.documentId ? (
          <div className="small">
            <Link to="/documents/$id" params={{ id: item.records.documentId }} search={{ page: item.records.page ?? undefined, cite: item.records.citationId ?? undefined }}>
              {item.records.documentTitle}
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function NotesItemPane({ item, keys = false }: { item: NotesItem; keys?: boolean }) {
  const m = useTimelineMutations();
  const toast = useToast();
  const canWrite = useMe().canWrite;
  const [reason, setReason] = useState('');
  const drug = useDrugTimeline(item.drugKey);
  useEffect(() => setReason(''), [item.key]);
  const answer = (a: NotesAnswer) => m.notes.mutate({ key: item.key, answer: a, ...(reason.trim() ? { reason: reason.trim() } : {}) }, { onSuccess: (r) => toast(r.words, 'ok'), onError: (err) => toast(errorMessage(err), 'bad') });
  const undo = () => m.undoNotes.mutate(item.key, { onSuccess: (r) => toast(r.words, 'ok'), onError: (err) => toast(errorMessage(err), 'bad') });
  const latest = useRef({ item, canWrite, busy: m.busy });
  latest.current = { item, canWrite, busy: m.busy };
  const can = (state: NotesItem['state']) => () => keys && latest.current.canWrite && !latest.current.busy && latest.current.item.state === state && !dialogOpen();
  useBindings(
    [
      ...NOTES_ANSWERS.map((a) => ({ keys: NOTES_ANSWER_KEYS[a], description: NOTES_ANSWER_WORDS[a], group: 'Page', when: can('answer'), run: () => answer(a) })),
      { keys: 'z', description: 'Undo my answer', group: 'Page', when: can('answered'), run: undo },
    ],
    [item.key, reason],
  );
  return (
    <DetailPane label={item.subject}>
      <DetailHeader eyebrow={`${item.what} · records vs my notes`} title={item.subject} status={[<DateText key="d" iso={item.notes.date} precision={item.notes.precision} text={item.notes.dateText} />, item.state === 'answer' ? <span key="s" className="nt-bad">differs</span> : item.state === 'waiting' ? <span key="s">waits for the records</span> : null]} />
      <Section title="Side by side">
        <NotesSides item={item} />
      </Section>
      {item.state === 'waiting' ? (
        <Section title="Settle the records first">
          <p className="nt-line warn">
            The clinical records disagree with each other here.{' '}
            {item.drugKey ? (
              <Link to="/reconcile" search={{ tab: 'meds', id: item.drugKey }}>
                Settle them under Medications
              </Link>
            ) : (
              <Link to="/reconcile" search={{ id: item.eventKey ?? undefined }}>
                Settle them under Needs a source
              </Link>
            )}
            , then answer here.
          </p>
        </Section>
      ) : item.state === 'answered' && item.answer ? (
        <Section title="Your answer">
          <p className="nt-answered">
            <strong>{NOTES_ANSWER_WORDS[item.answer.answer]}</strong>
            {item.answer.by ? ` (${item.answer.by})` : ''}. {item.answer.answer === 'notes_right' ? 'Your version is used; the record stays as written and is marked.' : item.answer.answer === 'both' ? 'Both are kept, side by side.' : item.answer.answer === 'not_same' ? 'They are not compared any more.' : 'The records are used.'}
          </p>
          {canWrite ? (
            <Button size="sm" onClick={undo} disabled={m.busy} shortcut="z">
              Undo my answer
            </Button>
          ) : null}
        </Section>
      ) : canWrite ? (
        <Section title="Which is right?">
          {item.topic !== 'medication' ? (
            <div className="row nt-gap-bottom nt-reason">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why (optional): it is kept with your answer" aria-label="Why (optional)" />
            </div>
          ) : null}
          <div className="nt-answers">
            {NOTES_ANSWERS.map((a) => (
              <Button key={a} size="sm" variant={a === 'notes_right' ? 'accent' : 'default'} onClick={() => answer(a)} disabled={m.busy} shortcut={keys ? NOTES_ANSWER_KEYS[a] : undefined}>
                {NOTES_ANSWER_WORDS[a]}
              </Button>
            ))}
          </div>
          <p className="nt-line">My notes are right: your version is used and the record is marked, never changed. Both are true: two different things (another course, another dose). Not the same thing: they are about different matters.</p>
        </Section>
      ) : null}
      {item.drugKey && drug.data ? (
        <Section title="The drug's timeline">
          <Lanes timeline={drug.data} />
        </Section>
      ) : null}
    </DetailPane>
  );
}

export function NotesStage({ search }: { search: ReconcileNav }) {
  const navigate = useNavigate({ from: '/reconcile' });
  const list: List = search.list ?? 'answer';
  const items = useNotesItems(list, search.q || undefined);
  const counts = useNotesCounts();
  const rows = useMemo(() => items.data?.items ?? [], [items.data]);
  const selectedId = search.id ?? null;
  const selected = rows.find((r) => r.key === selectedId) ?? null;
  const [qLocal, setQLocal] = useDebouncedSearch(search.q, (q) => void navigate({ search: (prev: ReconcileNav) => ({ ...prev, q, id: undefined }), replace: true }));
  const setList = (l: List) => void navigate({ search: (prev: ReconcileNav) => ({ ...prev, list: l === 'answer' ? undefined : l, id: undefined }) });
  const select = (key: string | null) => void navigate({ search: (prev: ReconcileNav) => ({ ...prev, id: key ?? undefined }), replace: true });
  const latest = useRef(list);
  latest.current = list;
  useBindings(
    [
      { keys: 'v v', description: 'Next list: to answer, waiting on the records, answered', group: 'Lists', run: () => !dialogOpen() && setList(LISTS[(LISTS.indexOf(latest.current) + 1) % LISTS.length]) },
      ...LISTS.map((l) => ({ keys: LIST_KEYS[l], description: `Show ${LIST_WORDS[l].toLowerCase()}`, group: 'Lists', run: () => !dialogOpen() && setList(l) })),
    ],
    [],
  );
  useRegisterCommands(
    LISTS.map((l) => ({ id: `reconcile.notes.${l}`, title: `Records vs my notes: ${LIST_WORDS[l].toLowerCase()}`, group: 'Reconciliation', shortcut: LIST_KEYS[l], keywords: 'reconcile notes personal', run: () => setList(l) })),
    [],
  );
  const columns = useMemo<ColumnDef<NotesItem, unknown>[]>(
    () => [
      { id: 'when', header: 'When', accessorFn: (r) => dateSortKey(r.notes.date), sortUndefined: 'last', cell: ({ row }) => <DateText iso={row.original.notes.date} precision={row.original.notes.precision} text={row.original.notes.dateText} />, meta: { width: 100, shrink: false } },
      {
        id: 'what',
        header: 'What',
        accessorFn: (r) => `${r.subject} ${r.what}`,
        cell: ({ row }) => (
          <span className="nt-cell">
            <span>{row.original.subject}</span>
            <span className="nt-cell-sub">{row.original.what}</span>
          </span>
        ),
        meta: { grow: true, minWidth: 150 },
      },
      { id: 'mine', header: 'Your notes', accessorFn: (r) => r.notes.says, cell: ({ getValue }) => <span className={list === 'answer' ? 'nt-bad' : undefined}>{String(getValue())}</span>, meta: { width: 130, maxWidth: 170, wrap: true, shrink: false } },
      { id: 'records', header: 'Records', accessorFn: (r) => r.records?.says ?? '', cell: ({ getValue }) => <span>{String(getValue()) || '—'}</span>, meta: { width: 150, maxWidth: 200, wrap: true, shrink: false } },
      ...(list === 'answered' ? [{ id: 'answer', header: 'Your answer', accessorFn: (r: NotesItem) => (r.answer ? NOTES_ANSWER_WORDS[r.answer.answer] : ''), meta: { width: 140, shrink: false } } as ColumnDef<NotesItem, unknown>] : []),
    ],
    [list],
  );
  const c = counts.data;
  const countOf: Record<List, number | undefined> = { answer: c?.toAnswer, waiting: c?.waiting, answered: c?.answered };
  const left = items.isPending ? (
    <Loading>Loading…</Loading>
  ) : items.isError ? (
    <Loading>Could not load this list: {errorMessage(items.error)}</Loading>
  ) : (
    <DataTable key={list} columns={columns} data={rows} rowId={(r) => r.key} selectedId={selectedId} onSelect={(r) => select(r?.key ?? null)} onOpen={(r) => select(r.key)} initialSort={[{ id: 'when', desc: true }]} rowClassName={() => (list === 'answer' ? 'nt-differs-row' : '')} tableId={`reconcile.notes.${list}`} autoFocus emptyText={search.q ? 'Nothing matches this search.' : list === 'answer' ? 'Nothing to answer: where the records are settled, your notes agree with them or give nothing to compare.' : list === 'waiting' ? 'Nothing waits on the records.' : 'No answers yet.'} />
  );
  const right = selected ? <NotesItemPane key={selected.key} item={selected} keys /> : rows.length ? <EmptyState title="Pick one">See your notes beside the records and say which is right. Move with j and k.</EmptyState> : null;
  return (
    <div className="page">
      <PageHeader title="Reconciliation" intro={INTRO} />
      <Toolbar label="Lists and search">
        <StageSwitch stage="notes" />
        <Segmented<List> label="Show" value={list} onChange={setList} options={LISTS.map((l) => ({ value: l, label: LIST_WORDS[l], count: countOf[l], title: LIST_INTRO[l] }))} />
        <SearchField label="Find" placeholder="Drug, test or note" value={qLocal} onChange={setQLocal} width={200} />
        <ToolbarKeys
          items={[
            ['j/k', 'move'],
            ['esc', 'clear'],
            ['1/2', 'stage'],
            ['v v', 'next list'],
            ...(list === 'answer' ? NOTES_ANSWERS.map((a) => [NOTES_ANSWER_KEYS[a], NOTES_ANSWER_WORDS[a].toLowerCase()] as const) : list === 'answered' ? [['z', 'undo'] as const] : []),
          ]}
        />
      </Toolbar>
      <p className={`nt-intro${list === 'answer' && (c?.toAnswer ?? 0) > 0 ? ' bad' : list === 'waiting' && (c?.waiting ?? 0) > 0 ? ' warn' : ''}`}>
        <strong>{LIST_WORDS[list]}.</strong> {LIST_INTRO[list]}
      </p>
      <div className="page-body flush">
        <SplitView storageKey="reconcile.notes" defaultLeft={56} minLeft={440} minRight={440} left={left} right={right} />
      </div>
    </div>
  );
}
