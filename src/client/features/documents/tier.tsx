/**
 * Where a document came from, in the words the Guide uses ("How CaseFile
 * works", Kinds of documents), never the stored code (primary, patient,
 * compilation, external, unknown). One map for the documents list, the
 * document pane and page, and the labs By document view.
 */
import { Tag, type TagTone } from '../../ui/StatusTag';

export interface TierWords {
  label: string;
  tone: TagTone;
  /** What it counts for, in a sentence (hover text). */
  title: string;
}

export const TIER_WORDS: Record<string, TierWords> = {
  primary: { label: 'Clinical record', tone: 'ok', title: 'A hospital or clinic document (lab report, scan report, clinic note, procedure report). For measurements and dates it is the truth.' },
  patient: { label: 'Your own notes', tone: 'accent', title: 'Written by you or your chief of staff. For how a treatment felt or a symptom ran, your word comes first; it never overrides a measured value unless you say the record is wrong.' },
  compilation: { label: 'Summary', tone: 'warn', title: 'A summary, dossier or timeline put together from other records (including ones Claude wrote). It never outranks a clinical record.' },
  external: { label: 'Outside letter', tone: 'info', title: 'A letter from an insurer, employer, school or advocate.' },
  unknown: { label: 'Not sorted yet', tone: 'neutral', title: 'Claude has not worked out where this came from yet.' },
};

/** The order the choices are offered in (Edit details, the Source filter). */
export const TIER_ORDER = ['primary', 'patient', 'compilation', 'external', 'unknown'] as const;

export function tierWords(tier: string | null | undefined): TierWords {
  return TIER_WORDS[tier || 'unknown'] ?? TIER_WORDS.unknown;
}

/** The tier as a small tag in plain words; nothing without a tier. */
export function TierTag({ tier }: { tier: string | null | undefined }) {
  if (!tier) return null;
  const w = tierWords(tier);
  return (
    <Tag tone={w.tone} title={w.title}>
      {w.label}
    </Tag>
  );
}

/** Who wrote it, in plain words. */
export const AUTHOR_WORDS: Record<string, string> = {
  clinician: 'A clinician',
  patient: 'You',
  chief_of_staff: 'Chief of staff',
  ai_summary: 'Claude (a summary)',
  advocate: 'An advocate',
  other: 'Someone else',
};
