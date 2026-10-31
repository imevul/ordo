import type { ScimGroup, ScimLinkPreview, ScimToken } from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../../api/client.ts';
import { keys } from '../../../api/queries.ts';
import { confirmDialog } from '../../../components/ui/Modal.tsx';
import { t } from '../../../i18n/index.ts';
import { roleLabel } from '../../../i18n/labels.ts';
import { relativeTime } from '../../../lib/format.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';
import { SettingsCard, TeamSelect } from '../ui.tsx';
import { CopyField, errMsg } from './shared.tsx';

// ─── Org → Authentication → Directory sync ─────────────────────────────

interface TokensResponse {
  tokens: ScimToken[];
  baseUrl: string;
}

export function DirectorySyncCard({
  defaultRole,
  onDefaultRole,
}: {
  defaultRole: 'member' | 'guest';
  onDefaultRole: (role: 'member' | 'guest') => void;
}) {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const key = ['ws', ws.slug, 'scim-tokens'];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api.get<TokensResponse>(wsPath(ws.slug, '/scim/tokens')),
  });
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const reload = () => qc.invalidateQueries({ queryKey: key });

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await api.post<ScimToken & { token: string }>(wsPath(ws.slug, '/scim/tokens'), {
        name,
      });
      setFresh(res.token);
      setName('');
      reload();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  const revoke = async (token: ScimToken) => {
    const ok = await confirmDialog({
      title: t('sso.scim.revokeTitle', { name: token.name }),
      body: t('sso.scim.revokeBody'),
      confirmLabel: t('sso.scim.revoke'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(wsPath(ws.slug, `/scim/tokens/${token.id}`));
      setFresh(null);
      reload();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  return (
    <SettingsCard title={t('sso.scim.title')} description={t('sso.scim.description')}>
      {data && (
        <div className="mb-4 border border-border-soft bg-bg p-3">
          <CopyField label={t('sso.scim.baseUrl')} value={data.baseUrl} />
        </div>
      )}
      {fresh && (
        <div className="panel panel-sm mb-4 p-4 [--panel-border:var(--color-primary)]">
          <p className="mb-2 text-[13px]">{t('sso.scim.copyNow')}</p>
          <CopyField label="Bearer" value={fresh} />
        </div>
      )}
      {data?.tokens.map((token) => (
        <div
          key={token.id}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-soft py-2.5 text-[13px]"
        >
          <KeyRound size={14} className="flex-none text-index" />
          <span className="min-w-24 flex-1 truncate">{token.name}</span>
          <code className="font-mono text-[11px] text-index">{token.prefix}…</code>
          <span className="font-mono text-[11px] text-index">
            {token.lastUsedAt
              ? t('sso.scim.lastUsed', { time: relativeTime(token.lastUsedAt) })
              : t('sso.scim.neverUsed')}
            {token.createdBy && ` · ${t('sso.scim.createdBy', { name: token.createdBy })}`}
          </span>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            aria-label={t('sso.scim.revokeLabel', { name: token.name })}
            onClick={() => revoke(token)}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      {data?.tokens.length === 0 && (
        <p className="font-mono text-[12px] text-index">{t('sso.scim.empty')}</p>
      )}
      <form onSubmit={create} className="mt-4 flex flex-wrap gap-2">
        <input
          className="input min-w-0 flex-1 sm:max-w-64"
          required
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('sso.scim.tokenName')}
          aria-label={t('sso.scim.tokenName')}
        />
        <button className="btn btn-primary">
          <Plus size={13} /> {t('sso.scim.create')}
        </button>
      </form>
      <label className="mt-5 flex items-center justify-between border-t border-border-soft pt-4 text-[13.5px]">
        {t('sso.scim.defaultRole')}
        <select
          className="input w-40"
          value={defaultRole}
          onChange={(e) => onDefaultRole(e.target.value as 'member' | 'guest')}
        >
          <option value="member">{roleLabel('member')}</option>
          <option value="guest">{roleLabel('guest')}</option>
        </select>
      </label>
    </SettingsCard>
  );
}

/** Directory groups, and the teams they decide. Linking shows who'd join and leave first. */
export function DirectoryGroupsCard({
  matchByName,
  onMatchByName,
}: {
  matchByName: boolean;
  onMatchByName: (on: boolean) => void;
}) {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const key = ['ws', ws.slug, 'scim-groups'];
  const { data: groups = [] } = useQuery({
    queryKey: key,
    queryFn: () => api.get<ScimGroup[]>(wsPath(ws.slug, '/scim/groups')),
  });

  const link = async (group: ScimGroup, teamId: string | null) => {
    try {
      if (teamId) {
        const team = ws.teamById.get(teamId);
        const preview = await api.post<ScimLinkPreview>(
          wsPath(ws.slug, `/scim/groups/${group.id}/preview`),
          { teamId },
        );
        const names = (people: { name: string }[]) => people.map((p) => p.name).join(', ');
        const ok = await confirmDialog({
          title: t('sso.scim.linkTitle', { group: group.displayName, team: team?.name ?? '' }),
          body: (
            <>
              {preview.add.length > 0 && (
                <p>{t('sso.scim.joins', { names: names(preview.add) })}</p>
              )}
              {preview.remove.length > 0 && (
                <p className="mt-1">{t('sso.scim.leaves', { names: names(preview.remove) })}</p>
              )}
              {!preview.add.length && !preview.remove.length && <p>{t('sso.scim.noChange')}</p>}
            </>
          ),
          confirmLabel: t('sso.scim.link'),
          danger: preview.remove.length > 0,
        });
        if (!ok) return;
      }
      await api.put(wsPath(ws.slug, `/scim/groups/${group.id}/team`), { teamId });
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: keys.bootstrap(ws.slug) });
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  return (
    <SettingsCard title={t('sso.scim.groups')} description={t('sso.scim.groupsHint')}>
      <label className="mb-3 flex items-center justify-between gap-3 border-b border-border-soft pb-3 text-[13.5px]">
        {t('sso.scim.matchByName')}
        <input
          type="checkbox"
          className="accent-primary"
          checked={matchByName}
          onChange={(e) => onMatchByName(e.target.checked)}
        />
      </label>
      {groups.map((g) => (
        <div
          key={g.id}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-soft py-2.5 text-[13px]"
        >
          <span className="min-w-24 flex-1 truncate">{g.displayName}</span>
          <span className="font-mono text-[11px] text-index">
            {t('sso.scim.memberCount', { count: g.memberCount })}
          </span>
          <TeamSelect
            className="input h-8 w-44 py-0 text-[12.5px]"
            none={t('sso.scim.notLinked')}
            value={g.teamId}
            aria-label={t('sso.scim.teamOf', { group: g.displayName })}
            onChange={(teamId) => link(g, teamId)}
          />
        </div>
      ))}
      {groups.length === 0 && (
        <p className="font-mono text-[12px] text-index">{t('sso.scim.noGroups')}</p>
      )}
    </SettingsCard>
  );
}
