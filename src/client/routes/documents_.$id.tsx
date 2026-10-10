/**
 * /documents/$id — one document, full page: its summary (what Claude found in
 * it), the text of every page with cited passages marked, or the original file,
 * chosen under Show:. The details pulled from it are listed on the right; c
 * opens one in Details from documents to answer it.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { z } from 'zod';
import { Loading, PageHeader } from '../ui/PageHeader';
import { Button } from '../ui/Button';
import { FilterGroup, SearchField, Segmented, Toolbar } from '../ui/Toolbar';
import { Tag, FactStatusTag, TrustTag, TRUST_ORDER } from '../ui/StatusTag';
import { DateText } from '../ui/DateText';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { useToast } from '../ui/Toast';
import { useRegisterCommands } from '../app/commands';
import { useBindings } from '../app/shortcuts';
import {
  fetchFactDetail,
  fileUrl,
  pageImageUrl,
  useCitation,
  useDocument,
  useDocumentFacts,
  pageBuckets,
  useDocumentPageRanges,
  useExtractDocument,
  type DocumentPage,
  type FactRow,
  type PageRange,
} from '../api/documents';
import { DocumentBrief, useTestRanges } from '../features/documents/DocumentBrief';
import { highlightPieces, locateQuote, normaliseRanges, spanHoldsQuote } from '../features/documents/cite';
import { useDocumentBrief, type DocumentTierFields } from '../features/documents/api';
import { documentTypeLabel } from '../api/filing';
import { TierTag } from '../features/documents/tier';
import { documentStatus } from '../features/documents/status';
import { CoverageSection } from '../features/documents/CoveragePanel';
import { ToolbarKeys } from '../ui/Toolbar';
import '../features/documents/documents.css';
import { checkOfDocument, isHeldDocument } from '../api/patient-check';
import { HELD_EXPLAIN, HELD_WORDS } from '../features/patient-check/words';
import { heldWords } from '@shared/patient-identity';
import { useMe } from '../api/users';
import { useSelfCheckAction } from '../features/self-check/useSelfCheckAction';

const WINDOW = 30;

/** How the quote was found on the page, in words (the same as a detail's citations). */
const MATCH_WORDS: Record<string, string> = { exact: 'word for word', normalized: 'same words, spacing differs', fuzzy: 'close match' };


const searchSchema = z.object({
  page: z.coerce.number().int().min(1).optional().catch(undefined),
  cite: z.string().optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  tab: z.enum(['brief', 'text', 'original']).optional().catch(undefined),
  img: z.enum(['ocr', 'all', 'none']).optional().catch(undefined),
  /** The fact selected in the side list. */
  fact: z.string().optional().catch(undefined),
});
type ViewerSearch = z.infer<typeof searchSchema>;

/** Image types the browser shows from the original bytes; anything else is shown as the server's PNG render. */
const BROWSER_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);

export const Route = createFileRoute('/documents_/$id')({
  validateSearch: (search: Record<string, unknown>): ViewerSearch => searchSchema.parse(search),
  component: DocumentViewerPage,
});

/** The page text with the cited passage and the search hits marked (the pieces come from features/documents/cite.ts). */
function renderHighlighted(text: string, cite: { start: number; end: number } | null, q: string | undefined): ReactNode {
  const pieces = highlightPieces(text, cite, q);
  if (!pieces) return text;
  return pieces.map((p) =>
    typeof p === 'string' ? (
      p
    ) : (
      <mark key={p.key} className={p.strong ? 'hl strong' : 'hl'} data-cite={p.strong ? '1' : undefined}>
        {p.text}
      </mark>
    ),
  );
}

