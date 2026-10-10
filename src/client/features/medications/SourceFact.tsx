import { Link } from '@tanstack/react-router';
import { Tag } from '../../ui/StatusTag';
import type { SourceFactCitation, SourceFactRef } from '../../api/medications';
import { SourceCheck } from './MedTags';

/**
 * Where a row or an event came from: what the document says, the words quoted from its page, and a button that opens
 * that page (the document's name and page). Your answer about the detail shows only when it says something
 * (MedTags SourceCheck). A quote that was not found on the page is said so, never hidden.
 */
export function SourceFactLine({ fact, onOpenCitation, compact }: { fact: SourceFactRef; onOpenCitation: (c: SourceFactCitation) => void; compact?: boolean }) {
  const c = fact.citation;
  return (
    <div className={`med-fact${c && !c.verified ? ' unverified' : ''}`}>
      {!compact ? <div className="statement">{fact.statement}</div> : null}
      {c && !compact ? <div className="quote">“{c.quote}”</div> : null}
      <div className="med-fact-from">
        {c ? (
          <button type="button" className={`cite${c.verified ? '' : ' unverified'}`} onClick={() => onOpenCitation(c)} title={c.verified ? 'Open the page these words are on' : 'These words were not found on the page; opens the page'}>
            {fact.documentTitle ?? 'The document'} · p.{c.pageNumber}
          </button>
        ) : fact.documentTitle ? (
          <span className="muted">{fact.documentTitle}</span>
        ) : (
          <span className="muted">No page quoted</span>
        )}
        {c && !c.verified ? <span className="med-fact-warn">quote not found on the page</span> : null}
        <SourceCheck status={fact.status} basis={fact.verdictBasis} />
        {fact.deleted ? <Tag tone="ash">detail deleted</Tag> : null}
        <Link to="/facts" search={{ id: fact.id }} className="med-fact-link">
          See it in Details from documents
        </Link>
      </div>
    </div>
  );
}
