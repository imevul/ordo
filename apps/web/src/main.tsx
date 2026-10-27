import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError } from './api/client.ts';
import { setLocale, storedLocale } from './i18n/index.ts';
import { makeRouter } from './router.tsx';
import './styles/app.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      // Try even when the browser says it's offline: some queries answer from what this device
      // kept (the signed-in person, the config, the workspace's copy).
      networkMode: 'offlineFirst',
    },
    // Changes through the local copy queue themselves; the rest fail with a message.
    mutations: { networkMode: 'always' },
  },
});

const router = makeRouter(queryClient);

// Installable app, offline shell and push notifications (see public/sw.js).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// The language this browser used last, so the first paint is already in it; if the signed-in
// person's own choice (from /auth/me) differs, WorkspaceLayout switches to it.
await setLocale(storedLocale());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
