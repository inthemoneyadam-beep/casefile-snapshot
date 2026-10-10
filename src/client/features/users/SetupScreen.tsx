/**
 * First run (no keyring yet): start a new case, or restore one from a backup.
 *
 * Start a new case: one form that creates the case. Your name and passphrase (twice), the chief of staff (a people
 * row of kind chief_of_staff; with a passphrase, also an editor login), an optional Anthropic API key, whether to
 * import the Files folder next to the app (not on a hosted server, which has no such folder), and the theme.
 * Submitting creates the owner, unlocks, and opens /setup, which runs the import when asked and lists what was
 * created.
 *
 * Restore from a backup: choose a backup zip made by this app; it is sent as it is (still encrypted), in pieces
 * (api/restore.ts: Railway ends a request whose body takes over 5 minutes), with the upload's progress on screen;
 * an upload that stopped carries on when the same file is restored again. Then the server checks it and unpacks it
 * into the empty case (its progress from GET /api/auth/status). Then the unlock screen asks for the passphrase that
 * was in use when the backup was made.
 *
 * On a hosted server (Railway) both ask for the setup code (CASEFILE_SETUP_TOKEN), so nobody who finds the address
 * can claim the server first; when the server has no setup code, both say so and stay off.
 */
import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { errorText, setupCase, useAuthFull, type RestoreStatus } from '../../api/users';
import { RESTORE_MAX_BYTES, RestoreCancelledError, RestoreConnectionError, checkRestore, restoreBackup } from '../../api/restore';
import { applyAppearance, readAppearance, type Theme } from '../../app/theme';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { Segmented } from '../../ui/Toolbar';
import { APP_NAME, DEFAULT_SETTINGS } from '@shared/constants';
import { backupFileProblem, errorCode, restoreRunning, restoreStatusLine, sizeWords, uploadLine } from './restoreWords';
import { useThrottle } from './useThrottle';
import { noteSetupScreenShown } from './restoreNotice';
import './users.css';

const THEMES: Theme[] = ['dark', 'dim', 'light'];
const THEME_WORDS: Record<Theme, string> = { dark: 'Dark', dim: 'Dim (darker)', light: 'Light' };

export type SetupMode = 'new' | 'restore';

export const SETUP_WORDS = {
  intro: 'Start a new case, or restore one from a backup made by this app.',
  newIntro: 'One passphrase locks the database and every file; there is no way to recover it if it is lost. Everything below can be changed later in Settings.',
  restoreIntro:
    'Choose a backup made by this app: the zip from Settings, Backups (Download), or the one Back up CaseFile.cmd saved. It is unpacked into this empty case; then you unlock with the passphrase that was in use when the backup was made.',
  codeHint: 'The code saved as CASEFILE_SETUP_TOKEN in Railway’s Variables for this app. It shows the server is yours. It is not a passphrase and is not kept in the case.',
  codeMissing: 'Setting up is turned off: the server has no setup code (CASEFILE_SETUP_TOKEN). Add it in Railway’s Variables and redeploy, then reload this page.',
  newFootLocal: 'Stays on this computer. Nothing leaves it except the Claude requests you start.',
  newFootHosted: 'Kept encrypted on your Railway server. Nothing leaves it except the Claude requests you start.',
  restoreFootLocal: 'The backup is unpacked into the empty case folder on this computer.',
  restoreFootHosted: 'Sent over an encrypted connection. The backup stays encrypted on your Railway server.',
} as const;

