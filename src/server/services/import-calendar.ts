/**
 * Calendar import (docs/API-CONTRACTS-3.md, slice O). An iCalendar (.ics)
 * file is read into a preview of its events; each event gets a suggestion
 * (an encounter, a note on the daily log, or nothing) with fuzzy matches of
 * its SUMMARY, LOCATION and attendee names against the people on file; the
 * user's choices are then applied. Nothing is written by the preview.
 *
 * Parsing covers what calendars actually export (RFC 5545):
 * - folded lines (CRLF or LF followed by one space or tab) are unfolded;
 * - TEXT values are unescaped (\\ \; \, \n);
 * - DTSTART may be a DATE (all-day), a UTC DATE-TIME (…Z), a DATE-TIME with
 *   TZID (IANA names, the common Windows names Outlook writes, and
 *   "/vendor/…/Area/City" prefixes), or a floating DATE-TIME. A timed event
 *   is moved into the case's time zone (the PC's; the encounter keeps a
 *   local day and a HH:MM time) and the item keeps the time as written; a
 *   TZID this runtime does not know keeps its wall-clock time, with a note;
 * - RRULE is not expanded: the first occurrence is offered and the item says
 *   that it repeats. A moved occurrence (RECURRENCE-ID) shares its series'
 *   UID, so its import key is `<UID>#<RECURRENCE-ID>`; an event without a
 *   UID gets a stable key from its start, summary and location.
 *
 * Idempotence: the key of every imported event is appended to the setting
 * `import.icsUids`. The preview marks those as already imported and apply
 * skips them, so re-importing the same file creates nothing. An event that
 * Casefile itself exported (casefile-encounter-<id>@casefile.local) points
 * at its encounter and is suggested as skip.
 *
 * Provenance: an encounter keeps the event's DESCRIPTION in its prep notes
 * followed by one line naming the file, the import day and the UID; a daily
 * note is one "Calendar: <title> at <time>, <location>" line appended to
 * the day's notes (existing notes are never replaced).
 */
import { z } from 'zod';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, schema } from '../db';
import { badRequest, parseOrThrow } from '../util/errors';
import { normalizeKey, parseJson, sha256 } from '../util/ids';
import { getSetting, setSetting } from './settings';
import { onLockChange } from '../auth';
import { createEncounter } from './encounters';
import { getDay, latestLoggableDay, upsertDay } from './symptoms';
import { parsePartialDate, todayIso } from '../../shared/dates';
import { ENCOUNTER_KINDS } from '../../shared/enums';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const CALENDAR_KINDS = ['encounter', 'daily', 'skip'] as const;
export type CalendarKind = (typeof CALENDAR_KINDS)[number];
export type EncounterKind = (typeof ENCOUNTER_KINDS)[number];

/** One VEVENT as read from the file, with its start moved into the case's time zone. */
export interface IcsEvent {
  /** The import key: UID, `UID#RECURRENCE-ID` for a moved occurrence, or `nouid-<hash>`. */
  uid: string;
  /** UID exactly as written; null when the event had none. */
  uidAsWritten: string | null;
  /** YYYY-MM-DD in the case's time zone; null when DTSTART is missing or unreadable. */
  start: string | null;
  /** HH:MM (24 h) in the case's time zone; null for an all-day event. */
  time: string | null;
  allDay: boolean;
  /** SUMMARY, unescaped; '' when the event has none. */
  title: string;
  location: string | null;
  description: string | null;
  /** STATUS: TENTATIVE, CONFIRMED or CANCELLED. */
  status: string | null;
  /** The RRULE as written (not expanded); null for a single event. */
  recurrence: string | null;
  /** The TZID as written, 'UTC' for a …Z time, null for all-day and floating times. */
  timeZone: string | null;
  /** DTSTART in words as the file gave it ("2024-03-11 09:30 America/Chicago"). */
  asWritten: string | null;
  /** Names (CN) of the organizer and attendees. */
  attendees: string[];
  /** Things worth knowing about this event (repeats, time zone kept, unreadable start). */
  notes: string[];
}

export interface CalendarSuggestion {
  kind: CalendarKind;
  encounterKind: EncounterKind;
  clinicianId: string | null;
  clinicianName: string | null;
  institutionId: string | null;
  institutionName: string | null;
  /** How each match was found: which field, and the share of the name's words that matched. */
  matchNote: string | null;
  /** An encounter already on file for this event (same day and clinician or title, or Casefile's own export). */
  existingEncounterId: string | null;
  existingEncounterTitle: string | null;
  /** Why this kind was suggested, in one line. */
  reason: string;
}

export interface CalendarPreviewItem extends IcsEvent {
  startPrecision: 'day' | 'unknown';
  alreadyImported: boolean;
  suggested: CalendarSuggestion;
}

