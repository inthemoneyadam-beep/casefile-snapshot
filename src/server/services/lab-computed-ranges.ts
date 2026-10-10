/**
 * The ranges the patient types for computed tests (2026-10-09, D6): one per computed test (by its analyte key: the albumin
 * index, the IgG index, or the name of a general formula), stored in the settings table under
 * `labs.computedRanges`. A typed range is drawn dashed and labelled "range typed by you"; it never makes a value red,
 * never judges a value and is never the lab's band.
 *
 * Kept apart from services/lab-compute.ts so services/labs.ts can read it for its charts without importing the
 * computing service (which reads labs.ts).
 */
import type { Settings, SettingKey } from '../../shared/constants';
import { COMPUTED_RANGES_SETTING, type TypedRange } from '../../shared/labcompute';
import { getSetting, setSetting } from './settings';

/** Every typed range, by analyte key (cast: not listed in DEFAULT_SETTINGS, the filing.ts precedent). */
export function typedRanges(): Record<string, TypedRange> {
  const raw = getSetting(COMPUTED_RANGES_SETTING as SettingKey) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, TypedRange> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const r = v as Partial<TypedRange>;
    const low = typeof r.low === 'number' && Number.isFinite(r.low) ? r.low : null;
    const high = typeof r.high === 'number' && Number.isFinite(r.high) ? r.high : null;
    if (low == null && high == null) continue;
    out[k] = { low, high, by: typeof r.by === 'string' && r.by.trim() ? r.by : 'you', at: typeof r.at === 'string' ? r.at : '' };
  }
  return out;
}

/** The range typed for one computed test, or null. */
export function typedRangeFor(analyteKey: string | null | undefined): TypedRange | null {
  if (!analyteKey) return null;
  return typedRanges()[analyteKey] ?? null;
}

/** Store (or, with null, clear) the range typed for one computed test. */
export function writeTypedRange(analyteKey: string, range: TypedRange | null): Record<string, TypedRange> {
  const all = typedRanges();
  if (range) all[analyteKey] = range;
  else delete all[analyteKey];
  setSetting(COMPUTED_RANGES_SETTING as SettingKey, all as unknown as Settings[SettingKey]);
  return all;
}
