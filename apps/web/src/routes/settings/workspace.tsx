import {
  ACCENT_PRESETS,
  type AuditEntry,
  accentVariables,
  branchName,
  contrast,
  DEFAULT_ACCENT,
  HEX_COLOR,
  type Invite,
  MEMBER_ROLE_LABELS,
  MEMBER_ROLES,
  type MemberRole,
  THEME_BACKGROUND,
  type WorkspaceDomain,
  type WorkspaceSettings,
} from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  Ban,
  CheckCircle2,
  Copy,
  Globe,
  Mail,
  RotateCcw,
  Trash2,
  Upload,
  UserCheck,
} from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, upload, wsPath } from '../../api/client.ts';
import { keys, useConfig, useInvites, useWsMutation } from '../../api/queries.ts';
import { TeamIcon } from '../../components/icons.tsx';
import { Spinner } from '../../components/PageHeader.tsx';
import { Picker } from '../../components/properties.tsx';
import { ActorName } from '../../components/ui/ActorName.tsx';
import { Avatar } from '../../components/ui/Avatar.tsx';
import { confirmDialog, Modal } from '../../components/ui/Modal.tsx';
import { relativeTime, shortDate } from '../../lib/format.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { FormRow, SettingsCard } from './ui.tsx';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

// ─── General ───────────────────────────────────────────────────────────