export interface CalendarPreview {
  filename: string | null;
  /** The time zone timed events were moved into. */
  timeZone: string;
  items: CalendarPreviewItem[];
  counts: { events: number; encounter: number; daily: number; skip: number; alreadyImported: number; repeating: number };
  /** File-level problems (unreadable lines, duplicate UIDs). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Low-level iCalendar reading
// ---------------------------------------------------------------------------

export interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** Split into content lines and unfold continuations (a line starting with one space or tab). */
export function unfoldLines(text: string): string[] {
  const src = text.replace(/^﻿/, '').replace(/\r\n|\r/g, '\n');
  const out: string[] = [];
  for (const line of src.split('\n')) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out.filter((l) => l.trim().length > 0);
}

/** One content line: NAME;PARAM=value;PARAM="quoted:value":VALUE. Null when it is not one. */
export function parseContentLine(line: string): IcsProperty | null {
  const m = /^[A-Za-z0-9-]+/.exec(line);
  if (!m) return null;
  const name = m[0].toUpperCase();
  let i = name.length;
  const params: Record<string, string> = {};
  while (line[i] === ';') {
    i++;
    const eq = line.indexOf('=', i);
    if (eq < 0) return null;
    const pname = line.slice(i, eq).trim().toUpperCase();
    i = eq + 1;
    let val = '';
    for (;;) {
      if (line[i] === '"') {
        const end = line.indexOf('"', i + 1);
        if (end < 0) return null;
        val += line.slice(i + 1, end);
        i = end + 1;
      } else {
        let j = i;
        while (j < line.length && line[j] !== ';' && line[j] !== ':' && line[j] !== ',') j++;
        val += line.slice(i, j);
        i = j;
      }
      if (line[i] === ',') {
        val += ',';
        i++;
        continue;
      }
      break;
    }
    params[pname] = val;
  }
  if (line[i] !== ':') return null;
  return { name, params, value: line.slice(i + 1) };
}

/** Unescape a TEXT value: \\ \; \, and \n (or \N) for a line break. */
export function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

/** The Windows zone names Outlook and Exchange write as TZID, mapped to IANA. */
const WINDOWS_ZONES: Record<string, string> = {
  'eastern standard time': 'America/New_York',
  'us eastern standard time': 'America/Indiana/Indianapolis',
  'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver',
  'us mountain standard time': 'America/Phoenix',
  'pacific standard time': 'America/Los_Angeles',
  'alaskan standard time': 'America/Anchorage',
  'hawaiian standard time': 'Pacific/Honolulu',
  'atlantic standard time': 'America/Halifax',
  'newfoundland standard time': 'America/St_Johns',
  'canada central standard time': 'America/Regina',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'w europe standard time': 'Europe/Berlin',
  'romance standard time': 'Europe/Paris',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'e europe standard time': 'Europe/Chisinau',
  'fle standard time': 'Europe/Kiev',
  'gtb standard time': 'Europe/Bucharest',
  'israel standard time': 'Asia/Jerusalem',
  'india standard time': 'Asia/Kolkata',
  'china standard time': 'Asia/Shanghai',
  'tokyo standard time': 'Asia/Tokyo',
  'aus eastern standard time': 'Australia/Sydney',
  'e australia standard time': 'Australia/Brisbane',
  'new zealand standard time': 'Pacific/Auckland',
  utc: 'UTC',
  'coordinated universal time': 'UTC',
};

const zoneOk = new Map<string, boolean>();

export function isKnownTimeZone(tz: string): boolean {
  if (!tz) return false;
  const hit = zoneOk.get(tz);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    ok = true;
  } catch {
    ok = false;
  }
  zoneOk.set(tz, ok);
  return ok;
}

/** The case's time zone: the PC's. */
export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** An IANA zone for a TZID as calendars write it, or null when it cannot be resolved. */
export function resolveTimeZone(tzid: string): string | null {
  const t = tzid.trim().replace(/^"|"$/g, '');
  if (!t) return null;
  if (isKnownTimeZone(t)) return t;
  const win = WINDOWS_ZONES[normalizeKey(t)];
  if (win) return win;
  // "/mozilla.org/20050126_1/America/New_York", "/softwarestudio.org/Olson_20011030_5/America/Chicago"
  const tail = /([A-Za-z_]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)$/.exec(t);
  if (tail && isKnownTimeZone(tail[1])) return tail[1];
  return null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(tz, f);
  }
  return f;
}

interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function wallAt(instant: number, tz: string): Wall {
  const parts = formatterFor(tz).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute'), s: get('second') };
}

