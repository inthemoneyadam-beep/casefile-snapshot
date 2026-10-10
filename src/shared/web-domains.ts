/**
 * The web search scope (2026-10-09, the user's request 6; lead's corrections): "Find doctors" (the default) limits the
 * web search tool to doctor-finding sites through the API's allowed_domains option, so the tool enforces it, not the
 * prompt; "Open" sends no list and allows any site. Shared by the server (services/web-search.ts builds the list for
 * Find candidates and Ask's "Search the web") and the browser (Settings and the Care team page show it).
 *
 * The tool's rules for allowed_domains: at most 64 plain host names per request, each covering its subdomains; no
 * scheme, port, path or wildcard; no IP address, single-label name, bare suffix ("edu", "gov", "co.uk") or local name.
 * Practice, hospital and university sites cannot all be listed in advance, so "Find doctors" sends, in this order:
 * the three fixed sites, the licensing boards of the states the search names (a table in Settings), every accepted
 * candidate's own website, and the "Hospital and university sites" list in Settings. Past 64 is left out and the run
 * says so. Nothing here touches the database.
 */
import { US_STATES } from './care-team';

export const SEARCH_SCOPES = ['find_doctors', 'open'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];
export const SEARCH_SCOPE_WORDS: Record<SearchScope, string> = { find_doctors: 'Find doctors', open: 'Open' };
export const SEARCH_SCOPE_HINTS: Record<SearchScope, string> = {
  find_doctors: 'Only doctor-finding sites: docinfo.org, healthgrades.com, doximity.com, the licensing boards of the states you name, the websites of the people on your list, and your hospital and university sites. The web tool itself keeps to them.',
  open: 'Any site on the web.',
};
export function readSearchScope(v: unknown): SearchScope {
  return v === 'open' ? 'open' : 'find_doctors';
}

/** Always first in "Find doctors", in this order (the patient's list). */
export const FIND_DOCTORS_SITES = ['docinfo.org', 'healthgrades.com', 'doximity.com'] as const;
/** The web search tool takes at most this many sites per request. */
export const MAX_ALLOWED_DOMAINS = 64;

/** A state's licensing board site. `checked`: a person opened it and confirmed it is the board (Settings). */
export interface LicensingBoard {
  state: string;
  host: string;
  name?: string | null;
  checked: boolean;
}

/** The web search tool versions (Settings, Advanced): 20250305 is the documented one and the default. */
export const WEB_SEARCH_TOOL_VERSIONS = ['20250305', '20260209'] as const;
export type WebSearchToolVersion = (typeof WEB_SEARCH_TOOL_VERSIONS)[number];
export function readToolVersion(v: unknown): WebSearchToolVersion {
  return v === '20260209' ? '20260209' : '20250305';
}

const LOCAL_SUFFIX = /(^|\.)(localhost|local|internal|localdomain|invalid)$/;
/** Second-level labels that are registries, not sites: "co.uk", "gov.au", "edu.au", "k12" and the like. */
const REGISTRY_LABELS = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'mil', 'nhs', 'gob', 'gouv', 'nic', 'sch', 'ltd', 'plc', 'info', 'biz', 'k12', 'lib', 'state', 'med']);
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A site as the web search tool takes it: a plain host name, lower case, without "www." (a listed site covers its
 * subdomains, www included). A pasted link is read for its host. Null for anything the tool refuses: a wildcard, an IP
 * address, a single label, a bare suffix ("edu", "gov", "co.uk", "oh.us"), a local name, or not a host at all.
 */
