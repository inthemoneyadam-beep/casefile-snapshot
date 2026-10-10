/**
 * Symptoms and the daily log: the configurable 0–10 symptom set, one score
 * per (day, symptom), one daily_log row per day (sleep, energy, notes, tags),
 * CSV import, and the chart series that overlay medication courses and
 * encounters.
 *
 * Nothing here is ever deleted: `symptom_entries` and `daily_log` carry no
 * `deleted_at`, so a wrong score is corrected by overwriting it (0 means
 * "none") and a definition is retired with `active = false` while its
 * entries stay. Services validate their own input with zod so the seed, the
 * CSV importer and the routes share one rule set.
 */
import { z } from 'zod';
import { and, asc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import * as PapaNs from 'papaparse';
import { db, schema } from '../db';
import { badRequest, conflict, notFound, zodIssues } from '../util/errors';
import { getMedicationTimeline, medicationCourse, medicationLanes } from './medications';
import { newId, normalizeKey, nowIso, parseJson } from '../util/ids';
import { parsePartialDate, readDateCell, todayIso } from '../../shared/dates';
import { chartSpec, chartX, type ChartBand, type ChartMarker, type ChartPoint, type ChartSpec } from '../../shared/chart';
import { LONG_TEXT_MAX } from '../../shared/constants';

// papaparse ships a UMD build; under Node ESM the API lives on `default`.
const Papa = ((PapaNs as unknown as { default?: typeof PapaNs }).default ?? PapaNs) as typeof PapaNs;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SymptomDefinitionRow = typeof schema.symptomDefinitions.$inferSelect;
export type SymptomEntryRow = typeof schema.symptomEntries.$inferSelect;
export type DailyLogRow = typeof schema.dailyLog.$inferSelect;

export type SymptomDefinition = SymptomDefinitionRow & { entryCount: number; lastDate: string | null };

export interface DayScore {
  score: number;
  note: string | null;
}

/** One day of the log: the daily_log fields plus every score keyed by symptom id. */
export interface DayRow {
  date: string;
  sleepHours: number | null;
  sleepQuality: number | null;
  energy: number | null;
  notes: string | null;
  tags: string[];
  /** True when a daily_log row exists for this date. */
  hasLog: boolean;
  scores: Record<string, DayScore>;
}

export interface SymptomSummary {
  definitions: number;
  active: number;
  daysLogged: number;
  firstDate: string | null;
  lastDate: string | null;
  loggedToday: boolean;
}

export type SeriesBucket = 'day' | 'week';

/**
 * A medication course in the window, with its true dates (the chart's own copy is clipped to the window) and the
 * record it stands for. One per medication; two names of one drug share a lane.
 */
export interface OverlayBand extends ChartBand {
  medicationId: string;
  /** The untruncated medication name (the chart label may be shortened). */
  name: string;
  /** The chart row (medicationLanes): "Metformin ER" and "Metformin ER (Example Pharma)" share the lane "metformin er"; "Insulin (Lantus)" and "Insulin (Humalog)" do not. */
  lane: string;
  /**
   * The recorded start; when the start is not recorded, the first time the records place the drug (firstSeen); with
   * neither (only a stop is known), the window's first day.
   */
  from: string;
  /** The medication's start was stated (by a document, by hand, by a start line). */
  startRecorded: boolean;
  /** `from` is that recorded start (false: first seen then, or the window's edge; it may have begun earlier). */
  startKnown: boolean;
  /**
   * The first time the records place the drug (its detail's date, its history lines, its recorded start). Null when
   * none, and when the course is known only by its stop (`from` is then the window's first day, not a mention).
   */
  firstSeen: string | null;
  /** The stop date, or null while it goes on. */
  to: string | null;
  /** No stop date and the medication is current (active, prn, planned). */
  ongoing: boolean;
  /** The medication's status is stopped. */
  stopped: boolean;
  /** `from` lies before the window's first day (the chart starts it at the left edge). */
  startsBeforeWindow: boolean;
  /** The stop lies after the window's last day (the chart ends it at the right edge). */
  endsAfterWindow: boolean;
}

/** An event tick as drawn on the chart, plus the record it stands for. */
export interface OverlayMarker extends ChartMarker {
  kind: 'medication' | 'encounter';
  medicationId: string | null;
  encounterId: string | null;
}

export interface SeriesResult {
  from: string;
  to: string;
  bucket: SeriesBucket;
  chart: ChartSpec;
  sleep: ChartSpec;
  /** The chart's bands and markers with the ids of their source records, so the page can link each one. */
  overlays: { bands: OverlayBand[]; markers: OverlayMarker[] };
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
  /** Days written (one per distinct valid date); on a dry run, days that would be written. */
  imported: number;
  /** Scores written (or that would be written). */
  entries: number;
  /** Names of symptom definitions created (or reactivated) for symptom columns; on a dry run, those that would be. */
  created: string[];
  /** Rows not written, 1-based over the data rows (the header is not counted). */
  skipped: Array<{ row: number; reason: string }>;
  /**
   * How each header was read, by header: a daily-log field (date,
   * sleep_hours, sleep_quality, energy, notes, tags), 'symptom', or 'ignored'
   * (a second column for a daily-log field already taken).
   */
  columns: Record<string, string>;
  /**
   * Values already in the log that the file replaces with a different value.
   * Filling an empty value is not listed. symptom_entries and daily_log keep
   * no history, so this is the only record of what an import changes.
   */
  overwritten: ImportOverwrite[];
  /** True when nothing was written (a preview). */
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day as YYYY-MM-DD; anything else is a 400. */
export function assertDay(date: string): string {
  const t = (date ?? '').trim();
  const p = parsePartialDate(t);
  if (!DAY_RE.test(t) || p.precision !== 'day' || p.iso !== t) throw badRequest(`date must be a real day as YYYY-MM-DD (got "${date}")`);
  return t;
}

/**
 * The latest day the log accepts: the server's today plus one day of slack,
 * so a client on the LAN in a time zone ahead of the server can still log
 * its own today. The page itself never steps past the viewer's today.
 */
export function latestLoggableDay(today: string = todayIso()): string {
  return addDays(today, 1);
}

const score = z.number().int().min(0).max(10);
const scoreInput = z.union([
  score,
  z.object({
    score: score.optional(),
    note: z.string().max(LONG_TEXT_MAX).nullable().optional(),
  }),
]);

export const dayInputSchema = z.object({
  scores: z.record(z.string().min(1), scoreInput).optional(),
  notes: z.string().max(10000).nullable().optional(),
  sleepHours: z.number().min(0).max(24).nullable().optional(),
  sleepQuality: z.number().int().min(0).max(10).nullable().optional(),
  energy: z.number().int().min(0).max(10).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
});
export type DayInput = z.infer<typeof dayInputSchema>;

export const definitionCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(LONG_TEXT_MAX).nullable().optional(),
});
export const definitionPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(LONG_TEXT_MAX).nullable().optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});
export type DefinitionCreate = z.infer<typeof definitionCreateSchema>;
export type DefinitionPatch = z.infer<typeof definitionPatchSchema>;