/** The UTC instant at which a wall-clock time occurs in `tz` (the earlier one across a DST overlap). */
export function zonedToUtc(w: Wall, tz: string): number {
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  let t = asUtc;
  for (let k = 0; k < 4; k++) {
    const seen = wallAt(t, tz);
    const offset = Date.UTC(seen.y, seen.mo - 1, seen.d, seen.h, seen.mi, seen.s) - t;
    const next = asUtc - offset;
    if (next === t) break;
    t = next;
  }
  return t;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function dayOf(w: Wall): string {
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}`;
}

function timeOf(w: Wall): string {
  return `${pad(w.h)}:${pad(w.mi)}`;
}

interface ReadStart {
  date: string;
  time: string | null;
  allDay: boolean;
  timeZone: string | null;
  asWritten: string;
  note: string | null;
}

/** Read a DTSTART (or RECURRENCE-ID) property; null when the value is not a date. */
export function readDateProperty(p: IcsProperty, targetZone: string): ReadStart | null {
  const v = p.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i.exec(v);
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const check = parsePartialDate(date);
  if (check.precision !== 'day' || check.iso !== date) return null;
  const valueType = (p.params.VALUE ?? '').toUpperCase();
  if (valueType === 'DATE' || m[4] === undefined) return { date, time: null, allDay: true, timeZone: null, asWritten: date, note: null };
  const wall: Wall = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] ?? 0) };
  if (wall.h > 23 || wall.mi > 59 || wall.s > 60) return null;
  const hhmm = `${m[4]}:${m[5]}`;
  if (m[7]) {
    const local = wallAt(Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s), targetZone);
    return { date: dayOf(local), time: timeOf(local), allDay: false, timeZone: 'UTC', asWritten: `${date} ${hhmm} UTC`, note: null };
  }
  const tzid = p.params.TZID?.trim();
  if (tzid) {
    const zone = resolveTimeZone(tzid);
    if (!zone) return { date, time: hhmm, allDay: false, timeZone: tzid, asWritten: `${date} ${hhmm} ${tzid}`, note: `time zone "${tzid}" is not known here; ${hhmm} is kept as written` };
    const local = zone === targetZone ? wall : wallAt(zonedToUtc(wall, zone), targetZone);
    return { date: dayOf(local), time: timeOf(local), allDay: false, timeZone: tzid, asWritten: `${date} ${hhmm} ${tzid}`, note: null };
  }
  return { date, time: hhmm, allDay: false, timeZone: null, asWritten: `${date} ${hhmm}`, note: null };
}

// ---------------------------------------------------------------------------
// Whole file
// ---------------------------------------------------------------------------

export interface ParsedCalendar {
  events: IcsEvent[];
  warnings: string[];
  timeZone: string;
}

function cnOf(p: IcsProperty): string | null {
  const cn = p.params.CN ? unescapeText(p.params.CN).trim() : '';
  if (cn && !/^mailto:/i.test(cn) && !/@/.test(cn)) return cn;
  return null;
}

/**
 * Read every VEVENT of an iCalendar text. Properties of nested components
 * (VALARM) are ignored; VTIMEZONE blocks are not needed because TZIDs are
 * resolved by name. A file without BEGIN:VCALENDAR or VEVENT is a 400.
 */
export function parseIcs(text: string, opts: { timeZone?: string | null } = {}): ParsedCalendar {
  const targetZone = opts.timeZone && isKnownTimeZone(opts.timeZone) ? opts.timeZone : systemTimeZone();
  const lines = unfoldLines(text ?? '');
  if (!lines.some((l) => /^BEGIN:VCALENDAR\s*$/i.test(l))) throw badRequest('this is not an iCalendar file (no BEGIN:VCALENDAR); export the calendar as .ics');
  const warnings: string[] = [];
  const raw: IcsProperty[][] = [];
  const stack: string[] = [];
  let current: IcsProperty[] | null = null;
  let unreadable = 0;
  for (const line of lines) {
    const p = parseContentLine(line);
    if (!p) {
      unreadable++;
      continue;
    }
    if (p.name === 'BEGIN') {
      const comp = p.value.trim().toUpperCase();
      stack.push(comp);
      if (comp === 'VEVENT' && !current) current = [];
      continue;
    }
    if (p.name === 'END') {
      const comp = p.value.trim().toUpperCase();
      const at = stack.lastIndexOf(comp);
      if (at >= 0) stack.length = at;
      if (comp === 'VEVENT' && current && !stack.includes('VEVENT')) {
        raw.push(current);
        current = null;
      }
      continue;
    }
    if (current && stack[stack.length - 1] === 'VEVENT') current.push(p);
  }
  if (current) {
    raw.push(current);
    warnings.push('the file ends inside an event (END:VEVENT missing); that event was read as far as it goes');
  }
  if (unreadable) warnings.push(`${unreadable} line${unreadable === 1 ? '' : 's'} could not be read and ${unreadable === 1 ? 'was' : 'were'} ignored`);
  if (!raw.length) throw badRequest('the calendar file has no events (VEVENT)');

  const events: IcsEvent[] = [];
  const seen = new Set<string>();
  for (const props of raw) {
    const get = (name: string) => props.find((p) => p.name === name);
    const text = (name: string): string | null => {
      const p = get(name);
      if (!p) return null;
      const v = unescapeText(p.value).trim();
      return v || null;
    };
    const notes: string[] = [];
    const title = text('SUMMARY') ?? '';
    const location = text('LOCATION');
    const description = text('DESCRIPTION');
    const status = get('STATUS')?.value.trim().toUpperCase() || null;
    const rrule = get('RRULE')?.value.trim() || null;
    const rdate = get('RDATE')?.value.trim() || null;
    const recurrence = rrule ?? (rdate ? `RDATE:${rdate}` : null);
    if (recurrence) notes.push('repeats in the calendar; only this first occurrence is offered (the series is not expanded)');

    const dtstartProp = get('DTSTART');
    let start: ReadStart | null = null;
    if (!dtstartProp) notes.push('no start date (DTSTART) in the file');
    else {
      start = readDateProperty(dtstartProp, targetZone);
      if (!start) notes.push(`the start "${dtstartProp.value.trim()}" could not be read`);
      else if (start.note) notes.push(start.note);
    }

    const uidAsWritten = get('UID')?.value.trim() || null;
    const recurrenceIdRaw = get('RECURRENCE-ID')?.value.trim() || null;
    if (recurrenceIdRaw) notes.push('a moved or changed occurrence of a repeating event');
    const uid = uidAsWritten
      ? recurrenceIdRaw
        ? `${uidAsWritten}#${recurrenceIdRaw}`
        : uidAsWritten
      : `nouid-${sha256(`${dtstartProp?.value.trim() ?? ''}|${title}|${location ?? ''}`).slice(0, 24)}`;
    if (!uidAsWritten) notes.push('no UID in the file; a key was made from its start, title and location');
    if (seen.has(uid)) {
      warnings.push(`the event "${title || uid}" appears twice with the same UID; only the first is offered`);
      continue;
    }
    seen.add(uid);

    const attendees: string[] = [];
    for (const p of props) {
      if (p.name !== 'ORGANIZER' && p.name !== 'ATTENDEE') continue;
      const cn = cnOf(p);
      if (cn && !attendees.includes(cn)) attendees.push(cn);
    }

    events.push({
      uid,
      uidAsWritten,
      start: start?.date ?? null,
      time: start?.time ?? null,
      allDay: start?.allDay ?? false,
      title,
      location,
      description,
      status,
      recurrence,
      timeZone: start?.timeZone ?? null,
      asWritten: start?.asWritten ?? null,
      attendees,
      notes,
    });
  }
  return { events, warnings, timeZone: targetZone };
}

// ---------------------------------------------------------------------------
// Matching names against the people on file
// ---------------------------------------------------------------------------

