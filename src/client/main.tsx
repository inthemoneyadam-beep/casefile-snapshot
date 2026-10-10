// First: Zod's settings before any schema is made (zodConfig.ts; the hosted Content-Security-Policy).
import './zodConfig';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { applyAppearance, readAppearance } from './app/theme';
import { installActivityTracking } from './app/activity';

import '@fontsource/newsreader/400.css';
import '@fontsource/newsreader/400-italic.css';
import '@fontsource/newsreader/500.css';
import '@fontsource/newsreader/600.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/400-italic.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/base.css';
import './styles/features.css';
import './styles/print.css';

applyAppearance(readAppearance());
// Before the first request: reads count toward the idle lock only after real input.
installActivityTracking();

const queryClient = new QueryClient({
  defaultOptions: {
    // Polls stop while the tab is hidden (deliberate: a hidden tab is idle).
    queries: { retry: false, staleTime: 5_000, refetchOnWindowFocus: false, refetchIntervalInBackground: false },
    mutations: { retry: false },
  },
});

// Scroll is restored when moving to another page, never when only the search changes on the same page (?id=, a tab, a
// filter): the list has already scrolled its selected row into view, and putting back the position saved before the
// change would leave the selection out of sight (j past the last visible row). Called once per rendered navigation.
let renderedPath: string | null = null;
const router = createRouter({
  routeTree,
  defaultPreload: false,
  scrollRestoration: ({ location }) => {
    const samePage = location.pathname === renderedPath;
    renderedPath = location.pathname;
    return !samePage;
  },
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
