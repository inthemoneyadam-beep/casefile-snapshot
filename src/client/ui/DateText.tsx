import { formatPartialDate, type DatePrecision } from '@shared/dates';

/** Shows a partial date at its precision; hovering shows the text as written. */
export function DateText({ iso, precision, text, className = '' }: { iso: string | null | undefined; precision?: DatePrecision | string | null; text?: string | null; className?: string }) {
  const shown = formatPartialDate(iso, (precision as DatePrecision) ?? undefined);
  const title = text && text !== shown ? `as written: ${text}` : undefined;
  return (
    <span className={`mono nowrap ${className}`.trim()} title={title}>
      {shown}
      {precision && precision !== 'day' && iso ? <span className="faint xs"> ~</span> : null}
    </span>
  );
}

/** Full datetime, local, compact. */
export function DateTimeText({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <span className="faint">—</span>;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return <span className="mono">{iso}</span>;
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    <span className="mono nowrap" title={d.toISOString()}>
      {d.getFullYear()}-{p(d.getMonth() + 1)}-{p(d.getDate())} {p(d.getHours())}:{p(d.getMinutes())}
    </span>
  );
}

/**
 * Words that may wrap, with every date in them kept whole: "Portal message to the clinic, 2024-03-27" wraps before
 * the date, never inside it ("2024-" / "03-27"). For names in a list cell that wraps to two lines.
 */
export function KeepDatesWhole({ text }: { text: string | null | undefined }) {
  const s = text ?? '';
  const parts = s.split(/(\d{4}-\d{2}(?:-\d{2})?)/);
  if (parts.length < 2) return <>{s}</>;
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <span key={i} className="nowrap">
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </>
  );
}
