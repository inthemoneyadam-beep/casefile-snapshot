/**
 * The one line in the nav foot: who is signed in and their role, plus the
 * persistent "reachable on the local network" notice while the LAN listener
 * is up (Settings, People with access).
 *
 * The shell mounts this line on every page, so it also registers the
 * palette command for Getting started (/setup is not in the nav, and a
 * command registered by the page itself would only exist while already on it).
 */
import { useNavigate } from '@tanstack/react-router';
import { useMe } from '../../api/users';
import { useRegisterCommands } from '../../app/commands';
import { ROLE_WORDS } from '../settings/words';
import './users.css';

export function AccessLine() {
  const me = useMe();
  const navigate = useNavigate();
  useRegisterCommands(
    [{ id: 'setup.open', title: 'Go to Getting started', group: 'Actions', keywords: 'setup first run welcome getting started import files folder', run: () => void navigate({ to: '/setup', search: {} }) }],
    [navigate],
  );
  if (!me.user) return null;
  const roleHint = me.isOwner ? 'Owner: everything' : me.isEditor ? 'Editor: everything except security settings and the AI key' : 'Viewer: reads everything; adds calls and messages, to-dos and symptom days';
  return (
    <div className="access-line" title={roleHint}>
      <div className="who">
        <span className="name">{me.user.name}</span>
        <span className="role">{ROLE_WORDS[me.user.role] ?? me.user.role}</span>
      </div>
      {me.lan?.active ? <div className="lan">Reachable on the local network</div> : null}
    </div>
  );
}
