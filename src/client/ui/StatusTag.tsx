import type { ReactNode } from 'react';
import type { Trust, TrustInfo } from '@shared/reconcile';

export type TagTone = 'neutral' | 'ok' | 'warn' | 'bad' | 'danger' | 'ash' | 'info' | 'accent';

export function Tag({ tone = 'neutral', children, title }: { tone?: TagTone; children: ReactNode; title?: string }) {
  return (
    <span className={`tag ${tone}`} title={title}>
      {children}
    </span>
  );
}

const FACT_STATUS_TONE: Record<string, TagTone> = { unverified: 'neutral', confirmed: 'ok', disputed: 'bad', superseded: 'ash' };
const FINDING_STATUS_TONE: Record<string, TagTone> = { new: 'warn', confirmed: 'ok', dismissed: 'ash', resolved: 'neutral', disputed: 'bad' };
const RECORD_STATUS_TONE: Record<string, TagTone> = { unknown: 'neutral', expected: 'warn', requested: 'info', received: 'ok', not_held: 'ash', denied: 'danger' };
const TASK_STATUS_TONE: Record<string, TagTone> = { open: 'warn', in_progress: 'info', done: 'ok', cancelled: 'ash' };
const JOB_STATUS_TONE: Record<string, TagTone> = { queued: 'neutral', running: 'info', done: 'ok', failed: 'bad', cancelled: 'ash' };
const TEXT_STATUS_TONE: Record<string, TagTone> = { pending: 'neutral', extracting: 'info', extracted: 'ok', ocr_needed: 'warn', ocr_running: 'info', ocr_done: 'ok', failed: 'bad' };
const MED_STATUS_TONE: Record<string, TagTone> = { active: 'ok', stopped: 'ash', prn: 'info', planned: 'warn', unknown: 'neutral' };

/**
 * A fact's stored status in the user's words, for rows that carry no trust
 * (where a row has one, show TrustTag instead). Nothing waits for approval:
 * a detail with no answer from the user is "automatic", a quiet word (or
 * nothing at all with `hideAutomatic`, in lists where it would only repeat).
 * The user's own answers keep their tags: accurate (checked against the
 * original, or said to be right without saying against what: the word
 * Details from documents shows for it, so a detail reads the same on every
 * page), inferred (only from a summary), your correction (the record is wrong
 * here), unsure, incorrect (set aside), and replaced (superseded).
 */
export function FactStatusTag({ status, basis, hideAutomatic = false }: { status: string; basis?: string | null; hideAutomatic?: boolean }) {
  if (status === 'confirmed' && basis === 'summary')
    return (
      <Tag tone="info" title="Only seen in a summary, not the original record; the original is on the Records checklist to request">
        inferred
      </Tag>
    );
  if (status === 'confirmed' && basis === 'original')
    return (
      <Tag tone="ok" title="Checked against the original record">
        accurate
      </Tag>
    );
  if (status === 'confirmed' && basis === 'correction')
    return (
      <Tag tone="ok" title="You said the clinical record is wrong here; this version is used, and the record is kept as written">
        your correction
      </Tag>
    );
  if (status === 'confirmed')
    return (
      <Tag tone="ok" title="You said it is right (for example with Confirm all), without saying what you compared it with">
        accurate
      </Tag>
    );
  if (status === 'unverified' && basis === 'unsure')
    return (
      <Tag tone="neutral" title="You looked and could not tell whether it is right">
        unsure
      </Tag>
    );
  if (status === 'unverified') {
    if (hideAutomatic) return null;
    return (
      <span className="faint xs" title="Read by Claude from a document. No answer from you is needed.">
        automatic
      </span>
    );
  }
  if (status === 'disputed')
    return (
      <Tag tone="bad" title="You marked it incorrect; it stays on file, set aside">
        incorrect
      </Tag>
    );
  if (status === 'superseded')
    return (
      <Tag tone="ash" title="Replaced: the clinical record's value (or a newer reading) is used instead">
        replaced
      </Tag>
    );
  return <Tag tone={FACT_STATUS_TONE[status] ?? 'neutral'}>{status}</Tag>;
}
const TRUST_TONE: Record<Trust, TagTone> = { verified: 'ok', accurate: 'ok', unbacked: 'neutral', inaccurate: 'bad', conflict: 'warn', replaced: 'ash' };
const TRUST_WORD: Record<Trust, string> = { verified: 'verified', accurate: 'accurate', unbacked: 'not backed yet', inaccurate: 'inaccurate', conflict: 'needs a source', replaced: 'replaced' };
/** Sort order of the trust words in a table column: what needs a look first. */
export const TRUST_ORDER: Record<Trust, number> = { inaccurate: 0, conflict: 1, unbacked: 2, accurate: 3, verified: 4, replaced: 5 };

/** One plain line for a trust tag's tooltip: the reason, or the record it was compared with. */
export function trustTitle(t: TrustInfo): string {
  const record = t.recordDocumentTitle?.trim();
  const base =
    t.reason?.trim() ||
    (t.trust === 'verified'
      ? `From ${record ?? 'a clinical record'}.`
      : t.trust === 'accurate'
        ? `Matches ${record ?? 'the clinical record'}.`
        : t.trust === 'unbacked'
          ? 'Nothing to compare it with yet. Adding the clinical record will check it.'
          : t.trust === 'inaccurate'
            ? `Disagrees with ${record ?? 'the clinical record'}.`
            : t.trust === 'conflict'
              ? 'Your documents disagree and no clinical record settles it yet. See Reconciliation.'
              : 'Replaced by a newer reading or a merged duplicate.');
  return t.byUser ? `${base} (your answer)` : base;
}

