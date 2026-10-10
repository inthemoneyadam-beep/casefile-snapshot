/**
 * The timeline: one chronology over every dated entity. It is a UNION ALL
 * over documents, facts, communications, encounters, medication events, lab
 * results, imaging studies, symptom entries (one row per day), the daily log,
 * tasks and findings, each tagged with its kind.
 *
 * Partial dates sort with `dateSortKey` semantics (a year-only item sorts
 * before January of that year) and from/to windows compare on the prefix of
 * that key, so a window of "2024" includes a year-only 2024 fact and a window
 * starting "2024-03" does not.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { hrefFor } from './search';
import { visibleWithRecordSql } from './communications';
import type { DatePrecision } from '../../shared/dates';
import {
  TIMELINE_KINDS,
  type TimelineBucket,
  type TimelineDensityResponse,
  type TimelineItem,
  type TimelineKind,
  type TimelineResponse,
} from '../../shared/timeline';

export interface TimelineFilter {
  /** YYYY, YYYY-MM or YYYY-MM-DD. */
  from?: string | null;
  to?: string | null;
  kinds?: TimelineKind[] | null;
  q?: string | null;
  /**
   * With `q`: also match the notes written on each item that the consult's
   * get_timeline tool prints (check notes, visit prep notes, questions and
   * outcomes, a contact's outcome and promised follow-up, lab, imaging,
   * symptom and daily log notes, a finding's note). Off for the Timeline
   * page, whose search keeps to the columns it shows.
   */
  qNotes?: boolean | null;
  personId?: string | null;
  documentId?: string | null;
  limit?: number | null;
  /**
   * With `bucket`: return at most this many items per period (the first ones
   * in date order), so an overview at year or month zoom fetches only the
   * rows it previews instead of the whole range up to the limit. Periods use
   * the density strip's bucketing (imprecise dates land in the first period
   * they cover).
   */
  perBucket?: number | null;
  bucket?: TimelineBucket | null;
}

/**
 * A timeline item as this service returns it. `overriddenBy` is the id of the
 * patient statement that takes precedence over a fact (slice Q), null
 * otherwise. It belongs on the shared TimelineItem; it is declared here
 * because src/shared/timeline.ts is outside this change.
 */
export type TimelineRow = TimelineItem & { overriddenBy: string | null };
export type TimelineRowsResponse = Omit<TimelineResponse, 'items'> & { items: TimelineRow[] };

interface RawRow {
  id: string;
  kind: TimelineKind;
  date: string | null;
  date_precision: string | null;
  title: string | null;
  detail: string | null;
  status: string | null;
  sub_kind: string | null;
  person_name: string | null;
  document_id: string | null;
  ref_id: string | null;
  overridden_by: string | null;
  notes?: string | null;
  sort_key: string;
}

const PARTIAL_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;
const DEFAULT_LIMIT = 5000;
const MAX_LIMIT = 20000;
const MAX_PER_BUCKET = 100;

