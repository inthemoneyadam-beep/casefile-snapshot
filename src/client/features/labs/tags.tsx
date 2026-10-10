import type { TrustInfo } from '@shared/reconcile';
import { FactStatusTag, Tag } from '../../ui/StatusTag';
import { CheckTag } from '../reconcile/CheckTag';
import { TierTag as DocumentTierTag } from '../documents/tier';
import { COMBINED_LABEL, COMBINED_TITLE, fromLineTitle, fromLineWords, isCombined, type PartLike } from './parts';
import { rangeMark, type RangeInput, type RangeMark, type TestRange } from './range';
import { resultMark, type ResultLike } from './words';
import { INPUT_CHANGED, computedTitle, type ComputedView } from '@shared/labcompute';

/**
 * A value the patient computed (2026-10-09): "computed", or "input changed: compute again" when an input was edited, disputed
 * or removed since (never recomputed by itself). The hover names the label and every input's page.
 */
export function ComputedTag({ computed: c }: { computed: ComputedView | null | undefined }) {
  if (!c) return null;
  if (c.changes.length) {
    return (
      <Tag tone="warn" title={c.changes.join('\n')}>
        {INPUT_CHANGED}
      </Tag>
    );
  }
  return (
    <Tag tone="neutral" title={`${c.record.label}\n${computedTitle(c.record.inputs)}`}>
      computed
    </Tag>
  );
}

export const SPECIMEN_LABEL: Record<string, string> = { serum: 'serum', plasma: 'plasma', whole_blood: 'whole blood', csf: 'CSF', urine: 'urine', other: 'other' };

/** The sample in a heading or a switch ("Sample: Blood (serum)"), sentence case. */
export const SAMPLE_WORDS: Record<string, string> = { serum: 'Blood (serum)', plasma: 'Plasma', whole_blood: 'Whole blood', csf: 'CSF', urine: 'Urine', other: 'Other' };

export function specimenLabel(s: string | null | undefined): string {
  return s ? (SPECIMEN_LABEL[s] ?? s.replace(/_/g, ' ')) : '';
}

export function sampleWords(s: string | null | undefined): string {
  return s ? (SAMPLE_WORDS[s] ?? s.replace(/_/g, ' ')) : '';
}

/**
 * A value outside the range printed with it, in red with the word ("high", "low"), whether the report flagged it or
 * the number is outside its own range; the hover says which. Nothing for a value within its range, a value that
 * printed no range, or a summary's own claim.
 */
export function RangeTag({ mark }: { mark: RangeMark | null | undefined }) {
  if (!mark) return null;
  return (
    <Tag tone="danger" title={mark.title}>
      {mark.word}
    </Tag>
  );
}

/** The value's mark worked out here (range.ts rangeMark: its printed flag, else its own range; `test` is ignored), as a tag. */
export function ValueRangeTag({ value }: { value: RangeInput; test?: TestRange | null }) {
  return <RangeTag mark={rangeMark(value)} />;
}

export function SpecimenTag({ specimen }: { specimen: string | null | undefined }) {
  if (!specimen) return <span className="faint">—</span>;
  return <Tag tone={specimen === 'csf' ? 'info' : 'neutral'}>{specimenLabel(specimen)}</Tag>;
}

/** Where a document came from, in plain words (Clinical record, Your own notes, Summary...); nothing without a tier. */
export function TierTag({ tier }: { tier: string | null | undefined }) {
  return <DocumentTierTag tier={tier} />;
}

/** The file a CSV-imported row came from, read from the protected notes prefix. */
export function importedFrom(notes: string | null | undefined): string | null {
  const m = (notes ?? '').match(/^imported from ([^;]+)/);
  return m ? m[1].trim() : null;
}

/**
 * Where a row comes from and how far it can be trusted: a value read from a
 * document shows its automatic check (verified, accurate, not compared, not
 * backed yet, inaccurate, needs a source, replaced); a row whose detail was later
 * deleted, an imported row and a hand-entered row say so. Set-aside rows are
 * kept out of trends; the tag says why.
 */
