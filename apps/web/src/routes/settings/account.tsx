import { AVATAR_COLORS } from '@ordo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../api/client.ts';
import { keys, useApiKeys } from '../../api/queries.ts';
import { Avatar } from '../../components/ui/Avatar.tsx';
import { relativeTime } from '../../lib/format.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { FormRow, SettingsCard } from './index.tsx';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

export function AccountSection() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const [name, setName] = useState(ws.me.name);
  const [username, setUsername] = useState(ws.me.username);
  const [color, setColor] = useState(ws.me.avatarColor);
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });

  const saveProfile = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.patch('/me', { name, username, avatarColor: color });
      await qc.invalidateQueries({ queryKey: keys.me });
      await qc.invalidateQueries({ queryKey: keys.bootstrap(ws.slug) });
      toast.success('Profile saved');
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post('/me/password', pw);
      setPw({ currentPassword: '', newPassword: '' });
      toast.success('Password changed. Other sessions were signed out.');
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  return (
    <>
      <SettingsCard title="Profile">
        <form onSubmit={saveProfile}>
          <div className="mb-5 flex items-center gap-4">
            <Avatar name={name || '?'} color={color} size={48} />
            <div className="flex flex-wrap gap-1.5">
              {AVATAR_COLORS.map((c) => (
                <button
                  type="button"
                  key={c}
                  onClick={() => setColor(c)}
                  className={`h-6 w-6 ${color === c ? 'outline-2 outline-offset-2 outline-text' : ''}`}
                  style={{ background: c }}
                  aria-label={`Avatar color ${c}`}
                />
              ))}
            </div>
          </div>
          <FormRow label="Full name">
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </FormRow>
          <FormRow label="Username" hint="Used for @mentions.">
            <input
              className="input font-mono"
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase())}
              required
            />
          </FormRow>
          <FormRow label="Email">
            <input className="input" value={ws.me.email} disabled />
          </FormRow>
          <button className="btn btn-primary">Save profile</button>
        </form>
      </SettingsCard>
      <SettingsCard title="Password">
        <form onSubmit={changePassword}>
          <FormRow label="Current password">
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={pw.currentPassword}
              onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })}
              required
            />
          </FormRow>
          <FormRow label="New password" hint="At least 8 characters.">
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              minLength={8}
              value={pw.newPassword}
              onChange={(e) => setPw({ ...pw, newPassword: e.target.value })}
              required
            />
          </FormRow>
          <button className="btn btn-ghost">Change password</button>
        </form>
      </SettingsCard>
    </>
  );
}

export function ApiKeysSection() {
  const qc = useQueryClient();
  const { data: list = [] } = useApiKeys();
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await api.post<{ token: string }>('/me/api-keys', { name });
      setCreated(res.token);
      setName('');
      qc.invalidateQueries({ queryKey: keys.apiKeys });
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  const revoke = async (id: string) => {
    if (!confirm('Revoke this key? Anything using it stops working.')) return;
    await api.del(`/me/api-keys/${id}`);
    qc.invalidateQueries({ queryKey: keys.apiKeys });
  };

  return (
    <SettingsCard
      title="Personal API keys"
      description={
        <>
          Keys act as you against the REST API. Send them as{' '}
          <code className="font-mono text-highlight">Authorization: Bearer ordo_…</code>. See{' '}
          <span className="font-mono">docs/api.md</span>.
        </>
      }
    >
      <form onSubmit={create} className="mb-5 flex gap-2">
        <input
          className="input"
          placeholder="Key name, e.g. CI bot"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <button className="btn btn-primary">
          <KeyRound size={13} /> Create
        </button>
      </form>
      {created && (
        <div className="panel panel-sm mb-5 p-4 [--panel-border:var(--color-primary)]">
          <div className="kicker mb-2">// copy it now — it won't be shown again</div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{created}</code>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                navigator.clipboard?.writeText(created);
                toast.success('Copied');
              }}
            >
              <Copy size={12} /> Copy
            </button>
          </div>
        </div>
      )}
      {list.map((k) => (
        <div key={k.id} className="flex h-11 items-center gap-3 border-b border-border-soft">
          <KeyRound size={14} className="text-muted" />
          <span className="min-w-0 flex-1 truncate">{k.name}</span>
          <span className="font-mono text-[11.5px] text-index">{k.prefix}…</span>
          <span className="hidden w-32 text-right font-mono text-[11px] text-index sm:block">
            {k.lastUsedAt ? `used ${relativeTime(k.lastUsedAt)}` : 'never used'}
          </span>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={() => revoke(k.id)}
            aria-label={`Revoke ${k.name}`}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      {list.length === 0 && !created && (
        <p className="font-mono text-[12px] text-index">// no keys yet</p>
      )}
    </SettingsCard>
  );
}
