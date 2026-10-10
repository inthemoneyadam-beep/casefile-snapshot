/**
 * Pieces both import views share: the page header (one sentence of purpose, the actions the view passes), the
 * toolbar's "Import from:" switch, the three steps under the toolbar, the hidden file input, the drop target, the
 * row-status tag and the confirm-before-import dialog.
 */
import { forwardRef, useState, type ReactNode } from 'react';
import { hasFiles } from '../../app/dom';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { PageHeader } from '../../ui/PageHeader';
import type { ActionBarProps } from '../../ui/ActionBar';
import { Tag } from '../../ui/StatusTag';
import { Segmented } from '../../ui/Toolbar';

export type ImportKind = 'ics' | 'csv';

export const IMPORT_TITLE = 'Import calendar or spreadsheet';
export const IMPORT_INTRO = 'Bring in appointments and diary notes from a calendar file, or symptom scores, lab values and calls from a spreadsheet. Nothing is saved until you press Import.';

export { errorMessage } from '../../api/client';
export { dialogOpen } from '../../app/dom';
export { plural } from '../../app/text';

/** The page header every import view shows: the title, a line naming the file, the one sentence, the view's actions. */
export function ImportHeader({ meta, actions }: { meta?: ReactNode; actions?: ActionBarProps }) {
  return <PageHeader title={IMPORT_TITLE} meta={meta} intro={IMPORT_INTRO} actions={actions} />;
}

/** "Import from: Calendar file · Spreadsheet", one labelled switch (v i / v s). */
export function KindTabs({ kind, onKind }: { kind: ImportKind; onKind: (k: ImportKind) => void }) {
  return (
    <Segmented
      label="Import from"
      value={kind}
      onChange={onKind}
      options={[
        { value: 'ics', label: 'Calendar file (.ics)', title: 'Appointments and diary notes from a calendar exported as an .ics file (keys v i)' },
        { value: 'csv', label: 'Spreadsheet (.csv)', title: 'Symptom scores, lab values or calls and messages from a spreadsheet saved as .csv (keys v s)' },
      ]}
    />
  );
}

/**
 * The three steps under the toolbar, the one you are on marked, and one sentence saying what to do now:
 * 1 Choose a file, 2 Check what each row becomes, 3 Import.
 */
export function ImportSteps({ step, check, now }: { step: 1 | 2 | 3; check: string; now: ReactNode }) {
  const steps = ['Choose a file', check, 'Import'];
  return (
    <div className="import-steps" role="status">
      <ol className="import-step-list" aria-label="Steps">
        {steps.map((s, i) => {
          const n = i + 1;
          const state = n < step ? 'done' : n === step ? 'current' : 'next';
          return (
            <li key={n} className={`import-step ${state}`} aria-current={state === 'current' ? 'step' : undefined}>
              <span className="import-step-n">{n}</span>
              {s}
              {state === 'done' ? <span className="sr-only"> (done)</span> : null}
            </li>
          );
        })}
      </ol>
      <span className="import-step-now">{now}</span>
    </div>
  );
}

/** A hidden file input; the page opens it from a button or the `f` key. */
export const FileInput = forwardRef<HTMLInputElement, { accept: string; onFile: (f: File) => void }>(function FileInput({ accept, onFile }, ref) {
  return (
    <input
      ref={ref}
      type="file"
      accept={accept}
      className="sr-only"
      tabIndex={-1}
      aria-hidden="true"
      onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (f) onFile(f);
      }}
    />
  );
});

/**
 * The page body as a drop target for one file. Marked data-own-drop so the
 * app-wide drop zone (which uploads to the documents) leaves these drops alone.
 */
export function DropArea({ onFile, children, label }: { onFile: (f: File) => void; children: ReactNode; label: string }) {
  const [over, setOver] = useState(false);
  return (
    <div
      className="page-body flush import-body"
      data-own-drop
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
    >
      {over ? <div className="dropzone over import-drop">{label}</div> : null}
      {children}
    </div>
  );
}

/** Where a row stands, in words: to import, cannot import, left out, imported before. */
export const ROW_STATUS_WORDS = { import: 'to import', skip: 'cannot import', excluded: 'left out', already: 'imported before' } as const;

export function RowStatusTag({ status, already, title }: { status: 'import' | 'skip' | 'excluded'; already?: boolean; title?: string }) {
  if (already) return <Tag tone="ash" title={title}>{ROW_STATUS_WORDS.already}</Tag>;
  if (status === 'import') return <Tag tone="ok" title={title}>{ROW_STATUS_WORDS.import}</Tag>;
  if (status === 'excluded') return <Tag tone="neutral" title={title}>{ROW_STATUS_WORDS.excluded}</Tag>;
  return <Tag tone="warn" title={title}>{ROW_STATUS_WORDS.skip}</Tag>;
}

/** Confirm an import: the summary of what will be written, Import focused so Enter goes ahead. */
export function ApplyConfirm({ open, onClose, onApply, title, children, busy, confirmLabel = 'Import' }: { open: boolean; onClose: () => void; onApply: () => void; title: string; children: ReactNode; busy: boolean; confirmLabel?: string }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      width={520}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            data-autofocus=""
            disabled={busy}
            onClick={() => {
              onApply();
              onClose();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="import-confirm">{children}</div>
    </Dialog>
  );
}

/** One line per thing to know, each led by its row (or event) when it has one. */
export function IssueList({ items, empty }: { items: Array<{ row?: number | string; text: string }>; empty?: string }) {
  if (!items.length) return empty ? <p className="muted">{empty}</p> : null;
  return (
    <ul className="import-issues">
      {items.map((it, i) => (
        <li key={i}>
          {it.row !== undefined ? <span className={typeof it.row === 'number' ? 'import-issue-row mono' : 'import-issue-row'}>{typeof it.row === 'number' ? `Row ${it.row}` : it.row}</span> : null}
          <span>{it.text}</span>
        </li>
      ))}
    </ul>
  );
}
