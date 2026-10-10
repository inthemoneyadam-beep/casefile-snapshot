/**
 * Spreadsheet import: one .csv into the symptom diary, the lab results or the calls and messages.
 * Step 1: choose where the rows go ("Into:") and the file; the dry run reads it and writes nothing. Changing where
 * the rows go, "Add people not on file" or a name decision reads it again.
 * Step 2: every data row is listed with what it would write or why it cannot be imported; rows can be unticked
 * (sent as `exclude`, so row numbers never shift). For calls and messages every name in the `with` column has a
 * decision: the person it matched, a new person, or left out (then named in the summary).
 * Step 3: Import (the page's primary action, asks first).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { parseLabValue } from '@shared/labvalues';
import {
  CSV_TARGETS,
  runCsvImport,
  useRefreshAfterImport,
  type CommCsvName,
  type CommCsvRow,
  type CsvResult,
  type CsvRow,
  type CsvTarget,
  type LabCsvRow,
  type SymptomCsvRow,
} from '../../api/import';
import { usePeople, type PersonRow } from '../../api/people';
import { useRegisterCommands } from '../../app/commands';
import { useBindings } from '../../app/shortcuts';
import { Button } from '../../ui/Button';
import { DataTable, type ColumnDef } from '../../ui/DataTable';
import { DateText } from '../../ui/DateText';
import { DetailHeader, DetailPane, KeyFacts, type KeyFact } from '../../ui/DetailPane';
import { Select } from '../../ui/Field';
import { EmptyState, Loading, Section } from '../../ui/PageHeader';
import { SplitView } from '../../ui/SplitView';
import { FilterGroup, SearchField, Segmented, Toolbar } from '../../ui/Toolbar';
import { ToolbarKeys } from '../../ui/Toolbar';
import { sampleWords } from '../labs/tags';
import { ApplyConfirm, DropArea, errorMessage, FileInput, ImportHeader, ImportSteps, IssueList, KindTabs, plural, RowStatusTag, dialogOpen, type ImportKind } from './shared';

/** Where the rows go, as the menu names it. */
export const TARGET_WORDS: Record<CsvTarget, string> = { symptoms: 'Symptom diary', labs: 'Lab results', communications: 'Calls and messages' };
const TARGET_LOWER: Record<CsvTarget, string> = { symptoms: 'the symptom diary', labs: 'the lab results', communications: 'the calls and messages' };

/** The columns each target reads (the header to use, then what goes in it); shown before a file is chosen. */
const GUIDE: Record<CsvTarget, Array<[string, string]>> = {
  symptoms: [
    ['date', 'Needed. One row per day: 2024-03-11, 3/11/2024 or March 11, 2024.'],
    ['one column per symptom', 'A whole number from 0 to 10, headed with the symptom’s name (joint pain, dizziness…). A new name becomes a new symptom.'],
    ['sleep_hours', 'Hours slept, 0 to 24.'],
    ['sleep_quality, energy', 'From 0 to 10.'],
    ['notes, tags', 'Free text; tags separated by ; or ,'],
  ],
  labs: [
    ['date', 'Needed. When the sample was taken; a month or a year is kept as just that.'],
    ['test, value', 'Needed. The value is kept exactly as written (“<3”, “Negative”, “1,234”).'],
    ['unit', 'mg/dL, g/L and so on.'],
    ['ref_low, ref_high', 'The normal range as two numbers; or one reference column such as 3.5-5.0, <5 or >10.'],
    ['specimen', 'Serum, plasma, whole blood, CSF or urine. Left empty, it is worked out from the test.'],
    ['lab, flag, notes', 'The lab that did the test; the flag as printed (H, L…); anything else.'],
  ],
  communications: [
    ['date', 'Needed. A time after the date is ignored.'],
    ['subject', 'Needed (or a summary, whose first line becomes the subject).'],
    ['direction', 'In, out, internal or both ways (inbound, outbound, sent, received also work). Empty: out.'],
    ['channel', 'Portal, call, email, visit, fax, letter, text, video or other (phone, MyChart, SMS also work). Empty: other.'],
    ['with', 'Names separated by ; or , (“Jane Smith, MD” stays one name), matched to the people on file.'],
    ['summary, outcome', 'Free text.'],
    ['follow_up, follow_up_due', 'What was promised, and by when.'],
    ['topics', 'Separated by ; or ,'],
  ],
};

/** What each column of the file was read as, in words (the server sends the field's code). */
const FIELD_WORDS: Record<string, string> = {
  date: 'Date',
  resulted: 'Result date',
  analyte: 'Test',
  value: 'Value',
  unit: 'Unit',
  ref_low: 'Normal range, low end',
  ref_high: 'Normal range, high end',
  ref: 'Normal range',
  specimen: 'Sample',
  lab: 'Lab',
  flag: 'Flag',
  notes: 'Notes',
  direction: 'Direction',
  channel: 'How (call, portal…)',
  with: 'With whom',
  subject: 'Subject',
  summary: 'Summary',
  outcome: 'Outcome',
  follow_up: 'Follow-up promised',
  follow_up_due: 'Follow-up due',
  topics: 'Topics',
  sleep_hours: 'Hours slept',
  sleep_quality: 'Sleep quality',
  energy: 'Energy',
  tags: 'Tags',
};

