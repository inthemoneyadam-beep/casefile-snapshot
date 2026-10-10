/**
 * /import — bring a calendar (.ics) or a spreadsheet (.csv) into the case
 * (docs/API-CONTRACTS-3.md, slice O). `?kind=ics|csv` picks what to import from (the toolbar's "Import from:"),
 * `?target=` where a spreadsheet's rows go ("Into:"), `?id=` the selected row (an event or a row number). Three
 * steps, shown under the toolbar: choose a file, check what each row becomes, Import (the page's one primary
 * action, which asks first). The file stays in the page: reading it writes nothing, and every write names the file
 * it came from. Viewers can read the case but not import.
 */
import { useCallback } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { CSV_TARGETS, type CsvTarget } from '../api/import';
import { useMe } from '../api/users';
import { useRegisterCommands } from '../app/commands';
import { useBindings } from '../app/shortcuts';
import { EmptyState, Loading } from '../ui/PageHeader';
import { Toolbar } from '../ui/Toolbar';
import { ToolbarKeys } from '../ui/Toolbar';
import { CalendarImport } from '../features/import/CalendarImport';
import { CsvImport } from '../features/import/CsvImport';
import { dialogOpen, ImportHeader, KindTabs, type ImportKind } from '../features/import/shared';
import '../features/import/import.css';

const searchSchema = z.object({
  kind: z.enum(['ics', 'csv']).optional().catch(undefined),
  target: z.enum(CSV_TARGETS).optional().catch(undefined),
  id: z.string().optional().catch(undefined),
});
export type ImportSearch = z.infer<typeof searchSchema>;

export const Route = createFileRoute('/import')({
  validateSearch: (s: Record<string, unknown>): ImportSearch => searchSchema.parse(s),
  component: ImportPage,
});

const ROLE_WORDS: Record<string, string> = { owner: 'the owner', editor: 'an editor', viewer: 'a viewer' };

function ImportPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const me = useMe();
  const kind: ImportKind = search.kind ?? 'ics';
  const target: CsvTarget = search.target ?? 'symptoms';

  const setKind = useCallback((k: ImportKind) => void navigate({ search: (prev) => ({ ...prev, kind: k, id: undefined }) }), [navigate]);
  const setTarget = useCallback((t: CsvTarget) => void navigate({ search: (prev) => ({ ...prev, kind: 'csv' as const, target: t, id: undefined }), replace: true }), [navigate]);
  const select = useCallback((id: string | null) => void navigate({ search: (prev) => ({ ...prev, id: id ?? undefined }), replace: true }), [navigate]);

  // View keys are `v` chords so the global `v t` / `v b` / `v r` appearance chords keep working.
  useBindings(
    [
      { keys: 'v i', description: 'Import from a calendar file (.ics)', group: 'Lists', when: () => !dialogOpen(), run: () => setKind('ics') },
      { keys: 'v s', description: 'Import from a spreadsheet (.csv)', group: 'Lists', when: () => !dialogOpen(), run: () => setKind('csv') },
    ],
    [setKind],
  );
  useRegisterCommands(
    [
      { id: 'import.view.ics', title: 'Import from a calendar file (.ics)', group: 'Import calendar or spreadsheet', keywords: 'calendar ics', shortcut: 'v i', run: () => setKind('ics') },
      { id: 'import.view.csv', title: 'Import from a spreadsheet (.csv)', group: 'Import calendar or spreadsheet', keywords: 'csv spreadsheet excel', shortcut: 'v s', run: () => setKind('csv') },
    ],
    [setKind],
  );

  if (me.isLoading) {
    return (
      <div className="page">
        <ImportHeader />
        <div className="page-body flush">
          <Loading />
        </div>
      </div>
    );
  }
  if (!me.canWrite) {
    return (
      <div className="page">
        <ImportHeader />
        <Toolbar label="Import from">
          <KindTabs kind={kind} onKind={setKind} />
          <ToolbarKeys items={[['v i', 'calendar'], ['v s', 'spreadsheet']]} />
        </Toolbar>
        <div className="page-body flush">
          <EmptyState title="Importing needs the owner or an editor">
            Importing adds appointments, diary notes and rows to the case. You are signed in as {ROLE_WORDS[me.role ?? ''] ?? 'a viewer'}, who can read the case but not import; ask the owner or the chief of staff.
          </EmptyState>
        </div>
      </div>
    );
  }
  return (
    <div className="page">
      {kind === 'ics' ? (
        <CalendarImport key="ics" kind={kind} onKind={setKind} selectedId={search.id ?? null} onSelect={select} />
      ) : (
        <CsvImport key="csv" kind={kind} onKind={setKind} target={target} onTarget={setTarget} selectedId={search.id ?? null} onSelect={select} />
      )}
    </div>
  );
}