export function SetupScreen() {
  const status = useAuthFull();
  const d = status.data;
  const hosted = d?.hosted === true;
  const codeNeeded = d?.setupTokenRequired === true;
  const codeMissing = d?.setupTokenMissing === true;
  const [mode, setMode] = useState<SetupMode>(() => (restoreRunning(d?.restore) ? 'restore' : 'new'));
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => noteSetupScreenShown(), []);

  return (
    <div className="lock setup-lock">
      <div className="lock-card setup">
        <div>
          <h1>{APP_NAME}</h1>
          <p className="setup-intro">{SETUP_WORDS.intro}</p>
        </div>
        <Segmented<SetupMode>
          ariaLabel="How to begin"
          className="setup-mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'new', label: 'Start a new case', disabled: busy, title: 'Create an empty case with your passphrase' },
            { value: 'restore', label: 'Restore from a backup', disabled: busy, title: 'Bring back a case from a backup zip made by this app' },
          ]}
        />
        {codeMissing ? (
          <div className="notice warn" role="alert">
            {SETUP_WORDS.codeMissing}
          </div>
        ) : null}
        {mode === 'new' ? (
          <NewCaseForm hosted={hosted} codeNeeded={codeNeeded} off={codeMissing} code={code} setCode={setCode} onBusy={setBusy} />
        ) : (
          <RestoreForm hosted={hosted} codeNeeded={codeNeeded} off={codeMissing} code={code} setCode={setCode} onBusy={setBusy} serverRestore={d?.restore ?? null} />
        )}
      </div>
    </div>
  );
}

interface FormProps {
  hosted: boolean;
  codeNeeded: boolean;
  /** The server has no setup code: nothing can be sent. */
  off: boolean;
  code: string;
  setCode: (v: string) => void;
  onBusy: (busy: boolean) => void;
}

function SetupCodeField({ value, onChange, disabled, inputRef, autoFocus }: { value: string; onChange: (v: string) => void; disabled: boolean; inputRef: RefObject<HTMLInputElement | null>; autoFocus?: boolean }) {
  return (
    <>
      <div className="setup-group">
        This server
        <small>{SETUP_WORDS.codeHint}</small>
      </div>
      <label htmlFor="su-code">Setup code</label>
      <input id="su-code" ref={inputRef} type="password" autoComplete="off" spellCheck={false} autoFocus={autoFocus} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} placeholder="From Railway’s Variables" />
    </>
  );
}

