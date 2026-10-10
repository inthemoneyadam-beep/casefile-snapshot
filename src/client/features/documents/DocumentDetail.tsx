/**
 * The right-hand pane of /documents, one document in the order a reader needs it:
 *
 *   header    where it came from and its type, the name, one status line ("3
 *             details found · 1 page"), the actions that matter (Open original,
 *             Read the text; the rest under More: Edit details, Rename with
 *             Claude, Pull out details again, Read the pages again, Delete) and
 *             the key facts (date, who wrote it, institution, pages, the file)
 *   notices   a likely copy, a name or date Claude suggests, where Claude filed
 *             it (or that it is not sorted yet)
 *   summary   what Claude found in it (DocumentBrief): the summary, key points
 *             and one table per kind of detail
 *
 * Edit details (b) swaps the summary for the form (title, type, date, where it
 * came from, who wrote it, institution, tags, notes) and, folded under
 * Technical details, the pages, the reading runs and the background jobs.
 */
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useRefile, DOCUMENT_TYPE_LABELS, documentTypeLabel } from '../../api/filing';
import { DocumentFilingPanel } from '../filing/Filing';
import { useNavigate } from '@tanstack/react-router';
import { Button } from '../../ui/Button';
import { Kbd } from '../../ui/Kbd';
import { Field, Input, Select, Textarea } from '../../ui/Field';
import { EmptyState, Loading, Section, Meta } from '../../ui/PageHeader';
import { DetailHeader, DetailPane } from '../../ui/DetailPane';
import { Tag, JobStatusTag } from '../../ui/StatusTag';
import { DateText, DateTimeText } from '../../ui/DateText';
import { useToast } from '../../ui/Toast';
import { useBindings } from '../../app/shortcuts';
import { useRegisterCommands } from '../../app/commands';
import { useMe } from '../../api/users';
import { AUTHOR_ROLES, DOCUMENT_CATEGORIES } from '@shared/enums';
import { parsePartialDate, formatPartialDate } from '@shared/dates';
import { DocumentBrief, useTestRanges } from './DocumentBrief';
import { titleProposalOf, useDocumentBrief, useRetitleDocument, useSetDocumentTier, type DocumentTierFields } from './api';
import { AUTHOR_WORDS, TIER_ORDER, TierTag, tierWords } from './tier';
import { documentStatus } from './status';
import { CoverageSection } from './CoveragePanel';
import { runStatusTone, runStatusWords } from './coverage';
import { modelWords } from '../settings/words';
import {
  copyWording,
  formatBytes,
  parseTags,
  useDocument,
  useExtractDocument,
  useExtractEstimate,
  useInstitutions,
  useJobAction,
  useKeepBothCopies,
  useReingestDocument,
  useSetAsideCopy,
  setAsideWords,
  useUpdateDocument,
  type DocumentDetail as DocumentDetailData,
} from '../../api/documents';
import './copies.css';
import { checkOfDocument, isHeldDocument } from '../../api/patient-check';
import { AddNumberOffer, HeldPanel, useNotMine } from '../patient-check/HeldPanel';
import { NOT_MINE_LABEL, NOT_MINE_TITLE, PATIENT_KEYS, documentLine } from '../patient-check/words';
import { useSelfCheckAction } from '../self-check/useSelfCheckAction';

interface FormState {
  title: string;
  category: string;
  documentDateText: string;
  institutionId: string;
  tags: string;
  notes: string;
}

function formFrom(d: DocumentDetailData): FormState {
  return {
    title: d.title,
    category: d.category,
    documentDateText: d.documentDateText ?? d.documentDate ?? '',
    institutionId: d.institutionId ?? '',
    tags: parseTags(d.tagsJson).join(', '),
    notes: d.notes ?? '',
  };
}

export function DocumentDetailPane({ id, onRequestDelete, onSetAside }: { id: string | null; onRequestDelete: (id: string) => void; onSetAside?: (id: string) => void }) {
  const doc = useDocument(id);
  if (!id) {
    return (
      <EmptyState title="Pick a document">
        Its summary, the details Claude found in it and where it was filed show here. Move with j and k; to add more, drop files on the list or use Add documents.
      </EmptyState>
    );
  }
  if (doc.isPending) return <Loading />;
  if (doc.isError || !doc.data)
    return (
      <div className="detail">
        <div className="notice bad">This document could not be loaded.</div>
      </div>
    );
  // Held back as "May be someone else's record" (2026-10-09): why, and the two answers; "Not my record" leaves the list.
  if (isHeldDocument(doc.data)) return <HeldPanel id={id} onAnswered={(x, answer) => (answer === 'not_mine' ? onSetAside?.(x) : undefined)} />;
  return <Loaded doc={doc.data} onRequestDelete={onRequestDelete} onSetAside={onSetAside} />;
}