export function fieldWords(f: string): string {
  const second = /^ignored \(a second (.+) column\)$/.exec(f);
  if (second) return `Not read (a second ${fieldWords(second[1]).toLowerCase()} column)`;
  if (f === 'ignored' || f.startsWith('ignored')) return 'Not read';
  const sym = /^symptom[:.](.+)$/.exec(f);
  if (sym) return `Symptom: ${sym[1]}`;
  return FIELD_WORDS[f] ?? f.charAt(0).toUpperCase() + f.slice(1).replace(/_/g, ' ');
}

/** The Calls and messages page's words for a direction (features/people/shared.ts DIRECTION_WORDS). */
const DIRECTION_WORDS: Record<string, string> = { inbound: 'Incoming', outbound: 'Outgoing', internal: 'Within your team', bidirectional: 'Both ways', third_party: 'Care team to someone else' };
const CHANNEL_WORDS: Record<string, string> = { portal: 'Portal message', call: 'Phone call', email: 'Email', visit: 'In person', fax: 'Fax', letter: 'Letter', text: 'Text message', video: 'Video call', other: 'Other' };
const words = (map: Record<string, string>, v: string | null | undefined) => (v ? (map[v] ?? v) : '');

function isIncluded(r: CsvRow, excluded: Set<number>): boolean {
  return r.status === 'import' && !excluded.has(r.row);
}

function shownStatus(r: CsvRow, excluded: Set<number>): 'import' | 'skip' | 'excluded' {
  if (r.status === 'skip') return 'skip';
  if (r.status === 'excluded' || excluded.has(r.row)) return 'excluded';
  return 'import';
}

/** Why a row cannot be imported, or what to know about it; the status tag's hover. */
function noteOf(r: CsvRow, excluded: Set<number>): string {
  if (r.status === 'skip') return r.reason ?? 'It cannot be imported.';
  if (excluded.has(r.row)) return 'Left out: unticked.';
  return r.warnings.join('; ');
}

/** What a name decision is now: an explicit choice, else what the server decided. */
function decisionOf(n: CommCsvName, map: Record<string, string>): string {
  return map[n.key] ?? '__auto';
}

const KIND_WORDS: Record<string, string> = { clinician: 'clinician', clinic: 'clinic', institution: 'institution', advocate: 'advocate', family: 'family', chief_of_staff: 'chief of staff', patient: 'patient', other: 'other' };

function autoLabel(n: CommCsvName): string {
  if (n.via === 'chosen') return 'as chosen';
  if (n.action === 'match') return `${n.personName}${n.via === 'fuzzy' ? ` (the name is ${Math.round((n.score ?? 0) * 100)}% alike)` : ''}`;
  if (n.action === 'create') return `a new person (${KIND_WORDS[n.newKind] ?? n.newKind})`;
  return n.ambiguous.length ? `left out: could be ${n.ambiguous.join(' or ')}` : 'left out: nobody on file by that name';
}

/** A row's name for its pane: the test, the subject or the day. */
function rowTitle(r: CsvRow, target: CsvTarget): string {
  if (target === 'labs') return (r as LabCsvRow).analyte || `Row ${r.row}`;
  if (target === 'communications') return (r as CommCsvRow).subject || r.summary || `Row ${r.row}`;
  return r.dateText || r.date || `Row ${r.row}`;
}

