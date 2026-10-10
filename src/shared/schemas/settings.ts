/**
 * What each setting may hold. PATCH /api/settings validates every key with
 * these before anything is written (src/server/routes/settings.ts), so a
 * null, an object where a list belongs or a malformed preset can never be
 * stored and break the pages that read it. One entry per key of
 * DEFAULT_SETTINGS; the type below makes a missing key a compile error.
 */
import { z } from 'zod';
import { LONG_TEXT_MAX, type SettingKey } from '../constants';
import { plainHost } from '../web-domains';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** One Ask preset (the same rules src/server/services/ask.ts applies when reading them; unknown fields are dropped). */
export const consultPresetSchema = z.object({
  key: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(60),
  hint: z.string().max(300).default(''),
  model: z.string().trim().min(1).max(64),
  effort: z.enum(EFFORTS),
  contextMode: z.enum(['retrieval', 'ledger', 'everything']),
  maxContextTokens: z.number().int().min(10_000).max(2_000_000),
});

const model = z.string().trim().min(1).max(64);
const shortText = z.string().max(300);
/** A site for the web search's "Find doctors" list: a plain host name the tool takes (web-domains.ts plainHost). */
const siteHost = z
  .string()
  .trim()
  .max(255)
  .refine((h) => plainHost(h) === h.toLowerCase(), 'not a plain site name the web search takes (e.g. example.org: no https://, path, wildcard or bare suffix)')
  .transform((h) => h.toLowerCase());
const longText = z.string().max(LONG_TEXT_MAX);

export const SETTING_SCHEMAS: { [K in SettingKey]: z.ZodType } = {
  'ai.enabled': z.boolean(),
  'ai.models.standard': model,
  'ai.models.deep': model,
  'ai.models.master': model,
  'ai.effort': z.enum(EFFORTS),
  'ai.extraction.effort': z.enum(EFFORTS),
  'ai.crossref.effort': z.enum(EFFORTS),
  'ai.apiKey': z.string().trim().max(400),
  'ai.maxPagesPerChunk': z.number().min(1).max(200).transform((n) => Math.round(n)),
  // Dollars, to the cent; 0 asks every time (zod 4 numbers refuse NaN and Infinity, which would switch the question off).
  'ai.autoResumeCeilingUsd': z.number().min(0).max(1000).transform((n) => Math.round(n * 100) / 100),
  'ask.presets': z
    .array(consultPresetSchema)
    .min(1)
    .max(40)
    .refine((list) => new Set(list.map((p) => p.key)).size === list.length, 'preset keys must be unique'),
  'ask.defaultPreset': z.string().trim().min(1).max(40),
  'ask.showThinking': z.boolean(),
  // Whole minutes; a fraction rounds up so it can never turn the lock off (0 does that).
  'lock.idleMinutes': z.number().min(0).max(1440).transform((n) => Math.ceil(n)),
  'ui.theme': z.enum(['dark', 'dim', 'light']),
  'ui.largeType': z.boolean(),
  'ui.reducedContrast': z.boolean(),
  'patient.name': shortText,
  'patient.dob': shortText,
  'patient.bloodType': shortText,
  'patient.emergencyContacts': longText,
  'patient.summary': longText,
  'patient.chiefOfStaffName': shortText,
  'patient.otherFirstNames': z.array(z.string().trim().min(1).max(60)).max(20),
  'patient.confusedWith': z.array(z.string().trim().min(1).max(60)).max(10),
  // A record number has at least three letters or digits (the check ignores shorter ones).
  'patient.recordNumbers': z.array(z.object({ number: z.string().trim().regex(/[A-Za-z0-9].*[A-Za-z0-9].*[A-Za-z0-9]/, 'a record number has at least three letters or digits').max(40), system: z.string().trim().max(120).default('') })).max(50),
  'migration.patientCheckV1': z.string().max(200),
  'access.lan': z.boolean(),
  'access.lanHost': z.string().trim().max(255),
  'import.icsUids': z.array(z.string().max(1000)).max(200_000),
  'filing.auto': z.boolean(),
  'migration.quietChecksV1': z.boolean(),
  'migration.medNamesV1': z.boolean(),
  'migration.medNamesV2': z.boolean(),
  'ai.webSearch.maxPerRun': z.object({ ask: z.number().int().min(1).max(20), findCandidates: z.number().int().min(1).max(30) }),
  'careTeam.searchRuns': z.array(z.record(z.string(), z.unknown())).max(50),
  'careTeam.searchScope': z.enum(['find_doctors', 'open']),
  'careTeam.licensingBoards': z
    .array(
      z.object({
        state: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'a state is its two-letter code, e.g. OH'),
        host: siteHost,
        name: z.string().trim().max(120).nullish(),
        checked: z.boolean(),
      }),
    )
    .max(60),
  'careTeam.hospitalSites': z.array(siteHost).max(64),
  'ai.webSearch.toolVersion': z.enum(['20250305', '20260209']),
};

/** The parsed value, or the first problem in words. */
export function parseSettingValue(key: SettingKey, value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  const r = SETTING_SCHEMAS[key].safeParse(value);
  if (r.success) return { ok: true, value: r.data };
  const issue = r.error.issues[0];
  const where = issue?.path.length ? ` (${issue.path.join('.')})` : '';
  return { ok: false, error: `setting ${key}${where}: ${issue?.message ?? 'invalid value'}` };
}
