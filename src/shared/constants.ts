export const APP_NAME = 'CaseFile';
export const DEFAULT_PORT = 4810;

/** Bumped whenever the extraction prompt or fact schema changes shape. */
export const EXTRACTION_SCHEMA_VERSION = 4; // 2: attribute pairs, objectivity and asserted_by per fact; 3: lab values as printed, flag_raw, collected/resulted/received dates, sample label, interpretation and limit used; 4: parts (segments) with route hints per kind and tier, messaging acts are not facts, lab values restated in a note are as reported in the note, citations and confidence lenient

/**
 * The most characters any free text the user types may hold: a question to the clinician, a reason, a note, a statement,
 * a visit question, a symptom note, the patient summary. Nearly unbound (about 25 pages); titles and names keep their own
 * short limits.
 */
export const LONG_TEXT_MAX = 100_000;

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * A consult preset is one position on the Ask slider: which model answers,
 * how hard it thinks, and how much of the case it is handed.
 * contextMode: 'retrieval' = top matching pages + facts; 'ledger' = the whole
 * structured ledger (all facts, people, communications, records, medications,
 * labs) plus retrieval; 'everything' = ledger plus as much raw page text as
 * fits in maxContextTokens, most relevant first.
 */
export interface ConsultPreset {
  key: string;
  label: string;
  hint: string;
  model: string;
  effort: Effort;
  contextMode: 'retrieval' | 'ledger' | 'everything';
  maxContextTokens: number;
}

export const DEFAULT_CONSULT_PRESETS: ConsultPreset[] = [
  { key: 'quick', label: 'Quick', hint: 'Simple lookups. Sonnet, low effort, top matches only.', model: 'claude-sonnet-5-5', effort: 'low', contextMode: 'retrieval', maxContextTokens: 60_000 },
  { key: 'standard', label: 'Standard', hint: 'Everyday questions. Sonnet, high effort, ledger plus matches.', model: 'claude-sonnet-5-5', effort: 'high', contextMode: 'ledger', maxContextTokens: 180_000 },
  { key: 'deep', label: 'Deep', hint: 'Hard questions. Opus, extra-high effort, ledger plus many pages.', model: 'claude-opus-5-5', effort: 'xhigh', contextMode: 'everything', maxContextTokens: 450_000 },
  { key: 'master', label: 'Master clinician', hint: 'Takes as long as it needs. Fable 5.1, maximum effort, the whole case.', model: 'claude-fable-5-1', effort: 'max', contextMode: 'everything', maxContextTokens: 850_000 },
];

