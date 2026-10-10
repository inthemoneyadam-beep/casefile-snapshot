/**
 * The open findings of the lab checks that name one value (LabEntry.labIssues, amendment G), shown on the value above
 * its Check:
 *   rule 10  one document gives two values for one test on one day that differ like a typing error (0.08 and 0.8,
 *            "<3" and "3", 62 and 26). Neither value is chosen; the original report decides.
 *   rule 12  a summary judges a value, or uses a limit, otherwise than the lab report printed it.
 *   computed the lab prints an index for the same collection as one the patient computed, and the two differ (2026-10-09).
 * Each notice gives the finding's own words, a link to every page it names, and "Open in What Claude noticed" (the
 * finding itself, where it is answered). A dismissed or resolved finding is not shown.
 */
import { Link, useNavigate } from '@tanstack/react-router';
import { Button } from '../../ui/Button';
import { useFinding, type EvidenceItem } from '../../api/findings';
import type { LabIssue } from '../../api/labs';

/** The headline of a lab check, in plain words. */
export const LAB_ISSUE_HEAD: Record<LabIssue['ruleId'], string> = {
  lab_same_source_conflict: 'Two values in one document',
  lab_claim_differs: 'A summary differs from the lab report',
  lab_computed_differs: 'The lab printed a different value',
};

export interface IssuePage {
  documentId: string;
  documentTitle: string | null;
  pageNumber: number | null;
  citationId: string | null;
}

/** The pages a finding's evidence names, once each, in its order: a quoted passage first, else the document. */
export function issuePages(evidence: readonly EvidenceItem[] | null | undefined): IssuePage[] {
  const out: IssuePage[] = [];
  const seen = new Set<string>();
  for (const e of evidence ?? []) {
    const c = e.citation;
    const page: IssuePage | null = c
      ? { documentId: c.documentId, documentTitle: c.documentTitle, pageNumber: c.pageNumber, citationId: c.id }
      : e.document
        ? { documentId: e.document.id, documentTitle: e.document.title, pageNumber: null, citationId: null }
        : e.fact?.sourceDocumentId
          ? { documentId: e.fact.sourceDocumentId, documentTitle: e.fact.documentTitle, pageNumber: null, citationId: null }
          : null;
    if (!page) continue;
    const k = `${page.documentId}|${page.pageNumber ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(page);
  }
  return out;
}

/** Open findings only: one the user dismissed or resolved is not raised again here. */
export function openIssues(issues: readonly LabIssue[] | null | undefined): LabIssue[] {
  return (issues ?? []).filter((i) => i.status !== 'dismissed' && i.status !== 'resolved');
}

const plainName = (s: string | null | undefined): string => ` ${(s ?? '').toLowerCase().replace(/[^a-z0-9µμ]+/g, ' ').trim()} `;

/**
 * The lines of a finding's words that are about this value's test (a summary's finding lists every value it restates:
 * on one value only its own lines are said). A line names the test as the documents write it; when no line names any of
 * `names`, every line is kept (nothing is hidden).
 */
export function linesForValue(detail: string | null | undefined, title: string, names: ReadonlyArray<string | null | undefined> = []): string[] {
  const lines = (detail?.trim() || title).split(/\n/).map((l) => l.trim()).filter(Boolean);
  const wanted = names.map(plainName).filter((n) => n.trim());
  if (!wanted.length || lines.length < 2) return lines;
  const own = lines.filter((l) => wanted.some((n) => plainName(l).includes(n)));
  return own.length ? own : lines;
}

function LabIssueNotice({ issue, names }: { issue: LabIssue; names?: ReadonlyArray<string | null | undefined> }) {
  const finding = useFinding(issue.findingId);
  const navigate = useNavigate();
  const pages = issuePages(finding.data?.evidence);
  // The finding's words about this value, one line each (its first line runs on after the headline). The lists send
  // only the title: the words come with the finding itself.
  // A rule-10 finding is about one pair (every line is this value's); a summary's (rule 12) lists every value it restates.
  const lines = linesForValue(issue.detail ?? finding.data?.detail ?? null, issue.title, issue.ruleId === 'lab_claim_differs' ? names : []);
  return (
    <div className="notice warn small labs-issue" role="note">
      <strong>{LAB_ISSUE_HEAD[issue.ruleId] ?? issue.title}.</strong> {lines[0]}
      {lines.slice(1).map((l) => (
        <span key={l} className="labs-fact-note labs-issue-line">
          {l}
        </span>
      ))}
      <div className="row wrap labs-issue-links">
        {pages.map((p) => (
          <Link
            key={`${p.documentId}|${p.pageNumber ?? ''}`}
            to="/documents/$id"
            params={{ id: p.documentId }}
            search={{ page: p.pageNumber ?? undefined, cite: p.citationId ?? undefined }}
            className="labs-source"
            title={`Open ${p.documentTitle ?? 'the document'}${p.pageNumber ? `, page ${p.pageNumber}` : ''}`}
          >
            {p.documentTitle ?? 'Document'}
            {p.pageNumber ? `, p.${p.pageNumber}` : ''}
          </Link>
        ))}
        <Button size="sm" variant="ghost" onClick={() => void navigate({ to: '/findings', search: { id: issue.findingId } })} title="The finding itself, where you can answer it">
          Open in What Claude noticed
        </Button>
      </div>
    </div>
  );
}

/** The value's open lab findings, newest first (as the server orders them); nothing without one. `names`: the value's test as written and as listed. */
export function LabIssueNotices({ issues, names }: { issues: readonly LabIssue[] | null | undefined; names?: ReadonlyArray<string | null | undefined> }) {
  const open = openIssues(issues);
  if (!open.length) return null;
  return (
    <div className="stack tight labs-issues">
      {open.map((i) => (
        <LabIssueNotice key={i.findingId} issue={i} names={names} />
      ))}
    </div>
  );
}
