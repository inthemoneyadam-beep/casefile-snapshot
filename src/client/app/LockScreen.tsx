/**
 * The lock screen. With no keyring yet it is the first-run setup
 * (features/users/SetupScreen: a new case, or a restore from a backup);
 * otherwise the unlock form, which shows a name select when more than one
 * person has a passphrase. Every passphrase opens the same encrypted case; the
 * name only decides whose session this is. On a hosted server the names are
 * not shown before a sign-in (the status lists none), so the form asks for the
 * passphrase alone and the server finds whose it is.
 *
 * After a restore from a backup it says so in the tab that restored it, until
 * the first unlock there.
 * After too many wrong passphrases the server answers 429 with a wait: the
 * form counts it down and keeps Unlock off until then.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { errorText, unlockAs, useAuthFull } from '../api/users';
import { Button } from '../ui/Button';
import { SetupScreen } from '../features/users/SetupScreen';
import { markRestoreNoticeSeen, showRestoreNotice } from '../features/users/restoreNotice';
import { useThrottle } from '../features/users/useThrottle';
import { APP_NAME } from '@shared/constants';
import '../features/users/users.css';

const LAST_USER_KEY = 'casefile.lastUserId';

function readLastUser(): string {
  try {
    return localStorage.getItem(LAST_USER_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeLastUser(id: string): void {
  try {
    localStorage.setItem(LAST_USER_KEY, id);
  } catch {
    // ignore
  }
}

export function LockScreen({ initialized }: { initialized: boolean }) {
  if (!initialized) return <SetupScreen />;
  return <UnlockForm />;
}

function UnlockForm() {
  const qc = useQueryClient();
  const status = useAuthFull();
  const users = status.data?.users ?? [];
  const [userId, setUserId] = useState<string>(() => readLastUser());
  const [pass, setPass] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const throttle = useThrottle();
  const hosted = status.data?.hosted === true;
  const restore = status.data?.restore ?? null;
  const restored = restore?.state === 'done' && showRestoreNotice(restore.at) ? restore : null;

  // Keep the chosen name valid as the list arrives or changes.
  useEffect(() => {
    if (!users.length) return;
    if (!users.some((u) => u.id === userId)) setUserId(users[0].id);
  }, [users, userId]);

  const multi = users.length > 1;
  const single = users.length === 1 ? users[0] : null;
  const chosen = multi ? users.find((u) => u.id === userId) ?? users[0] : single;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (throttle.waiting) return;
    setError(null);
    setBusy(true);
    try {
      await unlockAs(pass, multi ? chosen?.id : undefined);
      if (chosen) writeLastUser(chosen.id);
      if (restore?.state === 'done') markRestoreNoticeSeen(restore.at);
      setPass('');
      await qc.invalidateQueries();
    } catch (err) {
      if (throttle.block(err)) setError(null);
      else if (err instanceof ApiError && err.status === 401) setError('Wrong passphrase.');
      else setError(errorText(err, 'Could not unlock.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lock">
      <form className="lock-card" onSubmit={submit}>
        <div>
          <h1>{APP_NAME}</h1>
          <div className="muted small">{multi ? 'Choose your name and enter your passphrase to open the case.' : 'Enter your passphrase to open the case.'}</div>
        </div>
        {restored ? (
          <div className="notice ok" role="status">
            <strong>The backup is restored.</strong> Unlock with the passphrase that was in use when the backup was made.
          </div>
        ) : null}
        {multi ? (
          <div className="lock-who">
            <label htmlFor="lock-user">Who is this</label>
            <select id="lock-user" value={chosen?.id ?? ''} onChange={(e) => setUserId(e.target.value)} disabled={busy}>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          placeholder={single ? `Passphrase for ${single.name}` : 'Passphrase'}
          aria-label="Passphrase"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          disabled={busy}
        />
        {throttle.message || error ? (
          <div className="error" role="alert">
            {throttle.message ?? error}
          </div>
        ) : null}
        <div className="lock-foot">
          <span className="faint xs">{hosted ? 'Your Railway server. Nothing leaves it except the Claude requests you start.' : 'Local only. Nothing leaves this PC except AI requests you start.'}</span>
          <Button type="submit" variant="primary" disabled={busy || !pass || throttle.waiting}>
            {busy ? 'Working…' : 'Unlock'}
          </Button>
        </div>
      </form>
    </div>
  );
}