export function CsvImport({
  kind,
  onKind,
  target,
  onTarget,
  selectedId,
  onSelect,
}: {
  kind: ImportKind;
  onKind: (k: ImportKind) => void;
  target: CsvTarget;
  onTarget: (t: CsvTarget) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<CsvResult | null>(null);
  const [applied, setApplied] = useState<CsvResult | null>(null);
  const [excluded, setExcluded] = useState<Set<number>>(() => new Set());
  const [createPeople, setCreatePeople] = useState(false);
  const [map, setMap] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [q, setQ] = useState('');
  const [runSeq, setRunSeq] = useState(0);
  const seq = useRef(0);
  const refresh = useRefreshAfterImport();
  const people = usePeople({});
  const busy = loading || applying;

  const mapJson = JSON.stringify(map);
  // The dry run follows the file, the target and every option that changes what a row writes.
  useEffect(() => {
    if (!file) return;
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    runCsvImport(file, target, { dryRun: true, createPeople, map })
      .then((r) => {
        if (mine !== seq.current) return;
        setResult(r);
      })
      .catch((err) => {
        if (mine !== seq.current) return;
        setResult(null);
        setError(errorMessage(err));
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, target, createPeople, mapJson, runSeq]);

  function chooseFile(f: File) {
    setFile(f);
    setResult(null);
    setApplied(null);
    setExcluded(new Set());
    setMap({});
    onSelect(null);
  }

  // A result for another target (the dry run for the new one still running) is not shown.
  const current = result && result.target === target ? result : null;
  const rows: CsvRow[] = current ? current.rows : [];
  const included = rows.filter((r) => isIncluded(r, excluded));
  const selected = selectedId ? (rows.find((r) => String(r.row) === selectedId) ?? null) : null;
  const refused = rows.filter((r) => r.status === 'skip').length;

  function toggle(r: CsvRow) {
    if (r.status !== 'import') return;
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(r.row)) next.delete(r.row);
      else next.add(r.row);
      return next;
    });
  }

  function decide(key: string, value: string) {
    setMap((prev) => {
      const next = { ...prev };
      if (value === '__auto') delete next[key];
      else next[key] = value;
      return next;
    });
  }

  function apply() {
    if (!file || !current || !included.length) return;
    setApplying(true);
    setError(null);
    runCsvImport(file, target, { dryRun: false, exclude: [...excluded].sort((a, b) => a - b), createPeople, map })
      .then((r) => {
        setApplied(r);
        refresh(target);
        setRunSeq((n) => n + 1);
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setApplying(false));
  }

  function cycleTarget() {
    const i = CSV_TARGETS.indexOf(target);
    onTarget(CSV_TARGETS[(i + 1) % CSV_TARGETS.length]);
  }

  const latest = useRef({ file, result: current, included, busy, target });
  latest.current = { file, result: current, included, busy, target };
  const actions = useRef({ pick: () => undefined as void, dry: () => undefined as void, openApply: () => undefined as void, cycle: () => undefined as void, people: () => undefined as void });
  actions.current = {
    pick: () => fileRef.current?.click(),
    dry: () => {
      if (latest.current.file && !latest.current.busy) setRunSeq((n) => n + 1);
    },
    openApply: () => {
      if (latest.current.included.length && !latest.current.busy) setConfirm(true);
    },
    cycle: cycleTarget,
    people: () => setCreatePeople((v) => !v),
  };

  useBindings(
    [
      { keys: 'f', description: 'Choose a spreadsheet file', group: 'Page', when: () => !dialogOpen(), run: () => actions.current.pick() },
      { keys: 'd', description: 'Read the spreadsheet again (saves nothing)', group: 'Page', when: () => !dialogOpen() && Boolean(latest.current.file), run: () => actions.current.dry() },
      { keys: 'a', description: 'Import the ticked rows (asks first)', group: 'Page', when: () => !dialogOpen() && latest.current.included.length > 0, run: () => actions.current.openApply() },
      { keys: 't', description: 'Change where the rows go: symptom diary, lab results, calls and messages', group: 'Page', when: () => !dialogOpen(), run: () => actions.current.cycle() },
      { keys: 'p', description: 'Add people not on file, or not (calls and messages)', group: 'Page', when: () => !dialogOpen() && latest.current.target === 'communications', run: () => actions.current.people() },
    ],
    [],
  );

  useRegisterCommands(
    [
      { id: 'import.csv.file', title: 'Import: choose a spreadsheet (.csv) file', group: 'Import calendar or spreadsheet', keywords: 'csv excel spreadsheet symptoms labs communications', shortcut: 'f', run: () => actions.current.pick() },
      { id: 'import.csv.dry', title: 'Import: read the spreadsheet again (saves nothing)', group: 'Import calendar or spreadsheet', keywords: 'dry run check again', shortcut: 'd', when: () => Boolean(latest.current.file), run: () => actions.current.dry() },
      { id: 'import.csv.apply', title: 'Import: import the ticked spreadsheet rows', group: 'Import calendar or spreadsheet', keywords: 'apply', shortcut: 'a', when: () => latest.current.included.length > 0, run: () => actions.current.openApply() },
      { id: 'import.csv.symptoms', title: 'Import: spreadsheet into the symptom diary', group: 'Import calendar or spreadsheet', run: () => onTarget('symptoms') },
      { id: 'import.csv.labs', title: 'Import: spreadsheet into lab results', group: 'Import calendar or spreadsheet', run: () => onTarget('labs') },
      { id: 'import.csv.communications', title: 'Import: spreadsheet into calls and messages', group: 'Import calendar or spreadsheet', run: () => onTarget('communications') },
    ],
    [onTarget],
  );

  const columns = useMemo<ColumnDef<CsvRow, unknown>[]>(() => {
    // The tick and the row's number in one narrow column, so the key column keeps the room (the row number names the
    // row in "Rows that cannot be imported"). A row that cannot be imported shows a tag before its name, its reason on hover.
    const check: ColumnDef<CsvRow, unknown> = {
      id: 'row',
      header: () => <span title="The row in the file. Ticked rows are imported (Space ticks the row)">Row</span>,
      accessorFn: (r) => r.row,
      cell: ({ row }) => (
        <span className="import-rowcell">
          <input
            type="checkbox"
            tabIndex={-1}
            checked={isIncluded(row.original, excluded)}
            disabled={row.original.status !== 'import'}
            onChange={() => toggle(row.original)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Import row ${row.original.row}`}
          />
          <span className="mono">{row.original.row}</span>
        </span>
      ),
      meta: { width: 76, shrink: false, className: 'import-check' },
    };
    const date: ColumnDef<CsvRow, unknown> = { id: 'date', header: 'Date', accessorFn: (r) => r.date ?? '', cell: ({ row }) => <DateText iso={row.original.date} precision={row.original.datePrecision} text={row.original.dateText} />, meta: { width: 96, shrink: false } };
    /** The key column: a "cannot import" tag (reason on hover) before the row's name. */
    const keyCell = (r: CsvRow, text: ReactNode) => (
      <>
        {r.status === 'skip' ? (
          <span className="import-cannot">
            <RowStatusTag status="skip" title={noteOf(r, excluded)} />{' '}
          </span>
        ) : null}
        {text}
      </>
    );
    let middle: ColumnDef<CsvRow, unknown>[];
    if (target === 'labs') {
      const L = (r: CsvRow) => r as LabCsvRow;
      middle = [
        { id: 'analyte', header: 'Test', accessorFn: (r) => L(r).analyte, cell: ({ row }) => keyCell(row.original, L(row.original).analyte), meta: { grow: true, minWidth: 160 } },
        {
          id: 'value',
          header: 'Value',
          accessorFn: (r) => L(r).valueNum ?? L(r).value,
          cell: ({ row }) => (
            <span title={valueKindWords(L(row.original).value) ?? undefined}>
              <span className="mono">{L(row.original).value}</span>
              {L(row.original).unit ? <span className="muted"> {L(row.original).unit}</span> : null}
            </span>
          ),
          meta: { width: 90, maxWidth: 160 },
        },
        { id: 'ref', header: 'Normal range', accessorFn: (r) => L(r).ref ?? '', cell: ({ getValue }) => <span className="mono">{String(getValue())}</span>, meta: { width: 100, maxWidth: 140 } },
        { id: 'specimen', header: 'Sample', accessorFn: (r) => sampleWords(L(r).specimen), cell: ({ getValue }) => <span className="muted">{String(getValue())}</span>, meta: { width: 80, maxWidth: 130 } },
      ];
    } else if (target === 'communications') {
      const C = (r: CsvRow) => r as CommCsvRow;
      middle = [
        { id: 'subject', header: 'Subject', accessorFn: (r) => C(r).subject || r.summary, cell: ({ row }) => keyCell(row.original, C(row.original).subject || row.original.summary), meta: { grow: true, minWidth: 180 } },
        {
          id: 'channel',
          header: 'How',
          accessorFn: (r) => [words(CHANNEL_WORDS, C(r).channel), words(DIRECTION_WORDS, C(r).direction).toLowerCase()].filter(Boolean).join(', '),
          cell: ({ getValue }) => <span className="muted">{String(getValue())}</span>,
          meta: { width: 110, maxWidth: 150 },
        },
        { id: 'with', header: 'With', accessorFn: (r) => C(r).participants.map((p) => p.personName ?? p.name).join(', '), cell: ({ row }) => <Participants row={C(row.original)} />, meta: { width: 120, maxWidth: 200 } },
      ];
    } else {
      middle = [
        { id: 'summary', header: 'Values', accessorFn: (r) => (r as SymptomCsvRow).summary, cell: ({ row }) => keyCell(row.original, (row.original as SymptomCsvRow).summary), meta: { grow: true, minWidth: 200 } },
        { id: 'notes', header: 'Good to know', accessorFn: (r) => (r.status === 'import' ? r.warnings.join('; ') : ''), cell: ({ getValue }) => <span className="muted">{String(getValue())}</span>, meta: { width: 120, maxWidth: 220 } },
      ];
    }
    return [check, date, ...middle];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, excluded]);

  const peopleItems = people.data?.items ?? [];
  const names = current?.target === 'communications' ? current.names : [];

  const step: 1 | 2 | 3 = !current ? 1 : included.length ? 3 : 2;
  const noun = target === 'symptoms' ? 'day' : 'row';
  const now = !file
    ? `Choose where the rows go, then the .csv file (or drop it here). The columns it reads are listed below.`
    : loading && !current
      ? `Reading ${file.name}…`
      : !current
        ? 'That file could not be read. Choose another one.'
        : included.length
          ? `${plural(included.length, 'row')} ticked${refused ? `, ${refused} cannot be imported` : ''}. Untick any you do not want, pick one to see what it saves, then press Import.`
          : 'Nothing is ticked. Tick the rows to import (Space), or pick one to see why it cannot be imported.';

  const left =
    loading && !current ? (
      <Loading>Reading {file?.name}…</Loading>
    ) : (
      <DataTable
        columns={columns}
        data={rows}
        rowId={(r) => String(r.row)}
        selectedId={selectedId}
        onSelect={(r) => onSelect(r ? String(r.row) : null)}
        initialSort={[{ id: 'row', desc: false }]}
        rowClassName={(r) => (isIncluded(r, excluded) ? undefined : 'dim')}
        emptyText={q ? 'No row matches this search.' : 'The file holds no rows under its headers.'}
        autoFocus
        maxRows={20_000}
        globalFilter={q}
        tableId={`import.csv.${target}`}
        onKey={(e, cur) => {
          if (!cur || e.ctrlKey || e.metaKey || e.altKey) return false;
          if ((e.target as HTMLElement).tagName === 'INPUT') return false;
          if (e.key === ' ') {
            toggle(cur);
            return true;
          }
          return false;
        }}
        footer={
          <span>
            {plural(included.length, 'row')} ticked · {refused} cannot be imported · {rows.filter((r) => r.status === 'import' && excluded.has(r.row)).length} left out
          </span>
        }
      />
    );

  const right = selected ? (
    <RowDetail key={selected.row} row={selected} target={target} excluded={excluded} onToggle={() => toggle(selected)} names={names} map={map} onDecide={decide} people={peopleItems} />
  ) : current ? (
    <ResultSummary result={current} applied={applied} names={names} map={map} onDecide={decide} people={peopleItems} />
  ) : (
    <Loading>Reading the file…</Loading>
  );

  const body = !file ? (
    <CsvStart target={target} onChoose={() => actions.current.pick()} applied={applied} />
  ) : !current && !loading ? (
    <EmptyState
      title={`${file.name} could not be read for ${TARGET_LOWER[target]}`}
      action={
        <Button variant="primary" onClick={() => actions.current.pick()} shortcut="f">
          Choose another file
        </Button>
      }
    >
      {error ?? 'It does not look like a spreadsheet saved as .csv.'} The first row must hold the column headers; the columns {TARGET_LOWER[target]} read are listed when no file is chosen.
    </EmptyState>
  ) : (
    <SplitView storageKey="import.csv" defaultLeft={60} minLeft={460} minRight={400} left={left} right={right} />
  );

  return (
    <>
      <ImportHeader
        meta={
          file ? (
            <span>
              From <span className="mono">{file.name}</span> into {TARGET_LOWER[target]}
              {current ? (
                <>
                  {' · '}
                  {plural(current.rows.length, 'row')}
                </>
              ) : null}
            </span>
          ) : null
        }
        actions={
          current
            ? {
                primary: { label: applying ? 'Importing…' : included.length ? `Import ${plural(included.length, 'row')}` : 'Import', onClick: () => actions.current.openApply(), shortcut: 'a', disabled: !included.length || busy, title: `Save the ticked rows into ${TARGET_LOWER[target]} (asks first)` },
                secondary: [{ label: 'Choose another file', onClick: () => actions.current.pick(), shortcut: 'f' }],
                more: [
                  excluded.size
                    ? { label: 'Tick every row that can be imported', onClick: () => setExcluded(new Set()), disabled: busy }
                    : { label: 'Untick every row', onClick: () => setExcluded(new Set(rows.filter((r) => r.status === 'import').map((r) => r.row))), disabled: busy || !included.length },
                  { label: 'Read the file again', onClick: () => actions.current.dry(), shortcut: 'd', disabled: busy, title: 'Read the same file again, for example after adding someone on People and places; saves nothing' },
                ],
              }
            : { primary: { label: loading ? 'Reading…' : 'Choose a spreadsheet file', onClick: () => actions.current.pick(), shortcut: 'f', disabled: busy, title: `A .csv file of rows for ${TARGET_LOWER[target]}` } }
        }
      />
      <Toolbar label="Import from, into and find">
        <KindTabs kind={kind} onKind={onKind} />
        <Segmented
          label="Into"
          value={target}
          onChange={onTarget}
          options={CSV_TARGETS.map((t) => ({ value: t, label: TARGET_WORDS[t], title: `Rows become entries in ${TARGET_LOWER[t]} (t cycles)` }))}
        />
        {target === 'communications' ? (
          <FilterGroup label="Names">
            <label className="import-toggle" title="Key p">
              <input type="checkbox" checked={createPeople} onChange={(e) => setCreatePeople(e.target.checked)} />
              Add people not on file
            </label>
          </FilterGroup>
        ) : null}
        {current ? <SearchField label="Find" placeholder={target === 'labs' ? 'Test or value, e.g. protein' : target === 'communications' ? 'Subject or name' : 'Date or symptom'} value={q} onChange={setQ} width={210} /> : null}
        <ToolbarKeys
          items={
            current
              ? [['j/k', 'move'], ['space', 'tick'], ['a', 'import'], ['t', 'where the rows go'], target === 'communications' ? ['p', 'add people'] : null, ['f', 'another file'], ['/', 'find']]
              : [['f', 'choose a file'], ['t', 'where the rows go'], ['v i', 'calendar']]
          }
        />
      </Toolbar>
      <ImportSteps step={step} check={target === 'symptoms' ? 'Check what each day saves' : 'Check what each row saves'} now={now} />
      <FileInput ref={fileRef} accept=".csv,.tsv,.txt,text/csv" onFile={chooseFile} />
      <DropArea onFile={chooseFile} label="Drop the .csv file to read it">
        {error && current ? <div className="notice bad import-notice">{error}</div> : null}
        {applied ? <AppliedLine applied={applied} /> : null}
        {body}
      </DropArea>
      <ApplyConfirm
        open={confirm}
        onClose={() => setConfirm(false)}
        onApply={apply}
        busy={busy}
        title={`Import into ${TARGET_LOWER[target]}?`}
        confirmLabel={target === 'symptoms' ? 'Import' : `Import ${plural(included.length, noun)}`}
      >
        <ConfirmBody result={current} included={included} file={file} />
      </ApplyConfirm>
    </>
  );
}

/** Step 1, before a file is chosen: the button, and the columns this target reads. */
function CsvStart({ target, onChoose, applied }: { target: CsvTarget; onChoose: () => void; applied: CsvResult | null }) {
  return (
    <div className="import-start">
      <EmptyState
        title={`Choose a spreadsheet for ${TARGET_LOWER[target]}`}
        action={
          <Button variant="primary" onClick={onChoose} shortcut="f">
            Choose a spreadsheet file
          </Button>
        }
      >
        Save the spreadsheet as .csv (in Excel: File, Save a copy, CSV) and choose it, or drop it anywhere on this page. Nothing is saved until you press Import.
      </EmptyState>
      <div className="import-start-help">
        <Section title={`Columns ${TARGET_LOWER[target]} read`} intro="The first row must hold the headers. Similar headers work too (Test or Component for test, Units for unit, Who for with). Up to 20 000 rows and 20 MB.">
          <dl className="import-guide">
            {GUIDE[target].map(([k, v]) => (
              <div key={k} className="import-guide-row">
                <dt className="mono">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </Section>
        {applied ? <AppliedSection applied={applied} /> : null}
      </div>
    </div>
  );
}

function Participants({ row }: { row: CommCsvRow }) {
  if (!row.participants.length) return null;
  return (
    <span className="import-names-inline">
      {row.participants.map((p, i) => (
        <span key={p.key} className={p.action === 'none' ? 'muted' : undefined} title={p.action === 'match' ? `${p.name}: ${p.personName}` : p.action === 'create' ? 'A new person' : 'Left out; named in the summary'}>
          {i ? ', ' : ''}
          {p.action === 'create' ? `${p.name} (new)` : (p.personName ?? p.name)}
        </span>
      ))}
    </span>
  );
}

function NameChoice({ name, map, onDecide, people }: { name: CommCsvName; map: Record<string, string>; onDecide: (key: string, value: string) => void; people: PersonRow[] }) {
  return (
    <Select
      aria-label={`Who ${name.name} is`}
      value={decisionOf(name, map)}
      onChange={(e) => onDecide(name.key, e.target.value)}
      options={[
        { value: '__auto', label: `Suggested: ${autoLabel(name)}` },
        { value: 'new', label: `A new person (${KIND_WORDS[name.newKind] ?? name.newKind})` },
        { value: 'none', label: 'Leave out (named in the summary)' },
        ...people.map((p) => ({ value: p.id, label: `${p.name} (${KIND_WORDS[p.kind] ?? p.kind.replace(/_/g, ' ')})` })),
      ]}
    />
  );
}

function NamesTable({ names, map, onDecide, people }: { names: CommCsvName[]; map: Record<string, string>; onDecide: (key: string, value: string) => void; people: PersonRow[] }) {
  if (!names.length) return <p className="muted">No names in the with column.</p>;
  return (
    <table className="data-table import-names">
      <thead>
        <tr>
          <th>Name in the file</th>
          <th>On rows</th>
          <th>Who it is</th>
        </tr>
      </thead>
      <tbody>
        {names.map((n) => (
          <tr key={n.key}>
            <td>
              {n.name}
              {n.note && n.action === 'none' ? <div className="small muted">{n.note}</div> : null}
            </td>
            <td className="mono muted">
              {n.rows.slice(0, 8).join(', ')}
              {n.rows.length > 8 ? ' …' : ''}
            </td>
            <td>
              <NameChoice name={n} map={map} onDecide={onDecide} people={people} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RowDetail({
  row,
  target,
  excluded,
  onToggle,
  names,
  map,
  onDecide,
  people,
}: {
  row: CsvRow;
  target: CsvTarget;
  excluded: Set<number>;
  onToggle: () => void;
  names: CommCsvName[];
  map: Record<string, string>;
  onDecide: (key: string, value: string) => void;
  people: PersonRow[];
}) {
  const st = shownStatus(row, excluded);
  let written: Array<KeyFact | null> = [];
  if (target === 'labs') {
    const r = row as LabCsvRow;
    const kindWords = r.valueNum == null ? valueKindWords(r.value) : null;
    written = [
      { label: 'Value', value: r.value ? <>{r.value}{kindWords ? <span className="muted"> ({kindWords})</span> : null}</> : null, mono: true },
      r.unit ? { label: 'Unit', value: r.unit, mono: true } : null,
      r.ref ? { label: 'Normal range', value: r.ref, mono: true } : null,
      { label: 'Sample', value: sampleWords(r.specimen) },
      // The flag as written ("HH", "Pos"); a blank or dashed cell is "None printed" (rule 4). No flag column: nothing.
      r.flagRaw != null ? { label: 'Flag', value: r.flagRaw.trim() && r.flagRaw.trim() !== '-' ? r.flagRaw.trim() : 'None printed', mono: Boolean(r.flagRaw.trim() && r.flagRaw.trim() !== '-') } : r.flag ? { label: 'Flag', value: r.flag, mono: true } : null,
      r.lab ? { label: 'Lab', value: r.lab } : null,
      // The date is labelled by its kind, never "Collected" for a result date or a date of unknown kind (rule 7).
      { label: r.dateKind === 'collected' ? 'Collected' : r.dateKind === 'resulted' ? 'Resulted' : 'Date', value: <DateText iso={r.date} precision={r.datePrecision} text={r.dateText} /> },
      r.dateKind !== 'resulted' && (r.resulted || r.resultedText) ? { label: 'Resulted', value: <DateText iso={r.resulted ?? null} precision={r.resultedPrecision ?? 'unknown'} text={r.resultedText ?? null} /> } : null,
    ];
  } else if (target === 'communications') {
    const r = row as CommCsvRow;
    written = [
      { label: 'When', value: <DateText iso={r.date} precision={r.datePrecision} text={r.dateText} /> },
      r.direction ? { label: 'Direction', value: words(DIRECTION_WORDS, r.direction) } : null,
      r.channel ? { label: 'How', value: words(CHANNEL_WORDS, r.channel) } : null,
      r.body ? { label: 'Summary', value: <span className="import-desc">{r.body}</span>, wide: true } : null,
      r.outcome ? { label: 'Outcome', value: r.outcome, wide: true } : null,
      r.followUp ? { label: 'Follow-up', value: `${r.followUp}${r.followUpDue ? ` (due ${r.followUpDue})` : ''}`, wide: true } : null,
      r.topics.length ? { label: 'Topics', value: r.topics.join(', '), wide: true } : null,
    ];
  } else {
    const r = row as SymptomCsvRow;
    written = [
      ...Object.entries(r.scores).map(([k, v]): KeyFact => ({ label: k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' '), value: v, mono: true })),
      r.sleepHours != null ? { label: 'Hours slept', value: r.sleepHours, mono: true } : null,
      r.sleepQuality != null ? { label: 'Sleep quality', value: r.sleepQuality, mono: true } : null,
      r.energy != null ? { label: 'Energy', value: r.energy, mono: true } : null,
      r.notes ? { label: 'Notes', value: r.notes, wide: true } : null,
      r.tags.length ? { label: 'Tags', value: r.tags.join(', '), wide: true } : null,
    ];
  }
  const comm = target === 'communications' ? (row as CommCsvRow) : null;
  const cells = Object.entries(row.cells).filter(([, v]) => v !== '');
  return (
    <DetailPane label="Spreadsheet row">
      <DetailHeader
        eyebrow={
          <>
            <RowStatusTag status={st} />
            <span className="mono">Row {row.row}</span>
          </>
        }
        title={rowTitle(row, target)}
        status={[
          target === 'symptoms' ? null : (
            <DateText key="d" iso={row.date} precision={row.datePrecision} text={row.dateText} />
          ),
          st === 'import' ? `Will be saved in ${TARGET_LOWER[target]}` : st === 'excluded' ? 'Left out: it will not be saved' : 'Cannot be imported',
        ]}
        actions={row.status === 'import' ? { primary: { label: excluded.has(row.row) ? 'Import this one' : 'Leave this one out', onClick: onToggle, shortcut: 'space' } } : undefined}
      />
      {row.status === 'skip' ? (
        <div className="notice warn">
          <strong>Why it cannot be imported:</strong> {row.reason}
        </div>
      ) : null}
      {row.warnings.length ? (
        <Section title="Good to know">
          <IssueList items={row.warnings.map((text) => ({ text }))} />
        </Section>
      ) : null}
      {row.status !== 'skip' ? (
        <Section title={st === 'import' ? 'What it saves' : 'What it would save'}>
          <KeyFacts items={written} />
        </Section>
      ) : null}
      {comm && comm.participants.length ? (
        <Section title="People" intro="Who each name in the with column is. Changing one reads the file again.">
          <table className="data-table import-names">
            <tbody>
              {comm.participants.map((p) => {
                const n = names.find((x) => x.key === p.key);
                return (
                  <tr key={p.key}>
                    <td>
                      {p.name} {p.role ? <span className="muted small">{p.role}</span> : null}
                    </td>
                    <td>{n ? <NameChoice name={n} map={map} onDecide={onDecide} people={people} /> : <span className="muted">{p.personName ?? 'left out'}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Section>
      ) : null}
      <Section title="As written in the file" count={cells.length}>
        {cells.length ? (
          <dl className="import-guide compact">
            {cells.map(([k, v]) => (
              <div key={k} className="import-guide-row">
                <dt className="mono">{k}</dt>
                <dd className="import-cell mono">{v}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="muted">Every cell on this row is empty.</p>
        )}
      </Section>
    </DetailPane>
  );
}

/** The right pane before a row is picked: the file, the names (calls), how the columns were read, what cannot be imported. */
function ResultSummary({ result, applied, names, map, onDecide, people }: { result: CsvResult; applied: CsvResult | null; names: CommCsvName[]; map: Record<string, string>; onDecide: (key: string, value: string) => void; people: PersonRow[] }) {
  const toImport = result.rows.filter((r) => r.status === 'import').length;
  const refused = result.skipped.filter((s) => s.reason !== 'left out in the preview');
  return (
    <DetailPane label="Spreadsheet">
      <DetailHeader
        eyebrow={<span>Spreadsheet, into {TARGET_LOWER[result.target]}</span>}
        title={result.filename ?? 'The spreadsheet'}
        status={[plural(result.rows.length, 'row'), `${toImport} can be imported`, refused.length ? `${refused.length} cannot` : null]}
        facts={[
          result.target === 'symptoms' ? { label: 'Days', value: `${plural(result.imported, 'day')}, ${plural(result.entries, 'score')}` } : null,
          result.target === 'symptoms' && result.created.length ? { label: 'New symptoms', value: result.created.join(', '), wide: true } : null,
          result.target === 'symptoms' ? { label: 'Replaces', value: result.overwritten.length ? `${plural(result.overwritten.length, 'value')} already in the diary` : 'Nothing already in the diary', wide: true } : null,
        ]}
      />
      <p className="muted">Pick a row on the left to see what it saves. Move with j and k; Space ticks or unticks.</p>
      {applied ? <AppliedSection applied={applied} /> : null}
      {result.fileNotes.length ? (
        <Section title="Good to know about the file">
          <IssueList items={result.fileNotes.map((text) => ({ text }))} />
        </Section>
      ) : null}
      {result.target === 'communications' ? (
        <Section title="Names" count={names.length} intro="Who each name in the with column is. Changing one reads the file again.">
          <NamesTable names={names} map={map} onDecide={onDecide} people={people} />
        </Section>
      ) : null}
      {refused.length ? (
        <Section title="Rows that cannot be imported" count={refused.length}>
          <IssueList items={refused.slice(0, 200).map((s) => ({ row: s.row, text: s.reason }))} />
        </Section>
      ) : null}
      <Section title="How each column was read" count={Object.keys(result.columns).length}>
        <dl className="import-guide">
          {Object.entries(result.columns).map(([h, f]) => (
            <div key={h} className="import-guide-row">
              <dt className="mono">{h}</dt>
              <dd className={f.startsWith('ignored') ? 'muted' : undefined}>{fieldWords(f)}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </DetailPane>
  );
}

function appliedLink(r: CsvResult): ReactNode {
  if (r.target === 'labs') return <Link to="/labs" search={{ view: 'results' }}>Open lab results</Link>;
  if (r.target === 'communications') return <Link to="/communications">Open calls and messages</Link>;
  return <Link to="/symptoms">Open the symptom diary</Link>;
}

function AppliedLine({ applied }: { applied: CsvResult }) {
  const notWritten = applied.skipped.filter((s) => s.reason !== 'left out in the preview').length;
  return (
    <div className="notice ok import-notice" role="status">
      <strong>
        Imported {applied.target === 'symptoms' ? plural(applied.imported, 'day') : plural(applied.imported, 'row')} into {TARGET_LOWER[applied.target]}
      </strong>{' '}
      from <span className="mono">{applied.filename ?? 'the file'}</span>
      {applied.target === 'communications' && applied.createdPeople.length ? `, adding ${plural(applied.createdPeople.length, 'person', 'people')}` : ''}
      {notWritten ? `; ${notWritten} could not be saved` : ''}. {appliedLink(applied)}
    </div>
  );
}

function AppliedSection({ applied }: { applied: CsvResult }) {
  const failed = applied.skipped.filter((s) => s.reason !== 'left out in the preview');
  return (
    <Section title="Last import">
      <p>
        {applied.target === 'symptoms' ? `${plural(applied.imported, 'day')} and ${plural(applied.entries, 'score')} saved` : `${plural(applied.imported, 'row')} saved`} from <span className="mono">{applied.filename ?? 'the file'}</span>. {appliedLink(applied)}
      </p>
      {applied.target === 'communications' && applied.createdPeople.length ? (
        <p>
          New people:{' '}
          {applied.createdPeople.map((p, i) => (
            <span key={p.id}>
              {i ? ', ' : ''}
              <Link to="/people" search={{ id: p.id }}>
                {p.name}
              </Link>
            </span>
          ))}
        </p>
      ) : null}
      {applied.target === 'symptoms' && applied.overwritten.length ? <p className="muted">{plural(applied.overwritten.length, 'value')} already in the diary replaced.</p> : null}
      <IssueList items={failed.map((s) => ({ row: s.row, text: s.reason }))} />
    </Section>
  );
}

function ConfirmBody({ result, included, file }: { result: CsvResult | null; included: CsvRow[]; file: File | null }) {
  if (!result) return null;
  const name = <span className="mono">{file?.name ?? 'the file'}</span>;
  if (result.target === 'symptoms') {
    const rows = included as SymptomCsvRow[];
    const days = new Set(rows.map((r) => r.date)).size;
    const scores = rows.reduce((n, r) => n + Object.keys(r.scores).length, 0);
    const replaces = rows.reduce((n, r) => n + r.warnings.filter((w) => w.startsWith('replaces')).length, 0);
    return (
      <>
        <p>
          This saves {plural(days, 'day')} ({plural(scores, 'score')}) in the symptom diary, from {name}.
        </p>
        {replaces ? <p>{plural(replaces, 'value')} already in the diary will be replaced by the file’s; the diary keeps no copy of the old values.</p> : null}
        {result.created.length ? <p className="muted">New symptoms: {result.created.join(', ')}.</p> : null}
      </>
    );
  }
  if (result.target === 'labs') {
    return (
      <>
        <p>
          This adds {plural(included.length, 'lab value')} from {name}.
        </p>
        <p className="muted">Each value notes the file it came from; it is linked to no document. A value already on file (the same test, sample, date, value and unit) was left out when the file was read.</p>
      </>
    );
  }
  const rows = included as CommCsvRow[];
  const linked = new Set<string>();
  const added = new Set<string>();
  let leftOut = 0;
  for (const r of rows)
    for (const p of r.participants) {
      if (p.action === 'match' && p.personId) linked.add(p.personId);
      else if (p.action === 'create') added.add(p.key);
      else leftOut++;
    }
  return (
    <>
      <p>
        This adds {plural(rows.length, 'call or message', 'calls and messages')} from {name}, linked to {plural(linked.size, 'person', 'people')}
        {added.size ? `, and adds ${plural(added.size, 'new person', 'new people')}` : ''}.
      </p>
      {leftOut ? <p>{plural(leftOut, 'name')} not linked to anyone; each is written into its summary.</p> : null}
      <p className="muted">Each summary ends with a line naming the file and the row.</p>
    </>
  );
}

/** What a lab value with no number is, in plain words: "a limit, not a measurement" ("<3"), "words, no number", "a range of values". */
export function valueKindWords(value: string | null | undefined): string | null {
  const v = parseLabValue(value ?? '');
  switch (v.kind) {
    case 'censored':
      return 'a limit, not a measurement';
    case 'text':
      return 'words, no number';
    case 'range':
      return 'a range of values, not one measurement';
    default:
      return null;
  }
}

