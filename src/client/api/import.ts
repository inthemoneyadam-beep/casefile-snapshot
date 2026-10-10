/**
 * Calendar and spreadsheet import (docs/API-CONTRACTS-3.md, slice O). Types
 * mirror src/server/services/import-calendar.ts and import-csv.ts. Nothing
 * here caches the file: the page keeps the File and sends it again for each
 * dry run and for the apply.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { DatePrecision } from '@shared/dates';

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export const ENCOUNTER_KIND_OPTIONS = ['visit', 'telehealth', 'procedure', 'admission', 'test', 'infusion', 'other'] as const;
export type EncounterKind = (typeof ENCOUNTER_KIND_OPTIONS)[number];
export type CalendarKind = 'encounter' | 'daily' | 'skip';

export interface CalendarSuggestion {
  kind: CalendarKind;
  encounterKind: EncounterKind;
  clinicianId: string | null;
  clinicianName: string | null;
  institutionId: string | null;
  institutionName: string | null;
  matchNote: string | null;
  existingEncounterId: string | null;
  existingEncounterTitle: string | null;
  reason: string;
}

export interface CalendarItem {
  uid: string;
  uidAsWritten: string | null;
  start: string | null;
  time: string | null;
  allDay: boolean;
  title: string;
  location: string | null;
  description: string | null;
  status: string | null;
  recurrence: string | null;
  timeZone: string | null;
  asWritten: string | null;
  attendees: string[];
  notes: string[];
  startPrecision: 'day' | 'unknown';
  alreadyImported: boolean;
  suggested: CalendarSuggestion;
}

export interface CalendarPreview {
  filename: string | null;
  timeZone: string;
  items: CalendarItem[];
  counts: { events: number; encounter: number; daily: number; skip: number; alreadyImported: number; repeating: number };
  warnings: string[];
}

export interface CalendarApplyItem {
  uid: string;
  kind: CalendarKind;
  clinicianId?: string | null;
  institutionId?: string | null;
  title?: string | null;
  encounterKind?: EncounterKind | null;
  eventStatus?: string | null;
  start?: string | null;
  time?: string | null;
  summary?: string | null;
  location?: string | null;
  description?: string | null;
}

export interface CalendarApplyResult {
  imported: number;
  encounters: number;
  daily: number;
  created: Array<{ uid: string; kind: 'encounter' | 'daily'; id: string; date: string | null; title: string }>;
  skipped: Array<{ uid: string; title: string; reason: string }>;
}

export function previewCalendarFile(file: File): Promise<CalendarPreview> {
  const form = new FormData();
  form.set('file', file, file.name);
  return api.post<CalendarPreview>('/api/import/ics', form);
}

export function applyCalendarItems(filename: string | null, items: CalendarApplyItem[]): Promise<CalendarApplyResult> {
  return api.post<CalendarApplyResult>('/api/import/ics/apply', { filename, items });
}

// ---------------------------------------------------------------------------
// Spreadsheets
// ---------------------------------------------------------------------------

export const CSV_TARGETS = ['symptoms', 'labs', 'communications'] as const;
export type CsvTarget = (typeof CSV_TARGETS)[number];
export type CsvRowStatus = 'import' | 'skip' | 'excluded';

export interface CsvRowBase {
  row: number;
  status: CsvRowStatus;
  reason: string | null;
  warnings: string[];
  date: string | null;
  datePrecision: DatePrecision;
  dateText: string | null;
  summary: string;
  cells: Record<string, string>;
}

export interface SymptomCsvRow extends CsvRowBase {
  scores: Record<string, number>;
  sleepHours: number | null;
  sleepQuality: number | null;
  energy: number | null;
  notes: string | null;
  tags: string[];
}

export interface LabCsvRow extends CsvRowBase {
  analyte: string;
  value: string;
  valueNum: number | null;
  unit: string | null;
  ref: string | null;
  refLow: number | null;
  refHigh: number | null;
  specimen: string;
  flag: string | null;
  /** The flag cell as written ('' blank, '-' dash); null when the file has no flag column (2026-10). */
  flagRaw?: string | null;
  lab: string | null;
  /** What `date` is: 'collected' under a collected-type header, 'unknown' under Date/Day, 'resulted' when only a result date is given. */
  dateKind?: 'collected' | 'unknown' | 'resulted' | null;
  /** The result date, when the file has a result date column. */
  resulted?: string | null;
  resultedPrecision?: DatePrecision | null;
  resultedText?: string | null;
}

