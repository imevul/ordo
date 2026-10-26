import type { PlaceholderSummary, WorkspaceExport } from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Merge, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../api/client.ts';
import { Spinner } from '../../components/PageHeader.tsx';
import { Avatar } from '../../components/ui/Avatar.tsx';
import { confirmDialog } from '../../components/ui/Modal.tsx';
import { fileSize, relativeTime } from '../../lib/format.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { SettingsCard } from './ui.tsx';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

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
      title="People from imports"
      description="Placeholders stand in for people an import brought along who aren't members. When someone joins, merge their placeholder into their account: what it created, wrote and was assigned becomes theirs."
    >
      {data.map((p) => {
        const target = choice[p.id] ?? p.suggestedUserId ?? '';
        const counts = [
          p.assigned && `${p.assigned} assigned`,
          p.created && `${p.created} created`,
          p.comments && `${p.comments} comments`,
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <div key={p.id} className="flex items-center gap-3 border-b border-border-soft py-2.5">
            <Avatar name={p.name} color={p.avatarColor} size={22} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px]">{p.name}</div>
              <div className="truncate text-[11.5px] text-index">
                {[p.importedEmail, counts || 'nothing attributed'].filter(Boolean).join(' · ')}
              </div>
            </div>
            <select
              className="input h-8 w-48 py-0 text-[12.5px]"
              aria-label={`Member to merge ${p.name} into`}
              value={target}
              onChange={(e) => setChoice({ ...choice, [p.id]: e.target.value })}
            >
              <option value="">Merge into…</option>
              {humans.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.id === p.suggestedUserId ? ' (same email or name)' : ''}
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
                    title: `Merge ${p.name} into ${member.name}?`,
                    body: `Everything ${p.name} created, wrote and was assigned becomes ${member.name}'s; issues in teams ${member.name} can't see lose their assignee. This can't be undone.`,
                    confirmLabel: 'Merge',
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
                      ? `Merged. ${res.unassigned} issues in teams ${member.name} can't see are unassigned.`
                      : 'Merged',
                  );
                  qc.invalidateQueries({ queryKey: key });
                } catch (err) {
                  toast.error(errMsg(err));
                }
              }}
            >
              <Merge size={12} /> Merge
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
      title="Export"
      description="Download the workspace. JSON holds everything that belongs to it — people, teams, projects, cycles, and every issue with its comments, history and links. CSV holds the issues, in columns Ordo's CSV import reads back. Exports are kept for a week."
    >
      <div className="mb-4 flex gap-2">
        <button
          type="button"
          className="btn btn-primary"
          disabled={running}
          onClick={() => start('json')}
        >
          <Download size={13} /> Export JSON
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={running}
          onClick={() => start('csv')}
        >
          <Download size={13} /> Export issues as CSV
        </button>
      </div>
      {!data && <Spinner />}
      {data?.map((e) => (
        <div key={e.id} className="flex items-center gap-3 border-b border-border-soft py-2.5">
          <span className="tag w-14 flex-none justify-center font-mono uppercase">{e.format}</span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px]">
              {e.status === 'running'
                ? 'Being made…'
                : e.status === 'failed'
                  ? `Failed: ${e.error ?? 'unknown error'}`
                  : fileSize(e.size ?? 0)}
            </div>
            <div className="truncate text-[11.5px] text-index">
              {e.createdBy?.name ?? 'Someone'} · {relativeTime(e.createdAt)} · deleted{' '}
              {relativeTime(e.expiresAt)}
            </div>
          </div>
          {e.url && (
            <a className="btn btn-ghost btn-sm" href={e.url} download>
              <Download size={12} /> Download
            </a>
          )}
          {e.status !== 'running' && (
            <button
              type="button"
              className="btn btn-danger btn-sm"
              aria-label="Delete export"
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
      {data?.length === 0 && <p className="font-mono text-[12px] text-index">// no exports yet</p>}
    </SettingsCard>
  );
}
