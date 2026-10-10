/**
 * Typed client for /api/symptoms. Query keys all start with 'symptoms' so one
 * invalidation refreshes definitions, days, series and the summary together.
 * The day upsert is optimistic: a keystroke in the quick-entry grid shows at
 * once and is rolled back with a toast if the server refuses it.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChartBand, ChartMarker, ChartSpec } from '@shared/chart';
import type { BandFlags } from '../features/charts/lanes';
import { api } from './client';

export interface SymptomDefinition {
  id: string;
  name: string;
  description: string | null;
  sortOrder: number;
  active: boolean;
  createdAt: string;
  entryCount: number;
  lastDate: string | null;
}

export interface DayScore {
  score: number;
  note: string | null;
}

export interface DayRow {
  date: string;
  sleepHours: number | null;
  sleepQuality: number | null;
  energy: number | null;
  notes: string | null;
  tags: string[];
  hasLog: boolean;
  scores: Record<string, DayScore>;
}

export interface DaysResponse {
  from: string;
  to: string;
  days: DayRow[];
}

export type ScoreInput = number | { score?: number; note?: string | null };

export interface DayInput {
  scores?: Record<string, ScoreInput>;
  notes?: string | null;
  sleepHours?: number | null;
  sleepQuality?: number | null;
  energy?: number | null;
  tags?: string[];
}

export type SeriesBucket = 'day' | 'week';

export interface SeriesParams {
  from?: string;
  to?: string;
  symptomIds?: string;
  bucket?: SeriesBucket;
}

/**
 * A medication course as the chart draws it, with its true dates (not clipped
 * to the window), plus the medication it stands for. The flags (lane,
 * startKnown, ongoing, clippedStart, clippedEnd) are optional: without them a
 * course is its own row, its start counts as recorded, and it is ongoing when
 * it has no stop date.
 */
export type OverlayBand = ChartBand &
  BandFlags & {
    medicationId: string;
    /** The untruncated medication name (the chart label may be shortened). */
    name: string;
    /** The medication's start was stated (absent from an older server). */
    startRecorded?: boolean;
    /**
     * The first date the records mention the medication. Null with startKnown false: no document dates it and
     * `from` is only the window's first day (a course known only by its stop).
     */
    firstSeen?: string | null;
  };

/** An event tick as drawn on the chart, plus the record it stands for. */
export interface OverlayMarker extends ChartMarker {
  kind: 'medication' | 'encounter';
  medicationId: string | null;
  encounterId: string | null;
}

export interface SeriesResponse {
  from: string;
  to: string;
  bucket: SeriesBucket;
  chart: ChartSpec;
  sleep: ChartSpec;
  /** The chart's bands and markers with the ids of their source records. */
  overlays: { bands: OverlayBand[]; markers: OverlayMarker[] };
}

export interface SymptomSummary {
  definitions: number;
  active: number;
  daysLogged: number;
  firstDate: string | null;
  lastDate: string | null;
  loggedToday: boolean;
}

/** A value already in the log that an import replaces with a different one. */
export interface ImportOverwrite {
  date: string;
  /** The symptom name for a score; otherwise sleep_hours, sleep_quality, energy, notes or tags. */
  field: string;
  /** The value in the log now. */
  from: string | number;
  /** The value from the file. */
  to: string | number;
}

export interface ImportResult {
  /** Days written; on a dry run, days that would be written. */
  imported: number;
  entries: number;
  /** Definitions created or reactivated (on a dry run, that would be). */
  created: string[];
  skipped: Array<{ row: number; reason: string }>;
  /** How each header was read: a daily-log field, 'symptom' or 'ignored'. */
  columns: Record<string, string>;
  /** Values already in the log that the file replaces. */
  overwritten: ImportOverwrite[];
  /** True when nothing was written (a preview). */
  dryRun: boolean;
}

export const symptomKeys = {
  all: ['symptoms'] as const,
  definitions: (includeInactive: boolean) => ['symptoms', 'definitions', includeInactive] as const,
  days: (from: string, to: string) => ['symptoms', 'days', from, to] as const,
  series: (p: SeriesParams) => ['symptoms', 'series', p] as const,
  summary: ['symptoms', 'summary'] as const,
};