export const DEFAULT_SETTINGS = {
  'ai.enabled': true,
  'ai.models.standard': 'claude-sonnet-5-5',
  'ai.models.deep': 'claude-opus-5-5',
  'ai.models.master': 'claude-fable-5-1',
  'ai.effort': 'medium' as Effort,
  /** Extraction is transcription, not reasoning: low effort is faster, cheaper and leaves the output budget for facts. */
  'ai.extraction.effort': 'low' as Effort,
  /** The cross-reference pass reasons over the whole ledger; high leaves room for the JSON where max spent the budget thinking. */
  'ai.crossref.effort': 'high' as Effort,
  'ai.apiKey': '' as string,
  'ai.maxPagesPerChunk': 24,
  /**
   * After a restart or unlock, a document whose reading stopped part-way carries on by itself when the estimate for
   * what is left is at most this many dollars; above it, Claude asks once (2026-10-07; $50 since 2026-10-09).
   * 0 = always ask.
   */
  'ai.autoResumeCeilingUsd': 50,
  'ask.presets': DEFAULT_CONSULT_PRESETS as ConsultPreset[],
  'ask.defaultPreset': 'standard',
  'ask.showThinking': true,
  'lock.idleMinutes': 30,
  'ui.theme': 'dark' as 'dark' | 'dim' | 'light',
  'ui.largeType': false,
  'ui.reducedContrast': false,
  'patient.name': '',
  'patient.dob': '',
  'patient.bloodType': '',
  'patient.emergencyContacts': '' as string,
  'patient.summary': '' as string,
  'patient.chiefOfStaffName': 'Chief of staff' as string,
  /**
   * The wrong-patient guard (2026-10-09; shared/patient-identity.ts): other first names the patient goes by (a legal
   * name, a nickname), so a document printing one is never held back; the first names of someone often confused with
   * the patient (such as a twin), so a document printing one is; and the patient's record numbers, each with the health system or facility that gave it.
   */
  'patient.otherFirstNames': [] as string[],
  'patient.confusedWith': [] as string[],
  'patient.recordNumbers': [] as Array<{ number: string; system: string }>,
  /**
   * The Patient details (identitySignature) every document already in the case was last checked against; the check runs
   * again at the next unlock when they change. Set by the server; never shown.
   */
  'migration.patientCheckV1': '' as string,
  /** Serve on the local network as well as 127.0.0.1 (requires restart; trusted home network only). */
  'access.lan': false,
  'access.lanHost': '0.0.0.0',
  /** UIDs of calendar events already imported, so re-importing the same .ics is idempotent. */
  'import.icsUids': [] as string[],
  /** File classified documents automatically (settled at once; each placement can be undone). */
  'filing.auto': true,
  /**
   * The one-time cleanup for quiet checks (2026-10-05) has run: filings that waited for a check were settled, and
   * medications or allergies added only from summaries were taken back. Set by the server; never shown.
   */
  'migration.quietChecksV1': false,
  /**
   * The one-time cleanup for medication names (2026-10-06) has run: medications Claude made from a list heading
   * ("current working list") were taken back. Set by the server; never shown.
   */
  'migration.medNamesV1': false,
  /**
   * The second step of that cleanup (2026-10-06) has run: a medication Claude made a second time under another name of
   * a drug already on the list ("Metformin ER (Example Pharma)" beside "Metformin ER") was taken back and its details filed as
   * history lines on the older one. Set by the server; never shown.
   */
  'migration.medNamesV2': false,
  /**
   * Web search (2026-10-09, the Care team; off by default in Ask, a switch per question): the most searches one run
   * may make. ask = one answer of the clinician; findCandidates = one "Find candidates" run.
   */
  'ai.webSearch.maxPerRun': { ask: 5, findCandidates: 10 } as { ask: number; findCandidates: number },
  /**
   * The web searches made (Find candidates, and Ask's), newest first, at most 50: the queries sent and refused, the
   * searches made, the cost. Shown on the Care team page; the AI log keeps only the counts. Set by the server.
   */
  'careTeam.searchRuns': [] as unknown[],
  /**
   * Request 6 (2026-10-09): where web searches may look. find_doctors = the web search tool's allowed_domains (the
   * fixed doctor-finding sites, the boards of the states named, the candidates' own sites, the hospital and university
   * sites below); open = any site. Used by Find candidates and by Ask's "Search the web".
   */
  'careTeam.searchScope': 'find_doctors' as 'find_doctors' | 'open',
  /**
   * State licensing board sites for "Find doctors" (listed when a search names the state): the home state and its
   * neighbours, filled in Settings (empty here), e.g. { state: 'XX', host: 'medboard.example.gov', name: 'Example
   * State Medical Board', checked: false }; checked = a person opened it and confirmed it.
   */
  'careTeam.licensingBoards': [] as Array<{ state: string; host: string; name?: string | null; checked: boolean }>,
  /** Hospital and university sites "Find doctors" also allows (plain host names; empty to start). */
  'careTeam.hospitalSites': [] as string[],
  /**
   * The web search tool version: 20250305 (the documented response shape; the default) or 20260209 (dynamic filtering,
   * results may come inside code execution; not for Haiku models, which always get 20250305).
   */
  'ai.webSearch.toolVersion': '20250305' as '20250305' | '20260209',
};

export type SettingKey = keyof typeof DEFAULT_SETTINGS;
export type Settings = typeof DEFAULT_SETTINGS;

/**
 * USD per million tokens. Used only for the on-screen estimate. Cache writes are priced at the 1-hour rate (twice the
 * input price): every cache breakpoint in the app is 1h (DECISIONS 23), and the 5-minute rate (1.25x) would show
 * them 37.5% short.
 */
export const MODEL_PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 20 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 4 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 4 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 2 },
};

export const MODEL_CHOICES = [
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5',
];

export const MODEL_LABELS: Record<string, string> = {
  'claude-fable-5-1': 'Fable 5.1 (most capable, slow, 1M context)',
  'claude-opus-5-5': 'Opus 5.5 (deep, 1M context)',
  'claude-sonnet-5-5': 'Sonnet 5.5 (fast, 1M context)',
  'claude-opus-5': 'Opus 5',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-haiku-4-5': 'Haiku 4.5 (fastest, 200K context)',
};

/** Context window per model, used to cap what Ask sends. */
export const MODEL_CONTEXT_TOKENS: Record<string, number> = {
  'claude-fable-5-1': 1_000_000,
  'claude-opus-5-5': 1_000_000,
  'claude-sonnet-5-5': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-haiku-4-5': 200_000,
};