/**
 * One quiet line on a document that looks like a copy of an older one (server: services/duplicates.ts). The copy is
 * read, sorted and filed like any document; this only offers the two answers. Viewers see the line only.
 */
function LikelyCopyLine({ doc, onSetAside }: { doc: DocumentDetailData; onSetAside?: (id: string) => void }) {
  const copy = doc.likelyCopyOf ?? null;
  const navigate = useNavigate();
  const toast = useToast();
  const canWrite = useMe().canWrite;
  const keep = useKeepBothCopies();
  const setAside = useSetAsideCopy();
  const busy = keep.isPending || setAside.isPending;

  function runKeep() {
    if (!copy || busy || !canWrite) return;
    keep.mutate(doc.id, {
      onSuccess: () => toast(`Kept both. It will not be marked as a copy of "${copy.title}" again.`, 'ok'),
      onError: (err) => toast(err instanceof Error ? err.message : 'Could not keep both', 'bad'),
    });
  }
  function runSetAside() {
    if (!copy || busy || !canWrite) return;
    setAside.mutate(doc.id, {
      onSuccess: (r) => {
        toast(setAsideWords(r), 'ok');
        onSetAside?.(doc.id);
      },
      onError: (err) => toast(err instanceof Error ? err.message : 'Could not set it aside', 'bad'),
    });
  }

  useRegisterCommands(
    [
      { id: 'documents.copy.setAside', title: 'Set this copy aside', group: 'Documents', keywords: 'likely copy duplicate same document delete', when: () => Boolean(copy) && canWrite, run: runSetAside },
      { id: 'documents.copy.keepBoth', title: 'Keep both (not a copy)', group: 'Documents', keywords: 'likely copy duplicate same document not a copy', when: () => Boolean(copy) && canWrite, run: runKeep },
    ],
    [doc.id, copy?.documentId, canWrite, busy],
  );

  if (!copy) return null;
  return (
    <div className="doc-copy-line">
      <span>
        Looks like a copy of{' '}
        <a
          href={`/documents?id=${encodeURIComponent(copy.documentId)}`}
          onClick={(e) => {
            e.preventDefault();
            void navigate({ to: '/documents', search: { id: copy.documentId } });
          }}
        >
          {copy.title}
        </a>{' '}
        ({copyWording(copy.similarity)}).
      </span>
      {canWrite ? (
        <span className="doc-copy-actions">
          <Button size="sm" variant="ghost" disabled={busy} onClick={runSetAside} title="Moves this copy to Deleted documents and takes back what Claude filed only from it (allergies, and what the original also has, stay); Restore brings it back">
            Set this copy aside
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={runKeep} title="They are different documents: never mark this pair again">
            Keep both
          </Button>
        </span>
      ) : null}
    </div>
  );
}

type DetailView = 'brief' | 'details';

/** Where the document's date was read from, when that is worth saying. */
const DATE_SOURCE_WORDS: Record<string, string> = { filename: 'read from the file name', text: 'read from the file', dicom: 'from the scan file', ai: 'read by Claude', user: 'set by you' };