export function SourceTag({ source, trust, factStatus, factBasis, factDeleted, notes, computed }: { source: 'row' | 'fact'; trust?: TrustInfo | null; factStatus: string | null; factBasis?: string | null; factDeleted?: boolean; notes?: string | null; computed?: ComputedView | null }) {
  if (computed) return <ComputedTag computed={computed} />;
  if (factDeleted) return <Tag tone="ash" title="Added from a detail that was later deleted on Details from documents; kept out of trends">detail deleted</Tag>;
  if (trust) return <CheckTag trust={trust} />;
  if (factStatus === 'confirmed' || factStatus === 'unverified' || factStatus === 'disputed' || factStatus === 'superseded') return <FactStatusTag status={factStatus} basis={factBasis} />;
  if (source === 'fact') return <Tag tone="info" title="Read by Claude from a document">read by Claude</Tag>;
  const file = importedFrom(notes);
  if (file) return <Tag tone="info" title={`Imported from ${file}`}>imported</Tag>;
  return <Tag tone="neutral" title="Typed in by hand; not compared with a record">entered by you</Tag>;
}

/** Where a value came from, in a few plain words, for a key fact. */
export function originWords(e: { source: 'row' | 'fact'; factId: string | null; factDeleted?: boolean; notes?: string | null; documentId: string | null; computed?: ComputedView | null }): string {
  if (e.computed) return e.computed.record.label;
  if (e.factDeleted) return 'From a detail that was later deleted';
  if (e.source === 'fact') return 'Read by Claude from the document';
  const file = importedFrom(e.notes);
  if (file) return `Imported from ${file}`;
  if (e.factId) return 'Read by Claude, then copied into your lab list';
  return 'Entered by you';
}

/**
 * An abnormal or positive result, marked in plain words so it stands out: the report's flag (high, low, abnormal,
 * critical), else how a result in words reads (positive, abnormal). Nothing for a normal or negative result.
 */
export function ResultMarkTag({ result }: { result: ResultLike }) {
  const mark = resultMark(result);
  if (!mark) return null;
  return (
    <Tag tone={mark.tone} title={mark.title}>
      {mark.word}
    </Tag>
  );
}

/** The small plain label on a line that names several tests the app could not split. */
export function CombinedTag() {
  return (
    <span className="labs-linemark">
      <Tag tone="neutral" title={COMBINED_TITLE}>
        {COMBINED_LABEL}
      </Tag>
    </span>
  );
}

/** Does LineNote say anything for this entry ("one line, several tests", or "from one line")? */
export function hasLineNote(entry: PartLike | null | undefined): boolean {
  return Boolean(fromLineWords(entry)) || isCombined(entry);
}

/**
 * What a value's line says about it: "one line, several tests" on a line that could not be split, and on one part
 * of a line that was, a faint note. After the name in a list cell it is short and on one line, "from one line" (or
 * "from one line in <document>" where the row does not name the document), with the whole line on hover; with
 * `block`, a line of its own in a detail, the whole line written out ("from one line: <the line as written>").
 * Nothing for an ordinary value.
 */
export function LineNote({ entry, block, document }: { entry: PartLike | null | undefined; block?: boolean; document?: string | null }) {
  const words = fromLineWords(entry);
  const combined = isCombined(entry);
  if (!words && !combined) return null;
  // A space before each note in a list cell: the name may wrap there (a note glued to the name's last word would
  // carry it onto a third line).
  return (
    <>
      {combined ? (
        <>
          {block ? null : ' '}
          <CombinedTag />
        </>
      ) : null}
      {words ? (
        <>
          {block ? null : ' '}
          <span className={block ? 'labs-fromline block' : 'labs-fromline'} title={fromLineTitle(entry)}>
            {block ? words : `from one line${document ? ` in ${document}` : ''}`}
          </span>
        </>
      ) : null}
    </>
  );
}

/**
 * A value written in words or with slashes ("normal/negative", "15 raw, about 10 corrected"), allowed to wrap only
 * after a slash or a comma or at a space, never inside a word ("negativ e").
 */
export function Breakable({ text }: { text: string }) {
  const parts = text.split(/(?<=[/,])/);
  if (parts.length < 2) return <>{text}</>;
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {p}
          {i < parts.length - 1 ? <wbr /> : null}
        </span>
      ))}
    </>
  );
}
