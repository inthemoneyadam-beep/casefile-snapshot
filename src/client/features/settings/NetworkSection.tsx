/**
 * Settings, Advanced: local network access. Off, CaseFile answers only on this computer (127.0.0.1); on, it also
 * listens on the address below so a trusted home network can reach the lock screen. Only the owner changes it, and
 * it takes effect when the app restarts. (Moved here from People with access, 2026-10 UI overhaul.)
 */
import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { useSettings, useUpdateSettings } from '../../api/hooks';
import { useMe } from '../../api/users';
import { Field, Input } from '../../ui/Field';
import { useToast } from '../../ui/Toast';

export function NetworkSettings() {
  const me = useMe();
  const toast = useToast();
  const settings = useSettings();
  const update = useUpdateSettings();
  const s = settings.data;
  const canManage = me.isOwner;
  const [lanHost, setLanHost] = useState('');
  useEffect(() => {
    if (s) setLanHost(s['access.lanHost']);
  }, [s]);

  const patchLan = (p: { 'access.lan'?: boolean; 'access.lanHost'?: string }) =>
    update.mutate(p, {
      onSuccess: () => toast('Saved. Local network access changes when the app restarts.', 'ok'),
      onError: (err) => toast(err instanceof ApiError ? err.message : 'Could not save.', 'bad'),
    });
  const commitHost = () => {
    const v = lanHost.trim() || '0.0.0.0';
    if (!s || v === s['access.lanHost']) {
      setLanHost(v);
      return;
    }
    patchLan({ 'access.lanHost': v });
  };

  if (!s) return null;
  const now = me.lan ? (me.lan.active ? `On: reachable on the local network at ${me.lan.host}:${me.lan.port ?? ''}.` : me.lan.enabled ? 'Switched on; it starts when the app restarts.' : 'Off: reachable from this computer only.') : null;

  return (
    <div className="form settings-form">
      <Field inline label="Local network" hint={`For a trusted home network only: anyone on it can reach the lock screen, and every request still needs a person’s passphrase. From outside the home use a VPN such as Tailscale. Takes effect when the app restarts.${canManage ? '' : ' Only the owner can change this.'}`}>
        <label className="settings-check">
          <input type="checkbox" checked={s['access.lan']} disabled={!canManage || update.isPending} onChange={(e) => patchLan({ 'access.lan': e.target.checked })} />
          {s['access.lan'] ? 'On: also listen on the address below' : 'Off: this computer only'}
        </label>
      </Field>
      <Field inline label="Listen on address" hint="0.0.0.0 means every network connection of this computer.">
        <Input
          id="lan-host"
          value={lanHost}
          disabled={!canManage || update.isPending}
          onChange={(e) => setLanHost(e.target.value)}
          onBlur={commitHost}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitHost();
            }
          }}
          style={{ width: 200 }}
          className="mono"
          aria-label="Listen on address"
        />
      </Field>
      {now ? (
        <Field inline label="Right now">
          <span className={me.lan?.active ? 'settings-value warn' : 'settings-value'}>{now}</span>
        </Field>
      ) : null}
    </div>
  );
}
