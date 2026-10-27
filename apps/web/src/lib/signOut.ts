import { deleteLocalCopies } from '@ordo/sync';
import type { QueryClient } from '@tanstack/react-query';
import { api } from '../api/client.ts';

/** Ends the session, and leaves nothing of it on this device: caches and local copies go too. */
export async function signOut(qc: QueryClient) {
  await api.post('/auth/logout');
  qc.clear();
  await deleteLocalCopies().catch(() => {});
  location.href = '/login';
}