export function WorkspaceSection() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(ws.workspace.name);
  const [slug, setSlug] = useState(ws.workspace.slug);
  const fileRef = useRef<HTMLInputElement>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: keys.bootstrap(ws.slug) });
    qc.invalidateQueries({ queryKey: keys.me });
  };

  if (!ws.isAdmin) return <p className="text-muted">Only admins can change workspace settings.</p>;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.patch(wsPath(ws.slug, '/'), { name, slug });
      toast.success('Workspace saved');
      if (slug !== ws.slug)
        navigate({ to: '/$slug/settings/$section', params: { slug, section: 'workspace' } });
      refresh();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  const setDefaultTeam = async (teamId: string) => {
    await api.patch(wsPath(ws.slug, '/'), { defaultTeamId: teamId === 'none' ? null : teamId });
    refresh();
  };

  return (
    <>
      <SettingsCard title="Workspace">
        <div className="mb-5 flex items-center gap-4">
          {ws.workspace.logoUrl ? (
            <img src={ws.workspace.logoUrl} alt="" className="h-12 w-12 object-cover" />
          ) : (
            <TeamIcon color="var(--color-primary)" label={ws.workspace.name} size={48} />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => fileRef.current?.click()}
            >
              <Upload size={12} /> Upload logo
            </button>
            {ws.workspace.logoUrl && (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={async () => {
                  await api.del(wsPath(ws.slug, '/logo'));
                  refresh();
                }}
              >
                Remove
              </button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              try {
                await upload(wsPath(ws.slug, '/logo'), file, file.name);
                refresh();
              } catch (err) {
                toast.error(errMsg(err));
              }
            }}
          />
        </div>
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

      <SettingsCard
        title="Default team"
        description="New members (except guests) join this team automatically, and it's preselected for new issues."
      >
        <select
          className="input w-72"
          value={ws.workspace.defaultTeamId ?? 'none'}
          onChange={(e) => setDefaultTeam(e.target.value)}
        >
          <option value="none">None</option>
          {ws.teams
            .filter((t) => !t.private)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
        </select>
      </SettingsCard>

      <AccentCard />

      <BranchFormatCard />

      {ws.isOwner && <DangerZone />}
    </>
  );
}

/** The workspace's accent colour: presets, or any colour that reads on the dark background. */
function AccentCard() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const saved = ws.workspace.settings.accentColor ?? DEFAULT_ACCENT;
  const [draft, setDraft] = useState(saved);
  const valid = HEX_COLOR.test(draft);
  const faint = valid && contrast(draft, THEME_BACKGROUND) < 3;
  const save = async (color: string) => {
    try {
      await api.patch(wsPath(ws.slug, '/'), {
        settings: {
          accentColor: color.toLowerCase() === DEFAULT_ACCENT ? null : color.toLowerCase(),
        },
      });
      qc.invalidateQueries({ queryKey: keys.bootstrap(ws.slug) });
      toast.success('Accent saved');
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  return (
    <SettingsCard
      title="Accent colour"
      description="Buttons, highlights and glows across this workspace. Everyone in it sees the same colour; sign-in pages stay Hotline Pink."
    >
      <div className="mb-4 flex flex-wrap gap-2">
        {ACCENT_PRESETS.map((p) => (
          <button
            key={p.color}
            type="button"
            onClick={() => setDraft(p.color)}
            className={`flex items-center gap-2 border px-2.5 py-1.5 text-[12.5px] ${draft.toLowerCase() === p.color ? 'border-text text-text' : 'border-border-soft text-muted hover:text-text'}`}
            aria-pressed={draft.toLowerCase() === p.color}
          >
            <span className="h-3 w-3" style={{ background: p.color }} />
            {p.name}
          </button>
        ))}
      </div>
      <div className="mb-4 flex items-center gap-2">
        <input
          type="color"
          className="h-8 w-10 cursor-pointer border border-border bg-bg p-0.5"
          value={valid ? draft : DEFAULT_ACCENT}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Custom colour"
        />
        <input
          className="input w-32 font-mono"
          value={draft}
          onChange={(e) => setDraft(e.target.value.trim())}
          aria-label="Hex colour"
        />
      </div>
      {/* The palette is a set of CSS variables, so this box previews it without touching the page. */}
      <div
        className="mb-4 border border-border-soft bg-bg p-4"
        style={valid ? (accentVariables(draft) as React.CSSProperties) : undefined}
      >
        <div className="kicker mb-2">
          <span className="text-muted">// </span>preview
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="btn btn-primary btn-sm">Primary</span>
          <span className="btn btn-ghost btn-sm">Ghost</span>
          <span className="chip [--chip:var(--color-primary)]">in progress</span>
          <span className="text-[13px] text-highlight">a link</span>
          <span className="h-[7px] w-[7px] bg-primary shadow-[0_0_10px_var(--color-primary)]" />
          <span className="text-[12px] text-muted">muted text</span>
        </div>
      </div>
      {faint && (
        <p className="mb-3 text-[12px] text-warning">
          This colour is hard to see on the dark background; pick something brighter.
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!valid || draft.toLowerCase() === saved.toLowerCase()}
          onClick={() => save(draft)}
        >
          Save
        </button>
        {saved !== DEFAULT_ACCENT && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setDraft(DEFAULT_ACCENT);
              save(DEFAULT_ACCENT);
            }}
          >
            Back to Hotline Pink
          </button>
        )}
      </div>
    </SettingsCard>
  );
}

function BranchFormatCard() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const [format, setFormat] = useState(ws.workspace.settings.gitBranchFormat);
  const example = branchName(format, {
    identifier: 'ENG-42',
    title: 'Fix the flux capacitor',
    username: ws.me.username,
  });
  return (
    <SettingsCard
      title="Git branch names"
      description={
        <>
          What “Copy git branch name” produces. Use{' '}
          <code className="font-mono">{'{identifier}'}</code>,{' '}
          <code className="font-mono">{'{title}'}</code> and{' '}
          <code className="font-mono">{'{username}'}</code>. Branches containing the identifier link
          to the issue.
        </>
      }
    >
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.patch(wsPath(ws.slug, '/'), { settings: { gitBranchFormat: format } });
            qc.invalidateQueries({ queryKey: keys.bootstrap(ws.slug) });
            toast.success('Saved');
          } catch (err) {
            toast.error(errMsg(err));
          }
        }}
      >
        <input
          className="input w-72 font-mono"
          value={format}
          onChange={(e) => setFormat(e.target.value)}
          aria-label="Branch name format"
        />
        <button className="btn btn-primary">Save</button>
      </form>
      <p className="mt-2 font-mono text-[11.5px] text-index">→ {example}</p>
    </SettingsCard>
  );
}

