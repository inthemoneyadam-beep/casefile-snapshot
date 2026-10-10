/**
 * The right column of the diary: the selected day in the detail pane's order (the day, one status line), then its
 * sleep, energy, tags and notes (each box saves when you leave it or press Enter), then the notes written in the last
 * two weeks, for context while scoring. Every scale says what its ends mean.
 */
import { useEffect, useRef, useState } from 'react';
import { Section } from '../../ui/PageHeader';
import { DetailHeader, DetailPane } from '../../ui/DetailPane';
import { Tag } from '../../ui/StatusTag';
import type { DayInput, DayRow, SymptomDefinition } from '../../api/symptoms';
import { longDay } from './dates';

interface FieldProps {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  hint?: string;
  type?: 'number' | 'text';
  min?: number;
  max?: number;
  step?: number | 'any';
  onSave: (v: string) => void;
}

function BlurField({ id, label, value, placeholder, hint, type = 'text', min, max, step, onSave }: FieldProps) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  function commit() {
    if (draft.trim() !== value.trim()) onSave(draft.trim());
  }
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <div className="sym-day-field">
        <input
          id={id}
          type={type}
          min={min}
          max={max}
          step={step}
          value={draft}
          placeholder={placeholder}
          className={type === 'number' ? 'sym-num' : undefined}
          onFocus={() => (focused.current = true)}
          onBlur={() => {
            focused.current = false;
            commit();
          }}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
              (e.target as HTMLInputElement).blur();
            } else if (e.key === 'Escape') {
              setDraft(value);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        {hint ? <span className="sym-hint">{hint}</span> : null}
      </div>
    </>
  );
}

export interface DayDetailProps {
  date: string;
  today: string;
  day: DayRow | undefined;
  recent: DayRow[];
  definitions: SymptomDefinition[];
  saving: boolean;
  onSave: (input: DayInput) => void;
  onSelectDate: (date: string) => void;
}

function num(v: string): number | null {
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function DayDetail({ date, today, day, recent, definitions, saving, onSave, onSelectDate }: DayDetailProps) {
  const [notes, setNotes] = useState(day?.notes ?? '');
  const notesFocused = useRef(false);
  useEffect(() => {
    if (!notesFocused.current) setNotes(day?.notes ?? '');
  }, [day?.notes, date]);
  const scored = definitions.filter((d) => day?.scores[d.id]).length;
  const names = new Map(definitions.map((d) => [d.id, d.name]));

  function commitNotes() {
    if (notes.trim() !== (day?.notes ?? '').trim()) onSave({ notes: notes.trim() || null });
  }

  const recentNotes = recent
    .filter((r) => r.date !== date)
    .flatMap((r) => {
      const lines: Array<{ date: string; who: string; text: string }> = [];
      if (r.notes) lines.push({ date: r.date, who: 'Day note', text: r.notes });
      for (const [id, s] of Object.entries(r.scores)) if (s.note) lines.push({ date: r.date, who: `${names.get(id) ?? 'A symptom'} ${s.score}`, text: s.note });
      return lines;
    })
    .reverse();

  return (
    <DetailPane label="The day">
      <DetailHeader
        eyebrow={
          <>
            {date === today ? <Tag tone="accent">today</Tag> : <span>Day</span>}
            <span className="mono">{date}</span>
          </>
        }
        title={longDay(date)}
        status={[
          definitions.length ? `${scored} of ${definitions.length} symptom${definitions.length === 1 ? '' : 's'} scored` : 'no symptoms to score yet',
          saving ? 'saving…' : day?.hasLog ? 'sleep, energy or notes saved' : null,
        ]}
      />

      <Section title="Sleep, energy and notes" intro="Each box saves when you leave it or press Enter; Esc puts it back.">
        <div className="sym-day">
          <BlurField id="sym-sleep-hours" label="Sleep" type="number" min={0} max={24} step={0.5} value={day?.sleepHours != null ? String(day.sleepHours) : ''} placeholder="e.g. 7.5" hint="hours" onSave={(v) => onSave({ sleepHours: num(v) })} />
          <BlurField id="sym-sleep-quality" label="Sleep quality" type="number" min={0} max={10} step={1} value={day?.sleepQuality != null ? String(day.sleepQuality) : ''} placeholder="e.g. 6" hint="0 = worst, 10 = best" onSave={(v) => onSave({ sleepQuality: num(v) })} />
          <BlurField id="sym-energy" label="Energy" type="number" min={0} max={10} step={1} value={day?.energy != null ? String(day.energy) : ''} placeholder="e.g. 5" hint="0 = none, 10 = full" onSave={(v) => onSave({ energy: num(v) })} />
          <BlurField id="sym-tags" label="Tags" value={day?.tags.join(', ') ?? ''} placeholder="e.g. travel, infusion" hint="separate with commas" onSave={(v) => onSave({ tags: v.split(/[,;]/).map((t) => t.trim()).filter(Boolean) })} />
          <label htmlFor="sym-day-notes">Notes</label>
          <textarea
            id="sym-day-notes"
            rows={4}
            value={notes}
            placeholder="What happened today, in your words. Saved when you leave the box or press Ctrl+Enter."
            onFocus={() => (notesFocused.current = true)}
            onBlur={() => {
              notesFocused.current = false;
              commitNotes();
            }}
            onChange={(e) => setNotes(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                commitNotes();
                (e.target as HTMLTextAreaElement).blur();
              }
            }}
          />
        </div>
      </Section>

      <Section title="Notes from the last 14 days" count={recentNotes.length || undefined}>
        {recentNotes.length ? (
          <div className="sym-recent-list">
            {recentNotes.map((n, i) => (
              <button key={`${n.date}-${i}`} type="button" className="sym-recent" onClick={() => onSelectDate(n.date)} title="Open this day">
                <span className="mono sym-recent-date">{n.date}</span>
                <span className="sym-recent-text">
                  <span className="sym-recent-who">{n.who}: </span>
                  {n.text}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="sym-prose">No notes in the last 14 days. A note for one symptom goes beside its score; a note for the whole day goes above.</p>
        )}
      </Section>
    </DetailPane>
  );
}
