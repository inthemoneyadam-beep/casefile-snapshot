import type { Intolerance } from '../../api/medications';
import { severityWords } from './words';

/** The Never give banner: every drug that must never be given, with what happens. Renders nothing when there is none. */
export function HardStopBanner({ items }: { items: Intolerance[] }) {
  const stops = items.filter((i) => i.hardStop && i.active);
  if (!stops.length) return null;
  return (
    <div className="hardstop med-hardstop" role="alert" aria-label="Never give">
      <strong>Never give</strong>
      <div className="med-hardstop-list">
        {stops.map((s) => (
          <span key={s.id}>
            <span className="substance">{s.substance}</span>
            {s.reaction ? <span className="reaction">: {s.reaction}</span> : null}
            {s.severity && s.severity !== 'unknown' ? <span className="reaction"> ({severityWords(s.severity)})</span> : null}
          </span>
        ))}
      </div>
    </div>
  );
}