function DocumentViewerPage() {
  const { id } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const toast = useToast();
  const doc = useDocument(id);
  const citation = useCitation(search.cite);
  const facts = useDocumentFacts(id);
  const mainRef = useRef<HTMLDivElement>(null);
  const factsRef = useRef<HTMLDivElement>(null);

  const pageCount = doc.data?.pageCount ?? 0;
  // The brief is the first tab; a link that names a page, a citation or a search term lands on the text.
  // A document held back as "May be someone else's record" has no summary yet: it opens on the original.
  const held = isHeldDocument(doc.data);
  const tab = search.tab ?? (search.page || search.cite || search.q ? 'text' : held ? 'original' : 'brief');
  const brief = useDocumentBrief(id, tab === 'brief');
  const testRanges = useTestRanges();
  const extract = useExtractDocument();
  const targetPage = search.page ?? citation.data?.pageNumber ?? 1;
  const [ranges, setRanges] = useState<PageRange[]>([{ from: 1, to: WINDOW }]);
  const [visiblePage, setVisiblePage] = useState<number>(targetPage);
  const [pageInput, setPageInput] = useState(String(targetPage));
  const [qInput, setQInput] = useState(search.q ?? '');
  const selectedFact = search.fact ?? null;

  const setSearch = useCallback(
    (patch: Partial<ViewerSearch>) => void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true }),
    [navigate],
  );
  const setSelectedFact = (factId: string | null) => {
    if (factId !== selectedFact) setSearch({ fact: factId ?? undefined });
  };

  const ensureRange = useCallback((from: number, to: number) => {
    setRanges((rs) => {
      const covered = rs.some((r) => r.from <= from && r.to >= to);
      if (covered) return rs;
      return normaliseRanges([...rs, { from, to }], Number.MAX_SAFE_INTEGER);
    });
  }, []);

  // Make sure the target page is loaded (with some context around it).
  useEffect(() => {
    ensureRange(Math.max(1, targetPage - 5), targetPage + WINDOW - 6);
    setPageInput(String(targetPage));
  }, [targetPage, ensureRange]);

  const effectiveRanges = useMemo(() => (pageCount ? normaliseRanges(ranges, pageCount) : ranges.slice(0, 1)), [ranges, pageCount]);
  // One query per fixed bucket of pages (see pageBuckets): what is requested is exactly what is fetched.
  const buckets = useMemo(() => pageBuckets(effectiveRanges), [effectiveRanges]);
  const pageQueries = useDocumentPageRanges(id, effectiveRanges);
  const pages = useMemo(() => {
    const m = new Map<number, DocumentPage>();
    for (const q of pageQueries) for (const p of q.data?.items ?? []) m.set(p.pageNumber, p);
    return m;
  }, [pageQueries]);
  /** The bucket queries that overlap pages from..to. */
  const queriesFor = (from: number, to: number) => buckets.flatMap((b, i) => (b.from <= to && b.to >= from && pageQueries[i] ? [pageQueries[i]] : []));

  // Citation / q highlight location on the cited page. Stored offsets are used only while they still hold the
  // quote in the page text as it is now (a re-ingest replaces the text); otherwise the quote is looked up again
  // and marked approximate, or reported as not found.
  const citeSpan = useMemo(() => {
    const c = citation.data;
    if (!c) return null;
    const text = pages.get(c.pageNumber)?.text;
    if (!text) return null;
    if (c.charStart != null && c.charEnd != null && spanHoldsQuote(text, c.charStart, c.charEnd, c.quote)) return { page: c.pageNumber, start: c.charStart, end: c.charEnd, approx: false };
    const loc = locateQuote(text, c.quote);
    return loc ? { page: c.pageNumber, ...loc, approx: true } : null;
  }, [citation.data, pages]);

  const imgMode: 'ocr' | 'all' | 'none' = search.img ?? (doc.data?.ocrApplied ? 'ocr' : 'none');
  const visual = doc.data?.kind === 'pdf' || doc.data?.kind === 'image';

  // Scroll to the cited passage (or the target page) once it is in the DOM.
  const scrolledKey = useRef<string>('');
  useLayoutEffect(() => {
    if (tab !== 'text') return;
    const key = `${search.cite ?? ''}|${search.page ?? ''}|${search.q ?? ''}`;
    if (scrolledKey.current === key) return;
    const main = mainRef.current;
    if (!main) return;
    const mark = search.cite && citeSpan ? main.querySelector<HTMLElement>('mark[data-cite="1"]') : null;
    const block = main.querySelector<HTMLElement>(`[data-page="${targetPage}"]`);
    const qMark = !mark && search.q ? block?.querySelector<HTMLElement>('mark.hl') ?? main.querySelector<HTMLElement>('mark.hl') : null;
    const el = mark ?? qMark ?? block;
    if (!el) return;
    if (search.cite && citation.isPending) return;
    el.scrollIntoView({ block: mark || qMark ? 'center' : 'start' });
    scrolledKey.current = key;
  });

  // Track which page is at the top of the scroll area.
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const top = main.getBoundingClientRect().top + 8;
        const blocks = main.querySelectorAll<HTMLElement>('[data-page]');
        for (const b of blocks) {
          if (b.getBoundingClientRect().bottom > top) {
            const n = Number(b.dataset.page);
            setVisiblePage((v) => (v === n ? v : n));
            break;
          }
        }
      });
    };
    main.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      main.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, [tab, doc.data?.id]);

  const go = useCallback(
    (n: number) => {
      const max = pageCount || Number.MAX_SAFE_INTEGER;
      const target = Math.max(1, Math.min(max, Math.floor(n)));
      scrolledKey.current = '';
      setSearch({ page: target, tab: 'text' });
    },
    [pageCount, setSearch],
  );

  const next = () => go((visiblePage || targetPage) + 1);
  const prev = () => go((visiblePage || targetPage) - 1);
  const top = () => {
    scrolledKey.current = '';
    setSearch({ page: 1, tab: 'text' });
    mainRef.current?.scrollTo({ top: 0 });
  };
  const toggleOriginal = () => setSearch({ tab: tab === 'original' ? 'text' : 'original' });
  const showBrief = () => setSearch({ tab: 'brief' });
  const focusFacts = () => factsRef.current?.querySelector<HTMLElement>('.table-wrap')?.focus();
  const cycleImages = () => setSearch({ img: imgMode === 'none' ? 'ocr' : imgMode === 'ocr' ? 'all' : 'none' });
  const canExtract = Boolean(doc.data && doc.data.pageCount > 0 && (doc.data.textStatus === 'extracted' || doc.data.textStatus === 'ocr_done'));
  const runExtract = () => {
    if (!canExtract || extract.isPending) return;
    extract.mutate({ id }, { onSuccess: () => toast('Claude will pull out the details'), onError: (err) => toast(err instanceof Error ? err.message : 'Could not start pulling out the details', 'bad') });
  };
  // Checked against itself (2026-10-09): lab flags and contradictions in this document only, the cost shown first (a).
  const canWrite = useMe().canWrite;
  const selfCheck = useSelfCheckAction(id, { enabled: canWrite && canExtract && !held });

  useBindings(
    [
      { keys: 'n', description: 'Next page', group: 'Page', run: next },
      { keys: 'PageDown', description: 'Next page', group: 'Page', run: next },
      { keys: 'p', description: 'Previous page', group: 'Page', run: prev },
      { keys: 'PageUp', description: 'Previous page', group: 'Page', run: prev },
      { keys: 'g g', description: 'Top of document', group: 'Page', run: top },
      { keys: 'o', description: 'Toggle original file / text', group: 'Page', run: toggleOriginal },
      { keys: 'b', description: 'Show the summary', group: 'Page', run: showBrief },
      { keys: 'x', description: 'Pull out details from this document', group: 'Page', when: () => canExtract, run: runExtract },
      { keys: 'f', description: 'Focus the details list', group: 'Page', run: focusFacts },
      { keys: 'i', description: 'Cycle page images (pages read as a scan, all, none)', group: 'Page', run: cycleImages },
    ],
    [visiblePage, targetPage, pageCount, tab, imgMode, canExtract, extract.isPending],
  );

  useRegisterCommands(
    [
      { id: 'viewer.brief', title: 'Show the document summary', group: 'Documents', shortcut: 'b', keywords: 'brief', run: showBrief },
      { id: 'viewer.extract', title: 'Pull out details', group: 'Documents', shortcut: 'x', keywords: 'extract facts', when: () => canExtract, run: runExtract },
      { id: 'viewer.original', title: tab === 'original' ? 'Show page text' : 'Show original file', group: 'Documents', shortcut: 'o', run: toggleOriginal },
      { id: 'viewer.next', title: 'Next page', group: 'Documents', shortcut: 'n', run: next },
      { id: 'viewer.prev', title: 'Previous page', group: 'Documents', shortcut: 'p', run: prev },
      { id: 'viewer.top', title: 'Top of document', group: 'Documents', shortcut: 'g g', run: top },
      { id: 'viewer.facts', title: 'Focus the details from this document', group: 'Documents', shortcut: 'f', keywords: 'facts', run: focusFacts },
      { id: 'viewer.images', title: 'Cycle page images (pages read as a scan, all, none)', group: 'Documents', shortcut: 'i', keywords: 'render scan picture', when: () => visual, run: cycleImages },
      { id: 'viewer.download', title: 'Download original file', group: 'Documents', run: () => {
          window.open(fileUrl(id, true), '_blank');
        },
      },
      { id: 'viewer.back', title: 'Back to documents list', group: 'Documents', run: () => void navigate({ to: '/documents', search: { id } }) },
    ],
    [id, tab, visiblePage, targetPage, pageCount, canExtract, visual, imgMode],
  );

  async function openFact(f: FactRow) {
    if (f.pageNumber) {
      go(f.pageNumber);
      return;
    }
    const detail = await fetchFactDetail(f.id);
    const c = detail?.citations?.find((x) => x.verified) ?? detail?.citations?.[0];
    if (c) {
      scrolledKey.current = '';
      setSearch({ page: c.pageNumber, cite: c.id, tab: 'text' });
    } else {
      void navigate({ to: '/facts', search: { id: f.id } });
    }
  }

  const factColumns = useMemo<ColumnDef<FactRow, unknown>[]>(
    () => [
      { id: 'date', header: 'Date', accessorFn: (f) => f.date ?? '', cell: ({ row }) => <DateText iso={row.original.date} precision={row.original.datePrecision} />, meta: { width: 96 } },
      { id: 'statement', header: 'Detail', accessorKey: 'statement', cell: ({ getValue }) => String(getValue()), meta: { grow: true, minWidth: 160 } },
      // GET /api/facts attaches each detail's automatic check (trust); a row without one shows its stored status.
      {
        id: 'status',
        header: 'Check',
        accessorFn: (r) => (r.trust ? TRUST_ORDER[r.trust.trust] : 9),
        cell: ({ row }) => (row.original.trust ? <TrustTag trust={row.original.trust} /> : <FactStatusTag status={row.original.status} basis={row.original.verdictBasis} />),
        meta: { width: 104 },
      },
    ],
    [],
  );

  const d = doc.data;
  const title = d?.title ?? 'Document';
  const status = d ? documentStatus(d) : null;

  // Build the page list with collapsed gaps.
  const blocks: ReactNode[] = [];
  if (d && tab === 'text') {
    let n = 1;
    const total = pageCount;
    while (n <= total) {
      const p = pages.get(n);
      if (p) {
        const span = citeSpan && citeSpan.page === n ? citeSpan : null;
        const showImg = visual && (imgMode === 'all' || (imgMode === 'ocr' && p.ocr));
        blocks.push(
          <section key={n} className={`pagetext${n === targetPage ? ' current' : ''}`} id={`page-${n}`} data-page={n}>
            <div className="pagenum">
              <span>Page {n}{total ? ` of ${total}` : ''}</span>
              <span className="pagemeta">
                {p.ocr ? (
                  <Tag tone="info" title={p.confidence != null ? `Read as a scan; Claude is about ${p.confidence.toFixed(0)}% sure of the words` : 'Read as a scan'}>
                    read as a scan
                  </Tag>
                ) : null}
                <span className="muted">{p.charCount} characters</span>
                {visual ? (
                  <a href={pageImageUrl(id, n, 2)} target="_blank" rel="noreferrer">
                    Picture of the page
                  </a>
                ) : null}
              </span>
            </div>
            <pre className="pagebody">{p.text ? renderHighlighted(p.text, span, search.q) : <span className="faint">(no text on this page)</span>}</pre>
            {showImg ? <img className="pageimg" loading="lazy" src={pageImageUrl(id, n, 1.5)} alt={`Rendered page ${n}`} /> : null}
          </section>,
        );
        n++;
      } else {
        let m = n;
        while (m <= total && !pages.has(m)) m++;
        const gapFrom = n;
        const gapTo = m - 1;
        const covering = queriesFor(gapFrom, gapTo);
        const loading = covering.some((q) => q.isPending);
        const failed = covering.filter((q) => q.isError);
        // Fetched and still missing: the store has no text for these pages (asking again would change nothing).
        // (Buckets are disjoint, so the gap is fully fetched when their overlaps add up to its length.)
        const overlap = buckets.reduce((sum, b) => sum + Math.max(0, Math.min(b.to, gapTo) - Math.max(b.from, gapFrom) + 1), 0);
        const fetched = !loading && !failed.length && overlap === gapTo - gapFrom + 1;
        blocks.push(
          <div key={`gap-${gapFrom}`} className="page-gap">
            {loading ? (
              <span>Loading pages {gapFrom}–{gapTo}…</span>
            ) : fetched ? (
              <span>
                No text for page{gapFrom === gapTo ? ` ${gapFrom}` : `s ${gapFrom}–${gapTo}`}; on the Documents page, use More, Read the pages again, or Read as a scan for a scanned file.
              </span>
            ) : failed.length ? (
              <>
                <span>
                  Pages {gapFrom}–{gapTo} could not be loaded.
                </span>
                <Button size="sm" onClick={() => failed.forEach((q) => void q.refetch())}>
                  Retry
                </Button>
              </>
            ) : (
              <>
                <span>
                  Pages {gapFrom}–{gapTo} not loaded.
                </span>
                <Button size="sm" onClick={() => ensureRange(gapFrom, Math.min(gapTo, gapFrom + WINDOW - 1))}>
                  Load {Math.min(WINDOW, gapTo - gapFrom + 1)} more
                </Button>
                {gapTo - gapFrom + 1 > WINDOW ? (
                  <Button size="sm" variant="ghost" onClick={() => ensureRange(gapFrom, gapTo)}>
                    Load all {gapTo - gapFrom + 1}
                  </Button>
                ) : null}
              </>
            )}
          </div>,
        );
        n = m;
      }
    }
  }

  const cite = citation.data;
  // "verified" is shown only while the page text as loaded still holds the quote at the verified span; before the
  // page text arrives the stored flag stands.
  const citePageLoaded = cite ? pages.has(cite.pageNumber) : false;
  const citeVerified = Boolean(cite?.verified) && (!citePageLoaded || Boolean(citeSpan && !citeSpan.approx));
  // A passage like the quote was found but its numbers differ (the same wording as the fact detail's citations).
  const citeMismatch = cite?.matchKind === 'mismatch';
  const banner =
    search.cite ? (
      citation.isPending ? (
        <div className="notice cite-banner">Loading the quoted passage…</div>
      ) : citation.isError || !cite ? (
        <div className="notice warn cite-banner">
          The quoted passage could not be loaded{search.q ? `; highlighting matches for "${search.q}" instead` : ''}.
        </div>
      ) : (
        <div className={`notice cite-banner ${citeVerified ? 'ok' : 'warn'}`}>
          <div className="row wrap">
            <Tag tone={citeVerified ? 'ok' : 'warn'} title={citeVerified ? 'The quote was found word for word in the page text' : 'The quote could not be matched to the page text'}>
              {citeVerified ? 'quote found' : 'quote not matched'}
            </Tag>
            <span className="mono small">p.{cite.pageNumber}</span>
            {cite.matchKind && citeVerified ? <span className="muted small">{MATCH_WORDS[cite.matchKind] ?? cite.matchKind}</span> : null}
            {citeMismatch ? (
              <span className="muted small" title="A passage like the quote is on the page, but its numbers differ from the quote's: the value is not verified">
                value differs
              </span>
            ) : null}
            {cite.verified && !citeVerified ? <span className="muted small">the page text changed since the quote was found</span> : null}
            {citeSpan?.approx ? <span className="muted small">located approximately</span> : null}
            {!citeSpan && !citation.isPending && citePageLoaded && !citeMismatch ? <span className="muted small">quote not found on this page</span> : null}
            <span className="grow" />
            {cite.factId ? (
              <Link to="/facts" search={{ id: cite.factId }}>
                Open the detail
              </Link>
            ) : null}
          </div>
          <div style={{ marginTop: 4 }}>
            <q>{cite.quote}</q>
          </div>
        </div>
      )
    ) : null;

  return (
    <div className="page">
      <PageHeader
        title={title}
        meta={
          d ? (
            <span className="doc-page-meta">
              <TierTag tier={(d as typeof d & DocumentTierFields).sourceTier ?? 'unknown'} />
              <span>{documentTypeLabel(d.category)}</span>
              <DateText iso={d.documentDate} precision={d.documentDatePrecision} text={d.documentDateText} />
              <span className="mono">
                {d.pageCount} page{d.pageCount === 1 ? '' : 's'}
              </span>
              <span className={status?.bad ? 'text-bad' : undefined}>{status?.words}</span>
              {d.ocrApplied ? (
                <Tag tone="info" title="Some or all pages were scans, so Claude read them as pictures">
                  read as a scan
                </Tag>
              ) : null}
              {d.institutionName ? <span>{d.institutionName}</span> : null}
            </span>
          ) : doc.isError ? (
            'Not found'
          ) : null
        }
        actions={{
          secondary: [{ label: 'Back to documents', onClick: () => void navigate({ to: '/documents', search: { id } }), title: 'The list of every document, with this one selected' }],
          more: [
            { label: 'Download the original file', onClick: () => window.open(fileUrl(id, true), '_blank') },
            { label: 'Pull out the details', onClick: runExtract, shortcut: 'x', disabled: !canExtract || extract.isPending, title: canExtract ? 'Have Claude read the document and pull out the lab values, medications, diagnoses and other details' : 'Available once the pages have been read' },
            selfCheck.item,
          ],
        }}
      />
      {held ? (
        <div className="doc-backlog" role="status">
          <span className="doc-backlog-words">
            <strong>{HELD_WORDS}.</strong> {heldWords(checkOfDocument(doc.data)!)} {HELD_EXPLAIN} Answer on its page in Documents.
          </span>
          <Button size="sm" variant="accent" onClick={() => void navigate({ to: '/documents', search: { id } })} title="It's mine or Not my record">
            Answer
          </Button>
        </div>
      ) : null}
      <Toolbar label="Show and find">
        <Segmented
          label="Show"
          value={tab}
          onChange={(t) => setSearch({ tab: t })}
          options={[
            { value: 'brief', label: 'Summary', title: 'What Claude found in this document' },
            { value: 'text', label: 'Page text', title: 'The text of every page, with cited passages marked' },
            { value: 'original', label: 'Original file', title: 'The file exactly as it was added' },
          ]}
        />
        <FilterGroup label="Page">
          <input
            className="page-input"
            type="number"
            min={1}
            max={pageCount || undefined}
            value={pageInput}
            aria-label="Go to page"
            onChange={(e) => setPageInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const n = Number(pageInput);
                if (Number.isFinite(n) && n >= 1) go(n);
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
          <span className="muted small">
            of <span className="mono">{pageCount}</span>
            {tab === 'text' && visiblePage && visiblePage !== targetPage ? (
              <>
                {' '}
                · at <span className="mono">{visiblePage}</span>
              </>
            ) : null}
          </span>
        </FilterGroup>
        <SearchField
          label="Find"
          placeholder="Words in the text (Enter)"
          value={qInput}
          onChange={setQInput}
          width={220}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              scrolledKey.current = '';
              setSearch({ q: qInput.trim() || undefined, tab: 'text' });
            }
          }}
        />
        {visual && tab === 'text' ? (
          <Segmented
            label="Page pictures"
            value={imgMode}
            onChange={(m) => setSearch({ img: m })}
            options={[
              { value: 'ocr', label: 'Scanned pages', title: 'A picture under each page Claude read as a scan' },
              { value: 'all', label: 'All', title: 'A picture under every page' },
              { value: 'none', label: 'None', title: 'Text only' },
            ]}
          />
        ) : null}
        <ToolbarKeys
          items={[
            ['n/p', 'next / previous page'],
            ['g g', 'top'],
            ['b', 'summary'],
            ['o', 'original file'],
            ['f', 'details list'],
            ['i', 'page pictures'],
          ]}
        />
      </Toolbar>
      <div className="page-body flush">
        <div className="viewer">
          <div className="viewer-main" ref={mainRef}>
            {tab === 'brief' ? (
              <div className="viewer-brief">
                {d ? <CoverageSection documentId={id} pageCount={d.pageCount} keys={false} onOpenPage={(page) => setSearch({ page, tab: 'text' })} /> : null}
                <DocumentBrief documentId={id} brief={brief.data} loading={brief.isPending} error={brief.error instanceof Error ? brief.error.message : null} testRanges={testRanges} extractionStatus={d?.extractionStatus} canExtract={canExtract} />
              </div>
            ) : tab === 'text' ? (
              <>
                {banner}
                {!d ? (
                  doc.isError ? <div className="viewer-status">This document could not be loaded.</div> : <Loading />
                ) : d.pageCount === 0 ? (
                  <div className="viewer-status">
                    {d.textStatus === 'failed'
                      ? `The pages could not be read (${d.textError ?? 'no reason given'}). On the Documents page, use Read pages again, or Read as a scan for a scanned file.`
                      : `No page text yet (${documentStatus(d).words}). This page updates while Claude reads the file.`}
                  </div>
                ) : (
                  blocks
                )}
              </>
            ) : (
              <div className="viewer-original">
                {d?.kind === 'pdf' ? (
                  <iframe title="Original PDF" src={`${fileUrl(id)}#page=${targetPage}`} />
                ) : d?.kind === 'image' ? (
                  <img src={BROWSER_IMAGE_MIMES.has(d.mime) ? fileUrl(id) : pageImageUrl(id, 1, 1)} alt={d.filename} />
                ) : (
                  <div className="viewer-status">
                    No inline preview for {d?.kind ?? 'this'} files.{' '}
                    <a href={fileUrl(id, true)}>Download the original</a>.
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="viewer-side" ref={factsRef}>
            <div className="section-title">
              <h4>
                Details from this document
                {facts.data ? <span className="section-count">{facts.data.items.length}</span> : null}
              </h4>
              <Link to="/facts" search={{ documentId: id }} className="small" title="Every detail of this document in Details from documents, where you can answer them">
                See them all
              </Link>
            </div>
            <p className="viewer-side-intro">Enter goes to its page; c opens it in Details from documents to answer it.</p>
            <DataTable
              columns={factColumns}
              data={facts.data?.items ?? []}
              rowId={(f) => f.id}
              selectedId={selectedFact}
              onSelect={(f) => setSelectedFact(f?.id ?? null)}
              onOpen={(f) => void openFact(f)}
              initialSort={[{ id: 'date', desc: false }]}
              emptyText={facts.isPending ? 'Loading…' : d && d.extractionStatus === 'none' ? 'Claude has not pulled out the details yet. More, Pull out the details (x) starts it.' : 'No details from this document.'}
              onKey={(e, row) => {
                if (e.key === 'Escape') {
                  mainRef.current?.focus();
                  return false;
                }
                if (e.key === 'c' && row) {
                  // Verdicts are given in the Facts list: open the fact there, selected.
                  void navigate({ to: '/facts', search: { id: row.id } });
                  return true;
                }
                return false;
              }}
            />
          </div>
        </div>
      </div>
      {selfCheck.dialog}
    </div>
  );
}
