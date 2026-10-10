/**
 * "Same source" for the rules and the reconciliation (2026-10-07, findings D.1.8; WP-C).
 *
 * Before segments existed, a rule that must not compare a document with itself excluded every pair from the same
 * document. Inside a long export of many encounters that hid real disagreements (two encounters' doses or results
 * were never compared) and made false "follow-up missed" findings (a step promised in one encounter and done in a later
 * one of the same export was never seen). Now the unit is the document AND the passage (segment) a fact was read from
 * (`sameSourceUnit`); a fact with no segment link counts as the whole document, exactly as before.
 *
 * Epic prints one order or one lab result up to three times (inside the note, under the parent order, under the reflex
 * child; in several encounters for an order acted on elsewhere). Those printings are ONE source: two facts of the same
 * document whose citations or statement carry the same order id (`[990000123]`), plus the same component for a lab
 * result, are the same source unit wherever they sit, so a repeat is never a disagreement or a corroboration.
 *
 * The passage unit can be switched off (the whole document again) with the setting `rules.sourceUnitByPassage` = false
 * (cast key, not in DEFAULT_SETTINGS: unset reads as on), the findings' D.7 mitigation for a flood of new findings.
 * Pure helpers plus one setting read; no writes.
 */
import type { SettingKey } from '../../shared/constants';
import { normalizeKey } from '../../shared/text';
import { sameSourceUnit } from '../../shared/schemas/segments';
import { segmentLinkOf } from '../../shared/trust';
import { getSetting } from './settings';

/** Unset or true: the source unit is the passage; false: the whole document (as before 2026-10-07). */
export const SOURCE_UNIT_SETTING = 'rules.sourceUnitByPassage';

export function passageSourceUnitsOn(): boolean {
  try {
    return getSetting(SOURCE_UNIT_SETTING as SettingKey) !== false;
  } catch {
    return true;
  }
}

/** What a rule knows about where a fact came from. */
export interface SourceRef {
  documentId: string | null | undefined;
  segmentId?: string | null;
  /** epicOrderKey: order id (+ component for a lab result) when the record prints one. */
  orderKey?: string | null;
}

/**
 * True when two facts come from the same source unit: the same document and (with passages on) the same segment, or
 * the same printed order of that document. A fact with no document is never the same source as anything (as before).
 */
export function sameSource(a: SourceRef, b: SourceRef, byPassage: boolean = passageSourceUnitsOn()): boolean {
  if (!a.documentId || !b.documentId || a.documentId !== b.documentId) return false;
  if (!byPassage) return true;
  if (a.orderKey && b.orderKey && a.orderKey === b.orderKey) return true;
  return sameSourceUnit({ documentId: a.documentId, segmentId: a.segmentId ?? null }, { documentId: b.documentId, segmentId: b.segmentId ?? null });
}

/** Segment kinds that are no unit of their own: blocks of pages of an unknown layout stand for the whole document. */
const WHOLE_DOCUMENT_KINDS = new Set(['pages', 'other']);

/**
 * The passage a fact was read from (`attributes._segment.id`) when it is a unit of its own: a part of an export (an
 * encounter's notes, labs, messages...). A block of pages of an ordinary document is not (its facts stay one source, as
 * before), and neither is a fact with no link (read before segments existed, or typed). Null in those cases.
 */
export function segmentIdOf(attributes: string | Record<string, unknown> | null | undefined): string | null {
  const link = segmentLinkOf(attributes);
  if (!link?.id) return null;
  let a: unknown = attributes;
  if (typeof a === 'string') {
    try {
      a = JSON.parse(a);
    } catch {
      return null;
    }
  }
  const kind = segmentKindOf(a as Record<string, unknown>);
  return kind && WHOLE_DOCUMENT_KINDS.has(kind) ? null : link.id;
}

/** A grouping key for a source unit: the document, or the document and its passage (or printed order). */
export function sourceKeyOf(u: SourceRef, byPassage: boolean = passageSourceUnitsOn()): string {
  const doc = u.documentId ?? '';
  if (!byPassage) return doc;
  if (u.orderKey) return `${doc}#${u.orderKey}`;
  return u.segmentId ? `${doc}#${u.segmentId}` : doc;
}

const ORDER_ID = /\[(\d{6,12})\]/;

function strAttr(a: Record<string, unknown>, k: string): string {
  const v = a[k];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

/**
 * The printed order a fact repeats, as a key: "o:<order id>" (an order, a medication) or "o:<order id>|<component>" (a
 * lab result: the order plus the analyte, since one order prints several components). Only for facts read from a
 * segment of an export (a segment link), where Epic's repeated printing happens; null otherwise or without an order id.
 */
export function epicOrderKey(f: { type: string; statement: string; attributes: Record<string, unknown>; quotes?: readonly string[] }): string | null {
  if (!segmentIdOf(f.attributes)) return null;
  const fromAttr = strAttr(f.attributes, 'order_id').replace(/\D+/g, '');
  let id = fromAttr.length >= 6 ? fromAttr : '';
  if (!id) {
    for (const t of [f.statement, ...(f.quotes ?? [])]) {
      const m = t ? ORDER_ID.exec(t) : null;
      if (m) {
        id = m[1];
        break;
      }
    }
  }
  if (!id) return null;
  if (f.type === 'lab_result') {
    const component = normalizeKey(strAttr(f.attributes, 'analyte') || strAttr(f.attributes, 'name'));
    return component ? `o:${id}|${component}` : null;
  }
  return `o:${id}`;
}

/**
 * The kind of document a passage of an export stands for, so the reconciliation treats an export's Labs section as
 * the lab's own report and its notes as clinic notes (a whole export has one category, which would make every passage
 * "the same kind of document" and never comparable). Null for a kind that maps to nothing: the document's own
 * category then stands.
 */
export function categoryForSegmentKind(kind: string | null | undefined): string | null {
  switch (kind) {
    case 'lab_results':
      return 'lab_report';
    case 'imaging':
      return 'imaging_report';
    case 'procedures':
      return 'operative_report';
    case 'note':
    case 'telephone':
    case 'visit_info':
    case 'instructions':
      return 'clinical_note';
    case 'messages':
    case 'appointment_request':
    case 'patient_entered':
    case 'questionnaire':
      return 'portal_message';
    case 'letter':
      return 'letter';
    case 'patient_summary':
      return 'summary';
    default:
      return null;
  }
}

/** The `_segment.kind` of a fact's attributes, or null. */
export function segmentKindOf(attributes: Record<string, unknown> | null | undefined): string | null {
  const s = attributes?._segment;
  if (!s || typeof s !== 'object') return null;
  const k = (s as Record<string, unknown>).kind;
  return typeof k === 'string' && k ? k : null;
}