export type NameAction = 'match' | 'create' | 'none';

export interface CommCsvParticipant {
  key: string;
  name: string;
  action: NameAction;
  personId: string | null;
  personName: string | null;
  role: string;
}

export interface CommCsvRow extends CsvRowBase {
  direction: string | null;
  channel: string | null;
  subject: string;
  body: string | null;
  outcome: string | null;
  followUp: string | null;
  followUpDue: string | null;
  topics: string[];
  participants: CommCsvParticipant[];
}

export interface CommCsvName {
  key: string;
  name: string;
  action: NameAction;
  personId: string | null;
  personName: string | null;
  personKind: string | null;
  via: 'exact' | 'alias' | 'fuzzy' | 'chosen' | null;
  score: number | null;
  ambiguous: string[];
  newKind: string;
  rows: number[];
  note: string | null;
}

interface CsvResultBase<R extends CsvRowBase> {
  filename: string | null;
  dryRun: boolean;
  imported: number;
  skipped: Array<{ row: number; reason: string }>;
  warnings: Array<{ row: number; message: string }>;
  fileNotes: string[];
  columns: Record<string, string>;
  rows: R[];
}

export interface SymptomCsvResult extends CsvResultBase<SymptomCsvRow> {
  target: 'symptoms';
  entries: number;
  created: string[];
  overwritten: Array<{ date: string; field: string; from: string | number; to: string | number }>;
}

export interface LabCsvResult extends CsvResultBase<LabCsvRow> {
  target: 'labs';
  ids: string[];
}

export interface CommCsvResult extends CsvResultBase<CommCsvRow> {
  target: 'communications';
  createPeople: boolean;
  names: CommCsvName[];
  createdPeople: Array<{ id: string; name: string; kind: string }>;
  ids: string[];
}

export type CsvResult = SymptomCsvResult | LabCsvResult | CommCsvResult;
export type CsvRow = SymptomCsvRow | LabCsvRow | CommCsvRow;

export interface CsvRunOptions {
  dryRun: boolean;
  exclude?: number[];
  createPeople?: boolean;
  /** communications: name key -> person id, 'new' or 'none'. */
  map?: Record<string, string>;
}

export function runCsvImport(file: File, target: CsvTarget, opts: CsvRunOptions): Promise<CsvResult> {
  const form = new FormData();
  form.set('file', file, file.name);
  form.set('target', target);
  if (opts.exclude?.length) form.set('exclude', opts.exclude.join(','));
  if (opts.createPeople) form.set('createPeople', '1');
  if (opts.map && Object.keys(opts.map).length) form.set('map', JSON.stringify(opts.map));
  return api.post<CsvResult>(`/api/import/csv${opts.dryRun ? '?dryRun=1' : ''}`, form);
}

// ---------------------------------------------------------------------------
// Status and cache refresh
// ---------------------------------------------------------------------------

export const importKeys = { status: ['import', 'status'] as const };

export function useImportStatus(enabled = true) {
  return useQuery({ queryKey: importKeys.status, queryFn: () => api.get<{ icsImported: number }>('/api/import/status'), enabled, staleTime: 10_000 });
}

/** After an apply: every list an import can write to. */
export function useRefreshAfterImport(): (what: 'calendar' | CsvTarget) => void {
  const qc = useQueryClient();
  return (what) => {
    const keys: string[][] = [['import'], ['timeline'], ['today'], ['search']];
    if (what === 'calendar') keys.push(['encounters'], ['symptoms']);
    else if (what === 'symptoms') keys.push(['symptoms']);
    else if (what === 'labs') keys.push(['labs']);
    else keys.push(['communications'], ['people']);
    for (const k of keys) void qc.invalidateQueries({ queryKey: k });
  };
}
