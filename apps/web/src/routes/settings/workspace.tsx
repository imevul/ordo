import { MEMBER_ROLES } from '@ordo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Copy, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../api/client.ts';
import { keys, useInvites, useWsMutation } from '../../api/queries.ts';
import { Avatar } from '../../components/ui/Avatar.tsx';
import { relativeTime, shortDate } from '../../lib/format.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { FormRow, SettingsCard } from './index.tsx';

export function WorkspaceSection() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(ws.workspace.name);
  const [slug, setSlug] = useState(ws.workspace.slug);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.patch(wsPath(ws.slug, '/'), { name, slug });
      await qc.invalidateQueries({ queryKey: keys.me });
      toast.success('Workspace saved');
      if (slug !== ws.slug)
        navigate({ to: '/$slug/settings/$section', params: { slug, section: 'workspace' } });
      else qc.invalidateQueries({ queryKey: keys.bootstrap(ws.slug) });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed');
    }
  };
  if (ws.role !== 'admin')
    return <p className="text-muted">Only admins can change workspace settings.</p>;
  return (
    <SettingsCard title="Workspace">
      <form onSubmit={save}>
        <FormRow label="Name">
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </FormRow>
        <FormRow label="URL" hint="Changing it breaks existing links.">
          <div className="flex items-center border border-border bg-bg focus-within:border-primary">
            <span className="pl-3 font-mono text-[12px] text-index">{location.host}/</span>
            <input
              className="h-9 min-w-0 flex-1 bg-transparent pr-3 outline-none"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              required
            />
          </div>
        </FormRow>
        <button className="btn btn-primary">Save</button>
      </form>
    </SettingsCard>
  );
}

export function MembersSection() {
  const ws = useWorkspace();
  const isAdmin = ws.role === 'admin';
  const { data: invites = [] } = useInvites(ws.slug, isAdmin);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const inv = [keys.invites(ws.slug) as unknown as unknown[]];
  const createInvite = useWsMutation(
    ws.slug,
    (body: object) => api.post<{ url: string }>(wsPath(ws.slug, '/invites'), body),
    { invalidate: inv },
  );
  const revokeInvite = useWsMutation(
    ws.slug,
    (id: string) => api.del(wsPath(ws.slug, `/invites/${id}`)),
    { invalidate: inv },
  );
  const setMemberRole = useWsMutation(ws.slug, (v: { userId: string; role: string }) =>
    api.patch(wsPath(ws.slug, `/members/${v.userId}`), { role: v.role }),
  );
  const removeMember = useWsMutation(
    ws.slug,
    (userId: string) => api.del(wsPath(ws.slug, `/members/${userId}`)),
    { success: 'Member removed' },
  );

  const copy = (url: string) => {
    navigator.clipboard?.writeText(url);
    toast.success('Invite link copied');
  };

  return (
    <>
      {isAdmin && (
        <SettingsCard
          title="Invite"
          description="Create a link and share it however you like. Links with an email are single-use and only work for that address; links without one can be used by anyone until they expire (14 days)."
        >
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              createInvite.mutate(
                { email: email || undefined, role },
                {
                  onSuccess: (res) => {
                    copy(res.url);
                    setEmail('');
                  },
                },
              );
            }}
          >
            <input
              className="input min-w-0 flex-1"
              type="email"
              placeholder="email@example.com (optional)"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <select
              className="input w-32"
              value={role}
              onChange={(e) => setRole(e.target.value as 'member' | 'admin')}
            >
              {MEMBER_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <button className="btn btn-primary">Create link</button>
          </form>
          {invites.length > 0 && (
            <div className="mt-4">
              {invites.map((i) => (
                <div
                  key={i.id}
                  className="flex h-10 items-center gap-3 border-b border-border-soft text-[13px]"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {i.email ?? <span className="text-muted">Anyone with the link</span>}
                  </span>
                  <span className="tag font-mono">{i.role}</span>
                  <span className="hidden font-mono text-[11px] text-index sm:block">
                    expires {shortDate(i.expiresAt)}
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => copy(i.url)}
                    aria-label="Copy invite link"
                  >
                    <Copy size={12} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => revokeInvite.mutate(i.id)}
                    aria-label="Revoke invite"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </SettingsCard>
      )}
      <SettingsCard title={`Members · ${ws.members.length}`}>
        {ws.members.map((m) => (
          <div key={m.id} className="flex h-12 items-center gap-3 border-b border-border-soft">
            <Avatar name={m.name} color={m.avatarColor} size={24} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px]">
                {m.name} {m.id === ws.me.id && <span className="text-index">(you)</span>}
              </div>
              <div className="truncate font-mono text-[11px] text-index">
                @{m.username} · {m.email}
              </div>
            </div>
            <span className="hidden font-mono text-[11px] text-index md:block">
              joined {relativeTime(m.joinedAt)}
            </span>
            {isAdmin ? (
              <select
                className="h-7 border border-border bg-bg px-2 text-[12px] outline-none focus:border-primary"
                value={m.role}
                onChange={(e) => setMemberRole.mutate({ userId: m.id, role: e.target.value })}
                aria-label={`Role of ${m.name}`}
              >
                {MEMBER_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            ) : (
              <span className="tag font-mono">{m.role}</span>
            )}
            {(isAdmin || m.id === ws.me.id) && (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() =>
                  confirm(
                    m.id === ws.me.id
                      ? 'Leave this workspace?'
                      : `Remove ${m.name} from the workspace?`,
                  ) && removeMember.mutate(m.id)
                }
                aria-label={m.id === ws.me.id ? 'Leave workspace' : `Remove ${m.name}`}
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        ))}
      </SettingsCard>
    </>
  );
}