function parse<T>(s: z.ZodType<T>, input: unknown): T {
  const r = s.safeParse(input);
  if (!r.success) throw badRequest(zodIssues(r.error));
  return r.data;
}

// ---------------------------------------------------------------------------
// Date helpers (UTC arithmetic on YYYY-MM-DD strings; no timezone drift)
// ---------------------------------------------------------------------------

function toUtc(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtc(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return fromUtc(toUtc(day) + n * 86400000);
}

/** Monday of the ISO week containing `day`. */
export function weekStart(day: string): string {
  const t = toUtc(day);
  const dow = new Date(t).getUTCDay(); // 0 = Sunday
  return fromUtc(t - ((dow + 6) % 7) * 86400000);
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export function listDefinitions(opts: { includeInactive?: boolean } = {}): SymptomDefinition[] {
  const d = db();
  const sd = schema.symptomDefinitions;
  const rows = d
    .select({
      id: sd.id,
      name: sd.name,
      description: sd.description,
      sortOrder: sd.sortOrder,
      active: sd.active,
      createdAt: sd.createdAt,
      // The outer table is named explicitly: drizzle renders `${sd.id}` inside a
      // correlated subquery as a bare "id", which would resolve to the inner table.
      entryCount: sql<number>`(select count(*) from symptom_entries se where se.symptom_id = symptom_definitions.id)`.mapWith(Number),
      lastDate: sql<string | null>`(select max(se.date) from symptom_entries se where se.symptom_id = symptom_definitions.id)`,
    })
    .from(sd)
    .where(opts.includeInactive ? undefined : eq(sd.active, true))
    .orderBy(asc(sd.sortOrder), asc(sd.name), asc(sd.createdAt))
    .all();
  return rows.map((r) => ({ ...r, lastDate: r.lastDate ?? null }));
}

export function getDefinition(id: string): SymptomDefinition | null {
  return listDefinitions({ includeInactive: true }).find((r) => r.id === id) ?? null;
}

function findByName(name: string): SymptomDefinitionRow | null {
  const key = normalizeKey(name);
  if (!key) return null;
  for (const r of db().select().from(schema.symptomDefinitions).all()) if (normalizeKey(r.name) === key) return r;
  return null;
}

function nextSortOrder(): number {
  const r = db().get<{ m: number | null }>(sql`select max(sort_order) as m from symptom_definitions`);
  return (r?.m ?? 0) + 1;
}

/**
 * Create a definition. A retired definition with the same name (case and
 * punctuation insensitive) is reactivated instead of duplicated; an active
 * one is a 409.
 */
export function createDefinition(input: DefinitionCreate): SymptomDefinition & { reactivated: boolean } {
  const v = parse(definitionCreateSchema, input);
  const existing = findByName(v.name);
  if (existing) {
    if (existing.active) throw conflict(`a symptom named "${existing.name}" already exists`);
    db()
      .update(schema.symptomDefinitions)
      .set({ active: true, description: v.description === undefined ? existing.description : v.description || null })
      .where(eq(schema.symptomDefinitions.id, existing.id))
      .run();
    return { ...getDefinition(existing.id)!, reactivated: true };
  }
  const id = newId();
  db()
    .insert(schema.symptomDefinitions)
    .values({ id, name: v.name, description: v.description || null, sortOrder: nextSortOrder(), active: true, createdAt: nowIso() })
    .run();
  return { ...getDefinition(id)!, reactivated: false };
}

export function updateDefinition(id: string, patch: DefinitionPatch): SymptomDefinition {
  const v = parse(definitionPatchSchema, patch);
  const row = db().select().from(schema.symptomDefinitions).where(eq(schema.symptomDefinitions.id, id)).get();
  if (!row) throw notFound('symptom definition not found');
  const set: Partial<typeof schema.symptomDefinitions.$inferInsert> = {};
  if (v.name !== undefined) {
    const clash = findByName(v.name);
    if (clash && clash.id !== id) throw conflict(`a symptom named "${clash.name}" already exists`);
    set.name = v.name;
  }
  if (v.description !== undefined) set.description = v.description || null;
  if (v.active !== undefined) set.active = v.active;
  if (v.sortOrder !== undefined) set.sortOrder = v.sortOrder;
  if (Object.keys(set).length) db().update(schema.symptomDefinitions).set(set).where(eq(schema.symptomDefinitions.id, id)).run();
  return getDefinition(id)!;
}

/** Retire a definition. Its entries stay and still chart when asked for by id. */
export function deactivateDefinition(id: string): SymptomDefinition {
  return updateDefinition(id, { active: false });
}

/** Listed ids take positions 1..n in order; unlisted definitions follow in their previous order. */
export function reorderDefinitions(ids: string[]): SymptomDefinition[] {
  const v = parse(z.array(z.string().min(1)).min(1).max(500), ids);
  const d = db();
  const all = listDefinitions({ includeInactive: true });
  const known = new Set(all.map((r) => r.id));
  const missing = v.filter((id) => !known.has(id));
  if (missing.length) throw badRequest(`unknown symptom id ${missing.join(', ')}`);
  const seen = new Set<string>();
  const ordered = [...v.filter((id) => (seen.has(id) ? false : (seen.add(id), true))), ...all.map((r) => r.id).filter((id) => !seen.has(id))];
  d.transaction((tx) => {
    ordered.forEach((id, i) => {
      tx.update(schema.symptomDefinitions).set({ sortOrder: i + 1 }).where(eq(schema.symptomDefinitions.id, id)).run();
    });
  });
  return listDefinitions({ includeInactive: true });
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

function emptyDay(date: string): DayRow {
  return { date, sleepHours: null, sleepQuality: null, energy: null, notes: null, tags: [], hasLog: false, scores: {} };
}

function dayFromLog(date: string, log: DailyLogRow | undefined): DayRow {
  if (!log) return emptyDay(date);
  return {
    date,
    sleepHours: log.sleepHours,
    sleepQuality: log.sleepQuality,
    energy: log.energy,
    notes: log.notes,
    tags: parseJson<string[]>(log.tagsJson, []),
    hasLog: true,
    scores: {},
  };
}

/** Every day in [from, to] that has a score or a daily_log row, ascending. */
export function getDays(from: string, to: string): DayRow[] {
  const f = assertDay(from);
  const t = assertDay(to);
  if (f > t) throw badRequest('from must not be after to');
  const d = db();
  const logs = d.select().from(schema.dailyLog).where(and(gte(schema.dailyLog.date, f), lte(schema.dailyLog.date, t))).all();
  const entries = d.select().from(schema.symptomEntries).where(and(gte(schema.symptomEntries.date, f), lte(schema.symptomEntries.date, t))).all();
  const byDate = new Map<string, DayRow>();
  for (const l of logs) byDate.set(l.date, dayFromLog(l.date, l));
  for (const e of entries) {
    let row = byDate.get(e.date);
    if (!row) {
      row = emptyDay(e.date);
      byDate.set(e.date, row);
    }
    row.scores[e.symptomId] = { score: e.score, note: e.note };
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function getDay(date: string): DayRow {
  const day = assertDay(date);
  return getDays(day, day)[0] ?? emptyDay(day);
}

/**
 * Merge-upsert one day. Scores given are written (a bare number or
 * `{ score, note }`); scores not mentioned are untouched; a note without a
 * score keeps the existing score and is a 400 when there is none. Daily
 * fields are written only when present in the input. Idempotent. A day
 * after latestLoggableDay() is a 400: the log records days that happened.
 */
export function upsertDay(date: string, input: DayInput): DayRow {
  const day = assertDay(date);
  if (day > latestLoggableDay()) throw badRequest(`${day} is in the future; the log only takes days up to today`);
  const v = parse(dayInputSchema, input);
  const d = db();
  const scores = v.scores ?? {};
  const ids = Object.keys(scores);
  if (ids.length) {
    const known = new Set(d.select({ id: schema.symptomDefinitions.id }).from(schema.symptomDefinitions).all().map((r) => r.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) throw badRequest(`unknown symptom id ${unknown.join(', ')}`);
  }
  const existing = new Map<string, SymptomEntryRow>();
  if (ids.length) for (const e of d.select().from(schema.symptomEntries).where(eq(schema.symptomEntries.date, day)).all()) existing.set(e.symptomId, e);

  const now = nowIso();
  d.transaction((tx) => {
    for (const id of ids) {
      const raw = scores[id];
      const prev = existing.get(id);
      const sc = typeof raw === 'number' ? raw : raw.score ?? prev?.score;
      if (sc === undefined) throw badRequest(`scores.${id}: a note needs a score when no score is logged for that day`);
      const note = typeof raw === 'number' ? prev?.note ?? null : raw.note === undefined ? prev?.note ?? null : raw.note && raw.note.trim() ? raw.note.trim() : null;
      tx.insert(schema.symptomEntries)
        .values({ id: newId(), date: day, symptomId: id, score: sc, note, createdAt: now })
        .onConflictDoUpdate({ target: [schema.symptomEntries.date, schema.symptomEntries.symptomId], set: { score: sc, note } })
        .run();
    }
    const touchesLog = v.notes !== undefined || v.sleepHours !== undefined || v.sleepQuality !== undefined || v.energy !== undefined || v.tags !== undefined;
    if (touchesLog) {
      const set: Partial<typeof schema.dailyLog.$inferInsert> = { updatedAt: now };
      if (v.notes !== undefined) set.notes = v.notes && v.notes.trim() ? v.notes.trim() : null;
      if (v.sleepHours !== undefined) set.sleepHours = v.sleepHours;
      if (v.sleepQuality !== undefined) set.sleepQuality = v.sleepQuality;
      if (v.energy !== undefined) set.energy = v.energy;
      if (v.tags !== undefined) set.tagsJson = JSON.stringify([...new Set(v.tags.map((t) => t.trim()).filter(Boolean))]);
      tx.insert(schema.dailyLog)
        .values({ id: newId(), date: day, tagsJson: '[]', createdAt: now, ...set })
        .onConflictDoUpdate({ target: schema.dailyLog.date, set })
        .run();
    }
  });
  return getDay(day);
}

export function symptomSummary(today: string = todayIso()): SymptomSummary {
  const d = db();
  const defs = d.get<{ n: number; a: number }>(sql`select count(*) as n, coalesce(sum(active), 0) as a from symptom_definitions`);
  const days = d.get<{ n: number; mn: string | null; mx: string | null }>(sql`
    select count(*) as n, min(date) as mn, max(date) as mx from (
      select date from symptom_entries union select date from daily_log
    )`);
  const t = d.get<{ n: number }>(sql`select (select count(*) from symptom_entries where date = ${today}) + (select count(*) from daily_log where date = ${today}) as n`);
  return {
    definitions: defs?.n ?? 0,
    active: defs?.a ?? 0,
    daysLogged: days?.n ?? 0,
    firstDate: days?.mn ?? null,
    lastDate: days?.mx ?? null,
    loggedToday: (t?.n ?? 0) > 0,
  };
}

// ---------------------------------------------------------------------------
// Series (ChartSpec) with medication bands and encounter markers
// ---------------------------------------------------------------------------

function overlaps(start: string | null, stop: string | null, from: string, to: string): boolean {
  if (!start) return false;
  const s = chartX(start, 'date');
  const e = stop ? chartX(stop, 'date') : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(s)) return false;
  return s <= chartX(to, 'date') && e >= chartX(from, 'date');
}

/** Compare two partial ISO dates (YYYY, YYYY-MM, YYYY-MM-DD…) at the coarser of their precisions. */
function cmpPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  const x = a.slice(0, n);
  const y = b.slice(0, n);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * True when a partial date's period touches [from, to]: '2024-06' is in a
 * window starting 2024-06-15, as slice G's timeline window treats it. A plain
 * string compare would drop it ('2024-06' sorts before '2024-06-01').
 */
function inWindow(date: string, from: string, to: string): boolean {
  return cmpPrefix(date, from) >= 0 && cmpPrefix(date, to) <= 0;
}

function shortLabel(s: string, max = 28): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const MARKER_EVENT_KINDS = ['dose_change', 'hold', 'resume', 'reaction'];

/**
 * Medication courses in the window, one per medication, read through slice G's
 * getMedicationTimeline and shaped by its medicationCourse rule (one source of
 * truth): a course runs from its recorded start, or, when the start was never
 * stated (a drug only named on a dated list or note), from the first time the
 * records place it (startKnown false); it is open-ended only while current
 * (active, prn, planned; tone accent), and a stopped or unknown-status course
 * with no stop date gets no band at all rather than one drawn as ongoing. A
 * course whose only date is its stop starts at the window's left edge,
 * startKnown false, and is shown only while that stop is in the window.
 * Ordered by where each begins (true dates), then by name.
 */
function bandOverlays(from: string, to: string): OverlayBand[] {
  const out: OverlayBand[] = [];
  const fromX = chartX(from, 'date');
  const toX = chartX(to, 'date');
  // Only `from` narrows the read: a course whose stored start is after the window may have been seen inside it.
  const items = getMedicationTimeline({ from }).items;
  const lanes = medicationLanes(items);
  for (const it of items) {
    const c = medicationCourse(it, lanes.get(it.medicationId));
    if (!c) continue;
    // Known only by its stop: drawn from the left edge while the stop is in the window. A stop after the window says
    // nothing about the window itself.
    if (!c.from && c.to && chartX(c.to, 'date') > toX) continue;
    const begin = c.from ?? from;
    if (!overlaps(begin, c.to, from, to)) continue;
    const startsBeforeWindow = chartX(begin, 'date') < fromX;
    const endsAfterWindow = c.to != null && chartX(c.to, 'date') > toX;
    out.push({
      from: begin,
      to: c.to,
      label: shortLabel(c.name),
      tone: c.tone,
      lane: c.lane,
      startKnown: c.startKnown,
      ongoing: c.ongoing,
      clippedStart: startsBeforeWindow,
      clippedEnd: endsAfterWindow,
      medicationId: c.medicationId,
      name: c.name,
      startRecorded: c.startRecorded,
      // A course known only by its stop begins at the window's edge, which is no first mention: none is named.
      firstSeen: c.from ? it.firstSeen : null,
      stopped: c.stopped,
      startsBeforeWindow,
      endsAfterWindow,
    });
  }
  out.sort((a, b) => chartX(a.from, 'date') - chartX(b.from, 'date') || a.name.localeCompare(b.name));
  return out;
}

/** Medication courses as shaded bands, with their true dates (see bandOverlays for the rule). */
export function loadMedicationBands(from: string, to: string): ChartBand[] {
  return bandOverlays(from, to).map((b) => ({ from: b.from, to: b.to, label: b.label, tone: b.tone, lane: b.lane, startKnown: b.startKnown, ongoing: b.ongoing, clippedStart: b.clippedStart, clippedEnd: b.clippedEnd }));
}

/**
 * Dose changes, holds, resumes and reactions as ticks; encounters (not
 * cancelled) as ticks. Month- and year-precision dates count when their
 * period touches the window, and are drawn at the first day of the period.
 */
function markerOverlays(from: string, to: string): OverlayMarker[] {
  const d = db();
  const out: OverlayMarker[] = [];
  const events: OverlayMarker[] = [];
  for (const it of getMedicationTimeline({ from, to }).items) {
    for (const e of it.events) {
      if (!e.date || !MARKER_EVENT_KINDS.includes(e.kind)) continue;
      if (!inWindow(e.date, from, to)) continue;
      events.push({
        x: e.date.slice(0, 10),
        label: shortLabel(`${it.name}: ${e.kind.replace(/_/g, ' ')}`),
        tone: e.kind === 'reaction' ? 'bad' : 'warn',
        kind: 'medication',
        medicationId: it.medicationId,
        encounterId: null,
      });
    }
  }
  events.sort((x, y) => String(x.x).localeCompare(String(y.x)));
  out.push(...events);
  // The SQL bound starts at the year of `from` so a partial occurredAt
  // ('2024', '2024-06') is fetched; inWindow then decides.
  const encs = d
    .select({ id: schema.encounters.id, title: schema.encounters.title, date: schema.encounters.occurredAt, status: schema.encounters.status })
    .from(schema.encounters)
    .where(and(isNull(schema.encounters.deletedAt), gte(schema.encounters.occurredAt, from.slice(0, 4)), lte(schema.encounters.occurredAt, `${to}￿`)))
    .orderBy(asc(schema.encounters.occurredAt))
    .all();
  for (const e of encs) {
    if (!e.date || e.status === 'cancelled' || !inWindow(e.date, from, to)) continue;
    out.push({ x: e.date.slice(0, 10), label: shortLabel(e.title), tone: 'ash', kind: 'encounter', medicationId: null, encounterId: e.id });
  }
  return out;
}

interface Acc {
  sum: number;
  n: number;
}

function bucketKey(date: string, bucket: SeriesBucket): string {
  return bucket === 'week' ? weekStart(date) : date;
}

function meanPoints(acc: Map<string, Acc>, hrefFor: (x: string) => string): ChartPoint[] {
  return [...acc.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([x, { sum, n }]) => ({ x, y: Math.round((sum / n) * 10) / 10, href: hrefFor(x), label: n > 1 ? `mean of ${n}` : null }));
}

/**
 * Build the symptom chart (one line per definition, 0–10) and the sleep
 * chart (bars for hours, lines for quality and energy) over [from, to].
 * Weekly buckets are means per ISO week keyed by the Monday. Both specs are
 * validated with `chartSpec` before they leave the server.
 */
export function buildSeries(opts: { from?: string | null; to?: string | null; symptomIds?: string[] | null; bucket?: SeriesBucket | null }): SeriesResult {
  const to = assertDay(opts.to ?? todayIso());
  const from = assertDay(opts.from ?? addDays(to, -89));
  if (from > to) throw badRequest('from must not be after to');
  const bucket: SeriesBucket = opts.bucket === 'week' ? 'week' : 'day';
  const d = db();

  const all = listDefinitions({ includeInactive: true });
  const wanted = opts.symptomIds && opts.symptomIds.length ? all.filter((r) => opts.symptomIds!.includes(r.id)) : all.filter((r) => r.active);
  const unknown = (opts.symptomIds ?? []).filter((id) => !all.some((r) => r.id === id));
  if (unknown.length) throw badRequest(`unknown symptom id ${unknown.join(', ')}`);

  const entries = d
    .select({ date: schema.symptomEntries.date, symptomId: schema.symptomEntries.symptomId, score: schema.symptomEntries.score, note: schema.symptomEntries.note })
    .from(schema.symptomEntries)
    .where(and(gte(schema.symptomEntries.date, from), lte(schema.symptomEntries.date, to)))
    .orderBy(asc(schema.symptomEntries.date))
    .all();
  const hrefFor = (x: string) => `/symptoms?view=log&date=${x}`;

  const series = wanted.map((def) => {
    const mine = entries.filter((e) => e.symptomId === def.id);
    let points: ChartPoint[];
    if (bucket === 'day') {
      points = mine.map((e) => ({ x: e.date, y: e.score, href: hrefFor(e.date), label: e.note ? shortLabel(e.note, 60) : null }));
    } else {
      const acc = new Map<string, Acc>();
      for (const e of mine) {
        const k = bucketKey(e.date, 'week');
        const a = acc.get(k) ?? { sum: 0, n: 0 };
        a.sum += e.score;
        a.n += 1;
        acc.set(k, a);
      }
      points = meanPoints(acc, hrefFor);
    }
    return { name: def.name, unit: null, kind: 'line' as const, points };
  });
  if (!series.length) series.push({ name: 'No symptoms defined', unit: null, kind: 'line' as const, points: [] });

  const bandItems = bandOverlays(from, to);
  const markerItems = markerOverlays(from, to);
  // On the plot, bands are clipped to the window and a tick whose month or
  // year starts before the window sits at its left edge: LineChart widens the
  // x axis to every band end and tick, so a course started years ago would
  // otherwise squash a 30-day chart. A tick with a month- or year-only date
  // carries that date in its label. `overlays` keeps the true dates.
  const fromX = chartX(from, 'date');
  const toX = chartX(to, 'date');
  // Each band carries its lane (two names of one drug share a row), whether its start is known, whether it goes on,
  // and whether it was cut at either edge, so the chart can draw one row per drug with honest ends.
  const bands: ChartBand[] = bandItems.map((b) => ({
    from: b.startsBeforeWindow ? from : b.from,
    to: b.endsAfterWindow ? to : b.to,
    label: b.label,
    tone: b.tone,
    lane: b.lane,
    startKnown: b.startKnown,
    ongoing: b.ongoing,
    clippedStart: b.startsBeforeWindow,
    clippedEnd: b.endsAfterWindow,
  }));
  const markers: ChartMarker[] = markerItems.map((m) => {
    const x = String(m.x);
    const partial = x.length < 10;
    return { x: chartX(x, 'date') < fromX ? from : x, label: partial ? `${m.label} (${x})` : m.label, tone: m.tone };
  });
  const chart: ChartSpec = chartSpec.parse({
    type: 'line',
    title: 'Symptoms',
    subtitle: `${from} to ${to}${bucket === 'week' ? ' · weekly means' : ''}`,
    xType: 'date',
    yLabel: '0–10',
    series: series.slice(0, 8),
    yDomain: [0, 10],
    bands: bands.length ? bands : null,
    markers: markers.length ? markers : null,
    source: 'db',
    note: series.length > 8 ? `${series.length - 8} more symptoms not shown; pick up to 8` : null,
  });

  const logs = d
    .select()
    .from(schema.dailyLog)
    .where(and(gte(schema.dailyLog.date, from), lte(schema.dailyLog.date, to)))
    .orderBy(asc(schema.dailyLog.date))
    .all();
  const pick = (f: (l: DailyLogRow) => number | null): ChartPoint[] => {
    if (bucket === 'day') return logs.flatMap((l) => (f(l) == null ? [] : [{ x: l.date, y: f(l), href: hrefFor(l.date) }]));
    const acc = new Map<string, Acc>();
    for (const l of logs) {
      const v = f(l);
      if (v == null) continue;
      const k = weekStart(l.date);
      const a = acc.get(k) ?? { sum: 0, n: 0 };
      a.sum += v;
      a.n += 1;
      acc.set(k, a);
    }
    return meanPoints(acc, hrefFor);
  };
  const sleepHours = pick((l) => l.sleepHours);
  // 12 h is the floor so the 0–10 quality and energy lines keep a stable
  // scale; a longer night (up to 24 h is accepted) raises the top instead of
  // being clipped at the plot edge.
  const sleepTop = Math.max(12, Math.ceil(Math.max(0, ...sleepHours.map((p) => p.y ?? 0))));
  const sleep: ChartSpec = chartSpec.parse({
    type: 'bar',
    title: 'Sleep and energy',
    subtitle: bucket === 'week' ? 'weekly means' : null,
    xType: 'date',
    series: [
      { name: 'Sleep hours', unit: 'h', kind: 'bar', points: sleepHours },
      { name: 'Sleep quality', unit: null, kind: 'line', points: pick((l) => l.sleepQuality) },
      { name: 'Energy', unit: null, kind: 'line', points: pick((l) => l.energy) },
    ],
    yDomain: [0, sleepTop],
    bands: bands.length ? bands : null,
    source: 'db',
  });

  return { from, to, bucket, chart, sleep, overlays: { bands: bandItems, markers: markerItems } };
}

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

type Reserved = 'date' | 'sleepHours' | 'sleepQuality' | 'energy' | 'notes' | 'tags';

/** The documented daily-log columns (by normalised header); always read as daily-log fields. */
const RESERVED: Record<string, Reserved> = {
  date: 'date',
  'sleep hours': 'sleepHours',
  'sleep quality': 'sleepQuality',
  energy: 'energy',
  notes: 'notes',
  tags: 'tags',
};

/**
 * Loose synonyms for the daily-log columns. They give way to a symptom
 * definition (active or retired) with the same name, so a symptom called
 * "Sleep" is imported as a score rather than written to sleep hours.
 */
const RESERVED_SYNONYMS: Record<string, Reserved> = {
  day: 'date',
  sleep: 'sleepHours',
  note: 'notes',
};

/** How each daily-log field is named in the column report and in `overwritten`. */
const RESERVED_LABEL: Record<Reserved, string> = {
  date: 'date',
  sleepHours: 'sleep_hours',
  sleepQuality: 'sleep_quality',
  energy: 'energy',
  notes: 'notes',
  tags: 'tags',
};

interface ParsedRow {
  row: number;
  date: string;
  scores: Record<string, number>; // by column header
  notes?: string;
  sleepHours?: number;
  sleepQuality?: number;
  energy?: number;
  tags?: string[];
}

export interface ParsedCsv {
  rows: ParsedRow[];
  symptomColumns: string[];
  skipped: ImportResult['skipped'];
  columns: ImportResult['columns'];
  error?: string;
}

function parseScoreCell(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 10) return null;
  return n;
}

/**
 * Parse a CSV with a `date` column, one column per symptom name and the
 * optional columns sleep_hours, sleep_quality, energy, notes, tags. A row
 * with a bad date, a date after `latestDay` (default latestLoggableDay()),
 * or any invalid cell is skipped whole (reported), so an import never
 * half-writes a day. `symptomNames` are the names of existing definitions: a
 * header matching one of them is a symptom column even when it is also a
 * loose synonym (day, sleep, note). Nothing is written here.
 */
export function parseSymptomCsv(text: string, opts: { symptomNames?: Iterable<string>; latestDay?: string } = {}): ParsedCsv {
  const res = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ''), { header: true, skipEmptyLines: 'greedy', transformHeader: (h: string) => h.trim() });
  const headers = (res.meta.fields ?? []).filter((h) => h.trim());
  const known = new Set([...(opts.symptomNames ?? [])].map((n) => normalizeKey(n)));
  const latestDay = opts.latestDay ?? latestLoggableDay();
  const reserved = new Map<string, Reserved>();
  const symptomColumns: string[] = [];
  const columns: ImportResult['columns'] = {};
  for (const h of headers) {
    const key = normalizeKey(h);
    const r = RESERVED[key] ?? (known.has(key) ? undefined : RESERVED_SYNONYMS[key]);
    if (r) {
      if ([...reserved.values()].includes(r)) columns[h] = 'ignored';
      else {
        reserved.set(h, r);
        columns[h] = RESERVED_LABEL[r];
      }
    } else {
      symptomColumns.push(h);
      columns[h] = 'symptom';
    }
  }
  const dateCol = [...reserved.entries()].find(([, r]) => r === 'date')?.[0];
  if (!dateCol) return { rows: [], symptomColumns, skipped: [], columns, error: 'the CSV needs a "date" column' };
  if (!symptomColumns.length && ![...reserved.values()].some((r) => r !== 'date')) return { rows: [], symptomColumns, skipped: [], columns, error: 'the CSV needs at least one symptom column or a daily-log column' };

  const rows: ParsedRow[] = [];
  const skipped: ImportResult['skipped'] = [];
  res.data.forEach((rec, i) => {
    const row = i + 1;
    const rawDate = (rec[dateCol] ?? '').trim();
    const pd = readDateCell(rawDate);
    if (!pd.iso || pd.precision !== 'day') {
      skipped.push({ row, reason: rawDate ? `date "${rawDate}" is not a full day` : 'missing date' });
      return;
    }
    if (pd.iso > latestDay) {
      skipped.push({ row, reason: `date ${pd.iso} is in the future` });
      return;
    }
    const out: ParsedRow = { row, date: pd.iso, scores: {} };
    const problems: string[] = [];
    let any = false;
    for (const h of symptomColumns) {
      const raw = (rec[h] ?? '').trim();
      if (!raw) continue;
      const n = parseScoreCell(raw);
      if (n == null) problems.push(`${h}: "${raw}" is not a whole number 0-10`);
      else {
        out.scores[h] = n;
        any = true;
      }
    }
    for (const [h, r] of reserved) {
      if (r === 'date') continue;
      const raw = (rec[h] ?? '').trim();
      if (!raw) continue;
      any = true;
      if (r === 'notes') out.notes = raw;
      else if (r === 'tags') out.tags = raw.split(/[;|,]/).map((t) => t.trim()).filter(Boolean);
      else if (r === 'sleepHours') {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0 || n > 24) problems.push(`${h}: "${raw}" is not a number of hours 0-24`);
        else out.sleepHours = n;
      } else {
        const n = parseScoreCell(raw);
        if (n == null) problems.push(`${h}: "${raw}" is not a whole number 0-10`);
        else if (r === 'sleepQuality') out.sleepQuality = n;
        else out.energy = n;
      }
    }
    if (problems.length) {
      skipped.push({ row, reason: problems.join('; ') });
      return;
    }
    if (!any) {
      skipped.push({ row, reason: 'no values' });
      return;
    }
    rows.push(out);
  });
  return { rows, symptomColumns, skipped, columns };
}

/** Tags as upsertDay stores them: trimmed, de-duplicated, order kept. */
function normTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
}

