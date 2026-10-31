import { toast } from 'sonner';
import { t } from '../../../i18n/index.ts';

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : t('common.error'));

export const copy = (text: string) => {
  navigator.clipboard.writeText(text);
  toast.success(t('common.copied'));
};

/** What picking a forge repository fills into the new-repository form. */
export interface RepositoryDraft {
  name: string;
  url: string;
  defaultBranch: string;
  integrationId: string;
  externalRepo: string;
}