function DangerZone() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [heir, setHeir] = useState('');
  const [confirm, setConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const candidates = ws.members.filter(
    (m) => m.id !== ws.me.id && m.role !== 'guest' && !m.suspended,
  );

  return (
    <SettingsCard title="Danger zone">
      <div className="mb-6">
        <div className="mb-2 text-[13.5px]">Transfer ownership</div>
        <div className="flex gap-2">
          <select className="input w-72" value={heir} onChange={(e) => setHeir(e.target.value)}>
            <option value="">Choose a member…</option>
            {candidates.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({MEMBER_ROLE_LABELS[m.role]})
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!heir}
            onClick={async () => {
              const who = ws.memberById.get(heir)?.name;
              if (
                !(await confirmDialog({
                  title: `Make ${who} the owner?`,
                  body: "You'll become an admin.",
                  confirmLabel: 'Transfer ownership',
                  danger: true,
                }))
              )
                return;
              try {
                await api.post(wsPath(ws.slug, '/transfer-ownership'), {
                  userId: heir,
                  stepDown: true,
                });
                toast.success(`${who} now owns ${ws.workspace.name}`);
                qc.invalidateQueries({ queryKey: keys.bootstrap(ws.slug) });
              } catch (err) {
                toast.error(errMsg(err));
              }
            }}
          >
            Transfer
          </button>
        </div>
      </div>
      <button type="button" className="btn btn-danger" onClick={() => setDeleting(true)}>
        <Trash2 size={13} /> Delete workspace
      </button>
      <Modal
        open={deleting}
        onClose={() => setDeleting(false)}
        width={460}
        label="Delete workspace"
        align="center"
      >
        <form
          className="p-6"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.del(wsPath(ws.slug, '/'), { confirmSlug: confirm });
              qc.clear();
              navigate({ to: '/' });
            } catch (err) {
              toast.error(errMsg(err));
            }
          }}
        >
          <div className="section-label mb-4">Careful</div>
          <h2 className="text-lg font-bold tracking-tight">Delete {ws.workspace.name}?</h2>
          <p className="mt-2 text-[13.5px] text-muted">
            This permanently deletes every team, issue, project and comment in it, for everyone.
            Type <span className="font-mono text-text">{ws.slug}</span> to confirm.
          </p>
          <input
            className="input mt-4 font-mono"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoFocus
          />
          <div className="mt-6 flex justify-end gap-2">
            <button type="button" className="btn btn-ghost" onClick={() => setDeleting(false)}>
              Cancel
            </button>
            <button className="btn btn-danger" disabled={confirm !== ws.slug}>
              Delete forever
            </button>
          </div>
        </form>
      </Modal>
    </SettingsCard>
  );
}

// ─── Members ───────────────────────────────────────────────────────────