function sameTags(a: string[], b: string[]): boolean {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((t) => y.has(t));
}

/**
 * Every value already in the log that importing `rows` would replace with a
 * different one: one entry per (date, field), in file order, carrying the
 * value the file leaves there last. Filling an empty value is not an
 * overwrite; a score of 0 is a value. `defByColumn` maps a symptom column to
 * its existing definition (absent for a column that would create one, which
 * has no scores yet).
 */
function diffImport(rows: ParsedRow[], defByColumn: Map<string, SymptomDefinitionRow>): ImportOverwrite[] {
  if (!rows.length) return [];
  const d = db();
  const dates = rows.map((r) => r.date);
  const lo = dates.reduce((a, b) => (b < a ? b : a));
  const hi = dates.reduce((a, b) => (b > a ? b : a));
  const scoreNow = new Map<string, number>();
  for (const e of d.select().from(schema.symptomEntries).where(and(gte(schema.symptomEntries.date, lo), lte(schema.symptomEntries.date, hi))).all()) scoreNow.set(`${e.date} ${e.symptomId}`, e.score);
  const logNow = new Map<string, DailyLogRow>();
  for (const l of d.select().from(schema.dailyLog).where(and(gte(schema.dailyLog.date, lo), lte(schema.dailyLog.date, hi))).all()) logNow.set(l.date, l);

  const changes = new Map<string, ImportOverwrite>();
  const put = (key: string, date: string, field: string, from: string | number | null | undefined, to: string | number, same: boolean) => {
    if (from == null || from === '') return;
    if (same) changes.delete(key);
    else changes.set(key, { date, field, from, to });
  };
  for (const r of rows) {
    for (const [h, n] of Object.entries(r.scores)) {
      const def = defByColumn.get(h);
      if (!def) continue;
      const was = scoreNow.get(`${r.date} ${def.id}`);
      put(`${r.date} score ${def.id}`, r.date, def.name, was, n, was === n);
    }
    const log = logNow.get(r.date);
    if (!log) continue;
    if (r.sleepHours !== undefined) put(`${r.date} sleepHours`, r.date, 'sleep_hours', log.sleepHours, r.sleepHours, log.sleepHours === r.sleepHours);
    if (r.sleepQuality !== undefined) put(`${r.date} sleepQuality`, r.date, 'sleep_quality', log.sleepQuality, r.sleepQuality, log.sleepQuality === r.sleepQuality);
    if (r.energy !== undefined) put(`${r.date} energy`, r.date, 'energy', log.energy, r.energy, log.energy === r.energy);
    if (r.notes !== undefined) put(`${r.date} notes`, r.date, 'notes', log.notes, r.notes, (log.notes ?? '').trim() === r.notes.trim());
    if (r.tags !== undefined) {
      const was = normTags(parseJson<string[]>(log.tagsJson, []));
      const next = normTags(r.tags);
      if (was.length) put(`${r.date} tags`, r.date, 'tags', was.join(', '), next.join(', '), sameTags(was, next));
    }
  }
  return [...changes.values()];
}

