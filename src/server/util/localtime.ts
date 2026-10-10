/**
 * The case's local time (2026-10-08, lab check; moved here from services/ask-context.ts on 2026-10-09 so the records
 * and the findings write local days too). Every time stamp the clinician reads (questions, readings, proposals,
 * filings, records received, findings cleared) is the case's local day and time with its zone, never UTC, so a reading
 * made at 21:15 local time on the 8th, in a zone west of UTC, never reads as "the 9th", after today. The zone is TZ
 * (the host sets its own; UTC in the Dockerfile), else the machine's own, else UTC. Only instants (with Z or an offset) are converted; a plain day stays as written.
 */

function knownZone(tz: string | null | undefined): string | null {
  const t = tz?.trim();
  if (!t) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: t });
    return t;
  } catch {
    return null;
  }
}

/** The case's time zone: TZ (set by the host), else the machine's own, else UTC. */
export function caseTimeZone(): string {
  return knownZone(process.env.TZ) ?? knownZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? 'UTC';
}

/**
 * A stored instant ("2026-10-09T02:15:00.000Z", or with an offset), or null when the text is a plain day, a wall time
 * written without a zone (kept as written), or not a time stamp.
 */
function instantOf(iso: string | null | undefined): Date | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(iso.trim())) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function localParts(d: Date, tz: string): Record<string, string> {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  return Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
}

/**
 * The local day of a stored time stamp, in the case's zone ("2026-10-09T02:15Z" at UTC-5 is "2026-10-08"). A plain
 * day, or text that is not a time stamp, is returned as it is (its first 10 characters for a day with a time).
 */
export function localDayOf(iso: string | null | undefined, tz: string = caseTimeZone()): string {
  if (!iso) return '';
  const d = instantOf(iso);
  if (!d) return iso.slice(0, 10);
  const p = localParts(d, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** A stored time stamp as the case's local day, time and zone: "2026-10-08 20:15 UTC". A plain day stays a day. */
export function localStamp(iso: string | null | undefined, tz: string = caseTimeZone()): string {
  if (!iso) return '';
  const d = instantOf(iso);
  if (!d) return iso.slice(0, 10);
  const p = localParts(d, tz);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName ?? tz}`;
}

/** The local time and zone alone: "20:15 UTC" (empty for a plain day). */
export function localTimeOf(iso: string | null | undefined, tz: string = caseTimeZone()): string {
  const d = instantOf(iso);
  if (!d) return '';
  const p = localParts(d, tz);
  return `${p.hour}:${p.minute} ${p.timeZoneName ?? tz}`;
}