/** Honorifics and degrees: never part of what identifies a person. */
export const PERSON_TITLES = new Set(['dr', 'doctor', 'md', 'do', 'phd', 'np', 'pa', 'pac', 'rn', 'aprn', 'dnp', 'fnp', 'mbbs', 'frcp', 'facp', 'faan', 'mph', 'msc', 'mr', 'mrs', 'ms', 'miss', 'mx', 'prof', 'professor', 'jr', 'sr', 'ii', 'iii']);
/** Words every institution shares; they do not tell one from another. */
const ORG_GENERIC = new Set([
  'hospital', 'hospitals', 'clinic', 'clinics', 'center', 'centre', 'centers', 'medical', 'medicine', 'health', 'healthcare', 'care', 'associates', 'group', 'practice',
  'department', 'dept', 'services', 'service', 'system', 'systems', 'office', 'offices', 'inc', 'llc', 'pc', 'pllc', 'pa', 'institute', 'university', 'univ', 'school',
  'neurology', 'neurological', 'neuroscience', 'neurosciences', 'neurosurgery', 'rheumatology', 'immunology', 'cardiology', 'radiology', 'imaging', 'laboratory', 'laboratories',
  'lab', 'labs', 'infusion', 'urgent', 'primary', 'family', 'internal', 'specialty', 'specialists', 'physicians', 'partners', 'regional', 'general', 'community', 'memorial',
]);
const STOP = new Set(['the', 'of', 'and', 'at', 'for', 'in', 'on', 'a', 'an', 'to', 'with', 'by']);

export type MatchKind = 'person' | 'org';

export interface NameVariant {
  tokens: string[];
  /** Every word must match (an institution named only with generic words). */
  strict: boolean;
}

export interface MatchCandidate {
  id: string;
  name: string;
  kind: string;
  institutionId: string | null;
  variants: NameVariant[];
}

export function isOrgKind(kind: string): boolean {
  return kind === 'institution' || kind === 'clinic';
}

export function nameVariant(name: string, as: MatchKind): NameVariant {
  const words = normalizeKey(name)
    .split(' ')
    .filter((t) => t && !STOP.has(t));
  if (as === 'person') return { tokens: words.filter((t) => !PERSON_TITLES.has(t) && t.length > 1), strict: false };
  const distinctive = words.filter((t) => !ORG_GENERIC.has(t));
  return distinctive.length ? { tokens: distinctive, strict: false } : { tokens: words, strict: true };
}

export function tokenSet(text: string | null | undefined): Set<string> {
  return new Set(normalizeKey(text).split(' ').filter(Boolean));
}

/**
 * Share of a name's words found in the text (0 when below 0.5). One word out
 * of several counts only when it is a person's last word (a surname; "Jane"
 * alone does not name Jane Smith) or, for an institution, when it is one of
 * its distinctive words (generic ones such as "hospital" are not counted).
 */
export function overlapScore(v: NameVariant, text: Set<string>, as: MatchKind): { score: number; hits: number } {
  if (!v.tokens.length) return { score: 0, hits: 0 };
  const hits = v.tokens.filter((t) => text.has(t)).length;
  const score = hits / v.tokens.length;
  if (score < 0.5 || (v.strict && score < 1)) return { score: 0, hits };
  if (as === 'person' && hits === 1 && v.tokens.length > 1 && !text.has(v.tokens[v.tokens.length - 1])) return { score: 0, hits };
  return { score, hits };
}

export interface NameMatch {
  id: string;
  name: string;
  kind: string;
  institutionId: string | null;
  score: number;
  hits: number;
}

export interface MatchOutcome {
  match: NameMatch | null;
  /** Names of the people who tied for the best match; the match is then left empty rather than guessed. */
  ambiguous: string[];
}

/** The best-scoring candidate for a text; a tie between two different people is no match. */
export function bestMatch(text: string | null | undefined, candidates: MatchCandidate[]): MatchOutcome {
  const set = tokenSet(text);
  if (!set.size) return { match: null, ambiguous: [] };
  const scored: NameMatch[] = [];
  for (const c of candidates) {
    const as: MatchKind = isOrgKind(c.kind) ? 'org' : 'person';
    let best: { score: number; hits: number } = { score: 0, hits: 0 };
    for (const v of c.variants) {
      const s = overlapScore(v, set, as);
      if (s.score > best.score || (s.score === best.score && s.hits > best.hits)) best = s;
    }
    if (best.score > 0) scored.push({ id: c.id, name: c.name, kind: c.kind, institutionId: c.institutionId, score: best.score, hits: best.hits });
  }
  if (!scored.length) return { match: null, ambiguous: [] };
  scored.sort((a, b) => b.score - a.score || b.hits - a.hits || a.name.localeCompare(b.name));
  const top = scored[0];
  const tied = scored.filter((s) => s.score === top.score && s.hits === top.hits);
  if (tied.length > 1) return { match: null, ambiguous: tied.map((t) => t.name) };
  return { match: top, ambiguous: [] };
}

