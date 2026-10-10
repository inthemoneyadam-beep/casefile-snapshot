/**
 * /setup — getting started, shown right after the first-run screen created
 * the case (and reachable later from the palette). Runs the Files-folder
 * import when the setup screen asked for it (`?import=1`; the flag is dropped
 * from the URL once the import has been sent so a reload never repeats it),
 * lists who has access, and says whether Claude can be used yet. One primary
 * action: import the Files folder (i). On a hosted server (Railway) there is no
 * Files folder: the documents step says to drop or choose the files instead.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { useSettings } from '../api/hooks';
import { errorText, importFolder, useMe, useUsers, type ImportFolderResult } from '../api/users';
import { useRegisterCommands } from '../app/commands';
import { useBindings } from '../app/shortcuts';
import { Button } from '../ui/Button';
import { KeyFacts } from '../ui/DetailPane';
import { Loading, PageHeader, Section } from '../ui/PageHeader';
import { Tag } from '../ui/StatusTag';
import { APP_NAME } from '@shared/constants';
import { ROLE_WORDS } from '../features/settings/words';
import '../features/users/users.css';

const searchSchema = z.object({ import: z.enum(['1']).optional().catch(undefined) });
export type SetupSearch = z.infer<typeof searchSchema>;

export const Route = createFileRoute('/setup')({
  validateSearch: (s: Record<string, unknown>): SetupSearch => searchSchema.parse(s),
  component: SetupPage,
});

type ImportState = { status: 'idle' } | { status: 'running' } | { status: 'done'; result: ImportFolderResult } | { status: 'unavailable' } | { status: 'error'; error: string };

function SetupPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const me = useMe();
  const users = useUsers(Boolean(me.user));
  const settings = useSettings();
  const [imp, setImp] = useState<ImportState>({ status: 'idle' });
  const started = useRef(false);
  const folder = me.filesFolder;

  const runImport = useCallback(async () => {
    if (!folder || imp.status === 'running') return;
    setImp({ status: 'running' });
    try {
      const r = await importFolder(folder);
      setImp(r ? { status: 'done', result: r } : { status: 'unavailable' });
    } catch (err) {
      setImp({ status: 'error', error: errorText(err, 'The import did not work.') });
    }
  }, [folder, imp.status]);

  // The setup screen asked for the import: send it once, then drop the flag.
  useEffect(() => {
    if (search.import !== '1' || !folder || started.current) return;
    started.current = true;
    void navigate({ search: {}, replace: true });
    void runImport();
  }, [search.import, folder, navigate, runImport]);

  // Folder import is owner only on the server (it reads files on this computer).
  const canImport = Boolean(folder) && me.isOwner && imp.status !== 'running';
  useBindings([{ keys: 'i', description: 'Import the Files folder now', group: 'Page', when: () => canImport, run: () => void runImport() }], [canImport, runImport]);
  useRegisterCommands(
    [
      // 'Go to Getting started' (setup.open) is registered by AccessLine in the nav foot, so it exists on every page.
      { id: 'setup.import', title: 'Import the Files folder next to the app', group: 'Page', shortcut: 'i', keywords: 'folder import documents files', run: () => void runImport(), when: () => canImport },
    ],
    [canImport, runImport],
  );

  const s = settings.data;
  const people = users.data?.items ?? [];
  const folderText = folder ?? 'the Files folder next to the app';

  return (
    <div className="page setup-page">
      <PageHeader
        title="Getting started"
        intro={`${APP_NAME} is created and unlocked. Add the documents first; everything below can be changed later in Settings.`}
        actions={{
          primary: me.isOwner && folder ? { label: imp.status === 'running' ? 'Importing…' : imp.status === 'done' ? 'Import the folder again' : 'Import the Files folder', onClick: () => void runImport(), shortcut: 'i', disabled: !canImport, title: 'Copy every document in the Files folder into the encrypted case; the folder itself is never changed' } : null,
          secondary: [{ label: 'Open Documents', onClick: () => void navigate({ to: '/documents' }) }],
        }}
      />
      <div className="page-body">
        <div className="setup-steps">
          {me.hosted ? (
            <Section title="1. Documents" actions={<Link to="/documents">Documents</Link>} intro="Drag the records onto any page, or choose them with Add documents on the Documents page. Each file is copied into the encrypted case; a file already added is skipped.">
              {null}
            </Section>
          ) : (
          <Section title="1. Documents" intro="Put the records in this folder and import it. Each file is copied into the encrypted case and the folder itself is never changed; a file already added is skipped.">
            <div className="step-path">{folderText}</div>
            {imp.status === 'running' ? (
              <Loading>Importing…</Loading>
            ) : imp.status === 'done' ? (
              <div className="notice ok" role="status">
                <strong>
                  Imported {imp.result.imported}, skipped {imp.result.duplicates} already added
                  {imp.result.skipped.length ? `, ${imp.result.skipped.length} of a kind CaseFile cannot read` : ''}.
                </strong>{' '}
                Claude reads them in the background; see the line at the bottom of the window and <Link to="/documents">Documents</Link>.
                {imp.result.skipped.length ? (
                  <div className="small setup-skipped">
                    {imp.result.skipped.slice(0, 8).map((k) => `${k.file}: ${k.reason}`).join(' · ')}
                    {imp.result.skipped.length > 8 ? ' · …' : ''}
                  </div>
                ) : null}
              </div>
            ) : imp.status === 'unavailable' ? (
              <div className="notice warn">Importing a folder is not part of this version. Keep the documents in the folder above and add them on the Documents page (dragging them onto any page works too).</div>
            ) : imp.status === 'error' ? (
              <div className="notice bad">{imp.error}</div>
            ) : !me.isOwner ? (
              <p className="muted">Only the owner can import the folder. Add documents on the Documents page.</p>
            ) : null}
          </Section>
          )}

          <Section title="2. People with access" count={people.length || undefined} actions={<Link to="/settings">Change in Settings</Link>} intro="Each person opens the same case with a passphrase of their own.">
            {users.isPending ? (
              <Loading />
            ) : users.isError ? (
              <p className="muted">
                The list is not available here; you are signed in as {me.user?.name ?? 'yourself'} ({(ROLE_WORDS[me.role ?? ''] ?? 'unknown role').toLowerCase()}).
              </p>
            ) : (
              <KeyFacts
                items={people.map((u) => ({
                  label: (
                    <>
                      {u.name}
                      {u.isMe ? ' (you)' : ''}
                    </>
                  ),
                  value: (
                    <span className="row">
                      {ROLE_WORDS[u.role] ?? u.role}
                      {!u.hasPassphrase ? <Tag tone="warn">no passphrase yet</Tag> : null}
                    </span>
                  ),
                  wide: true,
                }))}
              />
            )}
          </Section>

          <Section title="3. Claude" actions={<Link to="/settings">Settings, AI</Link>}>
            {s ? (
              <p className="row">
                <Tag tone={s['ai.apiKeySet'] ? 'ok' : 'warn'}>{s['ai.apiKeySet'] ? 'key stored' : 'no key yet'}</Tag>
                <span className="muted">
                  {s['ai.apiKeySet'] ? 'Claude can read documents and answer questions; every request is listed in the AI usage log.' : 'Claude’s actions wait until an API key is entered in Settings. Everything else works without one.'}
                </span>
              </p>
            ) : (
              <Loading />
            )}
          </Section>

          <Section title="Next">
            <ul className="setup-next">
              <li>
                <Link to="/documents">Documents</Link>: add records; Claude reads, names and files each one.
              </li>
              <li>
                <Link to="/people">People and places</Link>: clinicians, clinics and the chief of staff.
              </li>
              <li>
                <Link to="/settings">Settings</Link>: the patient details for the emergency card, appearance, the lock.
              </li>
              <li>
                <Link to="/guide">How CaseFile works</Link>: the words and buttons you will meet.
              </li>
            </ul>
          </Section>
        </div>
      </div>
    </div>
  );
}