function NewCaseForm({ hosted, codeNeeded, off, code, setCode, onBusy }: FormProps) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [cosName, setCosName] = useState<string>(DEFAULT_SETTINGS['patient.chiefOfStaffName']);
  const [cosPass, setCosPass] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [importFiles, setImportFiles] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => readAppearance().theme);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusyState] = useState(false);
  const throttle = useThrottle();
  const codeRef = useRef<HTMLInputElement>(null);
  const setBusy = (b: boolean) => {
    setBusyState(b);
    onBusy(b);
  };

  function pickTheme(t: Theme) {
    setTheme(t);
    applyAppearance({ ...readAppearance(), theme: t });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (off || throttle.waiting) return;
    if (codeNeeded && !code.trim()) {
      codeRef.current?.focus();
      return setError('Enter the setup code first.');
    }
    if (!name.trim()) return setError('Your name is needed; it labels your login and the patient details.');
    if (pass.length < 8) return setError('Use at least 8 characters for your passphrase. A short sentence is easy to remember and hard to guess.');
    if (pass !== pass2) return setError('The two passphrases do not match.');
    if (cosPass && cosPass.length < 8) return setError('The chief of staff passphrase needs at least 8 characters (or leave it empty for now).');
    if (cosPass && cosPass === pass) return setError('Give the chief of staff a different passphrase from your own.');
    setBusy(true);
    try {
      await setupCase({
        passphrase: pass,
        setupToken: codeNeeded ? code : undefined,
        name: name.trim(),
        chiefOfStaff: cosName.trim() ? { name: cosName.trim(), passphrase: cosPass || undefined } : null,
        apiKey: apiKey.trim() || null,
        theme,
      });
      setPass('');
      setPass2('');
      setCosPass('');
      setApiKey('');
      setCode('');
      onBusy(false);
      void navigate({ to: '/setup', search: { import: importFiles && !hosted ? '1' : undefined } });
      await qc.invalidateQueries();
    } catch (err) {
      setBusy(false);
      if (throttle.block(err)) return;
      if (errorCode(err) === 'setup_token') codeRef.current?.focus();
      setError(errorText(err, 'Could not create the case.'));
    }
  }

  const locked = busy || off;
  return (
    <form className="setup-form" onSubmit={submit} autoComplete="off" aria-label="Start a new case">
      <p className="setup-lead">{SETUP_WORDS.newIntro}</p>
      {codeNeeded ? <SetupCodeField value={code} onChange={setCode} disabled={locked} inputRef={codeRef} autoFocus /> : null}

      <div className="setup-group">You</div>
      <label htmlFor="su-name">Your name</label>
      <Input id="su-name" autoFocus={!codeNeeded} value={name} onChange={(e) => setName(e.target.value)} disabled={locked} maxLength={120} />
      <label htmlFor="su-pass">Passphrase</label>
      <Input id="su-pass" type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} disabled={locked} placeholder="At least 8 characters" />
      <label htmlFor="su-pass2">Repeat passphrase</label>
      <Input id="su-pass2" type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} disabled={locked} />

      <div className="setup-group">
        Chief of staff
        <small>Added to People. With a passphrase of her own she gets an editor login: everything in the case except security settings and the AI key. She can change it after her first login.</small>
      </div>
      <label htmlFor="su-cos">Name</label>
      <Input id="su-cos" value={cosName} onChange={(e) => setCosName(e.target.value)} disabled={locked} maxLength={120} placeholder="Leave empty to skip" />
      <label htmlFor="su-cos-pass">Her passphrase</label>
      <Input id="su-cos-pass" type="password" autoComplete="new-password" value={cosPass} onChange={(e) => setCosPass(e.target.value)} disabled={locked || !cosName.trim()} placeholder="Optional" />

      <div className="setup-group">
        Claude (AI)
        <small>Optional. Kept in the encrypted settings. CaseFile contacts only api.anthropic.com, only when you start something that needs Claude, and lists every request.</small>
      </div>
      <label htmlFor="su-key">Anthropic API key</label>
      <Input id="su-key" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} disabled={locked} placeholder="Optional, e.g. sk-ant-…" />

      {hosted ? null : (
        <>
          <div className="setup-group">Documents</div>
          <label htmlFor="su-import">Files folder</label>
          <label className="setup-check" htmlFor="su-import">
            <input id="su-import" type="checkbox" checked={importFiles} onChange={(e) => setImportFiles(e.target.checked)} disabled={locked} />
            <span>
              Import the documents in the Files folder next to the app
              <span className="muted"> (each file is copied into the encrypted case; the folder itself is never changed)</span>
            </span>
          </label>
        </>
      )}

      <div className="setup-group">Appearance</div>
      <label>Theme</label>
      <div className="setup-themes">
        <Segmented<Theme> ariaLabel="Theme" value={theme} onChange={pickTheme} options={THEMES.map((t) => ({ value: t, label: THEME_WORDS[t], disabled: busy }))} />
      </div>

      {throttle.message || error ? (
        <div className="error setup-error" role="alert">
          {throttle.message ?? error}
        </div>
      ) : null}
      <div className="setup-actions">
        <span className="muted">{hosted ? SETUP_WORDS.newFootHosted : SETUP_WORDS.newFootLocal}</span>
        <Button type="submit" variant="primary" disabled={locked || throttle.waiting || !pass || !pass2 || !name.trim()}>
          {busy ? 'Creating…' : 'Create the case'}
        </Button>
      </div>
    </form>
  );
}

/** `base`: what the server already held when this upload began (it carries on), left out of the time-left estimate. */
export type Phase = { kind: 'idle' } | { kind: 'asking' } | { kind: 'sending'; sent: number; total: number; startedAt: number; base?: number } | { kind: 'working' } | { kind: 'lost' };