/** Live people as match candidates (name and aliases), optionally limited to some kinds. */
export function loadCandidates(kinds?: readonly string[]): MatchCandidate[] {
  const p = schema.people;
  const rows = db()
    .select({ id: p.id, name: p.name, kind: p.kind, institutionId: p.institutionId, aliasesJson: p.aliasesJson })
    .from(p)
    .where(kinds?.length ? and(isNull(p.deletedAt), inArray(p.kind, [...kinds])) : isNull(p.deletedAt))
    .all();
  return rows.map((r) => {
    const as: MatchKind = isOrgKind(r.kind) ? 'org' : 'person';
    const aliases = parseJson<unknown>(r.aliasesJson, []);
    const names = [r.name, ...(Array.isArray(aliases) ? aliases.filter((a): a is string => typeof a === 'string') : [])];
    return { id: r.id, name: r.name, kind: r.kind, institutionId: r.institutionId, variants: names.map((n) => nameVariant(n, as)).filter((v) => v.tokens.length) };
  });
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

/** Words that make an event a clinical appointment. Matched as whole words of the normalised text. */
const MEDICAL_WORDS = new Set([
  'dr', 'doctor', 'md', 'clinic', 'hospital', 'medical', 'physician', 'nurse', 'np', 'pcp', 'specialist', 'consult', 'consultation', 'followup', 'checkup', 'telehealth',
  'televisit', 'telemedicine', 'infusion', 'ivig', 'scig', 'plex', 'plasmapheresis', 'rituximab', 'ocrevus', 'tysabri', 'steroids', 'mri', 'ct', 'eeg',
  'emg', 'ncs', 'ekg', 'ecg', 'ultrasound', 'xray', 'scan', 'imaging', 'radiology', 'lab', 'labs', 'bloodwork', 'biopsy', 'surgery', 'procedure', 'lp', 'therapy',
  'physio', 'physiotherapy', 'vaccine', 'vaccination', 'injection', 'pharmacy', 'prescription', 'refill', 'er', 'emergency', 'admission', 'admitted', 'inpatient',
  'discharge', 'hospitalization', 'neurologist', 'rheumatologist', 'immunologist', 'neuro', 'mychart',
]);
const MEDICAL_PREFIX = /^(neurolog|neuroimmun|neuro-|rheumat|immunolog|cardiolog|endocrin|gastroent|dermatolog|psychiat|ophthalm|oncolog|hematolog|haematolog|nephrolog|urolog|pulmon|allergist|otolaryng|neuropsych|neurosurg|neuro-ophth)/;
const MEDICAL_PHRASES = ['pet scan', 'pet ct', 'pet mri', 'follow up', 'blood draw', 'blood work', 'blood test', 'lumbar puncture', 'spinal tap', 'x ray', 'video visit', 'urgent care', 'physical therapy', 'occupational therapy', 'speech therapy', 'sleep study', 'nerve conduction', 'check up', 'pre op', 'post op'];
/** "Appointment" alone could be a haircut. */
const WEAK_WORDS = new Set(['appointment', 'appt', 'appts', 'appointments', 'visit']);
/** Words of a symptom diary: a note on the day rather than a visit. */
const SYMPTOM_WORDS = new Set([
  'flare', 'flareup', 'relapse', 'migraine', 'headache', 'pain', 'fatigue', 'fever', 'seizure', 'seizures', 'symptom', 'symptoms', 'sick', 'ill', 'crash', 'nausea', 'vomiting',
  'rash', 'vertigo', 'dizzy', 'dizziness', 'insomnia', 'tremor', 'tremors', 'weakness', 'numbness', 'tingling', 'spasm', 'spasms', 'episode', 'attack', 'fainted', 'syncope',
  'brainfog', 'fog', 'cramps', 'cramping', 'malaise', 'reaction', 'hives',
]);
const SYMPTOM_PHRASES = ['brain fog', 'bad day', 'rest day', 'sick day', 'flare up', 'side effect', 'side effects'];

function hasPhrase(norm: string, phrases: string[]): boolean {
  const padded = ` ${norm} `;
  return phrases.some((p) => padded.includes(` ${p} `));
}

/**
 * How strongly the title (and location) say "clinical appointment". In a
 * location only words of four letters or more count, so a state in an
 * address ("Baltimore, MD", "Hartford, CT", "Erie, PA") is not read as one.
 */
export function medicalSignal(title: string, location: string | null = null): 'strong' | 'weak' | null {
  const t = normalizeKey(title);
  const l = normalizeKey(location);
  const tw = t ? t.split(' ') : [];
  const lw = l ? l.split(' ').filter((w) => w.length >= 4) : [];
  const strong = (w: string) => MEDICAL_WORDS.has(w) || MEDICAL_PREFIX.test(w);
  if (tw.some(strong) || lw.some(strong) || hasPhrase(t, MEDICAL_PHRASES) || hasPhrase(l, MEDICAL_PHRASES)) return 'strong';
  if (tw.some((w) => WEAK_WORDS.has(w)) || lw.some((w) => WEAK_WORDS.has(w))) return 'weak';
  return null;
}

export function symptomSignal(text: string): boolean {
  const norm = normalizeKey(text);
  if (!norm) return false;
  return norm.split(' ').some((w) => SYMPTOM_WORDS.has(w)) || hasPhrase(norm, SYMPTOM_PHRASES);
}

/** The encounter kind the words suggest; visit when nothing more specific is said. */
export function encounterKindFor(title: string, location: string | null, description: string | null): EncounterKind {
  const head = normalizeKey(`${title} ${location ?? ''}`);
  const all = `${head} ${normalizeKey(description)}`;
  const has = (norm: string, words: string[], phrases: string[] = []) => {
    const set = new Set(norm.split(' '));
    return words.some((w) => set.has(w)) || hasPhrase(norm, phrases);
  };
  if (has(head, ['admission', 'admitted', 'inpatient', 'hospitalization', 'hospitalisation'], ['hospital stay'])) return 'admission';
  if (has(head, ['infusion', 'ivig', 'scig', 'plex', 'plasmapheresis', 'rituximab', 'ocrevus', 'tysabri', 'cytoxan'], ['iv steroids'])) return 'infusion';
  if (has(head, ['lp', 'biopsy', 'surgery', 'procedure', 'endoscopy', 'colonoscopy'], ['lumbar puncture', 'spinal tap', 'nerve block'])) return 'procedure';
  if (has(head, ['mri', 'ct', 'scan', 'imaging', 'eeg', 'emg', 'ncs', 'ekg', 'ecg', 'echo', 'ultrasound', 'xray', 'lab', 'labs', 'bloodwork', 'test', 'testing', 'radiology'], ['pet scan', 'pet ct', 'pet mri', 'x ray', 'blood draw', 'blood work', 'blood test', 'sleep study', 'nerve conduction'])) return 'test';
  if (has(all, ['telehealth', 'televisit', 'telemedicine', 'virtual', 'zoom', 'doxy', 'webex'], ['video visit', 'video call', 'teams meeting', 'microsoft teams', 'phone visit'])) return 'telehealth';
  return 'visit';
}

interface EncounterLite {
  id: string;
  title: string;
  occurredAt: string | null;
  clinicianId: string | null;
  status: string;
}

function titleOverlap(a: string, b: string): number {
  const ta = [...tokenSet(a)].filter((t) => !STOP.has(t) && !PERSON_TITLES.has(t));
  const tb = tokenSet(b);
  const usable = ta.length && tb.size ? Math.min(ta.length, [...tb].filter((t) => !STOP.has(t) && !PERSON_TITLES.has(t)).length) : 0;
  if (!usable) return 0;
  return ta.filter((t) => tb.has(t)).length / usable;
}

export interface SuggestContext {
  clinicians: MatchCandidate[];
  institutions: MatchCandidate[];
  /** Live encounters keyed by their day. */
  encountersByDay: Map<string, EncounterLite[]>;
  encountersById: Map<string, EncounterLite>;
  importedUids: Set<string>;
  /** The latest day the daily log accepts. */
  latestDay: string;
  /** Name of a person or institution by id (for a clinician's institution). */
  nameOf: (id: string) => string | null;
}

/** Look up a match in the summary, each attendee and the location; the best one wins and says where it was found. */
function matchAcross(ev: IcsEvent, candidates: MatchCandidate[]): { match: NameMatch | null; via: string | null; ambiguous: string[] } {
  const sources: Array<[string, string | null]> = [['title', ev.title], ...ev.attendees.map((a): [string, string] => ['attendee', a]), ['location', ev.location]];
  let best: { match: NameMatch; via: string } | null = null;
  let ambiguous: string[] = [];
  for (const [via, text] of sources) {
    const r = bestMatch(text, candidates);
    if (r.match) {
      if (!best || r.match.score > best.match.score || (r.match.score === best.match.score && r.match.hits > best.match.hits)) best = { match: r.match, via };
    } else if (r.ambiguous.length && !ambiguous.length) ambiguous = r.ambiguous;
  }
  return { match: best?.match ?? null, via: best?.via ?? null, ambiguous: best ? [] : ambiguous };
}

const OWN_ENCOUNTER_UID = /^casefile-encounter-(.+)@casefile\.local$/;
const OWN_TASK_UID = /^casefile-task-(.+)@casefile\.local$/;

export function suggestFor(ev: IcsEvent, ctx: SuggestContext): CalendarSuggestion {
  const clin = matchAcross(ev, ctx.clinicians);
  const inst = matchAcross(ev, ctx.institutions);
  const notes: string[] = [];
  if (clin.match) notes.push(`clinician from the ${clin.via} (${Math.round(clin.match.score * 100)}% of the name)`);
  else if (clin.ambiguous.length) notes.push(`clinician unclear: ${clin.ambiguous.join(' or ')}`);
  let institutionId = inst.match?.id ?? null;
  let institutionName = inst.match?.name ?? null;
  if (inst.match) notes.push(`institution from the ${inst.via} (${Math.round(inst.match.score * 100)}% of the name)`);
  else if (inst.ambiguous.length) notes.push(`institution unclear: ${inst.ambiguous.join(' or ')}`);
  if (!institutionId && clin.match?.institutionId) {
    institutionId = clin.match.institutionId;
    institutionName = ctx.nameOf(institutionId);
    if (institutionName) notes.push("institution is the clinician's");
    else institutionId = null;
  }
  const encounterKind = encounterKindFor(ev.title, ev.location, ev.description);
  const base = {
    encounterKind,
    clinicianId: clin.match?.id ?? null,
    clinicianName: clin.match?.name ?? null,
    institutionId,
    institutionName,
    matchNote: notes.length ? notes.join('; ') : null,
    existingEncounterId: null as string | null,
    existingEncounterTitle: null as string | null,
  };
  const skip = (reason: string) => ({ ...base, kind: 'skip' as const, reason });

  if (ctx.importedUids.has(ev.uid)) return skip('already imported from a calendar file');
  const own = OWN_ENCOUNTER_UID.exec(ev.uidAsWritten ?? '');
  if (own) {
    const e = ctx.encountersById.get(own[1]);
    if (e) return { ...skip('exported from Casefile; this encounter is already on file'), existingEncounterId: e.id, existingEncounterTitle: e.title };
    return skip('exported from Casefile (its encounter has since been removed)');
  }
  if (OWN_TASK_UID.test(ev.uidAsWritten ?? '')) return skip('a Casefile task exported to the calendar');
  if (ev.status === 'CANCELLED') return skip('cancelled in the calendar');
  if (!ev.start) return skip('no readable start date');

  const sameDay = ctx.encountersByDay.get(ev.start) ?? [];
  const existing = sameDay.find((e) => (base.clinicianId && e.clinicianId === base.clinicianId) || titleOverlap(e.title, ev.title) >= 0.5);
  if (existing) return { ...skip('an encounter on the same day already matches it'), existingEncounterId: existing.id, existingEncounterTitle: existing.title };

  const words = `${ev.title} ${ev.location ?? ''}`;
  const medical = medicalSignal(ev.title, ev.location);
  if (base.clinicianId || base.institutionId) return { ...base, kind: 'encounter', reason: base.clinicianId ? `names ${base.clinicianName}` : `at ${base.institutionName}` };
  if (medical === 'strong') return { ...base, kind: 'encounter', reason: 'clinical words in the title or location' };
  if (symptomSignal(words)) {
    if (ev.start > ctx.latestDay) return skip('reads like a symptom note, but the daily log only takes days that happened');
    return { ...base, kind: 'daily', reason: 'reads like a symptom or diary note' };
  }
  if (medical === 'weak') return skip('an appointment, but no clinician, institution or clinical word was found');
  return skip('no clinician, institution or clinical word was found');
}

function buildContext(events: IcsEvent[]): SuggestContext {
  const d = db();
  const clinicians = loadCandidates(['clinician']);
  const institutions = loadCandidates(['institution', 'clinic']);
  const days = [...new Set(events.map((e) => e.start).filter((s): s is string => Boolean(s)))];
  const e = schema.encounters;
  const ownIds = events.map((ev) => OWN_ENCOUNTER_UID.exec(ev.uidAsWritten ?? '')?.[1]).filter((x): x is string => Boolean(x));
  const rows: EncounterLite[] = [];
  const cols = { id: e.id, title: e.title, occurredAt: e.occurredAt, clinicianId: e.clinicianId, status: e.status };
  // Chunked: SQLite caps bound parameters.
  for (let i = 0; i < days.length; i += 400) rows.push(...d.select(cols).from(e).where(and(isNull(e.deletedAt), inArray(e.occurredAt, days.slice(i, i + 400)))).all());
  for (let i = 0; i < ownIds.length; i += 400) rows.push(...d.select(cols).from(e).where(and(isNull(e.deletedAt), inArray(e.id, ownIds.slice(i, i + 400)))).all());
  const encountersByDay = new Map<string, EncounterLite[]>();
  const encountersById = new Map<string, EncounterLite>();
  for (const r of rows) {
    encountersById.set(r.id, r);
    if (!r.occurredAt || r.status === 'cancelled') continue;
    const list = encountersByDay.get(r.occurredAt) ?? [];
    if (!list.some((x) => x.id === r.id)) list.push(r);
    encountersByDay.set(r.occurredAt, list);
  }
  const names = new Map<string, string>();
  for (const c of [...clinicians, ...institutions]) names.set(c.id, c.name);
  const nameOf = (id: string): string | null => {
    if (names.has(id)) return names.get(id)!;
    const row = d.select({ name: schema.people.name }).from(schema.people).where(and(eq(schema.people.id, id), isNull(schema.people.deletedAt))).get();
    return row?.name ?? null;
  };
  return { clinicians, institutions, encountersByDay, encountersById, importedUids: new Set(importedUids()), latestDay: latestLoggableDay(), nameOf };
}

// ---------------------------------------------------------------------------
// Preview cache: lets apply work from the UIDs alone (the contract's body)
// ---------------------------------------------------------------------------

interface CachedEvent {
  event: IcsEvent;
  suggested: CalendarSuggestion;
  filename: string | null;
  at: number;
}

const CACHE_MAX = 20_000;
const CACHE_TTL_MS = 12 * 60 * 60_000;
const previewCache = new Map<string, CachedEvent>();

/** Forget every previewed event (called when the case locks: event text is case data). */
export function clearCalendarPreviewCache(): void {
  previewCache.clear();
}
onLockChange((unlocked) => {
  if (!unlocked) clearCalendarPreviewCache();
});

function remember(item: CalendarPreviewItem, filename: string | null): void {
  previewCache.delete(item.uid);
  previewCache.set(item.uid, { event: item, suggested: item.suggested, filename, at: Date.now() });
  while (previewCache.size > CACHE_MAX) {
    const oldest = previewCache.keys().next().value;
    if (oldest === undefined) break;
    previewCache.delete(oldest);
  }
}

function recall(uid: string): CachedEvent | null {
  const hit = previewCache.get(uid);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    previewCache.delete(uid);
    return null;
  }
  return hit;
}

