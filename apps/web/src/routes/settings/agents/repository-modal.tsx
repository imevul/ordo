import type { Integration, Repository } from '@ordo/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../../api/client.ts';
import { Modal } from '../../../components/ui/Modal.tsx';
import { t } from '../../../i18n/index.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';
import { FormRow } from '../ui.tsx';
import { errMsg, type RepositoryDraft } from './shared.ts';

export function RepositoryModal({
  repository,
  draft,
  forges,
  onClose,
  onSaved,
}: {
  repository: Repository | 'new' | null;
  /** Filled in from a forge repository picked in the browser. */
  draft?: RepositoryDraft;
  forges: Integration[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const ws = useWorkspace();
  const existing = repository && repository !== 'new' ? repository : null;
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  // Empty is no limit.
  const [maxRuns, setMaxRuns] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!repository) return;
    setName(existing?.name ?? draft?.name ?? '');
    setUrl(existing?.url ?? draft?.url ?? '');
    setDefaultBranch(existing?.defaultBranch ?? draft?.defaultBranch ?? 'main');
    setMaxRuns(existing?.maxConcurrentRuns ? String(existing.maxConcurrentRuns) : '');
  }, [repository, existing, draft]);
  const link = existing ?? (repository === 'new' ? draft : undefined);
  const linkedTo = link?.integrationId
    ? forges.find((f) => f.id === link.integrationId)?.name
    : undefined;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const body = {
      name,
      url,
      defaultBranch,
      maxConcurrentRuns: maxRuns ? Number(maxRuns) : null,
      ...(!existing &&
        draft && { integrationId: draft.integrationId, externalRepo: draft.externalRepo }),
    };
    try {
      if (existing) await api.patch(wsPath(ws.slug, `/repositories/${existing.id}`), body);
      else await api.post(wsPath(ws.slug, '/repositories'), body);
      onSaved();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={!!repository}
      onClose={onClose}
      width={560}
      label={t('agents.repositories.form.label')}
      align="center"
    >
      <form className="p-6" onSubmit={submit}>
        <div className="section-label mb-4">
          {existing ? t('agents.repositories.form.edit') : t('agents.repositories.form.new')}
        </div>
        <FormRow label={t('agents.repositories.form.name')}>
          <input
            className="input"
            required
            autoFocus
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </FormRow>
        <FormRow
          label={t('agents.repositories.form.url')}
          hint={t('agents.repositories.form.urlHint')}
        >
          <input
            className="input font-mono"
            required
            placeholder="git@git.example.com:acme/app.git"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              // Suggest a name from the URL until one is typed.
              const guess = /([^/:]+?)(\.git)?\/?$/.exec(e.target.value.trim())?.[1];
              if (!existing && guess && (!name || url.includes(name))) setName(guess);
            }}
          />
        </FormRow>
        <FormRow label={t('agents.repositories.form.defaultBranch')}>
          <input
            className="input w-48 font-mono"
            required
            value={defaultBranch}
            onChange={(e) => setDefaultBranch(e.target.value)}
          />
        </FormRow>
        <FormRow
          label={t('agents.repositories.form.maxRuns')}
          hint={t('agents.repositories.form.maxRunsHint')}
        >
          <input
            className="input w-32"
            type="number"
            min={1}
            max={100}
            step={1}
            placeholder={t('agents.repositories.form.maxRunsPlaceholder')}
            value={maxRuns}
            onChange={(e) => setMaxRuns(e.target.value)}
          />
        </FormRow>
        {link?.externalRepo && linkedTo && (
          <p className="text-[11.5px] text-index">
            {t('agents.repositories.form.linked', {
              repo: link.externalRepo,
              integration: linkedTo,
            })}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {existing ? t('common.save') : t('agents.repositories.add')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