/**
 * Import a CSV: creates a definition for every symptom column that carries
 * at least one value (reactivating a retired one with the same name), then
 * upserts each valid row as a day. A value already in the log for a date is
 * replaced by the file's (an empty cell leaves it alone), and every replaced
 * value is listed in `overwritten`, because symptom_entries and daily_log
 * keep no history. With `dryRun` nothing is written, definitions included,
 * and the result says what the import would do. Runs in one transaction;
 * re-importing the same file changes nothing.
 */
export function importCsv(text: string, opts: { dryRun?: boolean } = {}): ImportResult {
  if (!text || !text.trim()) throw badRequest('the CSV is empty');
  const dryRun = Boolean(opts.dryRun);
  const d = db();
  const defs = d.select().from(schema.symptomDefinitions).all();
  const parsed = parseSymptomCsv(text, { symptomNames: defs.map((r) => r.name) });
  if (parsed.error) throw badRequest(parsed.error);

  // The same match as findByName: the first definition whose normalised name equals the header's.
  const usedColumns = parsed.symptomColumns.filter((h) => parsed.rows.some((r) => h in r.scores));
  const defByColumn = new Map<string, SymptomDefinitionRow>();
  for (const h of usedColumns) {
    const key = normalizeKey(h);
    const def = key ? defs.find((r) => normalizeKey(r.name) === key) : undefined;
    if (def) defByColumn.set(h, def);
  }
  const base = {
    imported: new Set(parsed.rows.map((r) => r.date)).size,
    entries: parsed.rows.reduce((n, r) => n + Object.keys(r.scores).length, 0),
    skipped: parsed.skipped,
    columns: parsed.columns,
    dryRun,
  };

  if (dryRun) {
    const created: string[] = [];
    for (const h of usedColumns) {
      const def = defByColumn.get(h);
      if (!def) created.push(h);
      else if (!def.active) created.push(def.name);
    }
    return { ...base, created, overwritten: diffImport(parsed.rows, defByColumn) };
  }

  const created: string[] = [];
  let overwritten: ImportOverwrite[] = [];
  d.transaction(() => {
    overwritten = diffImport(parsed.rows, defByColumn);
    const idByColumn = new Map<string, string>();
    for (const h of usedColumns) {
      const existing = defByColumn.get(h);
      if (existing) {
        if (!existing.active) {
          createDefinition({ name: h });
          created.push(existing.name);
        }
        idByColumn.set(h, existing.id);
      } else {
        const def = createDefinition({ name: h });
        created.push(def.name);
        idByColumn.set(h, def.id);
      }
    }
    for (const r of parsed.rows) {
      const scores: Record<string, number> = {};
      for (const [h, n] of Object.entries(r.scores)) scores[idByColumn.get(h)!] = n;
      upsertDay(r.date, {
        scores,
        notes: r.notes,
        sleepHours: r.sleepHours,
        sleepQuality: r.sleepQuality,
        energy: r.energy,
        tags: r.tags,
      });
    }
  });
  return { ...base, created, overwritten };
}
