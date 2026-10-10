/**
 * The Search page's reading pane: the selected result read in place, so j / k
 * walks the results without leaving the page. One anatomy for every kind:
 * what it is (eyebrow), its name, one status line, the actions (Open first),
 * a few key facts, then what matched:
 *   a page      the whole page's text with the words marked, scrolled to the first match
 *   a detail    its check, the document it came from and the quotes it was read from
 *   a document  where it matched, and its first lines
 *   the rest    where it matched
 * Ids never show; they stay in the links.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useDocuments, type DocumentListItem, type PageWindow } from '../../api/documents';
import { useFact } from '../../api/facts';
import { documentTypeLabel } from '../../api/filing';
import { DetailHeader, DetailPane, type KeyFact } from '../../ui/DetailPane';
import { EmptyState, Loading, Section } from '../../ui/PageHeader';
import { DateText } from '../../ui/DateText';
import { CheckTag } from '../reconcile/CheckTag';
import { highlight, highlightKeepDates } from './highlight';
import { OPEN_WORDS, TYPE_ONE, factStatusWords, hitTitle, isHitType, matchCount } from './words';

export interface PreviewHit {
  type: string;
  id: string;
  title: string;
  snippet?: string;
  date?: string | null;
  href: string;
  documentId?: string;
  pageNumber?: number;
}

export interface HitPreviewProps {
  hit: PreviewHit;
  tokens: string[];
  /** Go where the result lives. */
  onOpen: () => void;
  /** Open another place in the app (the document's details, a quoted page). */
  onGo: (to: string) => void;
}

function usePage(documentId: string | undefined, page: number | undefined) {
  return useQuery({
    queryKey: ['search', 'page-text', documentId, page],
    queryFn: () => api.get<PageWindow>(`/api/documents/${documentId}/pages${api.qs({ from: page, to: page })}`),
    enabled: Boolean(documentId && page),
    staleTime: 60_000,
  });
}

/** Document facts that carry a value: type, date, where it came from. Empty ones are left out. */
function documentFacts(doc: DocumentListItem | undefined): KeyFact[] {
  if (!doc) return [];
  const out: KeyFact[] = [{ label: 'Type', value: documentTypeLabel(doc.category) }];
  if (doc.documentDate) out.push({ label: 'Date', value: <DateText iso={doc.documentDate} precision={doc.documentDatePrecision} text={doc.documentDateText} /> });
  if (doc.institutionName) out.push({ label: 'From', value: doc.institutionName });
  return out;
}

/** The page's text with the matched words marked; the box scrolls itself to the first match. */
function MarkedText({ text, tokens }: { text: string; tokens: string[] }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    const first = el?.querySelector<HTMLElement>('mark.hl');
    if (el && first) el.scrollTop = Math.max(0, first.offsetTop - 48);
    else if (el) el.scrollTop = 0;
  }, [text, tokens]);
  return (
    <div className="search-pagetext" ref={box} tabIndex={0} aria-label="The page's text, matching words marked">
      {highlight(text, tokens)}
    </div>
  );
}

