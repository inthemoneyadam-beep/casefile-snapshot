/**
 * Ask the clinician and the web (2026-10-09, the user's request 5): the "Search the web" switch (off by default, off again
 * after each question) with its cost, and under an answer the outside sources it read, apart from the citations of
 * your records: each [web N] with its link and the day read, the words searched (and any refused, never sent), and
 * anyone proposed for the Care team (waiting for your yes).
 */
import { Link } from '@tanstack/react-router';
import { useSettings } from '../../api/hooks';
import { estimateAskWebSearch, queryReasonWords, usdWords } from '@shared/care-team';
import { SEARCH_SCOPE_WORDS, readSearchScope, type SearchScope } from '@shared/web-domains';
import type { AskMeta } from '@shared/ask';
import './care-team.css';

/** The searches one answer may make (Settings, 5 by default) and the model the searches run on. */
export function useAskWebCap(): { cap: number; model: string; scope: SearchScope } {
  const s = useSettings();
  const v = s.data?.['ai.webSearch.maxPerRun'] as { ask?: number } | undefined;
  return { cap: typeof v?.ask === 'number' && v.ask >= 1 ? v.ask : 5, model: s.data?.['ai.models.standard'] ?? 'claude-sonnet-5-5', scope: readSearchScope(s.data?.['careTeam.searchScope']) };
}

/** " · web search on (Find doctors): up to 5 searches, about $0.30 more" (added to the cost line). */
export function webSearchCostWords(clinicianModel: string, web: { cap: number; model: string; scope?: SearchScope } = { cap: 5, model: 'claude-sonnet-5-5' }): string {
  const cap = web.cap;
  const e = estimateAskWebSearch(web.model, cap, clinicianModel);
  return ` · web search on (${SEARCH_SCOPE_WORDS[web.scope ?? 'find_doctors']}): up to ${cap} searches, ${usdWords(e.usd)} more`;
}

export function WebSearchSwitch({ on, onChange, compact }: { on: boolean; onChange: (v: boolean) => void; compact?: boolean }) {
  return (
    <label
      className="ask-check"
      title="Lets the clinician search the web for this question only (clinicians, clinics, services by place or specialty). Only search words go out: never your name, date of birth, record numbers or words from your records. Off again after the question."
    >
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      {compact ? 'Web' : 'Search the web'}
    </label>
  );
}

export function AskWebSources({ meta }: { meta: AskMeta }) {
  const sources = meta.webSources ?? [];
  const searches = meta.webSearches ?? [];
  const sent = searches.flatMap((s) => s.queries);
  const refused = searches.flatMap((s) => s.refused);
  const proposed = meta.careProposals ?? [];
  return (
    <div className="ask-web" aria-label="Outside sources from the web">
      <div className="ask-web-head">Outside sources (web)</div>
      <p className="muted">From web pages, not your records. They are never citations of your records.</p>
      {sources.length ? (
        <ol>
          {sources.map((s) => (
            <li key={s.n} value={s.n}>
              <span className="mono">web {s.n}</span>{' '}
              <a href={s.url} target="_blank" rel="noopener noreferrer nofollow">
                {s.title || s.url}
              </a>{' '}
              <span className="muted">(read {s.readAt})</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">The searches found no pages.</p>
      )}
      {sent.length ? (
        <p className="muted">
          Searched for: {sent.map((q, i) => (
            <span key={i}>
              {i ? '; ' : ''}
              <span className="ct-query">{q}</span>
            </span>
          ))}
        </p>
      ) : null}
      {refused.length ? (
        <p className="muted">
          Refused, never sent: {refused.map((r, i) => (
            <span key={i}>
              {i ? '; ' : ''}
              <span className="ct-query">{r.query}</span> ({queryReasonWords(r.reasons).replace(/\.$/, '').toLowerCase()})
            </span>
          ))}
          .
        </p>
      ) : null}
      {proposed.length ? (
        <p>
          {proposed.length === 1 ? 'One candidate waits' : `${proposed.length} candidates wait`} for your yes on the{' '}
          <Link to="/care-team" search={{ view: 'proposed' }}>
            Care team
          </Link>{' '}
          page.
        </p>
      ) : null}
    </div>
  );
}
