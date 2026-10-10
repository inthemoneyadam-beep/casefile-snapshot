/**
 * iCalendar (RFC 5545) writer for tasks and encounters. Pure text: nothing
 * here touches the database. Every line ends in CRLF, long lines are folded
 * at 75 octets, text values are escaped, all-day events use VALUE=DATE with
 * an exclusive DTEND the day after, and timed events are floating local
 * times (the user's calendar is on the same PC as the case file).
 */

export interface IcsAlarm {
  /** Absolute moment, converted to UTC in the output. */
  at: Date;
  description: string;
}

export interface IcsEvent {
  uid: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM local. When set the event is timed instead of all-day. */
  time?: string | null;
  /** Length of a timed event; default 60. */
  durationMinutes?: number | null;
  summary: string;
  description?: string | null;
  location?: string | null;
  status?: 'TENTATIVE' | 'CONFIRMED' | 'CANCELLED' | null;
  categories?: string[] | null;
  alarm?: IcsAlarm | null;
  url?: string | null;
}

const MAX_OCTETS = 75;

/** Escape a TEXT value: backslash, semicolon, comma, and line breaks. */
export function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

/** Fold one content line at 75 octets with CRLF + single space continuations (RFC 5545 §3.1). */
export function foldLine(line: string): string {
  const out: string[] = [];
  let cur = '';
  let curBytes = 0;
  let limit = MAX_OCTETS;
  for (const ch of line) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (curBytes + b > limit) {
      out.push(cur);
      cur = ' ';
      curBytes = 1;
      limit = MAX_OCTETS;
    }
    cur += ch;
    curBytes += b;
  }
  out.push(cur);
  return out.join('\r\n');
}

/** Compact ISO forms: 2024-03-11 -> 20240311 ; a Date -> 20240311T093000Z. */
export function icsDate(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, '');
}

export function icsUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** The day after a YYYY-MM-DD, in the same format (UTC arithmetic, no DST). */
export function nextDay(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** "10:30", "9:05", "2pm", "2:15 PM", "14h" -> { h, m }; anything else null. */
export function parseTimeText(t: string | null | undefined): { h: number; m: number } | null {
  if (!t) return null;
  const s = t.trim().toLowerCase();
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|h)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function property(name: string, value: string, params: string[] = []): string {
  return foldLine(`${name}${params.length ? `;${params.join(';')}` : ''}:${value}`);
}

function eventLines(e: IcsEvent, stamp: string): string[] {
  const lines: string[] = ['BEGIN:VEVENT', property('UID', e.uid), property('DTSTAMP', stamp)];
  const t = parseTimeText(e.time);
  if (t) {
    const start = `${icsDate(e.date)}T${pad(t.h)}${pad(t.m)}00`;
    const dur = Math.max(5, e.durationMinutes ?? 60);
    const endMinutes = t.h * 60 + t.m + dur;
    const endDay = endMinutes >= 24 * 60 ? nextDay(e.date) : e.date;
    const em = endMinutes % (24 * 60);
    lines.push(property('DTSTART', start), property('DTEND', `${icsDate(endDay)}T${pad(Math.floor(em / 60))}${pad(em % 60)}00`));
  } else {
    lines.push(property('DTSTART', icsDate(e.date), ['VALUE=DATE']), property('DTEND', icsDate(nextDay(e.date)), ['VALUE=DATE']));
  }
  lines.push(property('SUMMARY', icsEscape(e.summary)));
  if (e.description) lines.push(property('DESCRIPTION', icsEscape(e.description)));
  if (e.location) lines.push(property('LOCATION', icsEscape(e.location)));
  if (e.status) lines.push(property('STATUS', e.status));
  if (e.categories?.length) lines.push(property('CATEGORIES', e.categories.map(icsEscape).join(',')));
  if (e.url) lines.push(property('URL', e.url));
  if (e.alarm) {
    lines.push('BEGIN:VALARM', property('ACTION', 'DISPLAY'), property('DESCRIPTION', icsEscape(e.alarm.description)), property('TRIGGER', icsUtc(e.alarm.at), ['VALUE=DATE-TIME']), 'END:VALARM');
  }
  lines.push('END:VEVENT');
  return lines;
}

/** A complete VCALENDAR text with CRLF line endings. */
export function buildCalendar(events: IcsEvent[], opts: { name: string; now?: Date } = { name: 'Casefile' }): string {
  const stamp = icsUtc(opts.now ?? new Date());
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    property('PRODID', '-//Casefile//Case ledger//EN'),
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    property('X-WR-CALNAME', icsEscape(opts.name)),
  ];
  for (const e of events) lines.push(...eventLines(e, stamp));
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

/** Minimal structural check used by tests and the routes' self-check: balanced components and CRLF only. */
export function looksLikeValidCalendar(text: string): boolean {
  if (!text.startsWith('BEGIN:VCALENDAR\r\n') || !text.endsWith('END:VCALENDAR\r\n')) return false;
  if (/[^\r]\n|\r[^\n]/.test(text)) return false;
  const begins = (text.match(/^BEGIN:VEVENT\r$/gm) ?? []).length;
  const ends = (text.match(/^END:VEVENT\r$/gm) ?? []).length;
  return begins === ends;
}