export function HitPreview({ hit, tokens, onOpen, onGo }: HitPreviewProps) {
  const type = isHitType(hit.type) ? hit.type : null;
  const docs = useDocuments({});
  const docId = hit.type === 'document' ? hit.id : hit.documentId;
  const doc = docId ? docs.data?.items.find((d) => d.id === docId) : undefined;
  const page = usePage(hit.type === 'page' ? hit.documentId : hit.type === 'document' ? hit.id : undefined, hit.type === 'page' ? hit.pageNumber : hit.type === 'document' ? 1 : undefined);
  const fact = useFact(hit.type === 'fact' ? hit.id : null);

  const openAction = { label: type ? OPEN_WORDS[type] : 'Open', onClick: onOpen, shortcut: 'enter', title: 'Go to where this result lives in the case' };
  const eyebrow = type ? TYPE_ONE[type] : 'Result';

  if (hit.type === 'fact') {
    const f = fact.data;
    const statusWords = factStatusWords(hit.snippet);
    const citations = f?.citations ?? [];
    const firstCite = citations[0];
    return (
      <DetailPane label="The selected result">
        <DetailHeader
          eyebrow={
            <>
              <span>{eyebrow}</span>
              {f?.trust ? <CheckTag trust={f.trust} /> : null}
            </>
          }
          title={highlightKeepDates(f?.statement ?? hit.title, tokens)}
          status={[
            f?.date || hit.date ? <DateText key="d" iso={f?.date ?? hit.date} precision={f?.datePrecision} text={f?.dateText} /> : null,
            f?.document ? <span key="doc">from {f.document.title}</span> : null,
            !f && statusWords ? <span key="s">{statusWords}</span> : null,
          ]}
          actions={{
            primary: openAction,
            secondary: [
              firstCite ? { label: citations.length > 1 ? 'Open the first quoted page' : 'Open the quoted page', onClick: () => onGo(`/documents/${firstCite.documentId}?page=${firstCite.pageNumber}&cite=${firstCite.id}`), title: 'The page this detail was read from, with the quote marked' } : null,
            ],
          }}
        />
        {fact.isPending ? <Loading>Loading the detail…</Loading> : null}
        {fact.isError ? <p className="muted">This detail could not be loaded; Open shows it in Details from documents.</p> : null}
        {f ? (
          <Section title="Quoted from the document" count={citations.length || undefined} intro={citations.length ? 'The words Claude read this detail from.' : undefined}>
            {citations.length ? (
              <ul className="search-quotes">
                {citations.map((c) => (
                  <li key={c.id}>
                    <blockquote>{highlightKeepDates(c.quote, tokens)}</blockquote>
                    <div className="search-quote-foot">
                      <span className="mono">page {c.pageNumber}</span>
                      {c.verified ? null : <span className="search-warn">not found on the page as written</span>}
                      <button type="button" className="btn ghost sm" onClick={() => onGo(`/documents/${c.documentId}?page=${c.pageNumber}&cite=${c.id}`)}>
                        Open the page
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No quote is kept for this detail.</p>
            )}
          </Section>
        ) : null}
      </DetailPane>
    );
  }

  if (hit.type === 'page' || hit.type === 'document') {
    const text = page.data?.items[0]?.text ?? '';
    const title = doc?.title ?? hitTitle(hit);
    const n = text ? matchCount(text, tokens) : 0;
    const where = hit.type === 'page' ? 'on this page' : 'on the first page';
    return (
      <DetailPane label="The selected result">
        <DetailHeader
          eyebrow={<span>{eyebrow}</span>}
          title={highlightKeepDates(title, tokens)}
          status={[
            hit.type === 'page' ? <span key="p">Page {hit.pageNumber ?? 1}{doc?.pageCount ? ` of ${doc.pageCount}` : ''}</span> : doc?.pageCount ? `${doc.pageCount} page${doc.pageCount === 1 ? '' : 's'}` : null,
            text ? (n ? `${n} match${n === 1 ? '' : 'es'} ${where}` : `no match ${where}`) : null,
          ]}
          actions={{
            primary: openAction,
            secondary: [docId ? { label: 'Document details', onClick: () => onGo(`/documents?id=${docId}`), title: 'The document in the Documents list: its summary, where it came from and what Claude pulled out of it' } : null],
          }}
          facts={documentFacts(doc)}
        />
        {hit.type === 'document' && hit.snippet ? (
          <Section title="Where it matches">
            <p className="search-snippet">{highlight(hit.snippet, tokens)}</p>
          </Section>
        ) : null}
        <Section title={hit.type === 'page' ? 'On this page' : 'First page'} intro={hit.type === 'page' ? 'The text Claude read from the page; the words you searched for are marked.' : undefined}>
          {page.isPending ? <Loading>Loading the page…</Loading> : text.trim() ? <MarkedText text={text} tokens={tokens} /> : <p className="muted">No text was read from this page.</p>}
        </Section>
      </DetailPane>
    );
  }

  return (
    <DetailPane label="The selected result">
      <DetailHeader eyebrow={<span>{eyebrow}</span>} title={highlightKeepDates(hit.title, tokens)} status={hit.date ? [<DateText key="d" iso={hit.date} />] : undefined} actions={{ primary: openAction }} />
      <Section title="Where it matches">{hit.snippet ? <p className="search-snippet">{highlight(hit.snippet, tokens)}</p> : <p className="muted">The words matched its name.</p>}</Section>
    </DetailPane>
  );
}

/** The right pane before a result is picked: what it will show, and how to get there. */
export function PreviewHint(): ReactNode {
  return (
    <EmptyState title="Pick a result">
      The result you pick shows here: a page with the words marked, a detail with the quote it was read from. Move with j and k (or the arrow keys in the search box); Enter opens it where it lives.
    </EmptyState>
  );
}