export function plainHost(raw: string | null | undefined): string | null {
  const t = (raw ?? '').trim().toLowerCase();
  if (!t || t.includes('*') || /\s/.test(t)) return null;
  let host: string;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(t) ? t : `https://${t}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    host = u.hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.$/, '').replace(/^www\./, '');
  if (!host || host.length > 253 || host.includes(':') || host.startsWith('[')) return null;
  if (/^\d+(\.\d+){3}$/.test(host)) return null;
  if (LOCAL_SUFFIX.test(host)) return null;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,63}$/.test(tld) && !/^xn--[a-z0-9-]+$/.test(tld)) return null;
  if (labels.length === 2 && tld.length === 2 && REGISTRY_LABELS.has(labels[0])) return null;
  if (labels.length === 2 && tld === 'us' && US_STATES[labels[0].toUpperCase()]) return null;
  return host;
}

const STATE_NAMES = Object.entries(US_STATES)
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => b.name.length - a.name.length);

/**
 * State codes that are also words or medical abbreviations in a search ("MS", "MD", "PA or NP", "OR",
 * "IN"): read as a state only after a comma ("Jackson, MS") or alone ("MS" typed as the licence state). Review
 * 2026-10-09: such codes are common in searches.
 */
const AMBIGUOUS_CODES = new Set(['MS', 'MD', 'PA', 'OR', 'IN', 'ME', 'OK', 'HI', 'OH', 'DE', 'CO', 'LA', 'MA', 'MO', 'AL']);

/**
 * The states a search names, as codes, in the order they first appear: full names ("Ohio", "west virginia") and
 * two-letter codes written in capitals ("Columbus, OH"; the codes that are also abbreviations only after a comma or alone).
 */
export function statesNamed(texts: ReadonlyArray<string | null | undefined>): string[] {
  const found: Array<{ pos: number; code: string; n: number }> = [];
  texts.forEach((raw, n) => {
    let work = raw ?? '';
    for (const { code, name } of STATE_NAMES) {
      const re = new RegExp(`\\b${name.replace(/ /g, '\\s+')}\\b`, 'gi');
      work = work.replace(re, (m, pos: number) => {
        found.push({ pos, code, n });
        return ' '.repeat(m.length);
      });
    }
    const alone = work.trim();
    for (const m of work.matchAll(/(,\s*)?\b([A-Z]{2})\b/g)) {
      const code = m[2];
      if (!US_STATES[code]) continue;
      if (AMBIGUOUS_CODES.has(code) && !m[1] && alone !== code) continue;
      found.push({ pos: (m.index ?? 0) + (m[1]?.length ?? 0), code, n });
    }
  });
  found.sort((a, b) => a.n - b.n || a.pos - b.pos);
  return [...new Set(found.map((f) => f.code))];
}

export interface DomainPlan {
  scope: SearchScope;
  /** The sites sent as allowed_domains, in order (at most 64); null for Open (no list is sent). */
  domains: string[] | null;
  /** Sites past the limit, left out. */
  leftOut: string[];
  /** The states the search named (their boards are listed). */
  states: string[];
  /** Entries that are not plain host names the tool takes (never sent). */
  skipped: string[];
}

/**
 * The sites "Find doctors" allows, in order: the three fixed sites, the boards of the states named, each accepted
 * candidate's website, the hospital and university sites. Plain host names only, each once (a site already covered by
 * a listed parent is not listed again), at most 64; the rest is left out. "Open": no list.
 */
export function buildAllowedDomains(p: {
  scope: SearchScope;
  /** Everything the search names states in: the queries, and the typed place and licence state. */
  texts: ReadonlyArray<string | null | undefined>;
  boards: readonly LicensingBoard[];
  candidateSites: ReadonlyArray<string | null | undefined>;
  hospitalSites: ReadonlyArray<string | null | undefined>;
}): DomainPlan {
  const states = statesNamed(p.texts);
  if (p.scope === 'open') return { scope: 'open', domains: null, leftOut: [], states, skipped: [] };
  const ordered: Array<string | null | undefined> = [...FIND_DOCTORS_SITES];
  for (const s of states) for (const b of p.boards) if ((b.state ?? '').trim().toUpperCase() === s) ordered.push(b.host);
  ordered.push(...p.candidateSites, ...p.hospitalSites);
  const all: string[] = [];
  const skipped: string[] = [];
  for (const raw of ordered) {
    if (!raw || !raw.trim()) continue;
    const h = plainHost(raw);
    if (!h) {
      skipped.push(raw);
      continue;
    }
    // Each site once: a site under one already listed is covered by it. A site whose subdomains were listed first
    // takes the place of the first of them, and the others go (review 2026-10-09: both were sent, using up the 64).
    if (all.some((d) => h === d || h.endsWith(`.${d}`))) continue;
    const under = all.findIndex((d) => d.endsWith(`.${h}`));
    if (under < 0) {
      all.push(h);
      continue;
    }
    all[under] = h;
    for (let i = all.length - 1; i > under; i--) if (all[i].endsWith(`.${h}`)) all.splice(i, 1);
  }
  return { scope: 'find_doctors', domains: all.slice(0, MAX_ALLOWED_DOMAINS), leftOut: all.slice(MAX_ALLOWED_DOMAINS), states, skipped };
}

/** "Find doctors: 12 sites", "Find doctors: 64 sites, 3 left out (the limit is 64)", "Open: any site". */
export function scopeLine(plan: Pick<DomainPlan, 'scope' | 'domains' | 'leftOut'>): string {
  if (plan.scope === 'open' || !plan.domains) return 'Search scope: Open (any site)';
  const n = plan.domains.length;
  return `Search scope: Find doctors (${n} site${n === 1 ? '' : 's'}${plan.leftOut.length ? `; ${plan.leftOut.length} more left out, the limit is ${MAX_ALLOWED_DOMAINS}` : ''})`;
}
