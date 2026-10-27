import type { PlaceholderSummary, WorkspaceExport } from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Merge, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../api/client.ts';
import { Spinner } from '../../components/PageHeader.tsx';
import { Avatar } from '../../components/ui/Avatar.tsx';
import { confirmDialog } from '../../components/ui/Modal.tsx';
import { t } from '../../i18n/index.ts';
import { fileSize, relativeTime } from '../../lib/format.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { SettingsCard } from './ui.tsx';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : t('common.error'));

/** People imports brought along, and merging them into members who've joined since. */
export function PlaceholdersCard() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const key = ['ws', ws.slug, 'placeholders'];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api.get<PlaceholderSummary[]>(wsPath(ws.slug, '/placeholders')),
    enabled: ws.isAdmin,
  });
  const [choice, setChoice] = useState<Record<string, string>>({});
  if (!data?.length) return null;
  const humans = ws.members.filter((m) => !m.suspended);

  return (
    <SettingsCard
      title={t('settings.placeholders.title')}
      description={t('settings.placeholders.description')}
    >
      {data.map((p) => {
        const target = choice[p.id] ?? p.suggestedUserId ?? '';
        const counts = [
          p.assigned && t('settings.placeholders.assigned', { count: p.assigned }),
          p.created && t('settings.placeholders.created', { count: p.created }),
          p.comments && t('settings.placeholders.comments', { count: p.comments }),
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <div key={p.id} className="flex items-center gap-3 border-b border-border-soft py-2.5">
            <Avatar name={p.name} color={p.avatarColor} size={22} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px]">{p.name}</div>
              <div className="truncate text-[11.5px] text-index">
                {[p.importedEmail, counts || t('settings.placeholders.nothingAttributed')]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            <select
              className="input h-8 w-48 py-0 text-[12.5px]"
              aria-label={t('settings.placeholders.mergeTarget', { name: p.name })}
              value={target}
              onChange={(e) => setChoice({ ...choice, [p.id]: e.target.value })}
            >
              <option value="">{t('settings.placeholders.mergeInto')}</option>
              {humans.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id === p.suggestedUserId
                    ? t('settings.placeholders.suggested', { name: m.name })
                    : m.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={!target}
              onClick={async () => {
                const member = humans.find((m) => m.id === target)!;
                if (
                  !(await confirmDialog({
                    title: t('settings.placeholders.confirmTitle', {
                      placeholder: p.name,
                      member: member.name,
                    }),
                    body: t('settings.placeholders.confirmBody', {
                      placeholder: p.name,
                      member: member.name,
                    }),
                    confirmLabel: t('settings.placeholders.merge'),
                  }))
                )
                  return;
                try {
                  const res = await api.post<{ assigned: number; unassigned: number }>(
                    wsPath(ws.slug, `/placeholders/${p.id}/merge`),
                    { userId: target },
                  );
                  toast.success(
                    res.unassigned
                      ? t('settings.placeholders.mergedUnassigned', {
                          count: res.unassigned,
                          member: member.name,
                        })
                      : t('settings.placeholders.merged'),
                  );
                  qc.invalidateQueries({ queryKey: key });
                } catch (err) {
                  toast.error(errMsg(err));
                }
              }}
            >
              <Merge size={12} /> {t('settings.placeholders.merge')}
            </button>
          </div>
        );
      })}
    </SettingsCard>
  );
}

export function ExportsCard() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const key = ['ws', ws.slug, 'exports'];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api.get<WorkspaceExport[]>(wsPath(ws.slug, '/exports')),
    enabled: ws.isAdmin,
    refetchInterval: (q) => (q.state.data?.some((e) => e.status === 'running') ? 3000 : false),
  });
  const running = data?.some((e) => e.status === 'running');
  const start = async (format: 'json' | 'csv') => {
    try {
      await api.post(wsPath(ws.slug, '/exports'), { format });
      qc.invalidateQueries({ queryKey: key });
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  return (
    <SettingsCard
      title={t('settings.exports.title')}
      description={t('settings.exports.description')}
    >
      <div className="mb-4 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-primary"
          disabled={running}
          onClick={() => start('json')}
        >
          <Download size={13} /> {t('settings.exports.exportJson')}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={running}
          onClick={() => start('csv')}
        >
          <Download size={13} /> {t('settings.exports.exportCsv')}
        </button>
      </div>
      {!data && <Spinner />}
      {data?.map((e) => (
        <div key={e.id} className="flex items-center gap-3 border-b border-border-soft py-2.5">
          <span className="tag w-14 flex-none justify-center font-mono uppercase">{e.format}</span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px]">
              {e.status === 'running'
                ? t('settings.exports.running')
                : e.status === 'failed'
                  ? t('settings.exports.failed', {
                      error: e.error ?? t('settings.exports.unknownError'),
                    })
                  : fileSize(e.size ?? 0)}
            </div>
            <div className="truncate text-[11.5px] text-index">
              {t('settings.exports.meta', {
                name: e.createdBy?.name ?? t('settings.exports.someone'),
                created: relativeTime(e.createdAt),
                expires: relativeTime(e.expiresAt),
              })}
            </div>
          </div>
          {e.url && (
            <a className="btn btn-ghost btn-sm" href={e.url} download>
              <Download size={12} /> {t('settings.download')}
            </a>
          )}
          {e.status !== 'running' && (
            <button
              type="button"
              className="btn btn-danger btn-sm"
              aria-label={t('settings.exports.delete')}
              onClick={async () => {
                await api.del(wsPath(ws.slug, `/exports/${e.id}`));
                qc.invalidateQueries({ queryKey: key });
              }}
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      ))}
      {data?.length === 0 && (
        <p className="font-mono text-[12px] text-index">{t('settings.exports.empty')}</p>
      )}
    </SettingsCard>
  );
}
