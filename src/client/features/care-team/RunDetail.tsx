/**
 * The Care team page's "Web searches" view, right pane (moved out of routes/care-team.tsx in review, 2026-10-09): one
 * web search with the exact words sent, the ones refused (never sent), what the web tool searched, and the cost.
 */
import { RUN_STATUS_WORDS, queryReasonWords, usdWords, type SearchRun } from '@shared/care-team';
import { SEARCH_SCOPE_WORDS } from '@shared/web-domains';
import { roleWords } from './words';
import { Tag } from '../../ui/StatusTag';
import { DateTimeText } from '../../ui/DateText';
import { DetailHeader, DetailPane } from '../../ui/DetailPane';
import { Section } from '../../ui/PageHeader';

/** One web search: the exact words sent, the ones refused (never sent), what the web tool searched, the cost. Stop is for owners and editors (no onStop for a viewer). */
export function RunDetail({ run, onStop }: { run: SearchRun; onStop?: () => void }) {
  return (
    <DetailPane label="Web search">
      <DetailHeader
        eyebrow={<span>{run.kind === 'find' ? 'Find candidates' : 'Ask the clinician'}</span>}
        title={run.queries[0] ?? 'Nothing sent'}
        status={[
          <Tag key="s" tone={run.status === 'done' ? 'ok' : run.status === 'running' ? 'info' : run.status === 'failed' ? 'bad' : 'ash'}>
            {RUN_STATUS_WORDS[run.status]}
          </Tag>,
          `${run.searches} search${run.searches === 1 ? '' : 'es'} of up to ${run.maxSearches}`,
          run.status === 'running' ? `up to ${usdWords(run.estimateUsd)}` : usdWords(run.usd),
          run.kind === 'find' && run.status === 'done' ? `${run.proposed} proposed` : null,
        ]}
        actions={run.status === 'running' && onStop ? { secondary: [{ label: 'Stop', onClick: onStop, title: 'Stop this search' }] } : undefined}
        facts={[
          { label: 'Started', value: <DateTimeText iso={run.startedAt} />, mono: true },
          run.by ? { label: 'By', value: run.by } : null,
          run.kind === 'find' ? { label: 'Already known', value: `${run.duplicates} (on your list, waiting, or turned down)` } : null,
          { label: 'Pages read', value: String(run.results), mono: true },
          run.scope ? { label: 'Search scope', value: run.scope === 'open' ? 'Open: any site' : `${SEARCH_SCOPE_WORDS.find_doctors}: ${run.domains?.length ?? 0} site${run.domains?.length === 1 ? '' : 's'}` } : null,
          run.toolVersion ? { label: 'Web search version', value: run.toolVersion.replace(/^web_search_/, ''), mono: true } : null,
        ].filter((x): x is NonNullable<typeof x> => Boolean(x))}
      />
      {run.error ? <div className="notice warn small">{run.error}</div> : null}
      {run.criteria ? (
        <Section title="What you typed">
          <ul className="ct-lines">
            {run.criteria.condition ? <li>Condition or need: {run.criteria.condition}</li> : null}
            {run.criteria.kind ? <li>Kind of clinician or service: {run.criteria.kind}</li> : null}
            {run.criteria.role ? <li>Role: {roleWords(run.criteria.role)}</li> : null}
            {run.criteria.place ? <li>Where: {run.criteria.place}</li> : null}
            {run.criteria.licensedIn ? <li>Licensed in: {run.criteria.licensedIn}</li> : null}
          </ul>
        </Section>
      ) : null}
      <Section title="Sent" count={run.queries.length}>
        <ul className="ct-lines">
          {run.queries.map((q, i) => (
            <li key={i} className="ct-query">
              {q}
            </li>
          ))}
        </ul>
      </Section>
      {run.refused.length ? (
        <Section title="Refused, never sent" count={run.refused.length}>
          <ul className="ct-lines">
            {run.refused.map((r, i) => (
              <li key={i}>
                <span className="ct-query">{r.query}</span>
                <div className="muted">{queryReasonWords(r.reasons)}</div>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {run.queriesMade.length ? (
        <Section title="What the web tool searched" count={run.queriesMade.length}>
          <ul className="ct-lines">
            {run.queriesMade.map((q, i) => (
              <li key={i} className="ct-query">
                {q}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {run.scope === 'find_doctors' && run.domains?.length ? (
        <Section title="Sites allowed" count={run.domains.length} intro="Find doctors: the web search kept to these sites (and their subdomains).">
          <p className="ct-sites">{run.domains.join(', ')}</p>
          {run.domainsLeftOut?.length ? (
            <div className="notice warn small">
              Left out, past the limit of 64: {run.domainsLeftOut.join(', ')}.
            </div>
          ) : null}
        </Section>
      ) : null}
      {run.flagged?.length ? (
        <div className="notice bad small">
          The web tool searched {run.flagged.length === 1 ? 'something' : `${run.flagged.length} things`} the check would have refused: {run.flagged.map((f) => `"${f.query}"`).join(', ')}. It only ever saw the words above.
        </div>
      ) : null}
    </DetailPane>
  );
}

