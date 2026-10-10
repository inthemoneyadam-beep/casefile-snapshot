/**
 * The Medications page's words: the stored status, event and allergy codes said the way a patient says them
 * ("taking", "as needed", "dose changed", "never give"), never the raw codes ("active", "prn", "dose_change",
 * "hard_stop"). Plain TypeScript (no React, no DOM), so tests can run it under node.
 *
 * The data keeps its codes; only the screen changes. "Hard stop" stays the data term; the page says "never give".
 */
import { INTOLERANCE_KINDS, INTOLERANCE_SEVERITIES, MED_EVENT_KINDS, MED_STATUSES } from '@shared/enums';

export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'danger' | 'ash' | 'info' | 'accent';

/** A medication's status in words (lower case, as in a tag). */
export const MED_STATUS_WORDS: Record<string, string> = { active: 'taking', prn: 'as needed', planned: 'planned', stopped: 'stopped', unknown: 'not known' };
/** What each status means, for hover text. */
export const MED_STATUS_TITLES: Record<string, string> = {
  active: 'You take it now',
  prn: 'Taken only when needed',
  planned: 'Prescribed or planned, not started yet',
  stopped: 'No longer taken',
  unknown: 'Whether you still take it is not recorded',
};
export const MED_STATUS_TONE: Record<string, Tone> = { active: 'ok', stopped: 'ash', prn: 'info', planned: 'warn', unknown: 'neutral' };

export function medStatusWords(status: string): string {
  return MED_STATUS_WORDS[status] ?? status.replace(/_/g, ' ');
}

const sentence = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The status choices of a select, in words ("Taking", "As needed"). */
export const MED_STATUS_OPTIONS = MED_STATUSES.map((s) => ({ value: s, label: sentence(medStatusWords(s)) }));

/** What happened, for an event's tag ("started", "dose changed"). */
export const EVENT_WORDS: Record<string, string> = { start: 'started', stop: 'stopped', dose_change: 'dose changed', hold: 'paused', resume: 'restarted', reaction: 'reaction', note: 'note' };
export const EVENT_TONE: Record<string, Tone> = { start: 'ok', stop: 'ash', dose_change: 'accent', hold: 'warn', resume: 'ok', reaction: 'bad', note: 'info' };

export function eventWords(kind: string): string {
  return EVENT_WORDS[kind] ?? kind.replace(/_/g, ' ');
}

/** The event choices of a select, in words. */
export const EVENT_OPTIONS = MED_EVENT_KINDS.map((k) => ({ value: k, label: sentence(k === 'hold' ? 'paused (on hold)' : eventWords(k)) }));

/** An allergy's kind in words. "hard_stop" is the data's name for a drug that must never be given. */
export const INTOLERANCE_KIND_WORDS: Record<string, string> = { allergy: 'allergy', intolerance: 'intolerance', hard_stop: 'never give', caution: 'caution' };
export function intoleranceKindWords(kind: string): string {
  return INTOLERANCE_KIND_WORDS[kind] ?? kind.replace(/_/g, ' ');
}
export const INTOLERANCE_KIND_OPTIONS = INTOLERANCE_KINDS.map((k) => ({ value: k, label: sentence(intoleranceKindWords(k)) }));

export const SEVERITY_WORDS: Record<string, string> = { mild: 'mild', moderate: 'moderate', severe: 'severe', life_threatening: 'life-threatening', unknown: 'severity not known' };
export const SEVERITY_TONE: Record<string, Tone> = { mild: 'neutral', moderate: 'warn', severe: 'bad', life_threatening: 'danger', unknown: 'ash' };
export function severityWords(s: string): string {
  return SEVERITY_WORDS[s] ?? s.replace(/_/g, ' ');
}
export const SEVERITY_OPTIONS = INTOLERANCE_SEVERITIES.map((s) => ({ value: s, label: sentence(s === 'unknown' ? 'not known' : severityWords(s)) }));

/** "150 mg", or "" when no dose is recorded. */
export function doseWords(r: { dose: string | null; unit: string | null }): string {
  return [r.dose, r.unit].filter(Boolean).join(' ');
}

/** The optional list columns: shown only when at least one row in the list has a value (the detail shows them all). */
export type OptionalMedColumn = 'route' | 'frequency' | 'prescriber' | 'indication';

export function optionalMedColumns(rows: ReadonlyArray<{ route: string | null; frequency: string | null; prescriberName: string | null; indication: string | null }>): Set<OptionalMedColumn> {
  const out = new Set<OptionalMedColumn>();
  for (const r of rows) {
    if (r.route?.trim()) out.add('route');
    if (r.frequency?.trim()) out.add('frequency');
    if (r.prescriberName?.trim()) out.add('prescriber');
    if (r.indication?.trim()) out.add('indication');
  }
  return out;
}

/** How many, in words that agree in number: "1 medication", "2 medications". */
export { plural } from '../../app/text';