// ---------------------------------------------------------------------------
// Preview and apply
// ---------------------------------------------------------------------------

export function importedUids(): string[] {
  const v = getSetting('import.icsUids');
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Read a calendar file and say what each event would become. Writes nothing. */
export function previewCalendar(text: string, opts: { filename?: string | null; timeZone?: string | null } = {}): CalendarPreview {
  const parsed = parseIcs(text, { timeZone: opts.timeZone });
  const ctx = buildContext(parsed.events);
  const filename = opts.filename?.trim() || null;
  const items: CalendarPreviewItem[] = parsed.events.map((ev) => ({
    ...ev,
    startPrecision: ev.start ? 'day' : 'unknown',
    alreadyImported: ctx.importedUids.has(ev.uid),
    suggested: suggestFor(ev, ctx),
  }));
  items.sort((a, b) => (a.start ?? '9999').localeCompare(b.start ?? '9999') || (a.time ?? '').localeCompare(b.time ?? '') || a.title.localeCompare(b.title));
  for (const it of items) remember(it, filename);
  const counts = { events: items.length, encounter: 0, daily: 0, skip: 0, alreadyImported: 0, repeating: 0 };
  for (const it of items) {
    counts[it.suggested.kind]++;
    if (it.alreadyImported) counts.alreadyImported++;
    if (it.recurrence) counts.repeating++;
  }
  return { filename, timeZone: parsed.timeZone, items, counts, warnings: parsed.warnings };
}

const optId = z.string().trim().max(64).nullish();

export const calendarApplyItem = z.object({
  uid: z.string().trim().min(1).max(1000),
  kind: z.enum(CALENDAR_KINDS),
  /** Omitted: the preview's suggestion. null: none. */
  clinicianId: optId,
  institutionId: optId,
  /** The encounter title or daily note text; omitted: the event's SUMMARY. */
  title: z.string().trim().max(500).nullish(),
  encounterKind: z.enum(ENCOUNTER_KINDS).nullish(),
  /** The event's STATUS as previewed (TENTATIVE, CONFIRMED, CANCELLED); omitted: the server's copy. */
  eventStatus: z.string().trim().max(40).nullish(),
  // The previewed event, echoed back by the client. When absent, the server's
  // copy from the latest preview of this UID is used.
  start: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'start must be YYYY-MM-DD')
    .nullish(),
  time: z
    .string()
    .trim()
    .regex(/^\d{2}:\d{2}$/, 'time must be HH:MM')
    .nullish(),
  summary: z.string().max(2000).nullish(),
  location: z.string().max(500).nullish(),
  description: z.string().max(100_000).nullish(),
});

