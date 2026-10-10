import { useEffect } from 'react';
import { createRootRoute, Outlet } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStatus } from '../api/hooks';
import { LOCK_EVENT } from '../api/client';
import { LockScreen } from '../app/LockScreen';
import { Shell } from '../app/Shell';
import { CommandPalette } from '../app/CommandPalette';
import { GlobalShortcuts } from '../app/shortcuts';
import { ToastProvider } from '../ui/Toast';

export const Route = createRootRoute({ component: Root });

function Root() {
  const auth = useAuthStatus();
  const qc = useQueryClient();

  useEffect(() => {
    const onLocked = () => {
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
      void qc.invalidateQueries({ queryKey: ['auth'] });
    };
    window.addEventListener(LOCK_EVENT, onLocked);
    return () => window.removeEventListener(LOCK_EVENT, onLocked);
  }, [qc]);

  if (auth.isPending) return <div className="lock" />;
  if (auth.isError) {
    return (
      <div className="lock">
        <div className="lock-card">
          <h1>Casefile</h1>
          <div className="error">The server is not answering. If it is restarting, wait a minute and reload; on this computer, start it with Start CaseFile.cmd.</div>
        </div>
      </div>
    );
  }
  const a = auth.data;
  if (!a.unlocked || !a.session) return <LockScreen initialized={a.initialized} />;

  return (
    <ToastProvider>
      <Shell>
        <Outlet />
      </Shell>
      <CommandPalette />
      <GlobalShortcuts />
    </ToastProvider>
  );
}