/**
 * The automatic check of a detail, in plain words: verified (from a clinical
 * record), accurate (matches one), not backed yet (nothing to compare with,
 * quiet), inaccurate (red: disagrees with the record), needs a source (the
 * documents disagree and no record settles it), replaced. The tooltip gives
 * the reason or the record it was compared with. Renders nothing without a trust.
 */
export function TrustTag({ trust }: { trust: TrustInfo | null | undefined }) {
  if (!trust) return null;
  return (
    <Tag tone={TRUST_TONE[trust.trust] ?? 'neutral'} title={trustTitle(trust)}>
      {TRUST_WORD[trust.trust] ?? trust.trust}
    </Tag>
  );
}

/*
 * Stored statuses in the words the pages use (2026-10 UI rollout): the same words as each page's own map
 * (features/findings/words.ts ANSWER_WORDS, features/records/words.tsx, features/tasks/words.ts,
 * features/medications/words.ts), so a status reads the same wherever it shows. tests/ui-integration-words.test.ts
 * keeps them equal. The stored code never reaches the screen; an unknown one shows with its underscores as spaces.
 */
export const FINDING_STATUS_WORDS: Record<string, string> = { new: 'new', confirmed: 'needs follow-up', resolved: 'done', dismissed: "doesn't matter", disputed: 'incorrect' };
export const RECORD_STATUS_WORDS: Record<string, string> = { unknown: 'not sure yet', expected: 'missing', requested: 'asked for', received: 'received', not_held: 'they have none', denied: 'refused' };
export const TASK_STATUS_WORDS: Record<string, string> = { open: 'to do', in_progress: 'in progress', done: 'done', cancelled: 'cancelled' };
export const JOB_STATUS_WORDS: Record<string, string> = { queued: 'waiting', running: 'running', done: 'done', failed: 'failed', cancelled: 'cancelled' };
export const TEXT_STATUS_WORDS: Record<string, string> = { pending: 'not read yet', extracting: 'reading', extracted: 'read', ocr_needed: 'needs its text recognised', ocr_running: 'recognising its text', ocr_done: 'read', failed: 'could not be read' };
export const MED_STATUS_WORDS: Record<string, string> = { active: 'taking', prn: 'as needed', planned: 'planned', stopped: 'stopped', unknown: 'not known' };
const said = (map: Record<string, string>, status: string) => map[status] ?? status.replace(/_/g, ' ');

export function FindingStatusTag({ status }: { status: string }) {
  return <Tag tone={FINDING_STATUS_TONE[status] ?? 'neutral'}>{said(FINDING_STATUS_WORDS, status)}</Tag>;
}
export function RecordStatusTag({ status }: { status: string }) {
  return <Tag tone={RECORD_STATUS_TONE[status] ?? 'neutral'}>{said(RECORD_STATUS_WORDS, status)}</Tag>;
}
export function TaskStatusTag({ status }: { status: string }) {
  return <Tag tone={TASK_STATUS_TONE[status] ?? 'neutral'}>{said(TASK_STATUS_WORDS, status)}</Tag>;
}
export function JobStatusTag({ status }: { status: string }) {
  return <Tag tone={JOB_STATUS_TONE[status] ?? 'neutral'}>{said(JOB_STATUS_WORDS, status)}</Tag>;
}
export function TextStatusTag({ status }: { status: string }) {
  return <Tag tone={TEXT_STATUS_TONE[status] ?? 'neutral'}>{said(TEXT_STATUS_WORDS, status)}</Tag>;
}
export function MedStatusTag({ status }: { status: string }) {
  return <Tag tone={MED_STATUS_TONE[status] ?? 'neutral'}>{said(MED_STATUS_WORDS, status)}</Tag>;
}

/** Source tier of a document in the Guide's words (the same as features/documents/tier.tsx TIER_WORDS, which the pages use). */
const SOURCE_TIER_TONE: Record<string, TagTone> = { primary: 'ok', patient: 'accent', compilation: 'warn', external: 'info', unknown: 'neutral' };
export const SOURCE_TIER_WORDS: Record<string, string> = { primary: 'Clinical record', patient: 'Your own notes', compilation: 'Summary', external: 'Outside letter', unknown: 'Not sorted yet' };
const SOURCE_TIER_TITLE: Record<string, string> = {
  primary: 'A hospital or clinic document. For measurements and dates it is the truth.',
  patient: 'Written by you or your chief of staff. For how a treatment felt or a symptom ran, your word comes first.',
  compilation: 'A summary, dossier or timeline put together from other records. It never outranks a clinical record.',
  external: 'A letter from an insurer, employer, school or advocate.',
  unknown: 'Claude has not worked out where this came from yet.',
};
export function SourceTierTag({ tier, title }: { tier: string | null | undefined; title?: string }) {
  const t = tier || 'unknown';
  return (
    <Tag tone={SOURCE_TIER_TONE[t] ?? 'neutral'} title={title ?? SOURCE_TIER_TITLE[t]}>
      {SOURCE_TIER_WORDS[t] ?? t.replace(/_/g, ' ')}
    </Tag>
  );
}
