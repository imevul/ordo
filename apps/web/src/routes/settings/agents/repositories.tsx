import type { Integration, IntegrationProviderInfo, Repository } from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, wsPath } from '../../../api/client.ts';
import { keys as queryKeys } from '../../../api/queries.ts';
import { confirmDialog } from '../../../components/ui/Modal.tsx';
import { t } from '../../../i18n/index.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';
import { SettingsCard } from '../ui.tsx';
import { BrowseRepositoriesModal } from './browse-repositories.tsx';
import { RepositoryModal } from './repository-modal.tsx';
import type { RepositoryDraft } from './shared.ts';

// ─── Repositories ────────────────────────────────────────────────────

/** Forge providers whose integrations can list the repositories they see. */
const BROWSABLE = new Set(['github', 'forgejo']);

/** Settings → Repositories: where code lives, for projects and team defaults to point at. */
export function RepositoriesSection() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Repository | 'new' | null>(null);
  const [draft, setDraft] = useState<RepositoryDraft | undefined>();
  const [browsing, setBrowsing] = useState(false);
  const { data: connected } = useQuery({
    queryKey: ['ws', ws.slug, 'integrations'],
    queryFn: () =>
      api.get<{ providers: IntegrationProviderInfo[]; integrations: Integration[] }>(
        wsPath(ws.slug, '/integrations'),
      ),
    enabled: ws.isAdmin,
  });
  const forges = (connected?.integrations ?? []).filter(
    (i) => BROWSABLE.has(i.provider) && i.status !== 'disabled',
  );
  const reload = () => qc.invalidateQueries({ queryKey: queryKeys.bootstrap(ws.slug) });
  if (!ws.isAdmin) return <p className="text-muted">{t('agents.repositories.adminsOnly')}</p>;
  return (
    <>
      <SettingsCard
        title={t('agents.repositories.title')}
        description={t('agents.repositories.description')}
      >
        {ws.repositories.map((r) => (
          <div key={r.id} className="flex items-center gap-3 border-b border-border-soft py-3">
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px]">{r.name}</div>
              <div className="truncate font-mono text-[11.5px] text-index">
                {r.url} · {t('agents.repositories.branch', { branch: r.defaultBranch })}
                {r.maxConcurrentRuns !== null &&
                  ` · ${t('agents.repositories.maxRuns', { count: r.maxConcurrentRuns })}`}
              </div>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label={t('agents.repositories.edit', { name: r.name })}
              onClick={() => setEditing(r)}
            >
              <Pencil size={12} />
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              aria-label={t('agents.repositories.delete', { name: r.name })}
              onClick={async () => {
                if (
                  !(await confirmDialog({
                    title: t('agents.repositories.confirmDelete', { name: r.name }),
                    danger: true,
                  }))
                )
                  return;
                await api.del(wsPath(ws.slug, `/repositories/${r.id}`));
                reload();
              }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        {ws.repositories.length === 0 && (
          <p className="font-mono text-[12px] text-index">{t('agents.repositories.empty')}</p>
        )}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setDraft(undefined);
              setEditing('new');
            }}
          >
            <Plus size={13} /> {t('agents.repositories.add')}
          </button>
          {forges.length > 0 && (
            <button type="button" className="btn btn-ghost" onClick={() => setBrowsing(true)}>
              <Search size={13} /> {t('agents.repositories.browse')}
            </button>
          )}
        </div>
      </SettingsCard>
      {/* Mounted only while open, so each visit starts fresh. */}
      {browsing && (
        <BrowseRepositoriesModal
          forges={forges}
          onClose={() => setBrowsing(false)}
          onPick={(picked) => {
            setBrowsing(false);
            setDraft(picked);
            setEditing('new');
          }}
        />
      )}
      <RepositoryModal
        repository={editing}
        draft={draft}
        forges={forges}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          reload();
        }}
      />
    </>
  );
}
