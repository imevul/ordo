import type { ForgeRepository, Integration, Repository } from '@ordo/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, wsPath } from '../../../api/client.ts';
import { Spinner } from '../../../components/PageHeader.tsx';
import { Modal } from '../../../components/ui/Modal.tsx';
import { t } from '../../../i18n/index.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';
import { FormRow } from '../ui.tsx';
import { errMsg, type RepositoryDraft } from './shared.ts';

/** Repositories already added use one URL style; offer the same for new ones. */
function preferredUrlStyle(repositories: Repository[]): 'ssh' | 'https' {
  const https = repositories.filter((r) => /^https?:\/\//.test(r.url)).length;
  return https > repositories.length - https ? 'https' : 'ssh';
}

/** Pick a connected forge, then one of the repositories it can see. */
export function BrowseRepositoriesModal({
  forges,
  onClose,
  onPick,
}: {
  forges: Integration[];
  onClose: () => void;
  onPick: (draft: RepositoryDraft) => void;
}) {
  const ws = useWorkspace();
  const [integrationId, setIntegrationId] = useState(forges[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [style, setStyle] = useState(() => preferredUrlStyle(ws.repositories));
  const {
    data: repos,
    error,
    isFetching,
  } = useQuery({
    queryKey: ['ws', ws.slug, 'integrations', integrationId, 'repositories'],
    queryFn: () =>
      api.get<ForgeRepository[]>(wsPath(ws.slug, `/integrations/${integrationId}/repositories`)),
    enabled: !!integrationId,
    staleTime: 60_000,
    retry: false,
  });
  const needle = query.trim().toLowerCase();
  const matches = (repos ?? []).filter((r) => r.fullName.toLowerCase().includes(needle));
  const added = new Set(
    ws.repositories.flatMap((r) => [
      r.url,
      ...(r.integrationId && r.externalRepo ? [`${r.integrationId}:${r.externalRepo}`] : []),
    ]),
  );
  const isAdded = (r: ForgeRepository) =>
    added.has(r.sshUrl) || added.has(r.cloneUrl) || added.has(`${integrationId}:${r.fullName}`);
  const pick = (r: ForgeRepository) =>
    onPick({
      name: r.fullName.split('/').at(-1) ?? r.fullName,
      url: style === 'ssh' ? r.sshUrl : r.cloneUrl,
      defaultBranch: r.defaultBranch,
      integrationId,
      externalRepo: r.fullName,
    });

  return (
    <Modal
      open
      onClose={onClose}
      width={600}
      label={t('agents.repositories.picker.label')}
      align="center"
    >
      <div className="flex min-h-0 flex-col p-6">
        <div className="section-label mb-4">{t('agents.repositories.picker.label')}</div>
        {forges.length > 1 && (
          <FormRow label={t('agents.repositories.picker.integration')}>
            <select
              className="input"
              value={integrationId}
              onChange={(e) => setIntegrationId(e.target.value)}
            >
              {forges.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </FormRow>
        )}
        <div className="mb-3 flex items-center gap-3">
          <input
            className="input flex-1"
            autoFocus
            placeholder={t('agents.repositories.picker.search')}
            aria-label={t('agents.repositories.picker.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              // Same rule as clicking: repositories already added can't be picked again.
              const first = matches.find((r) => !isAdded(r));
              if (first) pick(first);
            }}
          />
          <fieldset className="flex items-center gap-3 text-[12px] text-muted">
            <legend className="sr-only">{t('agents.repositories.picker.cloneWith')}</legend>
            {(['ssh', 'https'] as const).map((s) => (
              <label key={s} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  className="accent-primary"
                  name="clone-style"
                  checked={style === s}
                  onChange={() => setStyle(s)}
                />
                {s === 'ssh' ? 'SSH' : 'HTTPS'}
              </label>
            ))}
          </fieldset>
        </div>
        <div className="min-h-[8rem] flex-1 overflow-y-auto border border-border-soft">
          {error ? (
            <p className="p-3 text-[12.5px] text-error">{errMsg(error)}</p>
          ) : !repos && isFetching ? (
            <div className="p-3">
              <Spinner />
            </div>
          ) : matches.length === 0 ? (
            <p className="p-3 font-mono text-[12px] text-index">
              {t('agents.repositories.picker.empty')}
            </p>
          ) : (
            matches.map((r) => (
              <button
                key={r.fullName}
                type="button"
                className="menu-item disabled:cursor-default disabled:opacity-50"
                disabled={isAdded(r)}
                onClick={() => pick(r)}
              >
                <span className="min-w-0 flex-1 truncate text-left font-mono text-[12.5px]">
                  {r.fullName}
                </span>
                {r.private && (
                  <span className="tag">{t('agents.repositories.picker.private')}</span>
                )}
                {isAdded(r) && (
                  <span className="tag font-mono">{t('agents.repositories.picker.added')}</span>
                )}
              </button>
            ))
          )}
        </div>
        <div className="mt-4 flex justify-end">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