function Loaded({ doc, onRequestDelete, onSetAside }: { doc: DocumentDetailData; onRequestDelete: (id: string) => void; onSetAside?: (id: string) => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const institutions = useInstitutions();
  const update = useUpdateDocument();
  const reingest = useReingestDocument();
  const extract = useExtractDocument();
  const jobAction = useJobAction();
  const canExtract = doc.pageCount > 0 && (doc.textStatus === 'extracted' || doc.textStatus === 'ocr_done');
  const estimate = useExtractEstimate(doc.id, canExtract);
  const dx = doc as DocumentDetailData & DocumentTierFields;
  const [view, setView] = useState<DetailView>('brief');
  const brief = useDocumentBrief(doc.id, view === 'brief');
  const retitle = useRetitleDocument();
  const setTier = useSetDocumentTier();
  const refile = useRefile();
  const titleProposal = titleProposalOf(dx);
  const classifying = doc.jobs.some((j) => j.type === 'triage_document' && (j.status === 'queued' || j.status === 'running'));
  const status = documentStatus(doc);
  const testRanges = useTestRanges();
  const canWrite = useMe().canWrite;
  // "Not my record" on any document (2026-10-09): the trash with the reason "wrong patient" (asks first).
  const notMine = useNotMine(doc, (x) => onSetAside?.(x));
  // Checked against itself (2026-10-09): lab flags and contradictions in this document only, the cost shown first (a).
  const selfCheck = useSelfCheckAction(doc.id, { enabled: canWrite && canExtract });
  const patientCheck = checkOfDocument(doc);
  const patientLine = documentLine(patientCheck, dx.sourceTier === 'patient');

  function runRetitle() {
    if (retitle.isPending || !canExtract) return;
    retitle.mutate(doc.id, { onSuccess: () => toast('Claude will suggest a name from the first pages'), onError: (err) => toast(err instanceof Error ? err.message : 'Could not start the rename', 'bad') });
  }
  function runExtract() {
    extract.mutate({ id: doc.id }, { onSuccess: () => toast('Claude will pull out the details again'), onError: (err) => toast(err instanceof Error ? err.message : 'Could not start', 'bad') });
  }
  function changeTier(sourceTier: string) {
    setTier.mutate({ id: doc.id, sourceTier }, { onSuccess: () => toast(`Marked as: ${tierWords(sourceTier).label}`, 'ok'), onError: (err) => toast(err instanceof Error ? err.message : 'Could not change where it came from', 'bad') });
  }
  function changeAuthorRole(authorRole: string) {
    setTier.mutate({ id: doc.id, authorRole: authorRole || null }, { onError: (err) => toast(err instanceof Error ? err.message : 'Could not change who wrote it', 'bad') });
  }
  function openOriginal() {
    void navigate({ to: '/documents/$id', params: { id: doc.id }, search: { tab: 'original' } });
  }
  function readText() {
    void navigate({ to: '/documents/$id', params: { id: doc.id }, search: { tab: 'text' } });
  }

  const [form, setForm] = useState<FormState>(() => formFrom(doc));
  const [baseline, setBaseline] = useState<string>(() => JSON.stringify(formFrom(doc)));
  const dirty = JSON.stringify(form) !== baseline;
  const [showAllPages, setShowAllPages] = useState(false);

  // Re-seed the form when the row changes underneath an untouched form.
  useEffect(() => {
    const next = formFrom(doc);
    const nextJson = JSON.stringify(next);
    if (!dirty && nextJson !== baseline) {
      setForm(next);
      setBaseline(nextJson);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, doc.updatedAt]);

  useEffect(() => {
    // New selection: always start from the server row.
    const next = formFrom(doc);
    setForm(next);
    setBaseline(JSON.stringify(next));
    setShowAllPages(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id]);

  const parsedDate = useMemo(() => parsePartialDate(form.documentDateText), [form.documentDateText]);

  function save(e?: FormEvent) {
    e?.preventDefault();
    if (!dirty || update.isPending) return;
    const tags = form.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    // A new type goes through re-filing (calls, appointments and records follow the type), not a plain edit.
    const newType = form.category !== doc.category ? form.category : null;
    update.mutate(
      {
        id: doc.id,
        patch: {
          title: form.title.trim() || doc.title,
          ...(newType ? {} : { category: form.category }),
          documentDateText: form.documentDateText.trim() || null,
          institutionId: form.institutionId || null,
          tags,
          notes: form.notes.trim() || null,
        },
      },
      {
        onSuccess: (d) => {
          const next = formFrom(d);
          setForm(next);
          setBaseline(JSON.stringify(next));
          if (newType) {
            refile.mutate(
              { documentId: doc.id, toCategory: newType },
              { onSuccess: () => toast('Saved, and filed again under the new type', 'ok'), onError: (err) => toast(err instanceof Error ? err.message : 'Saved, but the type could not be changed', 'bad') },
            );
          } else toast('Saved', 'ok');
        },
        onError: (err) => toast(err instanceof Error ? err.message : 'Save failed', 'bad'),
      },
    );
  }

  useBindings(
    [
      { keys: 'ctrl+s', description: 'Save the document details', group: 'Documents', global: true, run: () => save() },
      { keys: 'b', description: 'Switch between the summary and Edit details', group: 'Documents', run: () => setView((v) => (v === 'brief' ? 'details' : 'brief')) },
      { keys: 't', description: 'Rename the document with Claude', group: 'Documents', when: () => canExtract, run: () => runRetitle() },
      { keys: PATIENT_KEYS.notMine, description: `${NOT_MINE_LABEL}: the document is someone else's (asks first)`, group: 'Documents', when: () => canWrite, run: notMine.ask },
    ],
    [doc.id, form, dirty, update.isPending, canExtract, retitle.isPending, canWrite],
  );
  useRegisterCommands(
    [{ id: 'documents.notMine', title: `Documents: ${NOT_MINE_LABEL.toLowerCase()} (someone else's, asks first)`, group: 'Documents', shortcut: PATIENT_KEYS.notMine, keywords: "wrong patient twin someone else's delete trash", when: () => canWrite, run: notMine.ask }],
    [doc.id, canWrite],
  );

  const meta = useMemo<Record<string, unknown>>(() => {
    try {
      return JSON.parse(doc.metadataJson || '{}') as Record<string, unknown>;
    } catch {
      return {};
    }
  }, [doc.metadataJson]);
  const dicom = (meta.dicom ?? null) as Record<string, string | number> | null;
  /** Set by a folder import (services/folder-import.ts): which file on this computer the document was copied from. */
  const imported = (meta.import && typeof meta.import === 'object' && (meta.import as { kind?: string }).kind === 'folder' ? meta.import : null) as { folder: string; path: string; modifiedAt?: string } | null;
  // A date the model read but could not apply (the date was set by the user, the file header or an earlier run).
  const dateProposal = (() => {
    const p = (meta.classification as { applied?: { dateProposal?: unknown } } | undefined)?.applied?.dateProposal;
    return typeof p === 'string' && p.trim() && p.trim() !== (doc.documentDateText ?? doc.documentDate ?? '') ? p.trim() : null;
  })();
  const dateSourceWords = doc.documentDate || doc.documentDateText ? (DATE_SOURCE_WORDS[doc.dateSource ?? ''] ?? null) : null;
  const institutionOptions = useMemo(() => {
    const items = institutions.data?.items ?? [];
    const opts = items.map((p) => ({ value: p.id, label: p.name }));
    if (doc.institutionId && !items.some((p) => p.id === doc.institutionId)) opts.push({ value: doc.institutionId, label: doc.institutionName ?? doc.institutionId });
    return opts;
  }, [institutions.data, doc.institutionId, doc.institutionName]);

  const pagesShown = showAllPages ? doc.pages : doc.pages.slice(0, 40);
  const ocrPages = doc.pages.filter((p) => p.ocr).length;
  const cost = canExtract && estimate.data ? ` (about $${estimate.data.approxUsd < 0.01 ? estimate.data.approxUsd.toFixed(3) : estimate.data.approxUsd.toFixed(2)})` : '';

  return (
    <div className="doc-detail" tabIndex={-1}>
      <DetailPane label="Document">
        <DetailHeader
          eyebrow={
            <>
              <TierTag tier={dx.sourceTier ?? 'unknown'} />
              <span>{documentTypeLabel(doc.category)}</span>
              {classifying ? <Tag tone="info">Claude is sorting it…</Tag> : null}
            </>
          }
          title={doc.title}
          titleHint={doc.title !== doc.filename ? `File: ${doc.filename}` : undefined}
          status={[
            <span key="status" className={status.bad ? 'text-bad' : status.partial ? 'text-warn' : undefined}>
              {status.words}
            </span>,
            // Read in part: how many details it holds, after where the reading stands.
            status.partial && status.found ? <span key="found">{status.found}</span> : null,
            <span key="pages">
              {doc.pageCount.toLocaleString('en-US')} page{doc.pageCount === 1 ? '' : 's'}
              {ocrPages ? (ocrPages >= doc.pageCount ? ' (read as a scan)' : ` (${ocrPages.toLocaleString('en-US')} read as a scan)`) : ''}
            </span>,
          ]}
          actions={{
            primary: { label: 'Open original', onClick: openOriginal, title: 'The file exactly as it was added' },
            secondary: [{ label: 'Read the text', onClick: readText, title: 'The text Claude read, page by page, with every detail it pulled out marked' }],
            more: [
              { label: view === 'brief' ? 'Edit details' : 'Back to the summary', onClick: () => setView((v) => (v === 'brief' ? 'details' : 'brief')), shortcut: 'b', title: 'Title, type, date, where it came from, who wrote it, tags and notes; and the technical details' },
              { label: 'Rename with Claude', onClick: runRetitle, shortcut: 't', disabled: !canExtract || retitle.isPending || classifying, title: canExtract ? 'Ask Claude for a short, specific name from the first pages' : 'Available once the pages have been read' },
              { heading: 'Read it again' },
              { label: `Pull out details again${cost}`, onClick: runExtract, shortcut: 'x', disabled: !canExtract || extract.isPending, title: canExtract ? 'Have Claude read the document again and pull out the lab values, medications, diagnoses and other details' : 'Available once the pages have been read' },
              { label: 'Read the pages again', onClick: () => reingest.mutate({ id: doc.id }, { onSuccess: () => toast('Reading the pages again') }), shortcut: 'r', disabled: reingest.isPending, title: 'Read the text of the pages again from the original file' },
              doc.kind === 'pdf' ? { label: 'Read as a scan', onClick: () => reingest.mutate({ id: doc.id, forceOcr: true }, { onSuccess: () => toast('Reading the pages as scanned images') }), disabled: reingest.isPending, title: 'For scans or photos of paper: read the page images letter by letter (slower, but works when the text came out empty or garbled)' } : null,
              selfCheck.item,
              'separator',
              canWrite ? { label: `${NOT_MINE_LABEL}…`, onClick: notMine.ask, shortcut: PATIENT_KEYS.notMine, danger: true, title: NOT_MINE_TITLE } : null,
              { label: 'Delete…', onClick: () => onRequestDelete(doc.id), shortcut: 'Delete', danger: true, title: 'Moves it to Deleted documents (asks first); the original file is kept' },
            ],
          }}
          facts={[
            {
              label: 'Date',
              value: (
                <>
                  <DateText iso={doc.documentDate} precision={doc.documentDatePrecision} text={doc.documentDateText} />
                  {dateSourceWords && doc.dateSource === 'filename' ? <span className="muted small"> ({dateSourceWords})</span> : null}
                </>
              ),
            },
            dx.authorRole ? { label: 'Written by', value: AUTHOR_WORDS[dx.authorRole] ?? dx.authorRole.replace(/_/g, ' ') } : null,
            doc.institutionName ? { label: 'Institution', value: doc.institutionName } : null,
            {
              label: 'File',
              wide: true,
              value: (
                <a
                  href={`/documents/${doc.id}?tab=original`}
                  onClick={(e) => {
                    e.preventDefault();
                    openOriginal();
                  }}
                  title="Open the file exactly as it was added"
                  className="mono small"
                >
                  {doc.filename}
                </a>
              ),
            },
          ]}
        />

        <div className="doc-notices">
          {doc.textError ? <div className="notice bad">{doc.textError}</div> : null}
          {patientLine ? <div className={`patient-line${patientLine.tone === 'warn' ? ' warn' : ''}`}>{patientLine.text}</div> : null}
          <AddNumberOffer check={patientCheck} />
          <LikelyCopyLine doc={doc} onSetAside={onSetAside} />
          {titleProposal ? (
            <div className="doc-title-proposal">
              <span>Claude suggests the name</span>
              <q>{titleProposal}</q>
              <Button size="sm" variant="ghost" disabled={update.isPending} onClick={() => update.mutate({ id: doc.id, patch: { title: titleProposal } }, { onSuccess: () => toast('Name changed', 'ok') })}>
                Use it
              </Button>
            </div>
          ) : null}
          {dateProposal ? (
            <div className="doc-title-proposal">
              <span>Claude reads the date as</span>
              <q>{dateProposal}</q>
              <Button size="sm" variant="ghost" disabled={update.isPending} onClick={() => update.mutate({ id: doc.id, patch: { documentDateText: dateProposal } }, { onSuccess: () => toast('Date changed', 'ok'), onError: (err) => toast(err instanceof Error ? err.message : 'Could not change the date', 'bad') })}>
                Use it
              </Button>
            </div>
          ) : null}
          <DocumentFilingPanel
            key={doc.id}
            documentId={doc.id}
            category={doc.category}
            // Filed in Unsorted uploads is the user's own filing, not "named but not filed".
            classified={Boolean(meta.triage) && !meta.inbox}
            detailsToCheck={brief.data?.counts?.unverified ?? null}
            filingError={typeof (meta.filingError as { reason?: unknown } | undefined)?.reason === 'string' ? (meta.filingError as { reason: string }).reason : null}
          />
        </div>

        <CoverageSection key={`cov-${doc.id}`} documentId={doc.id} pageCount={doc.pageCount} onOpenPage={(page) => void navigate({ to: '/documents/$id', params: { id: doc.id }, search: { page } })} />

        {view === 'brief' ? (
          <Section title="What Claude found in it">
            <DocumentBrief documentId={doc.id} brief={brief.data} loading={brief.isPending} error={brief.error instanceof Error ? brief.error.message : null} compact showHead={false} testRanges={testRanges} extractionStatus={doc.extractionStatus} canExtract={canExtract} />
          </Section>
        ) : (
          <DetailsSections
            doc={doc}
            tier={dx.sourceTier ?? 'unknown'}
            authorRole={dx.authorRole ?? ''}
            onTier={changeTier}
            onAuthor={changeAuthorRole}
            tierBusy={setTier.isPending}
            imported={imported}
            form={form}
            setForm={setForm}
            dirty={dirty}
            save={save}
            saving={update.isPending}
            parsedDate={parsedDate}
            institutions={institutions}
            institutionOptions={institutionOptions}
            dicom={dicom}
            pagesShown={pagesShown}
            showAllPages={showAllPages}
            setShowAllPages={setShowAllPages}
            ocrPages={ocrPages}
            jobAction={jobAction}
            navigate={navigate}
            onDone={() => setView('brief')}
          />
        )}
      </DetailPane>
      {notMine.dialog}
      {selfCheck.dialog}
    </div>
  );
}

interface DetailsSectionsProps {
  doc: DocumentDetailData;
  tier: string;
  authorRole: string;
  onTier: (t: string) => void;
  onAuthor: (r: string) => void;
  tierBusy: boolean;
  form: FormState;
  setForm: (f: FormState) => void;
  dirty: boolean;
  save: (e?: FormEvent) => void;
  saving: boolean;
  parsedDate: ReturnType<typeof parsePartialDate>;
  institutions: ReturnType<typeof useInstitutions>;
  institutionOptions: Array<{ value: string; label: string }>;
  dicom: Record<string, string | number> | null;
  imported: { folder: string; path: string; modifiedAt?: string } | null;
  pagesShown: DocumentDetailData['pages'];
  showAllPages: boolean;
  setShowAllPages: (v: boolean | ((v: boolean) => boolean)) => void;
  ocrPages: number;
  jobAction: ReturnType<typeof useJobAction>;
  navigate: ReturnType<typeof useNavigate>;
  onDone: () => void;
}

/** Plain words for the background jobs a document has. */
const JOB_WORDS: Record<string, string> = {
  ingest_document: 'Reading the pages',
  reingest_document: 'Reading the pages again',
  extract_facts: 'Pulling out the details',
  resume_extraction: 'Reading the rest',
  read_notes: 'Reading your notes, several together',
  segment_document: 'Finding the visits and sections',
  rules_after_ingest: 'Checking across the records',
  triage_document: 'Sorting (name and type)',
  crossref: 'Checking across documents',
  export_packet: 'Making a packet',
  self_check: 'Checking it against itself',
};

/** Edit details: the form, then the pages, reading runs and background jobs folded under Technical details. */
function DetailsSections({ doc, tier, authorRole, onTier, onAuthor, tierBusy, form, setForm, dirty, save, saving, parsedDate, institutions, institutionOptions, dicom, imported, pagesShown, showAllPages, setShowAllPages, ocrPages, jobAction, navigate, onDone }: DetailsSectionsProps) {
  const technical: ReactNode = (
    <details className="doc-technical">
      <summary>Technical details</summary>
      <div className="doc-technical-body">
        <Meta
          items={[
            ['Pages', <span key="p" className="mono">{doc.pageCount}{ocrPages ? ` (${ocrPages} read as a scan)` : ''}</span>],
            ['Details', <span key="f" className="mono">{doc.factsCount}</span>],
            ['File kind', <span key="m" className="mono">{doc.mime}</span>],
            ['Size', <span key="z" className="mono">{formatBytes(doc.sizeBytes)}</span>],
            ['Fingerprint', <span key="s" className="mono" title={`SHA-256 ${doc.sha256}`}>{doc.sha256.slice(0, 16)}…</span>],
            ['Added', <DateTimeText key="a" iso={doc.createdAt} />],
            imported ? ['Copied from', <span key="imp" className="mono" title={imported.folder}>{imported.path}{imported.modifiedAt ? <span className="muted"> · file time {String(imported.modifiedAt).slice(0, 16).replace('T', ' ')}</span> : null}</span>] : null,
            ['Changed', <DateTimeText key="u" iso={doc.updatedAt} />],
          ]}
        />

        {dicom ? (
          <Section title="Scan file header (DICOM)">
            <Meta items={Object.entries(dicom).map(([k, v]) => [k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()), <span key={k} className="mono">{String(v)}</span>] as [string, ReactNode])} />
          </Section>
        ) : null}

        <Section title="Pages" count={doc.pages.length} actions={doc.pages.length > 40 ? <Button size="sm" variant="ghost" onClick={() => setShowAllPages((v) => !v)}>{showAllPages ? 'Show the first 40' : 'Show all'}</Button> : undefined}>
          {doc.pages.length ? (
            <table className="doc-subtable">
              <thead>
                <tr>
                  <th className="num">Page</th>
                  <th className="num">Characters</th>
                  <th>Read as</th>
                  <th className="num">How sure</th>
                </tr>
              </thead>
              <tbody>
                {pagesShown.map((p) => (
                  <tr key={p.pageNumber}>
                    <td className="num">
                      <a
                        href={`/documents/${doc.id}?page=${p.pageNumber}`}
                        onClick={(e) => {
                          e.preventDefault();
                          void navigate({ to: '/documents/$id', params: { id: doc.id }, search: { page: p.pageNumber } });
                        }}
                      >
                        {p.pageNumber}
                      </a>
                    </td>
                    <td className="num">{p.charCount}</td>
                    <td>{p.ocr ? <Tag tone="info">a scan</Tag> : <span className="muted">text</span>}</td>
                    <td className="num">{p.confidence != null ? `${p.confidence.toFixed(0)}%` : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="section-intro">{doc.textStatus === 'failed' ? 'The pages could not be read.' : 'No pages yet.'}</p>
          )}
        </Section>

        <Section title="Times Claude pulled out the details" count={doc.runs.length || undefined} intro={doc.runs.length ? 'Each reading, newest first. Parts read counts the model calls; a reading that stopped carries on from where it stopped.' : undefined}>
          {doc.runs.length ? (
            <table className="doc-subtable">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Model</th>
                  <th>Result</th>
                  <th className="num">Details</th>
                  <th className="num">Possible duplicates</th>
                  <th className="num">Parts read</th>
                </tr>
              </thead>
              <tbody>
                {doc.runs.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <DateTimeText iso={r.startedAt} />
                    </td>
                    <td>
                      {modelWords(r.model)}
                      {r.deep ? ' (deep)' : ''}
                    </td>
                    <td>
                      <Tag tone={runStatusTone(r.status)} title={r.error ?? undefined}>
                        {runStatusWords(r.status)}
                      </Tag>
                    </td>
                    <td className="num">{r.factsCount}</td>
                    <td className="num">{r.mergesProposed}</td>
                    <td className="num">{r.chunks}</td>
                  </tr>
                ))}
              </tbody>
              {doc.runs.length > 1 ? (
                <tfoot>
                  <tr>
                    <td colSpan={3}>
                      In all, {doc.runs.length} readings
                      {(() => {
                        const n = doc.runs.filter((r) => r.status !== 'done').length;
                        return n ? `; ${n} did not finish` : '';
                      })()}
                    </td>
                    <td className="num">{doc.runs.reduce((n, r) => n + r.factsCount, 0)}</td>
                    <td className="num">{doc.runs.reduce((n, r) => n + r.mergesProposed, 0)}</td>
                    <td className="num">{doc.runs.reduce((n, r) => n + r.chunks, 0)}</td>
                  </tr>
                </tfoot>
              ) : null}
            </table>
          ) : (
            <p className="section-intro">Claude has not pulled out the details of this document.</p>
          )}
        </Section>

        <Section title="Background work" count={doc.jobs.length || undefined}>
          {doc.jobs.length ? (
            <table className="doc-subtable">
              <thead>
                <tr>
                  <th>What</th>
                  <th>Status</th>
                  <th>Progress</th>
                  <th>Started</th>
                  <th>
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {doc.jobs.map((j) => (
                  <tr key={j.id}>
                    <td>{JOB_WORDS[j.type] ?? j.type.replace(/_/g, ' ')}</td>
                    <td>
                      <JobStatusTag status={j.status} />
                    </td>
                    <td className="wrap">
                      {j.status === 'running' ? (
                        <span className="row">
                          <span className="progress">
                            <i style={{ width: `${Math.round(Math.max(0.02, j.progress) * 100)}%` }} />
                          </span>
                          <span className="muted small">{j.progressText ?? `${Math.round(j.progress * 100)}%`}</span>
                        </span>
                      ) : j.error ? (
                        <span className="small text-bad" title={j.error}>
                          {j.error.length > 90 ? `${j.error.slice(0, 90)}…` : j.error}
                        </span>
                      ) : (
                        <span className="muted small">{j.progressText ?? ''}</span>
                      )}
                    </td>
                    <td>
                      <DateTimeText iso={j.createdAt} />
                    </td>
                    <td>
                      {j.status === 'queued' || j.status === 'running' ? (
                        <Button size="sm" variant="ghost" onClick={() => jobAction.mutate({ id: j.id, action: 'cancel' })}>
                          Cancel
                        </Button>
                      ) : j.status === 'failed' || j.status === 'cancelled' ? (
                        <Button size="sm" variant="ghost" onClick={() => jobAction.mutate({ id: j.id, action: 'retry' })}>
                          Try again
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="section-intro">Nothing running for this document.</p>
          )}
        </Section>
      </div>
    </details>
  );

  return (
    <>
      <Section
        title="Edit details"
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={onDone}>
              Back to the summary
            </Button>
            <Button size="sm" variant="primary" disabled={!dirty || saving} onClick={() => save()}>
              Save <Kbd>ctrl+s</Kbd>
            </Button>
          </>
        }
      >
        <form className="form doc-edit-form" onSubmit={save}>
          <Field inline label="Title">
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <Field inline label="Type">
            <Select value={form.category} options={DOCUMENT_CATEGORIES.map((c) => ({ value: c, label: DOCUMENT_TYPE_LABELS[c] ?? c }))} onChange={(e) => setForm({ ...form, category: e.target.value })} />
          </Field>
          <Field
            inline
            label="Date"
            hint={
              form.documentDateText.trim()
                ? parsedDate.iso
                  ? `Reads as ${formatPartialDate(parsedDate.iso, parsedDate.precision)}`
                  : 'Not recognised as a date; kept as written'
                : 'As written, for example 11 Mar 2024, 3/2024, 2023'
            }
          >
            <Input value={form.documentDateText} onChange={(e) => setForm({ ...form, documentDateText: e.target.value })} />
          </Field>
          <Field inline label="Where it came from" hint={`${tierWords(tier).title} Changed at once.`}>
            <Select aria-label="Where it came from" value={tier} options={TIER_ORDER.map((t) => ({ value: t, label: tierWords(t).label }))} disabled={tierBusy} onChange={(e) => onTier(e.target.value)} />
          </Field>
          <Field inline label="Written by" hint="Changed at once.">
            <Select aria-label="Written by" value={authorRole} options={AUTHOR_ROLES.map((r) => ({ value: r, label: AUTHOR_WORDS[r] ?? r }))} placeholder="Not known" disabled={tierBusy} onChange={(e) => onAuthor(e.target.value)} />
          </Field>
          <Field inline label="Institution" hint={institutions.data && !institutions.data.items.length ? 'No institutions under People and places yet.' : undefined}>
            <Select value={form.institutionId} options={institutionOptions} placeholder="None" onChange={(e) => setForm({ ...form, institutionId: e.target.value })} />
          </Field>
          <Field inline label="Tags" hint="Separated by commas">
            <Input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
          </Field>
          <Field inline label="Notes">
            <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </Field>
          <button type="submit" className="sr-only" tabIndex={-1}>
            Save
          </button>
        </form>
      </Section>
      {technical}
    </>
  );
}
