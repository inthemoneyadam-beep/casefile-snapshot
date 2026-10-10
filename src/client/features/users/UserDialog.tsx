/**
 * Add or edit a person with access: name, role, and a passphrase (required
 * when adding; optional when editing, where it resets theirs). The owner
 * sets a passphrase once; the person changes it after their first login
 * (Settings, Lock, Change passphrase).
 */
import { useEffect, useState, type FormEvent } from 'react';
import { ROLE_HINT, ROLES, type Role, type UserRow } from '../../api/users';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field, Input, Select } from '../../ui/Field';
import { ROLE_WORDS } from '../settings/words';

export interface UserDialogValues {
  name: string;
  role: Role;
  /** Empty when editing and left blank. */
  passphrase: string;
}

export function UserDialog({ open, mode, user, busy, error, onClose, onSubmit }: { open: boolean; mode: 'add' | 'edit'; user?: UserRow | null; busy?: boolean; error?: string | null; onClose: () => void; onSubmit: (v: UserDialogValues) => void }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(mode === 'edit' && user ? user.name : '');
    setRole(mode === 'edit' && user ? user.role : 'viewer');
    setPass('');
    setPass2('');
    setLocalError(null);
  }, [open, mode, user]);

  function submit(e: FormEvent) {
    e.preventDefault();
    setLocalError(null);
    if (!name.trim()) return setLocalError('A name is needed.');
    if (mode === 'add' && pass.length < 8) return setLocalError('Use at least 8 characters for the passphrase.');
    if (pass && pass.length < 8) return setLocalError('A new passphrase needs at least 8 characters, or leave both fields empty to keep the current one.');
    if (pass !== pass2) return setLocalError('The two passphrases do not match.');
    onSubmit({ name: name.trim(), role, passphrase: pass });
  }

  const title = mode === 'add' ? 'Add a person with access' : `Edit ${user?.name ?? 'person'}`;
  const shown = error ?? localError;
  return (
    <Dialog open={open} onClose={onClose} title={title} width={520}>
      <form className="form" onSubmit={submit} autoComplete="off">
        <Field inline label="Name">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120} disabled={busy} style={{ width: 300 }} />
        </Field>
        <Field inline label="Role" hint={ROLE_HINT[role]}>
          <Select options={ROLES.map((r) => ({ value: r, label: ROLE_WORDS[r] ?? r }))} value={role} onChange={(e) => setRole(e.target.value as Role)} disabled={busy} style={{ width: 160 }} />
        </Field>
        <Field inline label={mode === 'add' ? 'Passphrase' : 'New passphrase'} hint={mode === 'add' ? 'Set once by you; they change it after they first sign in. It opens the same case as yours. At least 8 characters.' : 'Leave both empty to keep the current one. A new one signs them out everywhere and the old one stops opening this case; full backups made before the change still open with the old one.'}>
          <Input type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} disabled={busy} style={{ width: 300 }} />
        </Field>
        <Field inline label="Repeat it" error={shown}>
          <Input type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} disabled={busy} style={{ width: 300 }} />
        </Field>
        <div className="form-actions">
          <Button type="submit" variant="primary" disabled={busy || !name.trim() || (mode === 'add' && !pass)}>
            {busy ? 'Saving…' : mode === 'add' ? 'Add person' : 'Save'}
          </Button>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