function InviteForm() {
  const ws = useWorkspace();
  const config = useConfig();
  const [emails, setEmails] = useState('');
  const [role, setRole] = useState<Exclude<MemberRole, 'owner'>>('member');
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const inv = [keys.invites(ws.slug) as unknown as unknown[]];
  const create = useWsMutation(
    ws.slug,
    (body: object) => api.post<Invite[]>(wsPath(ws.slug, '/invites'), body),
    {
      invalidate: inv,
    },
  );
  const emailEnabled = config.data?.emailEnabled;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const list = emails
      .split(/[\s,;]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    create.mutate(
      { emails: list.length ? list : undefined, role, teamIds },
      {
        onSuccess: (rows) => {
          setEmails('');
          if (list.length === 0 || !emailEnabled) {
            navigator.clipboard?.writeText(rows.map((r) => r.url).join('\n'));
            toast.success(
              list.length ? `${rows.length} invite links copied` : 'Invite link copied',
            );
          } else toast.success(`Invited ${rows.length} ${rows.length === 1 ? 'person' : 'people'}`);
        },
      },
    );
  };

  return (
    <SettingsCard
      title="Invite people"
      description={
        emailEnabled
          ? 'Enter email addresses to send invites, or leave it empty to create a shareable link. Links with an address only work for that person; open links work for anyone until they expire (14 days).'
          : "Email isn't set up on this instance, so invites are links you share yourself. Links with an address only work for that person."
      }
    >
      <form onSubmit={submit}>
        <textarea
          className="input"
          rows={2}
          placeholder="ann@example.com, bob@example.com (optional)"
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            className="input w-32"
            value={role}
            onChange={(e) => setRole(e.target.value as Exclude<MemberRole, 'owner'>)}
            aria-label="Role"
          >
            {(ws.isAdmin
              ? (['member', 'guest', 'admin'] as const)
              : (['member', 'guest'] as const)
            ).map((r) => (
              <option key={r} value={r}>
                {MEMBER_ROLE_LABELS[r]}
              </option>
            ))}
          </select>
          <Picker
            multi
            placeholder="Add to teams…"
            options={ws.teams.map((t) => ({ value: t.id, label: t.name, hint: t.key }))}
            selected={teamIds}
            onSelect={(id) =>
              setTeamIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
            }
            trigger={
              <button type="button" className="prop">
                {teamIds.length
                  ? `${teamIds.length} team${teamIds.length > 1 ? 's' : ''}`
                  : 'Teams…'}
              </button>
            }
          />
          <button className="btn btn-primary ml-auto">
            <Mail size={13} /> {emails.trim() && emailEnabled ? 'Send invites' : 'Create link'}
          </button>
        </div>
        {role === 'guest' && (
          <p className="mt-2 text-[12px] text-index">Guests only see the teams you add them to.</p>
        )}
      </form>
    </SettingsCard>
  );
}

function PendingInvites() {
  const ws = useWorkspace();
  const config = useConfig();
  const { data: invites = [] } = useInvites(ws.slug, true);
  const inv = [keys.invites(ws.slug) as unknown as unknown[]];
  const revoke = useWsMutation(
    ws.slug,
    (id: string) => api.del(wsPath(ws.slug, `/invites/${id}`)),
    { invalidate: inv },
  );
  const resend = useWsMutation(
    ws.slug,
    (id: string) => api.post(wsPath(ws.slug, `/invites/${id}/resend`)),
    {
      invalidate: inv,
      success: 'Invite sent again',
    },
  );
  if (invites.length === 0) return null;
  return (
    <SettingsCard title={`Pending invites · ${invites.length}`}>
      {invites.map((i) => (
        <div
          key={i.id}
          className="flex h-11 items-center gap-3 border-b border-border-soft text-[13px]"
        >
          <span className="min-w-0 flex-1 truncate">
            {i.email ?? <span className="text-muted">Anyone with the link</span>}
            {i.teamIds.length > 0 && (
              <span className="ml-2 text-index">
                → {i.teamIds.map((t) => ws.teamById.get(t)?.key ?? '?').join(', ')}
              </span>
            )}
          </span>
          <span className="tag font-mono">{MEMBER_ROLE_LABELS[i.role]}</span>
          <span className="hidden font-mono text-[11px] text-index sm:block">
            {i.lastSentAt
              ? `sent ${relativeTime(i.lastSentAt)}`
              : `expires ${shortDate(i.expiresAt)}`}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              navigator.clipboard?.writeText(i.url);
              toast.success('Invite link copied');
            }}
            aria-label="Copy invite link"
          >
            <Copy size={12} />
          </button>
          {i.email && config.data?.emailEnabled && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => resend.mutate(i.id)}
              aria-label="Resend"
            >
              <RotateCcw size={12} />
            </button>
          )}
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={() => revoke.mutate(i.id)}
            aria-label="Revoke invite"
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
    </SettingsCard>
  );
}