function cleanPartial(s: string | null | undefined): string | null {
  const t = (s ?? '').trim();
  return PARTIAL_RE.test(t) ? t : null;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

const NONE = sql``;

/** The non-empty texts among these SQL expressions, one per line (for the q filter over notes). */
function joinedText(...cols: string[]): SQL {
  return sql.raw(`nullif(trim(${cols.map((c) => `coalesce(${c}, '')`).join(' || char(10) || ')}), '')`);
}

/** The note on the check of a lab row's or imaging study's fact, while that fact is live (as get_timeline prints it). */
const factCheckNote = (col: string): string => `(select fc.verdict_note from facts fc where fc.id = ${col} and fc.deleted_at is null and fc.status != 'superseded')`;

/** A JSON list column, or null when it holds no entries. */
const jsonList = (col: string): string => `(case when ${col} in ('', '[]') then null else ${col} end)`;

/**
 * Notes per kind for `qNotes`, by branch alias. Every branch carries a
 * `notes` column (null when the filter is off) so the union stays aligned.
 */
const NOTE_COLUMNS: Record<TimelineKind, SQL> = {
  document: joinedText('d.notes', jsonList('d.tags_json')),
  fact: joinedText('f.verdict_note', 'f.override_reason'),
  communication: joinedText('c.outcome', 'c.follow_up_promised'),
  encounter: joinedText('e.prep_notes', 'e.outcomes', 'e.location', jsonList('e.questions_json')),
  medication_event: joinedText('me.detail', 'me.dose'),
  lab: joinedText('l.notes', factCheckNote('l.fact_id')),
  imaging: joinedText('i.notes', 'i.findings', factCheckNote('i.fact_id')),
  symptom: joinedText("(select group_concat(sn.note, char(10)) from symptom_entries sn where sn.date = s.date and trim(coalesce(sn.note, '')) != '')"),
  daily: joinedText('dl.notes', jsonList('dl.tags_json')),
  task: joinedText('t.detail'),
  finding: joinedText('f.verdict_note', 'f.detail'),
};

/** A lab row or imaging study on a soft-deleted document is hidden, as the Labs and Imaging pages hide it; a row with no document stays. */
const documentNotDeleted = (col: string): SQL => sql.raw(`(${col} is null or not exists (select 1 from documents dx where dx.id = ${col} and dx.deleted_at is not null))`);
/** A message read out of a record goes with its record (deleted, or held back as someone else's; review 2026-10-09). */
const VISIBLE_WITH_RECORD_C = sql.raw(visibleWithRecordSql('c'));

/**
 * A stored lab value as text without rounding: %g alone keeps six
 * significant digits and switches to exponent form (1234567 -> 1.23457e+06).
 * %.15g prints every digit a REAL holds (integers without a decimal point,
 * float noise trimmed); values below 1e-4, where %g would use an exponent,
 * are printed fixed-point with trailing zeros trimmed.
 */
const LAB_NUM = sql.raw(`(case
  when l.value_num != 0 and abs(l.value_num) < 0.0001 then rtrim(rtrim(printf('%.15f', l.value_num), '0'), '.')
  else printf('%.15g', l.value_num) end)`);

/**
 * A lab row read in SQL (the user's rules, 2026-10; amendment B3): the row's current text first (value_text, unit, ref_text,
 * flag: the user's edits always show), the text as printed (value_raw, unit_raw, ref_raw, flag_raw: migration 0004) only
 * where the current text is missing. A range is shown as printed, never composed from numbers ("-50"); a leading "ref"
 * label is not doubled. The date is the collected date, else the resulted date, said in the detail ("dated by its
 * result"), never the document's (rule 7). A blank or dashed printed flag is "no flag printed": no status.
 */
/**
 * SQL: the user changed this field of the row by hand (parse_json.userFields); a row saved by hand before that record
 * existed may have had any field changed or cleared. The same rule as the Labs page (lab-reading.ts fieldEdited): the
 * printed text never fills a field the user changed (2026-10 review: a cleared unit or range came back here).
 */
const labFieldEdited = (f: 'value' | 'unit' | 'range' | 'flag'): string =>
  `(case when json_valid(l.parse_json) then (case when json_type(l.parse_json, '$.userFields') = 'array' then exists (select 1 from json_each(l.parse_json, '$.userFields') ue where ue.value = '${f}') else l.updated_at != l.created_at end) else l.updated_at != l.created_at end)`;
const LAB_RANGE = `coalesce(l.ref_text, case when not ${labFieldEdited('range')} then l.ref_raw end)`;
/**
 * The value: the current text, else the printed text (never over the user's change), else the stored number. A plain
 * number whose stored reading is a limit (the page prints "<3" where the value was read as "3": the Labs page follows
 * the page) is said with the page's sign, never as the measurement "3" (rules 1, 2).
 */
const LAB_TEXT = `coalesce(l.value_text, case when not ${labFieldEdited('value')} then l.value_raw end)`;
const LAB_VALUE = sql.raw(`(case when l.value_kind = 'censored' and l.value_comparator in ('<', '<=', '>', '>=') and trim(${LAB_TEXT}) glob '[0-9.]*' and trim(${LAB_TEXT}) not glob '*[^0-9.,]*'
  then (case l.value_comparator when '<' then '<' when '<=' then '≤' when '>' then '>' else '≥' end) || trim(${LAB_TEXT}) else ${LAB_TEXT} end)`);
/**
 * The unit as the Labs page shows it: the current unit, an exactly repeated unit shown once (unit_parsed, the reading's
 * own projection: "cells/uL cells/uL" is "cells/uL"), else the printed unit when the user did not clear it.
 */
const LAB_UNIT = sql.raw(`(case when nullif(trim(l.unit), '') is not null then coalesce(l.unit_parsed, l.unit)
  when not ${labFieldEdited('unit')} and nullif(trim(l.unit_raw), '') is not null then coalesce(l.unit_parsed, l.unit_raw) end)`);
const LAB_DATE = sql.raw('coalesce(l.collected_at, l.resulted_at)');
const LAB_DATE_PRECISION = sql.raw("(case when l.collected_at is not null then l.collected_at_precision else coalesce(l.resulted_at_precision, l.collected_at_precision) end)");
const LAB_DETAIL = sql.raw(`nullif(trim(
  coalesce(case when ${LAB_RANGE} is null or trim(${LAB_RANGE}) = '' then null
    when lower(trim(${LAB_RANGE})) like 'ref%' or lower(trim(${LAB_RANGE})) like 'normal%' then trim(${LAB_RANGE})
    else 'ref ' || trim(${LAB_RANGE}) end, '')
  || (case when l.collected_at is null and l.resulted_at is not null then (case when ${LAB_RANGE} is not null and trim(${LAB_RANGE}) != '' then ' · ' else '' end) || 'dated by its result' else '' end)
), '')`);
/**
 * The status tag: the flag printed with the value (flag holds the meaning of the user's own choice when the user changed
 * it; the printed flag_raw fills it only when the user did not), never a summary's own flag (a document that restates
 * results: its flag is its claim, rules 11 and 12), never "no flag printed".
 */
const LAB_STATUS = sql.raw(`(case when dt.source_tier in ('patient', 'compilation', 'external') then null
  else coalesce(nullif(nullif(l.flag, ''), '-'), case when not ${labFieldEdited('flag')} then nullif(nullif(trim(l.flag_raw), ''), '-') end) end)`);

/**
 * One SELECT per kind, all with the same column list. Person and document
 * filters are applied inside each branch because the join differs per kind;
 * kinds that cannot be tied to a person or document are left out when such a
 * filter is active.
 */
function branches(f: TimelineFilter): SQL[] {
  const pid = f.personId || null;
  const did = f.documentId || null;
  const wanted = new Set<TimelineKind>(f.kinds && f.kinds.length ? f.kinds : TIMELINE_KINDS);
  const withNotes = Boolean(f.qNotes && (f.q ?? '').trim());
  const notes = (kind: TimelineKind): SQL => (withNotes ? NOTE_COLUMNS[kind] : sql`null`);
  const out: SQL[] = [];

  if (wanted.has('document')) {
    out.push(sql`
      select d.id as id, 'document' as kind, d.document_date as date, d.document_date_precision as date_precision,
        d.title as title, coalesce(nullif(d.notes, ''), d.filename) as detail, d.text_status as status, d.category as sub_kind,
        coalesce(a.name, i.name) as person_name, d.id as document_id, null as ref_id, null as overridden_by, ${notes('document')} as notes
      from documents d
        left join people a on a.id = d.author_person_id
        left join people i on i.id = d.institution_id
      where d.deleted_at is null
        ${pid ? sql`and (d.author_person_id = ${pid} or d.institution_id = ${pid})` : NONE}
        ${did ? sql`and d.id = ${did}` : NONE}`);
  }

  if (wanted.has('fact')) {
    out.push(sql`
      select f.id as id, 'fact' as kind, f.date as date, f.date_precision as date_precision,
        f.statement as title, d.title as detail, f.status as status, f.type as sub_kind,
        p.name as person_name, f.source_document_id as document_id, null as ref_id,
        f.overridden_by_fact_id as overridden_by, ${notes('fact')} as notes
      from facts f
        left join documents d on d.id = f.source_document_id
        left join people p on p.id = f.person_id
      where f.deleted_at is null and f.status != 'superseded'
        and (f.source_document_id is null or (d.id is not null and d.deleted_at is null))
        ${pid ? sql`and f.person_id = ${pid}` : NONE}
        ${did ? sql`and f.source_document_id = ${did}` : NONE}`);
  }

  if (wanted.has('communication')) {
    out.push(sql`
      select c.id as id, 'communication' as kind, c.occurred_at as date, c.occurred_at_precision as date_precision,
        c.subject as title, c.summary as detail,
        case when c.follow_up_promised is not null and c.follow_up_done_at is null then 'follow-up open' else null end as status,
        c.direction || ' ' || c.channel as sub_kind,
        (select group_concat(p.name, ', ') from communication_participants cp join people p on p.id = cp.person_id where cp.communication_id = c.id) as person_name,
        c.document_id as document_id, null as ref_id, null as overridden_by, ${notes('communication')} as notes
      from communications c
      where c.deleted_at is null and ${VISIBLE_WITH_RECORD_C}
        ${pid ? sql`and exists (select 1 from communication_participants cp2 where cp2.communication_id = c.id and cp2.person_id = ${pid})` : NONE}
        ${did ? sql`and c.document_id = ${did}` : NONE}`);
  }

  if (wanted.has('encounter')) {
    out.push(sql`
      select e.id as id, 'encounter' as kind, e.occurred_at as date, e.occurred_at_precision as date_precision,
        e.title as title, coalesce(nullif(e.outcomes, ''), nullif(e.location, ''), nullif(e.prep_notes, '')) as detail, e.status as status, e.kind as sub_kind,
        coalesce(p.name, i.name) as person_name, null as document_id, null as ref_id, null as overridden_by, ${notes('encounter')} as notes
      from encounters e
        left join people p on p.id = e.clinician_id
        left join people i on i.id = e.institution_id
      where e.deleted_at is null
        ${pid ? sql`and (e.clinician_id = ${pid} or e.institution_id = ${pid})` : NONE}
        ${did ? sql`and instr(e.document_ids_json, ${did}) > 0` : NONE}`);
  }

  if (wanted.has('medication_event') && !did) {
    out.push(sql`
      select me.id as id, 'medication_event' as kind, me.date as date, me.date_precision as date_precision,
        m.name || ': ' || replace(me.kind, '_', ' ') as title, coalesce(nullif(me.detail, ''), me.dose) as detail, null as status, me.kind as sub_kind,
        p.name as person_name, null as document_id, me.medication_id as ref_id, null as overridden_by, ${notes('medication_event')} as notes
      from medication_events me
        join medications m on m.id = me.medication_id
        left join people p on p.id = m.prescriber_id
      where m.deleted_at is null and me.deleted_at is null
        ${pid ? sql`and m.prescriber_id = ${pid}` : NONE}`);
  }

  if (wanted.has('lab')) {
    out.push(sql`
      select l.id as id, 'lab' as kind, ${LAB_DATE} as date, ${LAB_DATE_PRECISION} as date_precision,
        l.analyte || ' ' || coalesce(${LAB_VALUE}, case when l.value_num is not null then ${LAB_NUM} else '' end) || coalesce(' ' || ${LAB_UNIT}, '')
          -- A value the patient computed from printed values (2026-10-09) says so wherever it is listed.
          || case when l.raw_source = 'computed' then ' (computed by you)' else '' end as title,
        ${LAB_DETAIL} as detail,
        ${LAB_STATUS} as status, l.specimen as sub_kind,
        coalesce(p.name, l.lab_name) as person_name, l.document_id as document_id, null as ref_id, null as overridden_by, ${notes('lab')} as notes
      from lab_results l
        left join people p on p.id = l.institution_id
        left join documents dt on dt.id = l.document_id
      where l.deleted_at is null and ${documentNotDeleted('l.document_id')}
        ${pid ? sql`and l.institution_id = ${pid}` : NONE}
        ${did ? sql`and l.document_id = ${did}` : NONE}`);
  }

  if (wanted.has('imaging')) {
    out.push(sql`
      select i.id as id, 'imaging' as kind, i.performed_at as date, i.performed_at_precision as date_precision,
        i.title as title, coalesce(nullif(i.impression, ''), nullif(i.findings, '')) as detail, null as status, i.modality as sub_kind,
        p.name as person_name, i.document_id as document_id, null as ref_id, null as overridden_by, ${notes('imaging')} as notes
      from imaging_studies i
        left join people p on p.id = i.institution_id
      where i.deleted_at is null and ${documentNotDeleted('i.document_id')}
        ${pid ? sql`and i.institution_id = ${pid}` : NONE}
        ${did ? sql`and i.document_id = ${did}` : NONE}`);
  }

  if (wanted.has('symptom') && !pid && !did) {
    out.push(sql`
      select s.date as id, 'symptom' as kind, s.date as date, 'day' as date_precision,
        'Symptoms logged' as title,
        (select group_concat(r.name || ' ' || r.score, ', ' order by r.rn)
           from (select sd.name as name, se.score as score, se.date as d,
                        row_number() over (partition by se.date order by se.score desc, sd.sort_order asc) as rn
                 from symptom_entries se join symptom_definitions sd on sd.id = se.symptom_id) r
          where r.d = s.date and r.rn <= 3) as detail,
        null as status, cast(count(*) as text) || ' scores' as sub_kind, null as person_name, null as document_id, null as ref_id, null as overridden_by, ${notes('symptom')} as notes
      from symptom_entries s
      group by s.date`);
  }

  if (wanted.has('daily') && !pid && !did) {
    out.push(sql`
      select dl.id as id, 'daily' as kind, dl.date as date, 'day' as date_precision,
        'Daily log' as title,
        coalesce(nullif(dl.notes, ''), case when dl.sleep_hours is not null then 'sleep ' || printf('%g', dl.sleep_hours) || ' h' else null end) as detail,
        null as status, null as sub_kind, null as person_name, null as document_id, null as ref_id, null as overridden_by, ${notes('daily')} as notes
      from daily_log dl`);
  }

  if (wanted.has('task')) {
    out.push(sql`
      select t.id as id, 'task' as kind, substr(t.due_at, 1, 10) as date, 'day' as date_precision,
        t.title as title, t.detail as detail, t.status as status, t.priority as sub_kind,
        p.name as person_name, case when t.source_type = 'document' then t.source_id else null end as document_id, null as ref_id, null as overridden_by, ${notes('task')} as notes
      from tasks t
        left join people p on p.id = t.owner_person_id
      where t.deleted_at is null
        ${pid ? sql`and t.owner_person_id = ${pid}` : NONE}
        ${did ? sql`and t.source_type = 'document' and t.source_id = ${did}` : NONE}`);
  }

  if (wanted.has('finding') && !pid) {
    out.push(sql`
      select f.id as id, 'finding' as kind, substr(f.created_at, 1, 10) as date, 'day' as date_precision,
        f.title as title, f.why_it_matters as detail, f.status as status, f.category as sub_kind,
        null as person_name, null as document_id, null as ref_id, null as overridden_by, ${notes('finding')} as notes
      from findings f
      where f.deleted_at is null
        ${did ? sql`and exists (select 1 from finding_evidence fe where fe.finding_id = f.id and fe.document_id = ${did})` : NONE}`);
  }

  return out;
}

const SORT_KEY = sql`case
  when u.date is null then '9999-99-99'
  when length(u.date) = 4 then u.date || '-00-00'
  when length(u.date) = 7 then u.date || '-00'
  else substr(u.date, 1, 10) end`;

/**
 * `select ... from (...) t where <conds>` with the row-level filters. Date
 * filters only constrain dated rows so callers can still count the undated.
 */
function base(f: TimelineFilter, opts: { kinds: boolean; dates: boolean }): SQL | null {
  const parts = branches(f);
  if (!parts.length) return null;
  const union = sql.join(parts, sql` union all `);
  const conds: SQL[] = [sql`1 = 1`];
  if (opts.kinds && f.kinds && f.kinds.length) {
    conds.push(sql`t.kind in (${sql.join(f.kinds.map((k) => sql`${k}`), sql`, `)})`);
  }
  if (opts.dates) {
    const from = cleanPartial(f.from);
    const to = cleanPartial(f.to);
    if (from) conds.push(sql`(t.date is null or substr(t.sort_key, 1, ${from.length}) >= ${from})`);
    if (to) conds.push(sql`(t.date is null or substr(t.sort_key, 1, ${to.length}) <= ${to})`);
  }
  const q = (f.q ?? '').trim();
  if (q) {
    const like = `%${escapeLike(q)}%`;
    const inNotes = f.qNotes ? sql` or t.notes like ${like} escape '\\'` : NONE;
    conds.push(sql`(t.title like ${like} escape '\\' or t.detail like ${like} escape '\\' or t.person_name like ${like} escape '\\'${inNotes})`);
  }
  return sql`from (select u.*, ${SORT_KEY} as sort_key from (${union}) u) t where ${sql.join(conds, sql` and `)}`;
}

function hrefOf(r: RawRow, date: string): string {
  switch (r.kind) {
    case 'document':
      return hrefFor('document', r.id);
    case 'fact':
      return hrefFor('fact', r.id);
    case 'communication':
      return hrefFor('communication', r.id);
    case 'encounter':
      return hrefFor('encounter', r.id);
    case 'medication_event':
      return hrefFor('medication', r.ref_id ?? r.id);
    case 'lab':
      return hrefFor('lab', r.id);
    case 'imaging':
      return hrefFor('imaging', r.id);
    case 'symptom':
    case 'daily':
      return `/symptoms?date=${date}`;
    case 'task':
      return hrefFor('task', r.id);
    case 'finding':
      return hrefFor('finding', r.id);
  }
}

function precisionOf(date: string, stored: string | null): DatePrecision {
  if (stored === 'day' || stored === 'month' || stored === 'year') {
    // Trust the stored precision unless the value is visibly shorter.
    if (stored === 'day' && date.length < 10) return date.length === 4 ? 'year' : 'month';
    if (stored === 'month' && date.length === 4) return 'year';
    return stored;
  }
  return date.length === 4 ? 'year' : date.length === 7 ? 'month' : 'day';
}

function toItem(r: RawRow): TimelineRow {
  const date = (r.date ?? '').length > 10 ? r.date!.slice(0, 10) : r.date!;
  return {
    id: r.id,
    kind: r.kind,
    date,
    datePrecision: precisionOf(date, r.date_precision),
    title: r.title ?? '',
    detail: r.detail ?? null,
    status: r.status ?? null,
    href: hrefOf(r, date),
    subKind: r.sub_kind ?? null,
    personName: r.person_name ?? null,
    documentId: r.document_id ?? null,
    overriddenBy: r.kind === 'fact' ? (r.overridden_by ?? null) : null,
  };
}

/** The period a row falls in, as the density strip keys it ("2024-00" -> "2024-01"). */
function bucketExpr(bucket: TimelineBucket): SQL {
  return sql`replace(substr(t.sort_key, 1, ${BUCKET_LEN[bucket]}), '-00', '-01')`;
}

const ORDER = sql`sort_key asc, kind asc, title asc`;

export function listTimeline(f: TimelineFilter = {}): TimelineRowsResponse {
  const d = db();
  const limit = Math.max(1, Math.min(MAX_LIMIT, f.limit ?? DEFAULT_LIMIT));
  const perBucket = f.perBucket && f.perBucket > 0 ? Math.min(MAX_PER_BUCKET, Math.floor(f.perBucket)) : null;
  const counts: Record<string, number> = { undated: 0 };
  const empty: TimelineRowsResponse = { items: [], range: { min: null, max: null }, counts };

  const listBase = base(f, { kinds: true, dates: true });
  if (!listBase) return empty;
  const rows = perBucket
    ? d.all<RawRow>(
        sql`select p.* from (select t.*, row_number() over (partition by ${bucketExpr(f.bucket ?? 'year')} order by t.sort_key asc, t.kind asc, t.title asc) as rn ${listBase} and t.date is not null) p
          where p.rn <= ${perBucket} order by ${ORDER} limit ${limit}`,
      )
    : d.all<RawRow>(sql`select t.* ${listBase} and t.date is not null order by ${ORDER} limit ${limit}`);

  // Counts per kind ignore the kind toggles (so the toolbar can show what each
  // toggle would add) but honour every other filter.
  const countBase = base({ ...f, kinds: null }, { kinds: false, dates: true });
  if (countBase) {
    const cs = d.all<{ kind: string; undated: number; n: number }>(sql`select t.kind as kind, (t.date is null) as undated, count(*) as n ${countBase} group by t.kind, undated`);
    for (const c of cs) {
      if (c.undated) counts.undated += c.n;
      else counts[c.kind] = (counts[c.kind] ?? 0) + c.n;
    }
  }

  // The range spans the whole filtered corpus, not just the window.
  const rangeBase = base(f, { kinds: true, dates: false });
  let range: TimelineResponse['range'] = { min: null, max: null };
  if (rangeBase) {
    const r = d.get<{ min: string | null; max: string | null }>(sql`select min(t.date) as min, max(t.date) as max ${rangeBase} and t.date is not null`);
    range = { min: r?.min ? r.min.slice(0, 10) : null, max: r?.max ? r.max.slice(0, 10) : null };
  }

  return { items: rows.map(toItem), range, counts };
}

const BUCKET_LEN: Record<TimelineBucket, number> = { year: 4, month: 7, day: 10 };

/** Imprecise dates land in the first bucket of their period ("2024-00" -> "2024-01"). */
export function normalizeBucket(b: string): string {
  return b.replace(/-00(?=(-|$))/g, '-01');
}

export function timelineDensity(bucket: TimelineBucket, f: TimelineFilter = {}): TimelineDensityResponse {
  const d = db();
  const b = base(f, { kinds: true, dates: true });
  if (!b) return { bucket, items: [] };
  const n = BUCKET_LEN[bucket];
  const rows = d.all<{ bucket: string; kind: string; n: number }>(
    sql`select substr(t.sort_key, 1, ${n}) as bucket, t.kind as kind, count(*) as n ${b} and t.date is not null group by 1, 2 order by 1 asc`,
  );
  const byBucket = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const key = normalizeBucket(r.bucket);
    const rec = byBucket.get(key) ?? {};
    rec[r.kind] = (rec[r.kind] ?? 0) + r.n;
    byBucket.set(key, rec);
  }
  const items = [...byBucket.entries()].sort(([a], [bb]) => (a < bb ? -1 : a > bb ? 1 : 0)).map(([bk, counts]) => ({ bucket: bk, counts }));
  return { bucket, items };
}
