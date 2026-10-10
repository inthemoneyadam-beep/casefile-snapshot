/**
 * A day typed as text: never the browser's date picker, which shows mm/dd/yyyy where the rest of CaseFile writes
 * 2026-10-20. "2026-10-20", "10/20/2026" and "Oct 20 2026" are all read (parsePartialDate); a form keeps the typed
 * text and sends readDay(text).iso, and dayHint(text) says how it reads or that it could not be read.
 *
 *   <Field label="Received on" hint={dayHint(text)}><DayInput value={text} onChange={setText} /></Field>
 */
import type { InputHTMLAttributes } from 'react';
import { parsePartialDate } from '@shared/dates';

/** The placeholder every day box shows. */
export const DAY_PLACEHOLDER = 'e.g. 2026-10-20';

/** A typed day read as YYYY-MM-DD. Empty is fine (no day); anything that is not one whole day is not. */
export function readDay(text: string | null | undefined): { iso: string | null; ok: boolean } {
  const t = (text ?? '').trim();
  if (!t) return { iso: null, ok: true };
  const p = parsePartialDate(t);
  return p.iso && p.precision === 'day' ? { iso: p.iso, ok: true } : { iso: null, ok: false };
}

/**
 * Under the box: how a day typed another way reads, or what to type when it cannot be read. Nothing for a plain
 * YYYY-MM-DD. Shown through KeepDatesWhole where the box is narrow, so "2026-10-20" never breaks.
 */
export function dayHint(text: string | null | undefined): string | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  const { iso, ok } = readDay(t);
  if (!ok) return 'Could not read this as one day. Type it as 2026-10-20.';
  return iso === t ? null : `Reads as ${iso}.`;
}

export function DayInput({ value, onChange, placeholder, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> & { value: string; onChange: (text: string) => void }) {
  const { ok } = readDay(value);
  return (
    <input
      {...rest}
      type="text"
      autoComplete="off"
      className={['day-input', rest.className ?? ''].filter(Boolean).join(' ')}
      placeholder={placeholder ?? DAY_PLACEHOLDER}
      aria-invalid={ok ? undefined : true}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
