/**
 * Calendar import: one .ics file into appointments and notes in the symptom diary.
 * Step 1: choose (or drop) the file; the dry run reads it and writes nothing.
 * Step 2: every event is a row with the server's suggestion, which can be changed in the pane on the right (what it
 * becomes, its title, the kind of visit, the clinician, the institution); Space ticks or unticks a row.
 * Step 3: Import (the page's primary action, asks first) sends the ticked rows as previewed, then reads the file
 * again so the imported events show as imported. Importing the same file twice creates nothing: the server skips
 * events it has imported before.
 */
import { useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { todayIso } from '@shared/dates';
import {
  applyCalendarItems,
  ENCOUNTER_KIND_OPTIONS,
  previewCalendarFile,
  useImportStatus,
  useRefreshAfterImport,
  type CalendarApplyItem,
  type CalendarApplyResult,
  type CalendarItem,
  type CalendarPreview,
  type EncounterKind,
} from '../../api/import';
import { usePeople } from '../../api/people';
import { useRegisterCommands } from '../../app/commands';
import { useBindings } from '../../app/shortcuts';
import { Button } from '../../ui/Button';
import { DataTable, type ColumnDef } from '../../ui/DataTable';
import { DateText } from '../../ui/DateText';
import { DetailHeader, DetailPane } from '../../ui/DetailPane';
import { Field, Select } from '../../ui/Field';
import { EmptyState, Loading, Section } from '../../ui/PageHeader';
import { SplitView } from '../../ui/SplitView';
import { Tag } from '../../ui/StatusTag';
import { SearchField, Toolbar } from '../../ui/Toolbar';
import { ToolbarKeys } from '../../ui/Toolbar';
import { ApplyConfirm, DropArea, errorMessage, FileInput, ImportHeader, ImportSteps, IssueList, KindTabs, plural, RowStatusTag, dialogOpen, type ImportKind } from './shared';

interface Choice {
  include: boolean;
  kind: 'encounter' | 'daily';
  encounterKind: EncounterKind;
  clinicianId: string | null;
  institutionId: string | null;
  title: string;
}

/** The kinds of visit in words (the stored kinds stay what the Appointments page stores). */
export const ENCOUNTER_KIND_WORDS: Record<EncounterKind, string> = {
  visit: 'Visit',
  telehealth: 'Video or phone visit',
  procedure: 'Procedure',
  admission: 'Hospital stay',
  test: 'Test',
  infusion: 'Infusion',
  other: 'Other',
};

/** A calendar's own event status in words. */
const EVENT_STATUS_WORDS: Record<string, string> = { CONFIRMED: 'Confirmed', TENTATIVE: 'Tentative', CANCELLED: 'Cancelled' };

/** The last day the diary takes: the viewer's today (the server allows one day of slack). */
function latestLogDay(): string {
  return todayIso();
}

function importable(it: CalendarItem): boolean {
  return !it.alreadyImported && Boolean(it.start);
}

function suggestedChoice(it: CalendarItem): Choice {
  return {
    include: it.suggested.kind !== 'skip' && importable(it),
    kind: it.suggested.kind === 'daily' ? 'daily' : 'encounter',
    encounterKind: it.suggested.encounterKind,
    clinicianId: it.suggested.clinicianId,
    institutionId: it.suggested.institutionId,
    title: it.title || '(untitled calendar event)',
  };
}

function clip(s: string | null, max: number): string | null {
  return s && s.length > max ? s.slice(0, max) : s;
}

/** Why an event was not saved, in words (the server's "dry run" wording said plainly). */
export function skipReasonWords(reason: string): string {
  if (/not in a recent preview/i.test(reason)) return 'not in the file as it was last read; choose the file again';
  return reason;
}

/** What a ticked event becomes, in words: "Appointment (visit)", "Note in the symptom diary". */
export function becomesWords(c: Pick<Choice, 'kind' | 'encounterKind'>): string {
  return c.kind === 'daily' ? 'Note in the symptom diary' : `Appointment (${(ENCOUNTER_KIND_WORDS[c.encounterKind] ?? c.encounterKind).toLowerCase()})`;
}

export function CalendarImport({ kind, onKind, selectedId, onSelect }: { kind: ImportKind; onKind: (k: ImportKind) => void; selectedId: string | null; onSelect: (id: string | null) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<CalendarPreview | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [result, setResult] = useState<CalendarApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [q, setQ] = useState('');
  const refresh = useRefreshAfterImport();
  const status = useImportStatus();
  const people = usePeople({});

  const previewM = useMutation({ mutationFn: previewCalendarFile });
  const applyM = useMutation({ mutationFn: (v: { filename: string | null; items: CalendarApplyItem[] }) => applyCalendarItems(v.filename, v.items) });
  const busy = previewM.isPending || applyM.isPending;

  const personItems = people.data?.items ?? [];
  const clinicians = useMemo(() => personItems.filter((p) => p.kind === 'clinician').sort((a, b) => a.name.localeCompare(b.name)), [personItems]);
  const institutions = useMemo(() => personItems.filter((p) => p.kind === 'institution' || p.kind === 'clinic').sort((a, b) => a.name.localeCompare(b.name)), [personItems]);
  const nameOf = useMemo(() => new Map(personItems.map((p) => [p.id, p.name])), [personItems]);

  const items = preview?.items ?? [];
  const selected = selectedId ? (items.find((i) => i.uid === selectedId) ?? null) : null;
  const included = items.filter((it) => importable(it) && choices[it.uid]?.include);
  const latestDay = latestLogDay();

  function runPreview(f: File, keepChoices: boolean) {
    setError(null);
    previewM.mutate(f, {
      onSuccess: (p) => {
        setPreview(p);
        setChoices((prev) => {
          const next: Record<string, Choice> = {};
          for (const it of p.items) {
            const old = keepChoices ? prev[it.uid] : undefined;
            next[it.uid] = old && importable(it) ? old : suggestedChoice(it);
          }
          return next;
        });
      },
      onError: (err) => {
        setPreview(null);
        setError(errorMessage(err));
      },
    });
  }

  function chooseFile(f: File) {
    setFile(f);
    setResult(null);
    setChoices({});
    onSelect(null);
    runPreview(f, false);
  }

  function update(uid: string, patch: Partial<Choice>) {
    setChoices((prev) => (prev[uid] ? { ...prev, [uid]: { ...prev[uid], ...patch } } : prev));
  }

  function setAs(it: CalendarItem, as: 'encounter' | 'daily') {
    if (!importable(it)) return;
    if (as === 'daily' && it.start && it.start > latestDay) return;
    update(it.uid, { kind: as, include: true });
  }

  function apply() {
    if (!preview || !file || !included.length) return;
    const body: CalendarApplyItem[] = included.map((it) => {
      const c = choices[it.uid];
      return {
        uid: it.uid,
        kind: c.kind,
        title: c.title.trim() ? c.title.trim().slice(0, 500) : null,
        encounterKind: c.encounterKind,
        clinicianId: c.clinicianId,
        institutionId: c.institutionId,
        eventStatus: it.status,
        start: it.start,
        time: it.time,
        summary: clip(it.title, 2000),
        location: clip(it.location, 500),
        description: clip(it.description, 100_000),
      };
    });
    setError(null);
    applyM.mutate(
      { filename: preview.filename, items: body },
      {
        onSuccess: (r) => {
          setResult(r);
          refresh('calendar');
          runPreview(file, true);
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  }

  function resetChoices() {
    setChoices(Object.fromEntries(items.map((it) => [it.uid, suggestedChoice(it)])));
  }

  const latest = useRef({ file, preview, included, busy, selected });
  latest.current = { file, preview, included, busy, selected };
  const actions = useRef({ pick: () => fileRef.current?.click(), dry: () => undefined as void, openApply: () => undefined as void, reset: () => undefined as void });
  actions.current = {
    pick: () => fileRef.current?.click(),
    dry: () => {
      if (latest.current.file && !latest.current.busy) runPreview(latest.current.file, true);
    },
    openApply: () => {
      if (latest.current.included.length && !latest.current.busy) setConfirm(true);
    },
    reset: resetChoices,
  };

  useBindings(
    [
      { keys: 'f', description: 'Choose a calendar file', group: 'Page', when: () => !dialogOpen(), run: () => actions.current.pick() },
      { keys: 'd', description: 'Read the calendar file again (saves nothing)', group: 'Page', when: () => !dialogOpen() && Boolean(latest.current.file), run: () => actions.current.dry() },
      { keys: 'a', description: 'Import the ticked events (asks first)', group: 'Page', when: () => !dialogOpen() && latest.current.included.length > 0, run: () => actions.current.openApply() },
      { keys: 'r', description: 'Put every choice back to the suggestion', group: 'Page', when: () => !dialogOpen() && Boolean(latest.current.preview), run: () => actions.current.reset() },
    ],
    [],
  );

  useRegisterCommands(
    [
      { id: 'import.ics.file', title: 'Import: choose a calendar (.ics) file', group: 'Import calendar or spreadsheet', keywords: 'calendar ics outlook google appointments', shortcut: 'f', run: () => actions.current.pick() },
      { id: 'import.ics.dry', title: 'Import: read the calendar file again (saves nothing)', group: 'Import calendar or spreadsheet', keywords: 'dry run check again', shortcut: 'd', when: () => Boolean(latest.current.file), run: () => actions.current.dry() },
      { id: 'import.ics.apply', title: 'Import: import the ticked calendar events', group: 'Import calendar or spreadsheet', keywords: 'apply', shortcut: 'a', when: () => latest.current.included.length > 0, run: () => actions.current.openApply() },
      { id: 'import.ics.reset', title: 'Import: put the calendar choices back to the suggestions', group: 'Import calendar or spreadsheet', keywords: 'reset', shortcut: 'r', when: () => Boolean(latest.current.preview), run: () => actions.current.reset() },
    ],
    [],
  );

  /** Who and where an appointment is with, as chosen (the clinician and the institution on file). */
  const withWords = (r: CalendarItem): string => {
    const c = choices[r.uid];
    if (!c || c.kind !== 'encounter') return '';
    const who = c.clinicianId ? (nameOf.get(c.clinicianId) ?? r.suggested.clinicianName) : null;
    const where = c.institutionId ? (nameOf.get(c.institutionId) ?? r.suggested.institutionName) : null;
    return [who, where].filter(Boolean).join(', ');
  };

  const columns = useMemo<ColumnDef<CalendarItem, unknown>[]>(
    () => [
      {
        id: 'include',
        header: () => <span title="Ticked events are imported (Space ticks the row)">Import</span>,
        accessorFn: (r) => (choices[r.uid]?.include && importable(r) ? 0 : 1),
        cell: ({ row }) => {
          const it = row.original;
          const c = choices[it.uid];
          return (
            <input
              type="checkbox"
              tabIndex={-1}
              checked={Boolean(c?.include) && importable(it)}
              disabled={!importable(it)}
              onChange={() => update(it.uid, { include: !c?.include })}
              onClick={(e) => e.stopPropagation()}
              aria-label={`Import ${it.title || 'this event'}`}
            />
          );
        },
        meta: { width: 64, shrink: false, className: 'import-check' },
      },
      { id: 'date', header: 'Date', accessorFn: (r) => r.start ?? '', cell: ({ row }) => <DateText iso={row.original.start} precision={row.original.start ? 'day' : null} text={row.original.asWritten} />, meta: { width: 96, shrink: false } },
      { id: 'time', header: 'Time', accessorFn: (r) => (r.allDay ? '' : (r.time ?? '')), cell: ({ row }) => (row.original.allDay ? <span className="muted">all day</span> : <span className="mono">{row.original.time ?? ''}</span>), meta: { width: 64, shrink: false } },
      {
        // The event, then who and where it is with (the clinician and institution it is matched to), so the list keeps
        // every column in view at 1280px.
        id: 'title',
        header: 'Event',
        accessorFn: (r) => `${r.title} ${withWords(r)}`,
        cell: ({ row }) => {
          const w = withWords(row.original);
          return (
            <>
              {row.original.title || <span className="muted">(no title)</span>}
              {w ? <span className="muted"> · {w}</span> : null}
            </>
          );
        },
        meta: { grow: true, minWidth: 200 },
      },
      {
        id: 'as',
        header: 'Becomes',
        accessorFn: (r) => (r.alreadyImported ? 'imported before' : choices[r.uid]?.include && importable(r) ? becomesWords(choices[r.uid]) : 'left out'),
        cell: ({ row }) => {
          const it = row.original;
          const c = choices[it.uid];
          if (it.alreadyImported) return <Tag tone="ash">imported before</Tag>;
          if (!importable(it)) return <Tag tone="warn" title="No readable start date">cannot import</Tag>;
          if (!c?.include) return <span className="muted">left out</span>;
          return <span>{becomesWords(c)}</span>;
        },
        meta: { width: 190, maxWidth: 240, shrink: false },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [choices, nameOf],
  );

  const encountersToMake = included.filter((it) => choices[it.uid].kind === 'encounter');
  const upcoming = encountersToMake.filter((it) => it.start && it.start > todayIso()).length;
  const dailyToMake = included.length - encountersToMake.length;
  const importedSoFar = status.data?.icsImported ?? null;

  const step: 1 | 2 | 3 = !preview ? 1 : included.length ? 3 : 2;
  const now = !file
    ? 'Export the calendar as an .ics file, then choose it or drop it on this page.'
    : previewM.isPending && !preview
      ? `Reading ${file.name}…`
      : !preview
        ? 'That file could not be read. Choose another one.'
        : included.length
          ? `${plural(included.length, 'event')} ticked. Untick any you do not want, pick one to change what it becomes, then press Import.`
          : 'Nothing is ticked. Tick the events to import (Space), or pick one to change what it becomes.';

  const fileLine = file ? (
    <span>
      From <span className="mono">{file.name}</span>
      {preview ? (
        <>
          {' · '}
          {plural(preview.counts.events, 'event')}
          {preview.counts.alreadyImported ? `, ${preview.counts.alreadyImported} imported before` : ''}
        </>
      ) : null}
    </span>
  ) : importedSoFar ? (
    <span>
      <span className="mono">{importedSoFar}</span> calendar {importedSoFar === 1 ? 'event' : 'events'} imported so far
    </span>
  ) : null;

  const left = previewM.isPending && !preview ? (
    <Loading>Reading {file?.name}…</Loading>
  ) : (
    <DataTable
      columns={columns}
      data={items}
      rowId={(r) => r.uid}
      selectedId={selectedId}
      onSelect={(r) => onSelect(r?.uid ?? null)}
      initialSort={[{ id: 'date', desc: false }]}
      rowClassName={(r) => (choices[r.uid]?.include && importable(r) ? undefined : 'dim')}
      emptyText={q ? 'No event matches this search.' : 'The file holds no events.'}
      autoFocus
      maxRows={20_000}
      globalFilter={q}
      tableId="import.calendar"
      onKey={(e, current) => {
        if (!current || e.ctrlKey || e.metaKey || e.altKey) return false;
        if ((e.target as HTMLElement).tagName === 'INPUT') return false;
        if (e.key === ' ') {
          if (importable(current)) update(current.uid, { include: !choices[current.uid]?.include });
          return true;
        }
        if (e.key === 'e') {
          setAs(current, 'encounter');
          return true;
        }
        if (e.key === 'l') {
          setAs(current, 'daily');
          return true;
        }
        return false;
      }}
      footer={
        <span>
          {plural(included.length, 'event')} ticked: {plural(encountersToMake.length, 'appointment')}, {plural(dailyToMake, 'diary note')}
        </span>
      }
    />
  );

  const right = selected ? (
    <EventDetail
      key={selected.uid}
      item={selected}
      choice={choices[selected.uid] ?? suggestedChoice(selected)}
      latestDay={latestDay}
      clinicians={clinicians}
      institutions={institutions}
      onChange={(patch) => update(selected.uid, patch)}
    />
  ) : preview ? (
    <FileSummary preview={preview} result={result} />
  ) : (
    <Loading>Reading the file…</Loading>
  );

  const body = !file ? (
    <CalendarStart onChoose={() => actions.current.pick()} importedSoFar={importedSoFar} />
  ) : !preview && !previewM.isPending ? (
    <EmptyState
      title={`${file.name} could not be read`}
      action={
        <Button variant="primary" onClick={() => actions.current.pick()} shortcut="f">
          Choose another file
        </Button>
      }
    >
      {error ?? 'It does not look like a calendar file.'} A calendar file ends in .ics; Google Calendar and Outlook both save one (see the steps on this page with no file chosen).
    </EmptyState>
  ) : (
    <SplitView storageKey="import" defaultLeft={58} minLeft={440} minRight={420} left={left} right={right} />
  );

  return (
    <>
      <ImportHeader
        meta={fileLine}
        actions={
          preview
            ? {
                primary: { label: applyM.isPending ? 'Importing…' : included.length ? `Import ${plural(included.length, 'event')}` : 'Import', onClick: () => actions.current.openApply(), shortcut: 'a', disabled: !included.length || busy, title: 'Save the ticked events (asks first)' },
                secondary: [{ label: 'Choose another file', onClick: () => actions.current.pick(), shortcut: 'f' }],
                more: [
                  { label: 'Put every choice back to the suggestion', onClick: () => actions.current.reset(), shortcut: 'r', disabled: busy },
                  { label: 'Read the file again', onClick: () => actions.current.dry(), shortcut: 'd', disabled: busy, title: 'Read the same file again, for example after adding a clinician on People and places; saves nothing' },
                ],
              }
            : { primary: { label: file && previewM.isPending ? 'Reading…' : 'Choose a calendar file', onClick: () => actions.current.pick(), shortcut: 'f', disabled: busy, title: 'An .ics file exported from Google Calendar, Outlook or another calendar' } }
        }
      />
      <Toolbar label="Import from and find">
        <KindTabs kind={kind} onKind={onKind} />
        {preview ? <SearchField label="Find" placeholder="Event, place or person" value={q} onChange={setQ} width={220} /> : null}
        <ToolbarKeys
          items={
            preview
              ? [['j/k', 'move'], ['space', 'tick'], ['e', 'appointment'], ['l', 'diary note'], ['a', 'import'], ['f', 'another file'], ['/', 'find']]
              : [['f', 'choose a file'], ['v s', 'spreadsheet']]
          }
        />
      </Toolbar>
      <ImportSteps step={step} check="Check what each event becomes" now={now} />
      <FileInput ref={fileRef} accept=".ics,.ical,.icalendar,text/calendar" onFile={chooseFile} />
      <DropArea onFile={chooseFile} label="Drop the .ics file to read it">
        {error && preview ? <div className="notice bad import-notice">{error}</div> : null}
        {result ? (
          <div className="notice ok import-notice" role="status">
            <strong>Imported {plural(result.imported, 'event')}:</strong> {plural(result.encounters, 'appointment')} and {plural(result.daily, 'diary note')}.
            {result.skipped.filter((s) => s.reason !== 'left out').length ? ` ${plural(result.skipped.filter((s) => s.reason !== 'left out').length, 'event')} could not be saved; see the file summary (Esc).` : ''}{' '}
            <Link to="/encounters">Open Appointments</Link>
          </div>
        ) : null}
        {body}
      </DropArea>
      <ApplyConfirm open={confirm} onClose={() => setConfirm(false)} onApply={apply} busy={busy} title={`Import ${plural(included.length, 'calendar event')}?`} confirmLabel={`Import ${plural(included.length, 'event')}`}>
        <p>
          This adds {plural(encountersToMake.length, 'appointment')}
          {encountersToMake.length ? ` (${upcoming} upcoming, ${encountersToMake.length - upcoming} past)` : ''} and {plural(dailyToMake, 'note')} in the symptom diary, from <span className="mono">{preview?.filename ?? 'the file'}</span>.
        </p>
        <p className="muted">Each appointment keeps the event’s description and a line naming the file it came from. Events imported before are skipped, so importing the same file twice adds nothing.</p>
      </ApplyConfirm>
    </>
  );
}

/** Step 1, before a file is chosen: how to get the file, what happens to it, and the button. */
function CalendarStart({ onChoose, importedSoFar }: { onChoose: () => void; importedSoFar: number | null }) {
  return (
    <div className="import-start">
      <EmptyState
        title="Choose a calendar file"
        action={
          <Button variant="primary" onClick={onChoose} shortcut="f">
            Choose a calendar file
          </Button>
        }
      >
        Or drop it anywhere on this page. Nothing is saved until you press Import, and an event imported once is never imported again.
      </EmptyState>
      <div className="import-start-help">
        <Section title="Getting the file">
          <ul className="import-help-list">
            <li>
              <strong>Google Calendar:</strong> Settings, Import and export, Export. Unzip the download and choose the .ics file.
            </li>
            <li>
              <strong>Outlook:</strong> File, Save calendar.
            </li>
            <li>
              <strong>Apple Calendar:</strong> File, Export, Export.
            </li>
          </ul>
        </Section>
        <Section title="What each event becomes">
          <ul className="import-help-list">
            <li>An appointment, when it names a clinician or a clinic on file, or reads like a visit.</li>
            <li>A note in the symptom diary, when it reads like one (a flare, a migraine).</li>
            <li>Nothing, otherwise; you can still tick it. A repeating event is offered once, on its first date.</li>
          </ul>
          {importedSoFar !== null ? <p className="muted">{plural(importedSoFar, 'calendar event')} imported so far.</p> : null}
        </Section>
      </div>
    </div>
  );
}

interface PersonOption {
  id: string;
  name: string;
}

function EventDetail({
  item,
  choice,
  latestDay,
  clinicians,
  institutions,
  onChange,
}: {
  item: CalendarItem;
  choice: Choice;
  latestDay: string;
  clinicians: PersonOption[];
  institutions: PersonOption[];
  onChange: (patch: Partial<Choice>) => void;
}) {
  const canImport = importable(item);
  const dailyAllowed = Boolean(item.start && item.start <= latestDay);
  const s = item.suggested;
  const on = choice.include && canImport;
  return (
    <DetailPane label="Calendar event">
      <DetailHeader
        eyebrow={
          <>
            <RowStatusTag status={on ? 'import' : canImport ? 'excluded' : 'skip'} already={item.alreadyImported} />
            {item.recurrence ? <Tag tone="info" title="A repeating event: only its first date is offered">repeats</Tag> : null}
            {item.status === 'CANCELLED' ? <Tag tone="bad">cancelled</Tag> : null}
            <span>Calendar event</span>
          </>
        }
        title={item.title || '(no title)'}
        status={[
          <span key="when">
            <DateText iso={item.start} precision={item.start ? 'day' : null} text={item.asWritten} />
            {item.allDay ? ' (all day)' : item.time ? <span className="mono"> {item.time}</span> : null}
          </span>,
          <span key="as">{item.alreadyImported ? 'Imported before' : !canImport ? 'Cannot be imported' : on ? `Becomes: ${becomesWords(choice).toLowerCase()}` : 'Left out'}</span>,
        ]}
        actions={
          canImport
            ? { primary: { label: on ? 'Leave this one out' : 'Import this one', onClick: () => onChange({ include: !choice.include }), shortcut: 'space', title: on ? 'Untick it: it will not be imported' : 'Tick it: it will be imported' } }
            : undefined
        }
        facts={[
          item.location ? { label: 'Where', value: item.location, wide: true } : null,
          item.attendees.length ? { label: 'People', value: item.attendees.join(', '), wide: true } : null,
          item.asWritten ? { label: 'As written', value: item.asWritten, mono: true } : null,
          item.status && EVENT_STATUS_WORDS[item.status] && item.status !== 'CONFIRMED' ? { label: 'In the calendar', value: EVENT_STATUS_WORDS[item.status] } : null,
          item.recurrence ? { label: 'Repeats', value: 'Yes; only the first date is offered', title: item.recurrence } : null,
        ]}
      />

      {canImport ? (
        <Section title="What it becomes">
          <div className="form import-form">
            <Field inline label="Becomes" hint={dailyAllowed ? undefined : 'The symptom diary only takes days that have happened.'}>
              <Select
                value={choice.kind}
                onChange={(e) => onChange({ kind: e.target.value as Choice['kind'], include: true })}
                options={[{ value: 'encounter', label: 'An appointment' }, ...(dailyAllowed || choice.kind === 'daily' ? [{ value: 'daily', label: 'A note in the symptom diary' }] : [])]}
              />
            </Field>
            <Field inline label={choice.kind === 'daily' ? 'Note' : 'Title'}>
              <input type="text" value={choice.title} maxLength={500} onChange={(e) => onChange({ title: e.target.value })} />
            </Field>
            {choice.kind === 'encounter' ? (
              <>
                <Field inline label="Kind of visit">
                  <Select value={choice.encounterKind} onChange={(e) => onChange({ encounterKind: e.target.value as EncounterKind })} options={ENCOUNTER_KIND_OPTIONS.map((k) => ({ value: k, label: ENCOUNTER_KIND_WORDS[k] }))} />
                </Field>
                <Field inline label="Clinician" hint={s.clinicianName && s.clinicianId === choice.clinicianId ? 'Suggested from the event’s words.' : undefined}>
                  <Select value={choice.clinicianId ?? ''} onChange={(e) => onChange({ clinicianId: e.target.value || null })} placeholder="Nobody chosen" options={clinicians.map((p) => ({ value: p.id, label: p.name }))} />
                </Field>
                <Field inline label="Institution" hint={s.institutionName && s.institutionId === choice.institutionId ? 'Suggested from the event’s words.' : undefined}>
                  <Select value={choice.institutionId ?? ''} onChange={(e) => onChange({ institutionId: e.target.value || null })} placeholder="None chosen" options={institutions.map((p) => ({ value: p.id, label: p.name }))} />
                </Field>
              </>
            ) : null}
          </div>
        </Section>
      ) : (
        <div className="notice">{item.alreadyImported ? 'This event was imported from a calendar file before; importing again skips it.' : 'The event has no start date CaseFile can read, so it cannot be imported.'}</div>
      )}

      <Section title="Why this suggestion">
        <p>
          <strong>{s.kind === 'skip' ? 'Left out' : s.kind === 'daily' ? 'A note in the symptom diary' : `An appointment (${(ENCOUNTER_KIND_WORDS[s.encounterKind] ?? s.encounterKind).toLowerCase()})`}</strong>
          <span className="muted">: {s.reason}.</span>
        </p>
        {s.matchNote ? <p className="muted">{s.matchNote}</p> : null}
        {s.existingEncounterId ? (
          <p>
            Already on file:{' '}
            <Link to="/encounters" search={{ id: s.existingEncounterId }}>
              {s.existingEncounterTitle ?? 'the appointment'}
            </Link>
          </p>
        ) : null}
      </Section>

      {item.description ? (
        <Section title="Description in the calendar">
          <div className="import-desc">{item.description}</div>
        </Section>
      ) : null}
      {item.notes.length ? (
        <Section title="Good to know">
          <IssueList items={item.notes.map((text) => ({ text }))} />
        </Section>
      ) : null}
    </DetailPane>
  );
}

/** The right pane before an event is picked: the file, the last import, and what to do next. */
function FileSummary({ preview, result }: { preview: CalendarPreview; result: CalendarApplyResult | null }) {
  const failed = result ? result.skipped.filter((s) => s.reason !== 'left out') : [];
  return (
    <DetailPane label="Calendar file">
      <DetailHeader
        eyebrow={<span>Calendar file</span>}
        title={preview.filename ?? 'The calendar file'}
        status={[plural(preview.counts.events, 'event'), preview.counts.repeating ? `${preview.counts.repeating} repeating (first date only)` : null, preview.counts.alreadyImported ? `${preview.counts.alreadyImported} imported before` : null]}
        facts={[
          { label: 'Suggested', value: `${plural(preview.counts.encounter, 'appointment')}, ${plural(preview.counts.daily, 'diary note')}, ${preview.counts.skip} left out`, wide: true },
          { label: 'Times shown in', value: preview.timeZone, mono: true },
        ]}
      />
      <p className="muted">Pick an event on the left to see it and change what it becomes. Move with j and k; Space ticks or unticks.</p>
      {result ? (
        <Section title="Last import" count={result.imported}>
          {result.created.length ? (
            <ul className="import-created">
              {result.created.map((c) => (
                <li key={c.uid}>
                  <DateText iso={c.date} precision="day" />
                  {c.kind === 'encounter' ? (
                    <Link to="/encounters" search={{ id: c.id }}>
                      {c.title}
                    </Link>
                  ) : (
                    <Link to="/symptoms" search={{ date: c.id }}>
                      Symptom diary: {c.title}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Nothing was saved.</p>
          )}
          <IssueList items={failed.map((s) => ({ row: s.title, text: skipReasonWords(s.reason) }))} />
        </Section>
      ) : null}
      {preview.warnings.length ? (
        <Section title="Good to know about the file">
          <IssueList items={preview.warnings.map((text) => ({ text }))} />
        </Section>
      ) : null}
    </DetailPane>
  );
}
