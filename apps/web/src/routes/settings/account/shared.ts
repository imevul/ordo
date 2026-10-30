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

/** After API keys and connected apps were revoked along with a password or 2FA change. */
export function useRefreshCredentials() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: keys.apiKeys });
    qc.invalidateQueries({ queryKey: keys.oauthGrants });
  };
}
