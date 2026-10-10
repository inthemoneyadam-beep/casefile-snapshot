/**
 * The 14-day strip: a small heatmap, one column per day ending at the selected date, one row per symptom you track
 * plus sleep. Five shades of the accent carry the score (the stronger the colour, the worse, in every theme: on a dark background a strong colour looks lighter, so never "darker is worse"; see symptoms.css); a dashed box means
 * nothing was scored. Click a day to open it. A line under the strip says how to read it.
 */
import type { DayRow, SymptomDefinition } from '../../api/symptoms';
import { toneClass, weekday } from './dates';

export interface DayStripProps {
  dates: string[];
  days: DayRow[];
  definitions: SymptomDefinition[];
  selected: string;
  today: string;
  onSelect: (date: string) => void;
}

export function DayStrip({ dates, days, definitions, selected, today, onSelect }: DayStripProps) {
  const byDate = new Map(days.map((d) => [d.date, d]));
  return (
    <div className="sym-strip" aria-label={`The last ${dates.length} days`}>
      <table>
        <thead>
          <tr>
            <th className="label" scope="col">
              Last {dates.length} days
            </th>
            {dates.map((d) => (
              <th key={d} scope="col" className={d === selected ? 'sel' : d === today ? 'today' : undefined} title={d}>
                <button type="button" className="sym-day-btn" tabIndex={-1} onClick={() => onSelect(d)} aria-label={`Open ${d}`}>
                  <span className="wd">{weekday(d).slice(0, 2)}</span>
                  <span className="dd">{d.slice(8)}</span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {definitions.map((def) => (
            <tr key={def.id}>
              <td className="label" title={def.name}>
                {def.name}
              </td>
              {dates.map((d) => {
                const s = byDate.get(d)?.scores[def.id];
                return (
                  <td key={d} className={d === selected ? 'sel' : undefined}>
                    <button
                      type="button"
                      tabIndex={-1}
                      className={`sym-dot ${toneClass(s?.score)}`}
                      title={`${def.name}, ${d}: ${s ? `${s.score} out of 10${s.note ? `. ${s.note}` : ''}` : 'not scored'}`}
                      aria-label={`${def.name} on ${d}: ${s ? s.score : 'not scored'}`}
                      onClick={() => onSelect(d)}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
          <tr>
            <td className="label">Sleep, hours</td>
            {dates.map((d) => {
              const row = byDate.get(d);
              return (
                <td key={d} className={`sleep${d === selected ? ' sel' : ''}`} onClick={() => onSelect(d)} title={row?.sleepHours != null ? `${d}: ${row.sleepHours} hours of sleep` : `${d}: no sleep written down`}>
                  {row?.sleepHours != null ? row.sleepHours : '·'}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
      <p className="sym-strip-key">
        <span className="sym-key-dots" aria-hidden="true">
          <i className="sym-tone-1" />
          <i className="sym-tone-3" />
          <i className="sym-tone-5" />
        </span>
        The stronger the colour, the worse; a dashed box was not scored. Click a day to open it.
      </p>
    </div>
  );
}
