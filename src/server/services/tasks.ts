/**
 * Tasks and reminders: what is due, who owes it, and where it came from.
 * Every task remembers its source (a fact, a finding, a communication, a
 * document, an encounter, an inventory record, or the user) so the list can
 * open the passage or promise behind it. Tasks are soft-deleted and kept in
 * `entities_fts` so the palette finds them.
 *
 * Also here: the daily-plan payload, the iCalendar export, and the two
 * idempotent generators (open follow-ups -> tasks, record gaps -> tasks).
 */
import { z } from 'zod';
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../db';
import { hrefFor, indexEntity, removeEntityIndex } from './search';
import { listFollowUps, type CommWithParticipants } from './communications';
import { inferGaps, type Gap } from './records';
import { buildCalendar, type IcsEvent } from './ics';
import { badRequest, notFound, parseOrThrow } from '../util/errors';
import { newId, nowIso, parseJson } from '../util/ids';
import { daysBetween, isPastDue, parsePartialDate, todayIso } from '../../shared/dates';
import { TASK_OWNERS, TASK_PRIORITIES, TASK_SOURCE_TYPES, TASK_STATUSES } from '../../shared/enums';
import { parseCommunicationDetails } from '../../shared/schemas/segments';

// ---------------------------------------------------------------------------
// Validation helpers (shared with encounters.ts)
// ---------------------------------------------------------------------------

/** Parse with zod; a failure becomes a 400 listing every issue (util/errors parseOrThrow). */
export function parseInput<T>(schemaDef: z.ZodType<T>, data: unknown): T {
  return parseOrThrow(schemaDef, data);
}

/** Optional free text: '' and whitespace become null; undefined stays undefined (not provided). */
export const optText = (max = 4000) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => (v === undefined ? undefined : v && v.trim() ? v.trim() : null));

/** The statuses that mean "still to do". */
export const ACTIVE_STATUSES = ['open', 'in_progress'] as const;
export const CLOSED_STATUSES = ['done', 'cancelled'] as const;

export const OWNER_LABELS: Record<string, string> = { me: 'me', chief_of_staff: 'chief of staff', advocate: 'advocate', person: 'person' };

const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})/;

/** Precision-aware past-due check, shared with communications and the rules (src/shared/dates.ts). */
export { isPastDue };

/** A due day from free text: ISO, US numeric, or written. Partial dates are kept at their precision. */
export function resolveDay(text: string | null | undefined, field: string): string | null {
  if (text === null || text === undefined) return null;
  const p = parsePartialDate(text);
  if (!p.iso) throw badRequest(`${field}: could not read a date from "${text}"`);
  return p.iso;
}

