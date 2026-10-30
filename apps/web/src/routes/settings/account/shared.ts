import { useQueryClient } from '@tanstack/react-query';
import { keys } from '../../../api/queries.ts';
import { t } from '../../../i18n/index.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : t('common.error'));

/** Refreshes everything that shows the current user after an account change. */
export function useRefreshAccount() {
  const qc = useQueryClient();
  const ws = useWorkspace();
  return () => {
    qc.invalidateQueries({ queryKey: keys.account });
    qc.invalidateQueries({ queryKey: keys.me });
    qc.invalidateQueries({ queryKey: keys.bootstrap(ws.slug) });
  };
}
