/**
 * Where a fact came from, typed by a person: a web page (its link and the day it was read) or a phone call (who told
 * you and when). Shared by the dialogs of the Care team page. "No source yet" leaves the fact "not backed yet".
 */
import { Field, Input, Select } from '../../ui/Field';
import { Segmented } from '../../ui/Toolbar';
import { DayInput, dayHint, readDay } from '../../ui/DayInput';
import type { SourceInput } from '../../api/care-team';
import type { Communication } from '../../api/communications';

export interface SourceState {
  kind: 'none' | 'web' | 'phone';
  url: string;
  readAt: string;
  who: string;
  when: string;
  communicationId: string;
}

export const EMPTY_SOURCE: SourceState = { kind: 'none', url: '', readAt: '', who: '', when: '', communicationId: '' };

/** The source to send, null for "No source yet", or what is missing in words. */
export function sourceFrom(s: SourceState): { source: SourceInput | null; problem: string | null } {
  if (s.kind === 'none') return { source: null, problem: null };
  if (s.kind === 'web') {
    if (!s.url.trim()) return { source: null, problem: 'Paste the link of the page.' };
    if (s.readAt.trim() && !readDay(s.readAt).ok) return { source: null, problem: 'Type the day it was read as 2026-10-09.' };
    return { source: { kind: 'web', url: s.url.trim(), readAt: readDay(s.readAt).iso }, problem: null };
  }
  if (!s.who.trim()) return { source: null, problem: 'Say who told you.' };
  if (!s.when.trim() || !readDay(s.when).ok) return { source: null, problem: 'Say the day of the call, e.g. 2026-10-09.' };
  return { source: { kind: 'phone', who: s.who.trim(), when: readDay(s.when).iso ?? s.when.trim(), communicationId: s.communicationId || null }, problem: null };
}

export function SourceFields({ value, onChange, allowNone = true, calls = [], label = 'Source' }: { value: SourceState; onChange: (s: SourceState) => void; allowNone?: boolean; calls?: Communication[]; label?: string }) {
  const set = (patch: Partial<SourceState>) => onChange({ ...value, ...patch });
  const options = [
    ...(allowNone ? [{ value: 'none' as const, label: 'No source yet', title: 'It will read "not backed yet"' }] : []),
    { value: 'web' as const, label: 'A web page', title: 'The link, and the day you read it' },
    { value: 'phone' as const, label: 'Told us by phone', title: 'Who said it, and when' },
  ];
  return (
    <div className="ct-source-box">
      <Segmented label={label} value={value.kind} onChange={(k) => set({ kind: k })} options={options} />
      {value.kind === 'web' ? (
        <div className="ct-form">
          <div className="full">
            <Field label="Link">
              <Input value={value.url} onChange={(e) => set({ url: e.target.value })} placeholder="e.g. https://example.org/our-team" />
            </Field>
          </div>
          <Field label="Day you read it" hint={dayHint(value.readAt) ?? 'Today when blank.'}>
            <DayInput value={value.readAt} onChange={(t) => set({ readAt: t })} />
          </Field>
        </div>
      ) : null}
      {value.kind === 'phone' ? (
        <div className="ct-form">
          {calls.length ? (
            <div className="full">
              <Field label="From a call you logged" hint="Fills in the day. Optional.">
                <Select
                  aria-label="From a call you logged"
                  value={value.communicationId}
                  placeholder="None"
                  options={calls.map((c) => ({ value: c.id, label: `${c.occurredAt ?? 'no date'} · ${c.subject}` }))}
                  onChange={(e) => {
                    const c = calls.find((x) => x.id === e.target.value);
                    set({ communicationId: e.target.value, when: c?.occurredAt && c.occurredAt.length >= 10 ? c.occurredAt.slice(0, 10) : value.when });
                  }}
                />
              </Field>
            </div>
          ) : null}
          <Field label="Who told you">
            <Input value={value.who} onChange={(e) => set({ who: e.target.value })} placeholder="e.g. the front desk, Dr. Example's nurse" />
          </Field>
          <Field label="When" hint={dayHint(value.when)}>
            <DayInput value={value.when} onChange={(t) => set({ when: t })} />
          </Field>
        </div>
      ) : null}
    </div>
  );
}