function RestoreForm({ hosted, codeNeeded, off, code, setCode, onBusy, serverRestore }: FormProps & { serverRestore: RestoreStatus | null }) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  // Whether this form has sent anything yet: before that, a failure the server remembers is shown as the last one.
  const [attempted, setAttempted] = useState(false);
  const throttle = useThrottle();
  const codeRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // The server is still at work on a restore this page did not start (a reload, another tab): follow it.
  const serverBusy = restoreRunning(serverRestore);
  const busy = phase.kind !== 'idle' || serverBusy;
  // While the server works, ask it every 1.5 s where it stands; the root's status query sees `initialized` turn
  // true when it is done and swaps this screen for the unlock screen.
  useAuthFull(busy && phase.kind !== 'sending' && phase.kind !== 'asking' ? 1500 : false);

  // The choice of new case or restore stays put while anything is under way.
  useEffect(() => onBusy(busy), [busy, onBusy]);
  useEffect(() => () => abortRef.current?.abort(), []);

  // After the upload (and when the connection was lost after it) the outcome comes from the server's status: a
  // failure newer than the one on record when this restore started ends the wait. A success swaps the screen.
  const baselineAt = useRef<string | null>(null);
  useEffect(() => {
    if (phase.kind !== 'lost' && phase.kind !== 'working') return;
    if (serverRestore?.state === 'failed' && serverRestore.at !== baselineAt.current) {
      setPhase({ kind: 'idle' });
      setError(serverRestore.error ?? 'The restore did not work. Nothing was restored.');
    }
  }, [phase.kind, serverRestore, setPhase]);

  function choose(f: File | null) {
    setError(null);
    setFile(f);
    const problem = f ? backupFileProblem(f, RESTORE_MAX_BYTES) : null;
    if (problem) setError(problem);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (off || busy || throttle.waiting) return;
    if (codeNeeded && !code.trim()) {
      codeRef.current?.focus();
      return setError('Enter the setup code first.');
    }
    const problem = backupFileProblem(file, RESTORE_MAX_BYTES);
    if (problem || !file) {
      if (!file) fileRef.current?.click();
      return setError(problem);
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    baselineAt.current = serverRestore?.at ?? null;
    setAttempted(true);
    setPhase({ kind: 'asking' });
    try {
      // First, with no file: is the setup code right and the server ready? A refusal costs nothing to send.
      await checkRestore(codeNeeded ? code : undefined);
      if (ctrl.signal.aborted) throw new RestoreCancelledError();
      setPhase({ kind: 'sending', sent: 0, total: file.size, startedAt: Date.now() });
      await restoreBackup(file, {
        setupToken: codeNeeded ? code : undefined,
        signal: ctrl.signal,
        onProgress: (p) => setPhase((cur) => (cur.kind === 'sending' ? { ...cur, sent: p.sent, total: p.total, base: p.resumedFrom ?? 0 } : cur)),
        onSent: () => setPhase({ kind: 'working' }),
      });
      setCode('');
      await qc.invalidateQueries({ queryKey: ['auth'] });
    } catch (err) {
      if (err instanceof RestoreConnectionError && err.uploadFinished) {
        // The backup reached the server; its status says how the restore ends.
        setPhase({ kind: 'lost' });
        return;
      }
      setPhase({ kind: 'idle' });
      // A refusal may mean the server already holds a case (another tab finished first): ask it again.
      void qc.invalidateQueries({ queryKey: ['auth'] });
      if (err instanceof RestoreCancelledError) return setError(err.message);
      if (err instanceof RestoreConnectionError) return setError(`${err.message} Nothing was restored yet. Restore the same file again to carry on where it stopped.`);
      if (throttle.block(err)) return;
      if (errorCode(err) === 'setup_token') codeRef.current?.focus();
      setError(errorText(err, 'The restore did not work. Nothing was restored.'));
    } finally {
      abortRef.current = null;
    }
  }

  const locked = busy || off;
  // A backup dropped anywhere on the page is the one chosen (and a dropped file never makes the browser leave the
  // page to open it). The form is outlined while a file is over the page.
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth += 1;
      if (!lockedRef.current) setOver(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const onOverPage = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = lockedRef.current ? 'none' : 'copy';
    };
    const onDropPage = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      if (lockedRef.current) return;
      const f = e.dataTransfer?.files?.[0];
      if (f) choose(f);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOverPage);
    window.addEventListener('drop', onDropPage);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOverPage);
      window.removeEventListener('drop', onDropPage);
    };
  }, []); // choose only sets state, so the first one serves for good
  const progress = progressOf(phase, serverRestore);
  const lastFailed = !attempted && phase.kind === 'idle' && !error && serverRestore?.state === 'failed' ? serverRestore.error : null;
  return (
    <form
      className={['setup-form', 'restore-form', over ? 'over' : ''].filter(Boolean).join(' ')}
      onSubmit={submit}
      autoComplete="off"
      aria-label="Restore from a backup"
    >
      <p className="setup-lead">{SETUP_WORDS.restoreIntro}</p>
      {codeNeeded ? <SetupCodeField value={code} onChange={setCode} disabled={locked} inputRef={codeRef} autoFocus /> : null}

      <div className="setup-group">Backup</div>
      <label htmlFor="su-backup">Backup file</label>
      <div className="restore-file">
        <input
          id="su-backup"
          ref={fileRef}
          type="file"
          className="sr-only"
          accept=".zip,application/zip,application/x-zip-compressed"
          disabled={locked}
          onChange={(e) => {
            choose(e.target.files?.[0] ?? null);
            e.target.value = '';
          }}
        />
        <span className="row">
          <Button onClick={() => fileRef.current?.click()} disabled={locked} autoFocus={!codeNeeded}>
            {file ? 'Choose another file' : 'Choose the backup file'}
          </Button>
          <span className="muted">or drop it on this page</span>
        </span>
        {file ? (
          <span className="restore-name" title={file.name}>
            <span className="mono truncate">{file.name}</span>
            <span className="mono muted restore-size">{sizeWords(file.size)}</span>
          </span>
        ) : null}
      </div>

      {progress ? (
        <div className="restore-progress" role="status" aria-live="polite">
          {progress.fraction != null ? (
            <div className="restore-bar" aria-hidden="true">
              <span style={{ width: `${Math.round(progress.fraction * 1000) / 10}%` }} />
            </div>
          ) : null}
          <span className="muted">{progress.line}</span>
        </div>
      ) : null}
      {lastFailed ? (
        <div className="notice warn setup-error" role="status">
          The last restore did not work: {lastFailed}
        </div>
      ) : null}
      {throttle.message || error ? (
        <div className="error setup-error" role="alert">
          {throttle.message ?? error}
        </div>
      ) : null}
      <div className="setup-actions">
        <span className="muted">{hosted ? SETUP_WORDS.restoreFootHosted : SETUP_WORDS.restoreFootLocal}</span>
        <span className="row">
          {phase.kind === 'sending' || phase.kind === 'asking' ? (
            <Button variant="ghost" onClick={() => abortRef.current?.abort()}>
              Stop
            </Button>
          ) : null}
          <Button type="submit" variant="primary" disabled={locked || throttle.waiting || !file}>
            {phase.kind === 'sending' || phase.kind === 'asking' ? 'Sending…' : busy ? 'Restoring…' : 'Restore the backup'}
          </Button>
        </span>
      </div>
    </form>
  );
}

/** The progress line (and how full the bar is, when that is known) for where the restore stands. */
export function progressOf(phase: Phase, server: RestoreStatus | null, now = Date.now()): { line: string; fraction: number | null } | null {
  if (phase.kind === 'asking') return { line: 'Asking the server whether it can take the backup…', fraction: null };
  if (phase.kind === 'sending') return { line: uploadLine(phase.sent, phase.total, now - phase.startedAt, phase.base ?? 0), fraction: phase.total > 0 ? Math.min(1, phase.sent / phase.total) : null };
  const running = restoreRunning(server);
  if (phase.kind === 'lost') {
    const head = 'The connection dropped after the backup was sent; waiting for the server to finish.';
    return { line: running && server ? `${head} ${restoreStatusLine(server)}` : head, fraction: null };
  }
  if (phase.kind === 'working' || running) {
    if (server && running) {
      const fraction = server.state === 'extracting' && server.totalFiles ? server.files / server.totalFiles : server.state === 'receiving' && server.totalBytes ? server.receivedBytes / server.totalBytes : null;
      return { line: restoreStatusLine(server), fraction };
    }
    return { line: 'Sent. The server is checking the backup…', fraction: null };
  }
  return null;
}