export function useDefinitions(includeInactive = false) {
  return useQuery({
    queryKey: symptomKeys.definitions(includeInactive),
    queryFn: () => api.get<{ items: SymptomDefinition[] }>(`/api/symptoms/definitions${api.qs({ includeInactive: includeInactive ? 1 : undefined })}`),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

export function useDays(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: symptomKeys.days(from, to),
    queryFn: () => api.get<DaysResponse>(`/api/symptoms/entries${api.qs({ from, to })}`),
    enabled,
    staleTime: 10_000,
    placeholderData: (prev) => prev,
  });
}

export function useSeries(p: SeriesParams, enabled = true) {
  return useQuery({
    queryKey: symptomKeys.series(p),
    queryFn: () => api.get<SeriesResponse>(`/api/symptoms/series${api.qs(p as Record<string, string | undefined>)}`),
    enabled,
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });
}

export function useSymptomSummary() {
  return useQuery({ queryKey: symptomKeys.summary, queryFn: () => api.get<SymptomSummary>('/api/symptoms/summary'), staleTime: 10_000 });
}

/** Merge a day input into a cached DayRow the way the server will. */
export function applyDayInput(prev: DayRow | undefined, date: string, input: DayInput): DayRow {
  const base: DayRow = prev ? { ...prev, scores: { ...prev.scores }, tags: [...prev.tags] } : { date, sleepHours: null, sleepQuality: null, energy: null, notes: null, tags: [], hasLog: false, scores: {} };
  for (const [id, raw] of Object.entries(input.scores ?? {})) {
    const cur = base.scores[id];
    const score = typeof raw === 'number' ? raw : raw.score ?? cur?.score;
    if (score === undefined) continue;
    const note = typeof raw === 'number' ? cur?.note ?? null : raw.note === undefined ? cur?.note ?? null : raw.note && raw.note.trim() ? raw.note.trim() : null;
    base.scores[id] = { score, note };
  }
  if (input.notes !== undefined) base.notes = input.notes && input.notes.trim() ? input.notes.trim() : null;
  if (input.sleepHours !== undefined) base.sleepHours = input.sleepHours;
  if (input.sleepQuality !== undefined) base.sleepQuality = input.sleepQuality;
  if (input.energy !== undefined) base.energy = input.energy;
  if (input.tags !== undefined) base.tags = [...new Set(input.tags.map((t) => t.trim()).filter(Boolean))];
  if (input.notes !== undefined || input.sleepHours !== undefined || input.sleepQuality !== undefined || input.energy !== undefined || input.tags !== undefined) base.hasLog = true;
  return base;
}

export function useSymptomMutations() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: symptomKeys.all });
    void qc.invalidateQueries({ queryKey: ['timeline'] });
    void qc.invalidateQueries({ queryKey: ['today'] });
  };

  const upsertDay = useMutation({
    mutationFn: ({ date, input }: { date: string; input: DayInput }) => api.put<DayRow>(`/api/symptoms/day/${encodeURIComponent(date)}`, input),
    onMutate: async ({ date, input }) => {
      await qc.cancelQueries({ queryKey: ['symptoms', 'days'] });
      const snapshots = qc.getQueriesData<DaysResponse>({ queryKey: ['symptoms', 'days'] });
      for (const [key, data] of snapshots) {
        if (!data || date < data.from || date > data.to) continue;
        const idx = data.days.findIndex((x) => x.date === date);
        const next = applyDayInput(idx >= 0 ? data.days[idx] : undefined, date, input);
        const days = idx >= 0 ? data.days.map((x, i) => (i === idx ? next : x)) : [...data.days, next].sort((a, b) => (a.date < b.date ? -1 : 1));
        qc.setQueryData<DaysResponse>(key, { ...data, days });
      }
      return { snapshots };
    },
    onError: (_err, _vars, ctx) => {
      for (const [key, data] of ctx?.snapshots ?? []) qc.setQueryData(key, data);
    },
    onSettled: refresh,
  });

  const createDefinition = useMutation({
    mutationFn: (input: { name: string; description?: string | null }) => api.post<SymptomDefinition & { reactivated: boolean }>('/api/symptoms/definitions', input),
    onSuccess: refresh,
  });
  const updateDefinition = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { name?: string; description?: string | null; active?: boolean } }) => api.patch<SymptomDefinition>(`/api/symptoms/definitions/${encodeURIComponent(id)}`, patch),
    onSuccess: refresh,
  });
  const deactivateDefinition = useMutation({
    mutationFn: (id: string) => api.delete<SymptomDefinition>(`/api/symptoms/definitions/${encodeURIComponent(id)}`),
    onSuccess: refresh,
  });
  const reorderDefinitions = useMutation({
    mutationFn: (ids: string[]) => api.post<{ items: SymptomDefinition[] }>('/api/symptoms/definitions/reorder', { ids }),
    onSuccess: refresh,
  });
  // A dry run writes nothing, so only a real import refreshes the caches.
  const importCsv = useMutation({
    mutationFn: ({ csv, dryRun = false }: { csv: string; dryRun?: boolean }) => api.post<ImportResult>(`/api/symptoms/import${api.qs({ dryRun: dryRun ? 1 : undefined })}`, { csv }),
    onSuccess: (r) => {
      if (!r.dryRun) refresh();
    },
  });

  return { upsertDay, createDefinition, updateDefinition, deactivateDefinition, reorderDefinitions, importCsv };
}