export const calendarApplyInput = z.object({
  filename: z.string().trim().max(300).nullish(),
  items: z.array(calendarApplyItem).min(1, 'items is empty').max(5000),
});
export type CalendarApplyInput = z.input<typeof calendarApplyInput>;

export interface CalendarApplyResult {
  /** Encounters and daily notes created. */
  imported: number;
  encounters: number;
  daily: number;
  created: Array<{ uid: string; kind: 'encounter' | 'daily'; id: string; date: string | null; title: string }>;
  /** Every item not written, with the reason (left out, already imported, a refused value). */
  skipped: Array<{ uid: string; title: string; reason: string }>;
}

/** HH:MM now, local. */
function nowHhmm(now = new Date()): string {
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** Upcoming when the event is still ahead (today counts until its time has passed). */
export function statusFor(start: string | null, time: string | null, today = todayIso(), now = nowHhmm()): 'upcoming' | 'completed' {
  if (!start || start > today) return 'upcoming';
  if (start < today) return 'completed';
  return !time || time > now ? 'upcoming' : 'completed';
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Prep notes for an imported encounter: the event's description, then where it came from. */
export function provenanceNotes(description: string | null, filename: string | null, uid: string, today = todayIso(), eventStatus: string | null = null): string {
  const st = eventStatus?.trim() ? `, calendar status ${eventStatus.trim().toUpperCase()}` : '';
  const line = `Imported from the calendar file ${filename ?? '(unnamed)'} on ${today} (UID ${clip(uid, 300)}${st}).`;
  const desc = description?.trim() ? clip(description.trim(), 19_000) : '';
  return desc ? `${desc}\n\n${line}` : line;
}

/** The line a daily-log note gets for an event. */
export function dailyNoteLine(title: string, time: string | null, location: string | null, filename: string | null = null): string {
  return `Calendar${filename ? ` (${filename})` : ''}: ${title}${time ? ` at ${time}` : ''}${location ? `, ${location}` : ''}`;
}

/**
 * Create what the user chose. Each item is written on its own (a refused
 * item rolls back alone and is reported); everything runs in one
 * transaction with the UID list, so a crash leaves no half-recorded import.
 * Idempotent: UIDs already imported are skipped.
 */
export function applyCalendar(raw: unknown): CalendarApplyResult {
  const input = parseOrThrow(calendarApplyInput, raw);
  const d = db();
  const done = new Set(importedUids());
  const added: string[] = [];
  const result: CalendarApplyResult = { imported: 0, encounters: 0, daily: 0, created: [], skipped: [] };
  const latestDay = latestLoggableDay();
  const today = todayIso();

  d.transaction(() => {
    for (const it of input.items) {
      const cached = recall(it.uid);
      const echoed = it.start !== undefined || it.summary !== undefined || it.time !== undefined;
      const event = echoed
        ? { start: it.start ?? null, time: it.time ?? null, title: it.summary ?? '', location: it.location ?? null, description: it.description ?? null, status: it.eventStatus ?? cached?.event.status ?? null }
        : cached
          ? { start: cached.event.start, time: cached.event.time, title: cached.event.title, location: cached.event.location, description: cached.event.description, status: cached.event.status }
          : null;
      const title = (it.title ?? event?.title ?? '').trim() || '(untitled calendar event)';
      if (it.kind === 'skip') {
        result.skipped.push({ uid: it.uid, title, reason: 'left out' });
        continue;
      }
      if (done.has(it.uid)) {
        result.skipped.push({ uid: it.uid, title, reason: 'already imported from a calendar file' });
        continue;
      }
      if (!event) {
        result.skipped.push({ uid: it.uid, title, reason: 'not in a recent preview; run the dry run on the file again' });
        continue;
      }
      const filename = input.filename ?? cached?.filename ?? null;
      try {
        d.transaction(() => {
          if (it.kind === 'encounter') {
            const clinicianId = it.clinicianId !== undefined ? it.clinicianId : (cached?.suggested.clinicianId ?? null);
            const institutionId = it.institutionId !== undefined ? it.institutionId : (cached?.suggested.institutionId ?? null);
            const enc = createEncounter({
              title: clip(title, 500),
              kind: it.encounterKind ?? cached?.suggested.encounterKind ?? encounterKindFor(event.title, event.location, event.description),
              // A cancelled appointment stays cancelled: it must never read as a visit that took place.
              status: String(event.status ?? '').toUpperCase() === 'CANCELLED' ? 'cancelled' : statusFor(event.start, event.time, today),
              occurredAt: event.start,
              timeText: event.time,
              clinicianId: clinicianId || null,
              institutionId: institutionId || null,
              location: event.location ? clip(event.location, 500) : null,
              prepNotes: provenanceNotes(event.description, filename, it.uid, today, event.status),
              questions: [],
            });
            result.created.push({ uid: it.uid, kind: 'encounter', id: enc.id, date: enc.occurredAt, title: enc.title });
            result.encounters++;
          } else {
            if (!event.start) throw badRequest('a daily-log note needs the event to have a start date');
            if (event.start > latestDay) throw badRequest(`${event.start} is in the future; the daily log only takes days that happened`);
            const line = dailyNoteLine(title, event.time, event.location, filename);
            const existing = getDay(event.start).notes ?? '';
            if (!existing.split('\n').includes(line)) {
              const notes = existing.trim() ? `${existing.trimEnd()}\n${line}` : line;
              if (notes.length > 10_000) throw badRequest(`the notes for ${event.start} would pass 10 000 characters`);
              upsertDay(event.start, { notes });
            }
            result.created.push({ uid: it.uid, kind: 'daily', id: event.start, date: event.start, title });
            result.daily++;
          }
        });
        done.add(it.uid);
        added.push(it.uid);
      } catch (err) {
        result.skipped.push({ uid: it.uid, title, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    if (added.length) {
      const all = [...importedUids(), ...added];
      setSetting('import.icsUids', all.length > 200_000 ? all.slice(all.length - 200_000) : all);
    }
  });
  result.imported = result.created.length;
  return result;
}