/** A reminder: a full local datetime (YYYY-MM-DDTHH:MM) when a time is given, else a day. The day and time must be real. */
export function resolveReminder(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const m = text.trim().match(DATETIME_RE);
  if (m) {
    const day = parsePartialDate(m[1]);
    if (day.precision !== 'day' || day.iso !== m[1]) throw badRequest(`remindAt: invalid day in "${text}"`);
    const h = Number(m[2]);
    const mi = Number(m[3]);
    if (h > 23 || mi > 59) throw badRequest(`remindAt: invalid time in "${text}"`);
    return `${m[1]}T${String(h).padStart(2, '0')}:${m[3]}`;
  }
  return resolveDay(text, 'remindAt');
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const taskFields = {
  title: z.string().trim().min(1, 'title is required').max(500),
  detail: optText(20000),
  owner: z.enum(TASK_OWNERS),
  ownerPersonId: optText(64),
  dueAt: optText(64),
  remindAt: optText(64),
  status: z.enum(TASK_STATUSES),
  priority: z.enum(TASK_PRIORITIES),
  sourceType: z.enum(TASK_SOURCE_TYPES),
  sourceId: optText(64),
};

export const taskInput = z.object({
  ...taskFields,
  owner: taskFields.owner.default('me'),
  status: taskFields.status.default('open'),
  priority: taskFields.priority.default('normal'),
  sourceType: taskFields.sourceType.default('manual'),
});
/** Built from the undefaulted fields: zod 4 keeps a `.default()` under `.partial()`. */
export const taskPatch = z.object(taskFields).partial();
export type TaskInput = z.input<typeof taskInput>;
export type TaskPatch = z.input<typeof taskPatch>;

export const snoozeInput = z.object({ days: z.coerce.number().int().min(1).max(365).default(7) });

export const listQuery = z.object({
  /** Comma-separated statuses, or the aliases `active` (open + in progress) and `closed` (done + cancelled). */
  status: z.string().optional(),
  owner: z.string().optional(),
  ownerPersonId: z.string().optional(),
  due: z.enum(['overdue', 'today', 'week', 'all']).optional(),
  sourceType: z.string().optional(),
  sourceId: z.string().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(10000).optional(),
});
export type TaskFilters = z.infer<typeof listQuery>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskRow = typeof schema.tasks.$inferSelect;
type TaskInsert = typeof schema.tasks.$inferInsert;

export interface TaskListItem extends TaskRow {
  ownerName: string | null;
  sourceTitle: string | null;
  sourceHref: string | null;
  /** Still to do and the due date is past: before today, or for a month/year due date, that whole period has ended. */
  overdue: boolean;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Expand the status filter into literal statuses; unknown names are dropped. */
export function expandStatuses(status: string | null | undefined): string[] {
  if (!status) return [];
  const out = new Set<string>();
  for (const raw of status.split(',')) {
    const s = raw.trim();
    if (s === 'active') for (const x of ACTIVE_STATUSES) out.add(x);
    else if (s === 'closed') for (const x of CLOSED_STATUSES) out.add(x);
    else if ((TASK_STATUSES as readonly string[]).includes(s)) out.add(s);
  }
  return [...out];
}

export function isActive(status: string): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

function plusDays(day: string, n: number): string {
  const d = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Due-window conditions on the stored due date, compared at its precision
 * (today is cut to the due date's length): a month or year due date is
 * overdue only after its period has ended, and is "due this week" while its
 * period overlaps the next seven days. Mirrors isPastDue.
 */
function dueCondition(due: TaskFilters['due'], today: string): SQL | null {
  const t = schema.tasks;
  switch (due) {
    case 'overdue':
      return sql`${t.dueAt} is not null and ${t.dueAt} < substr(${today}, 1, length(${t.dueAt}))`;
    case 'today':
      return sql`${t.dueAt} is not null and substr(${t.dueAt}, 1, 10) = ${today}`;
    case 'week':
      return sql`${t.dueAt} is not null and ${t.dueAt} >= substr(${today}, 1, length(${t.dueAt})) and substr(${t.dueAt}, 1, 10) <= ${plusDays(today, 7)}`;
    default:
      return null;
  }
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

const PRIORITY_RANK = sql`case ${schema.tasks.priority} when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`;

const selectColumns = {
  id: schema.tasks.id,
  title: schema.tasks.title,
  detail: schema.tasks.detail,
  owner: schema.tasks.owner,
  ownerPersonId: schema.tasks.ownerPersonId,
  dueAt: schema.tasks.dueAt,
  remindAt: schema.tasks.remindAt,
  status: schema.tasks.status,
  priority: schema.tasks.priority,
  sourceType: schema.tasks.sourceType,
  sourceId: schema.tasks.sourceId,
  completedAt: schema.tasks.completedAt,
  createdAt: schema.tasks.createdAt,
  updatedAt: schema.tasks.updatedAt,
  deletedAt: schema.tasks.deletedAt,
  // The outer table is named explicitly: drizzle renders a column reference inside a subquery without its table.
  ownerName: sql<string | null>`(select p.name from people p where p.id = tasks.owner_person_id and p.deleted_at is null)`,
  sourceTitle: sql<string | null>`case tasks.source_type
    when 'plan_item' then (select pi.title from plan_items pi where pi.id = tasks.source_id)
    when 'fact' then (select f.statement from facts f where f.id = tasks.source_id)
    when 'finding' then (select fi.title from findings fi where fi.id = tasks.source_id)
    when 'communication' then (select c.subject from communications c where c.id = tasks.source_id)
    when 'document' then (select d.title from documents d where d.id = tasks.source_id)
    when 'encounter' then (select e.title from encounters e where e.id = tasks.source_id)
    when 'record' then (select r.title from records_inventory r where r.id = tasks.source_id)
    when 'care_candidate' then (select cc.name from care_candidates cc where cc.id = tasks.source_id)
    else null end`,
};

type SelectedTask = Omit<TaskListItem, 'sourceHref' | 'overdue'>;

/** The title shown for a task made from a consult answer ("Make task" on /ask). */
export const CONSULT_SOURCE_TITLE = 'Consult answer';

/**
 * Consult sessions behind manual tasks: "Make task" on an answer stores the
 * ask message id as the task's sourceId with sourceType 'manual'. One query
 * for the whole list (ids go in as JSON, so a long list has no bound limit).
 * A message that is gone (its session was deleted) maps to nothing.
 */
function consultSessions(rows: SelectedTask[]): Map<string, string> {
  const ids = [...new Set(rows.filter((r) => r.sourceType === 'manual' && r.sourceId).map((r) => r.sourceId as string))];
  if (!ids.length) return new Map();
  const list = JSON.stringify(ids);
  return new Map(
    db()
      .all<{ id: string; sessionId: string }>(sql`select m.id as id, m.session_id as sessionId from ask_messages m where m.id in (select value from json_each(${list}))`)
      .map((m) => [m.id, m.sessionId]),
  );
}

/** A to-do made from a Plan item (2026-10-09) opens that plan's checklist with the item selected. */
function planItemHref(itemId: string): string | null {
  const row = db().select({ planId: schema.planItems.planId }).from(schema.planItems).where(eq(schema.planItems.id, itemId)).get();
  return row ? `/plan?plan=${encodeURIComponent(row.planId)}&tab=checklist&id=${encodeURIComponent(itemId)}` : null;
}

function decorate(r: SelectedTask, today: string, consults: Map<string, string>): TaskListItem {
  let href: string | null = null;
  let title = r.sourceTitle ?? null;
  if (r.sourceId && r.sourceType === 'plan_item') {
    href = planItemHref(r.sourceId);
  } else if (r.sourceId && r.sourceType === 'care_candidate') {
    href = `/care-team?id=${encodeURIComponent(r.sourceId)}`;
  } else if (r.sourceId && r.sourceType !== 'manual') {
    href = hrefFor(r.sourceType as 'fact' | 'finding' | 'communication' | 'document' | 'encounter' | 'record', r.sourceId);
  } else if (r.sourceId && consults.has(r.sourceId)) {
    href = `/ask?session=${encodeURIComponent(consults.get(r.sourceId)!)}`;
    title = CONSULT_SOURCE_TITLE;
  }
  return { ...r, sourceTitle: title, ownerName: r.ownerName ?? null, sourceHref: href, overdue: isActive(r.status) && isPastDue(r.dueAt, today) };
}

export function listTasks(raw: unknown = {}): TaskListItem[] {
  const f = parseInput(listQuery, raw ?? {});
  const t = schema.tasks;
  const today = todayIso();
  const conds: SQL[] = [isNull(t.deletedAt)];
  const statuses = expandStatuses(f.status);
  if (statuses.length) conds.push(inArray(t.status, statuses));
  if (f.owner && (TASK_OWNERS as readonly string[]).includes(f.owner)) conds.push(eq(t.owner, f.owner));
  if (f.ownerPersonId) conds.push(eq(t.ownerPersonId, f.ownerPersonId));
  if (f.sourceType && (TASK_SOURCE_TYPES as readonly string[]).includes(f.sourceType)) conds.push(eq(t.sourceType, f.sourceType));
  if (f.sourceId) conds.push(eq(t.sourceId, f.sourceId));
  const due = dueCondition(f.due, today);
  if (due) conds.push(due);
  const q = f.q?.trim();
  if (q) {
    const like = `%${escapeLike(q)}%`;
    conds.push(sql`(${t.title} like ${like} escape '\\' or ${t.detail} like ${like} escape '\\')`);
  }
  const rows = db()
    .select(selectColumns)
    .from(t)
    .where(and(...conds))
    .orderBy(sql`(${t.dueAt} is null) asc`, asc(t.dueAt), PRIORITY_RANK, asc(t.createdAt))
    .limit(f.limit ?? 5000)
    .all();
  const consults = consultSessions(rows);
  return rows.map((r) => decorate(r, today, consults));
}

export function getTask(id: string): TaskListItem {
  const row = db()
    .select(selectColumns)
    .from(schema.tasks)
    .where(and(eq(schema.tasks.id, id), isNull(schema.tasks.deletedAt)))
    .get();
  if (!row) throw notFound('task not found');
  return decorate(row, todayIso(), consultSessions([row]));
}

export interface TaskCounts {
  active: number;
  closed: number;
  all: number;
  overdue: number;
  today: number;
  week: number;
}

export function taskCounts(): TaskCounts {
  const today = todayIso();
  const week = plusDays(today, 7);
  const r = db().get<{ active: number; closed: number; all: number; overdue: number; today: number; week: number }>(sql`
    select
      sum(case when status in ('open','in_progress') then 1 else 0 end) as active,
      sum(case when status in ('done','cancelled') then 1 else 0 end) as closed,
      count(*) as "all",
      sum(case when status in ('open','in_progress') and due_at is not null and due_at < substr(${today}, 1, length(due_at)) then 1 else 0 end) as overdue,
      sum(case when status in ('open','in_progress') and due_at is not null and substr(due_at, 1, 10) = ${today} then 1 else 0 end) as today,
      sum(case when status in ('open','in_progress') and due_at is not null and due_at >= substr(${today}, 1, length(due_at)) and substr(due_at, 1, 10) <= ${week} then 1 else 0 end) as week
    from tasks where deleted_at is null`);
  return { active: r?.active ?? 0, closed: r?.closed ?? 0, all: r?.all ?? 0, overdue: r?.overdue ?? 0, today: r?.today ?? 0, week: r?.week ?? 0 };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function assertPerson(id: string | null | undefined, field: string): void {
  if (!id) return;
  const ok = db().select({ id: schema.people.id }).from(schema.people).where(and(eq(schema.people.id, id), isNull(schema.people.deletedAt))).get();
  if (!ok) throw badRequest(`${field}: unknown person id ${id}`);
}

function indexTask(row: TaskRow, ownerName: string | null): void {
  const body = [row.detail, OWNER_LABELS[row.owner] ?? row.owner, ownerName, row.status.replace(/_/g, ' '), row.priority, row.sourceType].filter(Boolean).join(' · ');
  indexEntity('task', row.id, row.title, body);
}

export function createTask(raw: unknown): TaskListItem {
  const input = parseInput(taskInput, raw);
  assertPerson(input.ownerPersonId, 'ownerPersonId');
  if (input.owner === 'person' && !input.ownerPersonId) throw badRequest('ownerPersonId is required when owner is person');
  const now = nowIso();
  const row: TaskInsert = {
    id: newId(),
    title: input.title,
    detail: input.detail ?? null,
    owner: input.owner,
    ownerPersonId: input.ownerPersonId ?? null,
    dueAt: resolveDay(input.dueAt, 'dueAt'),
    remindAt: resolveReminder(input.remindAt),
    status: input.status,
    priority: input.priority,
    sourceType: input.sourceType,
    sourceId: input.sourceId ?? null,
    completedAt: (CLOSED_STATUSES as readonly string[]).includes(input.status) ? now : null,
    createdAt: now,
    updatedAt: now,
  };
  db().insert(schema.tasks).values(row).run();
  const saved = getTask(row.id);
  indexTask(saved, saved.ownerName);
  return saved;
}

export function updateTask(id: string, raw: unknown): TaskListItem {
  const current = getTask(id);
  const patch = parseInput(taskPatch, raw);
  // Only a newly chosen person must exist: an owner who was soft-deleted since stays referenced, so the task can still be edited.
  if (patch.ownerPersonId !== undefined && patch.ownerPersonId !== current.ownerPersonId) assertPerson(patch.ownerPersonId, 'ownerPersonId');
  const owner = patch.owner ?? current.owner;
  const ownerPersonId = patch.ownerPersonId !== undefined ? patch.ownerPersonId : current.ownerPersonId;
  if (owner === 'person' && !ownerPersonId) throw badRequest('ownerPersonId is required when owner is person');
  const now = nowIso();
  const set: Partial<TaskInsert> = { updatedAt: now };
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.detail !== undefined) set.detail = patch.detail;
  if (patch.owner !== undefined) set.owner = patch.owner;
  if (patch.ownerPersonId !== undefined) set.ownerPersonId = patch.ownerPersonId;
  if (patch.dueAt !== undefined) set.dueAt = resolveDay(patch.dueAt, 'dueAt');
  if (patch.remindAt !== undefined) set.remindAt = resolveReminder(patch.remindAt);
  if (patch.priority !== undefined) set.priority = patch.priority;
  if (patch.sourceType !== undefined) set.sourceType = patch.sourceType;
  if (patch.sourceId !== undefined) set.sourceId = patch.sourceId;
  if (patch.status !== undefined && patch.status !== current.status) {
    set.status = patch.status;
    set.completedAt = (CLOSED_STATUSES as readonly string[]).includes(patch.status) ? now : null;
  }
  db().update(schema.tasks).set(set).where(eq(schema.tasks.id, id)).run();
  const saved = getTask(id);
  indexTask(saved, saved.ownerName);
  return saved;
}

export function deleteTask(id: string): void {
  const r = db()
    .update(schema.tasks)
    .set({ deletedAt: nowIso(), updatedAt: nowIso() })
    .where(and(eq(schema.tasks.id, id), isNull(schema.tasks.deletedAt)))
    .run();
  if (r.changes === 0) throw notFound('task not found');
  removeEntityIndex('task', id);
}

export function completeTask(id: string): TaskListItem {
  getTask(id);
  const now = nowIso();
  db().update(schema.tasks).set({ status: 'done', completedAt: now, updatedAt: now }).where(eq(schema.tasks.id, id)).run();
  const saved = getTask(id);
  indexTask(saved, saved.ownerName);
  return saved;
}

export function reopenTask(id: string): TaskListItem {
  getTask(id);
  db().update(schema.tasks).set({ status: 'open', completedAt: null, updatedAt: nowIso() }).where(eq(schema.tasks.id, id)).run();
  const saved = getTask(id);
  indexTask(saved, saved.ownerName);
  return saved;
}

/**
 * Push the due day forward: from the current due day when it is still ahead,
 * otherwise from today. A partial due date counts from the first day of its
 * period (so "Sept 2099" + 7 is 2099-09-08, never today + 7). A reminder
 * moves by the same number of days.
 */
export function snoozeTask(id: string, raw: unknown = {}): TaskListItem {
  const current = getTask(id);
  const { days } = parseInput(snoozeInput, raw ?? {});
  const today = todayIso();
  const dueStart = current.dueAt ? dueDay(current.dueAt) : null;
  const base = dueStart && dueStart >= today ? dueStart : today;
  const dueAt = plusDays(base, days);
  const set: Partial<TaskInsert> = { dueAt, updatedAt: nowIso() };
  if (current.remindAt) {
    const shift = current.dueAt && current.dueAt.length === 10 ? daysBetween(current.dueAt, dueAt) : days;
    const day = current.remindAt.slice(0, 10);
    const rest = current.remindAt.slice(10);
    set.remindAt = day.length === 10 ? `${plusDays(day, shift)}${rest}` : current.remindAt;
  }
  if (!isActive(current.status)) {
    set.status = 'open';
    set.completedAt = null;
  }
  db().update(schema.tasks).set(set).where(eq(schema.tasks.id, id)).run();
  const saved = getTask(id);
  indexTask(saved, saved.ownerName);
  return saved;
}

// ---------------------------------------------------------------------------
// Generators: follow-ups and gaps become tasks, once
// ---------------------------------------------------------------------------

function existingSources(sourceType: string): Set<string> {
  return new Set(
    db()
      .select({ sourceId: schema.tasks.sourceId })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.sourceType, sourceType), isNull(schema.tasks.deletedAt)))
      .all()
      .map((r) => r.sourceId)
      .filter((x): x is string => Boolean(x)),
  );
}

export interface GeneratedTasks {
  created: TaskListItem[];
  /** Sources that already had a live task. */
  existing: number;
}

function withWhom(c: CommWithParticipants): string {
  const names = c.participants.map((p) => p.name);
  return names.length ? names.join(', ') : 'unknown';
}

/**
 * A promise read out of a record that its thread shows answered (a later care-team message or call settled it; see
 * threads.ts refreshThreads): not a follow-up that needs a task, even before its done time is written.
 */
function answeredInRecords(c: Pick<CommWithParticipants, 'detailsJson'>): boolean {
  const det = parseCommunicationDetails(c.detailsJson) as { origin?: string; userFields?: string[]; followUp?: { doneByCommunicationId?: string | null } };
  // A follow-up the user reopened (or marked himself) is his to say: the replies never outrank it (2026-10-07 review, rev-comms #9).
  if (det.userFields?.includes('followUpDone')) return false;
  return det.origin === 'extracted' && Boolean(det.followUp?.doneByCommunicationId);
}

/** One task per open promised follow-up, keyed by communication id. Already-covered promises are skipped, and so are answered ones. */
export function tasksFromFollowUps(): GeneratedTasks {
  const have = existingSources('communication');
  const today = todayIso();
  const created: TaskListItem[] = [];
  let existing = 0;
  for (const c of listFollowUps()) {
    if (answeredInRecords(c)) continue;
    if (have.has(c.id)) {
      existing++;
      continue;
    }
    const overdue = isPastDue(c.followUpDue, today);
    created.push(
      createTask({
        title: `Follow up: ${c.followUpPromised ?? c.subject}`,
        detail: `Promised ${c.occurredAt ?? 'on an unknown date'} by ${c.followUpOwnerName ?? withWhom(c)} (${c.channel}: "${c.subject}").${c.followUpDue ? ` Due ${c.followUpDue}.` : ''}`,
        owner: c.followUpOwnerPersonId ? 'person' : 'me',
        ownerPersonId: c.followUpOwnerPersonId ?? null,
        dueAt: c.followUpDue ?? null,
        priority: overdue ? 'high' : 'normal',
        sourceType: 'communication',
        sourceId: c.id,
      }),
    );
  }
  return { created, existing };
}

function gapTitle(g: Gap): string {
  const where = g.institution ? ` (${g.institution})` : '';
  switch (g.status) {
    case 'requested':
      return `Chase requested record: ${g.title}${where}`;
    case 'not_held':
      return `Find another source for: ${g.title}${where}`;
    case 'denied':
      return `Appeal or re-request denied record: ${g.title}${where}`;
    default:
      return `Request record: ${g.title}${where}`;
  }
}

/**
 * One task per record gap. Inventory gaps key on the inventory row; inferred
 * gaps key on the record_reference fact. A materialised gap keeps counting as
 * covered by the task created from its fact, so nothing is produced twice.
 */
export function tasksFromGaps(): GeneratedTasks {
  const haveRecords = existingSources('record');
  const haveFacts = existingSources('fact');
  const created: TaskListItem[] = [];
  let existing = 0;
  for (const g of inferGaps()) {
    const sourceType = g.kind === 'inventory' ? 'record' : 'fact';
    const covered = g.kind === 'inventory' ? haveRecords.has(g.id) || (g.sourceFactId ? haveFacts.has(g.sourceFactId) : false) : haveFacts.has(g.id);
    if (covered) {
      existing++;
      continue;
    }
    const detail = [
      g.kind === 'inferred' ? `Implied by ${g.sourceDocumentTitle ?? 'a document'}${g.citation ? ` p.${g.citation.pageNumber}: "${g.citation.quote}"` : ''}.` : `Inventory status: ${g.status.replace(/_/g, ' ')}.`,
      g.dateText || g.date ? `Record date ${g.dateText ?? g.date}.` : null,
      g.likelyHeldDocumentTitle ? `Possibly already held as "${g.likelyHeldDocumentTitle}".` : null,
    ]
      .filter(Boolean)
      .join(' ');
    created.push(createTask({ title: gapTitle(g), detail, owner: 'me', priority: g.status === 'requested' ? 'normal' : 'normal', sourceType, sourceId: g.id }));
  }
  return { created, existing };
}

// ---------------------------------------------------------------------------
// iCalendar
// ---------------------------------------------------------------------------

/** The moment a reminder fires, or null when the stored value is not a real moment (the event then carries no alarm). */
function reminderMoment(remindAt: string): Date | null {
  // Date-only reminders fire at 09:00 local time.
  const iso = remindAt.length === 10 ? `${remindAt}T09:00` : remindAt.length === 7 ? `${remindAt}-01T09:00` : remindAt.length === 4 ? `${remindAt}-01-01T09:00` : remindAt;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A partial due date lands on the first day of its period. */
function dueDay(dueAt: string): string {
  if (dueAt.length === 4) return `${dueAt}-01-01`;
  if (dueAt.length === 7) return `${dueAt}-01`;
  return dueAt.slice(0, 10);
}

export function taskToEvent(t: TaskListItem): IcsEvent | null {
  if (!t.dueAt) return null;
  const owner = t.owner === 'person' ? (t.ownerName ?? 'person') : (OWNER_LABELS[t.owner] ?? t.owner);
  const description = [t.detail, `Owner: ${owner}`, `Priority: ${t.priority}`, t.sourceTitle ? `Source: ${t.sourceTitle}` : null, t.dueAt.length < 10 ? `Due date as recorded: ${t.dueAt} (approximate)` : null].filter(Boolean).join('\n');
  const alarmAt = t.remindAt ? reminderMoment(t.remindAt) : null;
  return {
    uid: `casefile-task-${t.id}@casefile.local`,
    date: dueDay(t.dueAt),
    summary: `${t.title}${t.dueAt.length < 10 ? ' (approximate date)' : ''}`,
    description,
    status: t.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED',
    categories: ['Casefile', 'Task', t.priority],
    alarm: alarmAt ? { at: alarmAt, description: t.title } : null,
  };
}

/** The .ics text for every task matching the filters (default: still to do) that has a due day. */
export function tasksCalendar(filters: unknown = {}, now?: Date): string {
  const f = parseInput(listQuery, filters ?? {});
  const items = listTasks({ ...f, status: f.status ?? 'active' });
  const events = items.map(taskToEvent).filter((e): e is IcsEvent => Boolean(e));
  return buildCalendar(events, { name: 'Casefile tasks', now });
}

export function taskCalendar(id: string, now?: Date): string {
  const t = getTask(id);
  const e = taskToEvent(t);
  if (!e) throw badRequest('this task has no due date to put on a calendar');
  return buildCalendar([e], { name: 'Casefile task', now });
}

// ---------------------------------------------------------------------------
// Daily plan
// ---------------------------------------------------------------------------

export interface PlanEncounter {
  id: string;
  title: string;
  kind: string;
  status: string;
  occurredAt: string | null;
  occurredAtPrecision: string;
  timeText: string | null;
  location: string | null;
  clinicianName: string | null;
  institutionName: string | null;
  prepNotes: string | null;
  questions: string[];
}

export interface PlanMedication {
  id: string;
  name: string;
  dose: string | null;
  unit: string | null;
  route: string | null;
  frequency: string | null;
  status: string;
  indication: string | null;
  prescriberName: string | null;
}

export interface PlanHardStop {
  id: string;
  substance: string;
  kind: string;
  reaction: string | null;
  severity: string;
}

export interface PlanFollowUp {
  id: string;
  subject: string;
  followUpPromised: string | null;
  followUpDue: string | null;
  withWhom: string;
  overdue: boolean;
}

export interface PlanSymptom {
  id: string;
  name: string;
  logged: boolean;
  score: number | null;
}

export interface DailyPlan {
  date: string;
  tasksDue: TaskListItem[];
  overdue: TaskListItem[];
  /**
   * Tasks due in the six days after `date`, for the "coming up" line, plus
   * month- or year-precision tasks whose period is under way on `date` or
   * starts within those six days (not yet overdue, so listed here instead).
   */
  tasksSoon: TaskListItem[];
  encounters: PlanEncounter[];
  /** Encounters in the seven days after `date`. */
  encountersSoon: PlanEncounter[];
  followUpsDue: PlanFollowUp[];
  medicationsActive: PlanMedication[];
  hardStops: PlanHardStop[];
  symptomsToLog: PlanSymptom[];
  /** Daily-log notes already written for that day. */
  notes: string | null;
  patientName: string | null;
  generatedAt: string;
}

function questionTexts(json: string): string[] {
  const raw = parseJson<unknown[]>(json, []);
  if (!Array.isArray(raw)) return [];
  return raw.map((q) => (typeof q === 'string' ? q : q && typeof q === 'object' && typeof (q as { text?: unknown }).text === 'string' ? (q as { text: string }).text : '')).filter(Boolean);
}

function planEncounters(from: string, to: string): PlanEncounter[] {
  return db()
    .all<Omit<PlanEncounter, 'questions'> & { questionsJson: string }>(
      sql`select e.id, e.title, e.kind, e.status, e.occurred_at as occurredAt, e.occurred_at_precision as occurredAtPrecision, e.time_text as timeText,
            e.location, p.name as clinicianName, i.name as institutionName, e.prep_notes as prepNotes, e.questions_json as questionsJson
          from encounters e left join people p on p.id = e.clinician_id left join people i on i.id = e.institution_id
          where e.deleted_at is null and e.status != 'cancelled' and e.occurred_at is not null
            and substr(e.occurred_at, 1, 10) >= ${from} and substr(e.occurred_at, 1, 10) <= ${to}
          order by e.occurred_at asc, e.time_text asc`,
    )
    .map(({ questionsJson, ...e }) => ({ ...e, questions: questionTexts(questionsJson) }));
}

export function dailyPlan(dateRaw?: string | null): DailyPlan {
  const date = dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : dateRaw ? resolveDay(dateRaw, 'date')!.slice(0, 10) : todayIso();
  if (date.length !== 10) throw badRequest('date must be a full day (YYYY-MM-DD)');
  const d = db();
  const active = listTasks({ status: 'active' });
  const tasksDue = active.filter((t) => t.dueAt && t.dueAt.slice(0, 10) === date);
  const overdue = active.filter((t) => isPastDue(t.dueAt, date));
  const weekEnd = plusDays(date, 6);
  // Day dates: strictly after `date` up to weekEnd. Partial dates: the period overlaps [date, weekEnd] (compared at their precision).
  const tasksSoon = active.filter((t) => t.dueAt && (t.dueAt.length === 10 ? t.dueAt > date && t.dueAt <= weekEnd : !isPastDue(t.dueAt, date) && t.dueAt <= weekEnd.slice(0, t.dueAt.length)));
  const encounters = planEncounters(date, date);
  const encountersSoon = planEncounters(plusDays(date, 1), plusDays(date, 7));
  const followUpsDue = listFollowUps()
    .filter((c) => !c.followUpDue || c.followUpDue <= date)
    .map((c) => ({ id: c.id, subject: c.subject, followUpPromised: c.followUpPromised, followUpDue: c.followUpDue, withWhom: withWhom(c), overdue: isPastDue(c.followUpDue, date) }));
  const medicationsActive = d.all<PlanMedication>(sql`
    select m.id, m.name, m.dose, m.unit, m.route, m.frequency, m.status, m.indication, p.name as prescriberName
    from medications m left join people p on p.id = m.prescriber_id
    where m.deleted_at is null and m.status in ('active', 'prn') order by m.status asc, m.name collate nocase`);
  const hardStops = d.all<PlanHardStop>(sql`
    select id, substance, kind, reaction, severity from intolerances
    where deleted_at is null and active = 1 and (hard_stop = 1 or kind = 'hard_stop') order by substance collate nocase`);
  const symptomsToLog: PlanSymptom[] = d
    .all<{ id: string; name: string; logged: number; score: number | null }>(sql`
    select sd.id, sd.name, (se.id is not null) as logged, se.score as score
    from symptom_definitions sd left join symptom_entries se on se.symptom_id = sd.id and se.date = ${date}
    where sd.active = 1 order by sd.sort_order asc, sd.name collate nocase`)
    .map((s) => ({ id: s.id, name: s.name, logged: Boolean(s.logged), score: s.score }));
  const notes = d.get<{ notes: string | null }>(sql`select notes from daily_log where date = ${date}`)?.notes ?? null;
  const patient = d.get<{ v: string }>(sql`select value_json as v from settings where key = 'patient.name'`);
  let patientName: string | null = null;
  if (patient) {
    const v = parseJson<unknown>(patient.v, null);
    patientName = typeof v === 'string' && v.trim() ? v.trim() : null;
  }
  return { date, tasksDue, overdue, tasksSoon, encounters, encountersSoon, followUpsDue, medicationsActive, hardStops, symptomsToLog, notes, patientName, generatedAt: nowIso() };
}