export function MembersSection() {
  const ws = useWorkspace();
  const isAdmin = ws.isAdmin;
  const canInvite = isAdmin || (!ws.isGuest && ws.workspace.settings.invitePolicy === 'members');
  const update = useWsMutation(
    ws.slug,
    (v: { userId: string; role?: string; suspended?: boolean }) =>
      api.patch(wsPath(ws.slug, `/members/${v.userId}`), { role: v.role, suspended: v.suspended }),
  );
  const removeMember = useWsMutation(
    ws.slug,
    (userId: string) => api.del(wsPath(ws.slug, `/members/${userId}`)),
    {
      success: 'Member removed',
    },
  );

  return (
    <>
      {canInvite && <InviteForm />}
      {canInvite && <PendingInvites />}
      <SettingsCard title={`Members · ${ws.members.length}`}>
        {ws.members.map((m) => (
          <div
            key={m.id}
            className={`flex h-12 items-center gap-3 border-b border-border-soft ${m.suspended ? 'opacity-60' : ''}`}
          >
            <Avatar name={m.name} color={m.avatarColor} src={m.avatarUrl} size={24} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px]">
                {m.name} {m.id === ws.me.id && <span className="text-index">(you)</span>}
                {m.suspended && (
                  <span className="chip ml-2 [--chip:var(--color-warning)]">suspended</span>
                )}
              </div>
              <div className="truncate font-mono text-[11px] text-index">
                @{m.username}
                {m.email && ` · ${m.email}`}
              </div>
            </div>
            <span className="hidden font-mono text-[11px] text-index md:block">
              joined {relativeTime(m.joinedAt)}
            </span>
            {/* Admins manage roles; only owners can grant or take away ownership. */}
            {isAdmin && (ws.isOwner || m.role !== 'owner') ? (
              <select
                className="h-7 border border-border bg-bg px-2 text-[12px] outline-none focus:border-primary"
                value={m.role}
                onChange={(e) => update.mutate({ userId: m.id, role: e.target.value })}
                aria-label={`Role of ${m.name}`}
              >
                {MEMBER_ROLES.filter((r) => ws.isOwner || r !== 'owner').map((r) => (
                  <option key={r} value={r}>
                    {MEMBER_ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            ) : (
              <span className="tag font-mono">{MEMBER_ROLE_LABELS[m.role]}</span>
            )}
            {isAdmin && m.id !== ws.me.id && (ws.isOwner || m.role !== 'owner') && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => update.mutate({ userId: m.id, suspended: !m.suspended })}
                aria-label={m.suspended ? `Restore ${m.name}` : `Suspend ${m.name}`}
                title={m.suspended ? 'Restore access' : 'Suspend (keeps their history)'}
              >
                {m.suspended ? <UserCheck size={12} /> : <Ban size={12} />}
              </button>
            )}
            {(isAdmin || m.id === ws.me.id) && (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={async () => {
                  const self = m.id === ws.me.id;
                  const ok = await confirmDialog({
                    title: self ? 'Leave this workspace?' : `Remove ${m.name} from the workspace?`,
                    confirmLabel: self ? 'Leave' : 'Remove',
                    danger: true,
                  });
                  if (ok) removeMember.mutate(m.id);
                }}
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

// ─── Security ──────────────────────────────────────────────────────────

export function OrgSecuritySection() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const settings = ws.workspace.settings;
  const save = async (patch: Partial<WorkspaceSettings>) => {
    try {
      await api.patch(wsPath(ws.slug, '/'), { settings: patch });
      qc.invalidateQueries({ queryKey: keys.bootstrap(ws.slug) });
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  if (!ws.isAdmin) return <p className="text-muted">Only admins can change security settings.</p>;
  return (
    <>
      <SettingsCard title="Invitations">
        <label className="flex items-center justify-between py-2 text-[13.5px]">
          <span>
            Who can invite people
            <span className="block text-[12px] text-index">
              Members can't invite admins either way.
            </span>
          </span>
          <select
            className="input w-48"
            value={settings.invitePolicy}
            onChange={(e) =>
              save({ invitePolicy: e.target.value as WorkspaceSettings['invitePolicy'] })
            }
          >
            <option value="admins">Admins only</option>
            <option value="members">Admins and members</option>
          </select>
        </label>
      </SettingsCard>
      <DomainsCard />
      <SettingsCard
        title="Join by domain"
        description="Let anyone with a verified email address at one of your verified domains join without an invite."
      >
        <label className="flex items-center justify-between border-b border-border-soft py-2.5 text-[13.5px]">
          Allow joining by domain
          <input
            type="checkbox"
            className="accent-primary"
            checked={settings.domainAutoJoin}
            onChange={(e) => save({ domainAutoJoin: e.target.checked })}
          />
        </label>
        <label className="flex items-center justify-between py-2.5 text-[13.5px]">
          They join as
          <select
            className="input w-40"
            value={settings.autoJoinRole}
            onChange={(e) =>
              save({ autoJoinRole: e.target.value as WorkspaceSettings['autoJoinRole'] })
            }
          >
            <option value="member">Member</option>
            <option value="guest">Guest</option>
          </select>
        </label>
      </SettingsCard>
    </>
  );
}

function DomainsCard() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const key = ['ws', ws.slug, 'domains'];
  const { data: domains = [] } = useQuery({
    queryKey: key,
    queryFn: () => api.get<WorkspaceDomain[]>(wsPath(ws.slug, '/domains')),
  });
  const [domain, setDomain] = useState('');
  const reload = () => qc.invalidateQueries({ queryKey: key });
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post(wsPath(ws.slug, '/domains'), { domain });
      setDomain('');
      reload();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  return (
    <SettingsCard
      title="Domains"
      description="Prove you own an email domain by adding a DNS TXT record. On instances without public DNS, an instance admin can approve it instead."
    >
      <form onSubmit={add} className="mb-4 flex gap-2">
        <input
          className="input"
          placeholder="example.com"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          required
        />
        <button className="btn btn-primary">
          <Globe size={13} /> Add
        </button>
      </form>
      {domains.map((d) => (
        <div key={d.id} className="border-b border-border-soft py-3">
          <div className="flex items-center gap-3">
            <span className="flex-1 font-mono text-[13px]">{d.domain}</span>
            {d.verified ? (
              <span className="chip [--chip:var(--color-success)]">
                verified{d.verifiedBy === 'instance_admin' ? ' by admin' : ''}
              </span>
            ) : (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={async () => {
                  try {
                    await api.post(wsPath(ws.slug, `/domains/${d.id}/verify`));
                    toast.success(`${d.domain} verified`);
                    reload();
                  } catch (err) {
                    toast.error(errMsg(err));
                  }
                }}
              >
                <CheckCircle2 size={12} /> Verify
              </button>
            )}
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={async () => {
                await api.del(wsPath(ws.slug, `/domains/${d.id}`));
                reload();
              }}
              aria-label={`Remove ${d.domain}`}
            >
              <Trash2 size={12} />
            </button>
          </div>
          {!d.verified && (
            <div className="mt-2 border border-border-soft bg-bg p-2.5 font-mono text-[11.5px] text-muted">
              TXT <span className="text-text">_ordo-verify.{d.domain}</span> →{' '}
              <span className="text-text">ordo-verify={d.verificationToken}</span>
            </div>
          )}
        </div>
      ))}
      {domains.length === 0 && (
        <p className="font-mono text-[12px] text-index">// no domains yet</p>
      )}
    </SettingsCard>
  );
}

// ─── Audit log ─────────────────────────────────────────────────────────

/** Human wording for audit actions. */
export function describeAudit(e: { action: string; data: Record<string, unknown> }) {
  const d = e.data;
  const map: Record<string, string> = {
    'workspace.created': 'created the workspace',
    'workspace.updated': 'changed workspace settings',
    'workspace.deleted': 'deleted a workspace',
    'member.joined': `joined${d.via === 'domain' ? ' by domain' : ''}`,
    'member.role_changed': `changed a role to ${String(d.role)}`,
    'member.removed': d.self ? 'left the workspace' : 'removed a member',
    'member.suspended': 'suspended a member',
    'member.unsuspended': 'restored a member',
    'invite.created': `invited ${d.email ? String(d.email) : 'with a link'} as ${String(d.role)}`,
    'invite.revoked': 'revoked an invite',
    'invite.accepted': 'accepted an invite',
    'team.created': `created team ${String(d.name ?? '')}`,
    'team.updated': 'changed team settings',
    'team.deleted': `deleted team ${String(d.name ?? '')}`,
    'team.member_added': 'added someone to a team',
    'team.member_removed': 'removed someone from a team',
    'team.member_role_changed': 'changed a team role',
    'domain.added': `added domain ${String(d.domain)}`,
    'domain.verified': `verified ${String(d.domain)}`,
    'domain.removed': `removed domain ${String(d.domain)}`,
    'sso.provider_created': `added sign-in provider ${String(d.name ?? '')}`,
    'sso.provider_updated': 'changed a sign-in provider',
    'sso.provider_deleted': `removed sign-in provider ${String(d.name ?? '')}`,
    'auth.login':
      d.method === 'sso' ? `signed in with ${String(d.provider ?? 'SSO')}` : 'signed in',
    'auth.sso_bypass': 'signed in with a password (owner fallback)',
    'webhook.created': `added a webhook to ${String(d.url ?? '')}`,
    'webhook.updated': 'changed a webhook',
    'webhook.deleted': `removed the webhook to ${String(d.url ?? '')}`,
    'webhook.disabled': `webhook to ${String(d.url ?? '')} switched off after failures`,
    'integration.created': `connected ${String(d.name ?? d.provider ?? 'an integration')}`,
    'integration.updated': 'changed an integration',
    'integration.deleted': `disconnected ${String(d.name ?? d.provider ?? 'an integration')}`,
    'auth.identity_linked': `linked ${String(d.provider ?? 'an identity')}`,
  };
  return map[e.action] ?? e.action;
}

export function AuditSection() {
  const ws = useWorkspace();
  const { data, isLoading } = useQuery({
    queryKey: ['ws', ws.slug, 'audit'],
    queryFn: () => api.get<AuditEntry[]>(wsPath(ws.slug, '/audit-log?limit=200')),
    enabled: ws.isAdmin,
  });
  if (!ws.isAdmin) return <p className="text-muted">Only admins can see the audit log.</p>;
  if (isLoading) return <Spinner />;
  return (
    <SettingsCard
      title="Audit log"
      description="Security-relevant changes in this workspace, newest first."
    >
      {data?.map((e) => {
        const actor = e.actorId ? ws.memberById.get(e.actorId) : null;
        return (
          <div
            key={e.id}
            className="flex items-start gap-3 border-b border-border-soft py-2.5 text-[13px]"
          >
            {actor ? (
              <Avatar name={actor.name} color={actor.avatarColor} src={actor.avatarUrl} size={18} />
            ) : (
              <span className="h-[18px] w-[18px] flex-none bg-border" />
            )}
            <span className="min-w-0 flex-1">
              <ActorName person={actor} /> <span className="text-muted">{describeAudit(e)}</span>
            </span>
            <span className="flex-none font-mono text-[11px] text-index" title={e.ip ?? undefined}>
              {relativeTime(e.createdAt)}
            </span>
          </div>
        );
      })}
      {data?.length === 0 && <p className="font-mono text-[12px] text-index">// nothing yet</p>}
    </SettingsCard>
  );
}
