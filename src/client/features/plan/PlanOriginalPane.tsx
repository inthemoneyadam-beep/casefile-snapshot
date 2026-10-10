/**
 * Right pane of the Plan page's Original tab: the page of the plan document a passage is on, its text with every
 * passage the plan's items came from marked (the chosen one stronger), and a quote that was not found on the page
 * said plainly. The file itself opens in a new tab; the whole document in Documents.
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { DetailHeader, DetailPane } from '../../ui/DetailPane';
import { Tag } from '../../ui/StatusTag';
import { fileUrl } from '../../api/documents';
import type { PlanOriginal, PlanPassage } from '../../api/plans';

interface Span {
  start: number;
  end: number;
  strong: boolean;
  key: string;
}

/** The page text cut into plain and marked pieces: each passage found there, overlaps skipped, the chosen one strong. */
export function markedPieces(text: string, passages: ReadonlyArray<Pick<PlanPassage, 'key' | 'start' | 'end'>>, chosen: string | null): Array<string | Span & { text: string }> {
  const spans: Span[] = passages
    .filter((p) => p.start != null && p.end != null && p.end > p.start)
    .map((p) => ({ start: Math.max(0, p.start!), end: Math.min(text.length, p.end!), strong: p.key === chosen, key: p.key }))
    .sort((a, b) => a.start - b.start || Number(b.strong) - Number(a.strong));
  const out: Array<string | (Span & { text: string })> = [];
  let pos = 0;
  for (const s of spans) {
    if (s.start < pos) continue;
    if (s.start > pos) out.push(text.slice(pos, s.start));
    out.push({ ...s, text: text.slice(s.start, s.end) });
    pos = s.end;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

export function PlanOriginalPane({ original, passage, onOpenItem }: { original: PlanOriginal; passage: PlanPassage | null; onOpenItem: (itemId: string) => void }) {
  const pageNo = passage?.page ?? original.pages[0]?.page ?? 1;
  const page = original.pages.find((p) => p.page === pageNo) ?? null;
  const onPage = useMemo(() => original.passages.filter((p) => p.page === pageNo), [original.passages, pageNo]);
  const pieces = useMemo(() => (page ? markedPieces(page.text, onPage, passage?.key ?? null) : []), [page, onPage, passage?.key]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector('mark[data-chosen="1"]')?.scrollIntoView({ block: 'center' });
  }, [passage?.key, pageNo]);
  const body: ReactNode = pieces.map((p, i) =>
    typeof p === 'string' ? (
      p
    ) : (
      <mark key={`${p.key}-${i}`} className={p.strong ? 'hl strong' : 'hl'} data-chosen={p.strong ? '1' : undefined}>
        {p.text}
      </mark>
    ),
  );
  return (
    <DetailPane label="The plan document">
      <DetailHeader
        eyebrow={<span>The plan document · page {pageNo} of {original.pageCount}</span>}
        title={original.title}
        status={[
          passage ? (
            <span key="item">
              {passage.kindWords}:{' '}
              <button type="button" className="plan-link" onClick={() => onOpenItem(passage.itemId)}>
                {passage.itemTitle}
              </button>
            </span>
          ) : null,
          passage ? (
            passage.verified ? (
              <Tag key="v" tone="ok">
                found on the page
              </Tag>
            ) : (
              <Tag key="v" tone="warn" title="Kept and marked: the quote was not found on this page word for word">
                not found on the page
              </Tag>
            )
          ) : null,
        ]}
        actions={
          <span className="row">
            <a className="btn sm" href={fileUrl(original.documentId)} target="_blank" rel="noopener noreferrer" title="The file as you added it, in a new tab">
              Open the file
            </a>
            <Link className="btn sm ghost" to="/documents/$id" params={{ id: original.documentId }} search={{ page: pageNo, tab: 'text' }}>
              Open in Documents
            </Link>
          </span>
        }
      />
      {passage && (!passage.verified || passage.start == null) ? (
        <p className="notice warn small plan-unfound">
          {passage.verified ? 'Found on this page in reading order; it is not marked in the text below.' : 'Not found on this page word for word. Claude quoted:'} “{passage.quote}”
        </p>
      ) : null}
      {page ? (
        <div className="pagetext plan-pagetext" ref={ref}>
          {body}
        </div>
      ) : (
        <p className="muted">This page has no text.</p>
      )}
      {original.pagesLeftOut ? <p className="muted small">Pages without a passage are left out here ({original.pagesLeftOut}); Open in Documents shows them all.</p> : null}
    </DetailPane>
  );
}
