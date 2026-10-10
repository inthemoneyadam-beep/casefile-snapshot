/**
 * Trust follows the passage, not only the document (2026-10-07, large exports). A clinical record (tier `primary`) can
 * hold the patient's own words: his MyChart messages inside an Epic chart print, a questionnaire he filled in, a photo
 * he attached. Those passages are the patient's, so they are trusted as the patient's (`patient`), never as the
 * clinical record's: the value he quotes in a message is his claim, not a printed result, and a drug he mentions is not
 * filed as a medication from the record.
 *
 * Every trust consumer asks this module: reconcile's trust markers, lab reading roles (`roleForTier`), medication
 * filing, patient precedence and the assistant's labels. Rules:
 * - a passage is never trusted more than its document: the answer is the document's tier or a lower one;
 * - only a clinical record is re-tiered by its passage. A patient-voiced fact (`facts.asserted_by = 'patient'`, which
 *   the prompt keeps for first-person text: "patient reports headaches" is the clinician recording) or a passage in a
 *   patient-authored segment or message is `patient`; a segment with a tier of its own (an outside letter scanned into
 *   the export) takes that tier;
 * - every other document keeps its tier (a clinician quoted in the patient's own notes stays `patient`; a summary stays
 *   `compilation`; a document not sorted yet stays `unknown`).
 * Pure: no database, no Node APIs (also used by the browser).
 */
import { SOURCE_TIERS, type SourceTier } from './enums';

/** The key under `facts.attributes_json` that links a fact to the segment it was read from (internal: underscore). */
export const SEGMENT_ATTRIBUTE_KEY = '_segment';

/** Whose words a passage is, from whatever is known about it. Every field is optional. */
export interface PassageVoice {
  /** `facts.asserted_by` (patient | clinician | compiler | unknown). */
  assertedBy?: string | null;
  /** The tier of the segment the passage sits in (`document_segments.source_tier`, or `_segment.tier`). */
  segmentTier?: string | null;
  /** A message's or segment's voice (MessageVoice: patient | clinician | staff | system | third_party | unknown). */
  voice?: string | null;
}

/** A known tier, or `unknown`. */
export function normalizeTier(tier: string | null | undefined): SourceTier {
  return tier && (SOURCE_TIERS as readonly string[]).includes(tier) ? (tier as SourceTier) : 'unknown';
}

/** True when the passage is in the patient's own words. */
export function isPatientVoiced(voice: PassageVoice | null | undefined): boolean {
  if (!voice) return false;
  return voice.assertedBy === 'patient' || voice.voice === 'patient' || voice.segmentTier === 'patient';
}

/** The tier a passage is trusted at (see the rules above). */
export function effectiveTier(docTier: string | null | undefined, voice?: PassageVoice | null): SourceTier {
  const doc = normalizeTier(docTier);
  if (doc !== 'primary' || !voice) return doc;
  if (isPatientVoiced(voice)) return 'patient';
  const seg = normalizeTier(voice.segmentTier);
  if (seg !== 'primary' && seg !== 'unknown') return seg;
  return 'primary';
}

/** True when the passage is trusted below its document (the ingestion report counts these as "trust markers changed"). */
export function passageLowersTier(docTier: string | null | undefined, voice?: PassageVoice | null): boolean {
  return effectiveTier(docTier, voice) !== normalizeTier(docTier);
}

/** The `_segment` link of a fact's attributes, when it has one (attributes as stored text or already parsed). */
export function segmentLinkOf(attributes: string | Record<string, unknown> | null | undefined): { id: string | null; tier: string | null; voice: string | null } | null {
  let a: unknown = attributes;
  if (typeof a === 'string') {
    try {
      a = JSON.parse(a);
    } catch {
      return null;
    }
  }
  if (!a || typeof a !== 'object') return null;
  const s = (a as Record<string, unknown>)[SEGMENT_ATTRIBUTE_KEY];
  if (!s || typeof s !== 'object') return null;
  const r = s as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return { id: str(r.id), tier: str(r.tier), voice: str(r.voice) };
}

/** The voice of a fact row: its `asserted_by` plus its `_segment` link (attributes as stored text or parsed). */
export function factVoice(f: { assertedBy?: string | null; attributesJson?: string | null; attributes?: Record<string, unknown> | null }): PassageVoice {
  const seg = segmentLinkOf(f.attributes ?? f.attributesJson ?? null);
  return { assertedBy: f.assertedBy ?? null, segmentTier: seg?.tier ?? null, voice: seg?.voice ?? null };
}

/** effectiveTier for a fact row in a document of tier `docTier`. */
export function factTier(docTier: string | null | undefined, f: { assertedBy?: string | null; attributesJson?: string | null; attributes?: Record<string, unknown> | null }): SourceTier {
  return effectiveTier(docTier, factVoice(f));
}

/** The tier of a message body read out of a document of tier `docTier`: a patient's body is `patient`, a reply keeps the record's tier. */
export function messageTier(docTier: string | null | undefined, voice: string | null | undefined): SourceTier {
  return effectiveTier(docTier, { voice: voice ?? null });
}
