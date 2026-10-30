import {
  ACCENT_PRESETS,
  accentVariables,
  branchName,
  contrast,
  DEFAULT_ACCENT,
  HEX_COLOR,
  type Invite,
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
import { Picker } from '../../components/properties.tsx';
import { Avatar } from '../../components/ui/Avatar.tsx';
import { confirmDialog, Modal } from '../../components/ui/Modal.tsx';
import { t, tx } from '../../i18n/index.ts';
import { roleLabel } from '../../i18n/labels.ts';
import { relativeTime, shortDate } from '../../lib/format.ts';
import { useTheme } from '../../lib/theme.ts';
import { memberChoices, useWorkspace } from '../../lib/workspace.tsx';
import { FormRow, SettingsCard } from './ui.tsx';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : t('common.error'));

// ─── General ───────────────────────────────────────────────────────────

export function WorkspaceSection() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(ws.workspace.name);
  const [slug, setSlug] = useState(ws.workspace.slug);
  const fileRef = useRef<HTMLInputElement>(null);
  const zones =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const refresh = () => {
    qc.invalidateQueries({ queryKey: keys.bootstrap(ws.slug) });
    qc.invalidateQueries({ queryKey: keys.me });
  };

  if (!ws.isAdmin) return <p className="text-muted">{t('workspaceSettings.general.adminsOnly')}</p>;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.patch(wsPath(ws.slug, '/'), { name, slug });
      toast.success(t('workspaceSettings.general.saved'));
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
      <SettingsCard title={t('workspaceSettings.general.title')}>
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
              <Upload size={12} /> {t('workspaceSettings.general.uploadLogo')}
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
                {t('common.remove')}
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
          <FormRow label={t('workspaceSettings.general.name')}>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </FormRow>
          <FormRow
            label={t('workspaceSettings.general.url')}
            hint={t('workspaceSettings.general.urlHint')}
          >
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
          <button className="btn btn-primary">{t('common.save')}</button>
        </form>
      </SettingsCard>

      <SettingsCard
        title={t('workspaceSettings.defaultTeam.title')}
        description={t('workspaceSettings.defaultTeam.description')}
      >
        <select
          className="input w-72"
          value={ws.workspace.defaultTeamId ?? 'none'}
          onChange={(e) => setDefaultTeam(e.target.value)}
        >
          <option value="none">{t('common.none')}</option>
          {ws.teams
            .filter((team) => !team.private)
            .map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
        </select>
      </SettingsCard>

      <SettingsCard
        title={t('workspaceSettings.defaultAssignee.title')}
        description={t('workspaceSettings.defaultAssignee.description')}
      >
        <select
          className="input w-72"
          value={ws.workspace.settings.defaultAssigneeId ?? 'none'}
          onChange={async (e) => {
            try {
              await api.patch(wsPath(ws.slug, '/'), {
                settings: { defaultAssigneeId: e.target.value === 'none' ? null : e.target.value },
              });
              refresh();
            } catch (err) {
              toast.error(errMsg(err));
            }
          }}
        >
          <option value="none">{t('issues.none.assignee')}</option>
          {memberChoices(ws).map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </SettingsCard>

      <SettingsCard
        title={t('workspaceSettings.timeZone.title')}
        description={t('workspaceSettings.timeZone.description')}
      >
        <select
          className="input w-72"
          value={ws.workspace.settings.timezone ?? ''}
          onChange={async (e) => {
            try {
              await api.patch(wsPath(ws.slug, '/'), {
                settings: { timezone: e.target.value || null },
              });
              refresh();
            } catch (err) {
              toast.error(errMsg(err));
            }
          }}
        >
          <option value="">{t('workspaceSettings.timeZone.utc')}</option>
          {zones.map((z) => (
            <option key={z} value={z}>
              {z}
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

/** A preset's name in the reader's language; Hotline Pink is a name and stays as it is. */
function presetName(name: string) {
  const names: Record<string, string> = {
    Ember: t('workspaceSettings.accent.presets.ember'),
    Amber: t('workspaceSettings.accent.presets.amber'),
    Acid: t('workspaceSettings.accent.presets.acid'),
    Mint: t('workspaceSettings.accent.presets.mint'),
    Electric: t('workspaceSettings.accent.presets.electric'),
    Violet: t('workspaceSettings.accent.presets.violet'),
  };
  return names[name] ?? name;
}

/**
 * The workspace's accent colour: presets, or any colour that reads on the dark background. The
 * light theme deepens it on its own (accentVariables), so only the dark background is checked.
 */
function AccentCard() {
  const ws = useWorkspace();
  const { mode } = useTheme();
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
      toast.success(t('workspaceSettings.accent.saved'));
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  return (
    <SettingsCard
      title={t('workspaceSettings.accent.title')}
      description={t('workspaceSettings.accent.description')}
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
            {presetName(p.name)}
          </button>
        ))}
      </div>
      <div className="mb-4 flex items-center gap-2">
        <input
          type="color"
          className="h-8 w-10 cursor-pointer border border-border bg-bg p-0.5"
          value={valid ? draft : DEFAULT_ACCENT}
          onChange={(e) => setDraft(e.target.value)}
          aria-label={t('workspaceSettings.accent.custom')}
        />
        <input
          className="input w-32 font-mono"
          value={draft}
          onChange={(e) => setDraft(e.target.value.trim())}
          aria-label={t('workspaceSettings.accent.hex')}
        />
      </div>
      {/* The palette is a set of CSS variables, so this box previews it without touching the page. */}
      <div
        className="mb-4 border border-border-soft bg-bg p-4"
        style={valid ? (accentVariables(draft, mode) as React.CSSProperties) : undefined}
      >
        <div className="kicker mb-2">
          <span className="text-muted">// </span>
          {t('workspaceSettings.accent.preview')}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="btn btn-primary btn-sm">
            {t('workspaceSettings.accent.previewPrimary')}
          </span>
          <span className="btn btn-ghost btn-sm">{t('workspaceSettings.accent.previewGhost')}</span>
          <span className="chip [--chip:var(--color-primary)]">
            {t('workspaceSettings.accent.previewChip')}
          </span>
          <span className="text-[13px] text-highlight">
            {t('workspaceSettings.accent.previewLink')}
          </span>
          <span className="h-[7px] w-[7px] bg-primary shadow-[0_0_10px_var(--color-primary)]" />
          <span className="text-[12px] text-muted">
            {t('workspaceSettings.accent.previewMuted')}
          </span>
        </div>
      </div>
      {faint && (
        <p className="mb-3 text-[12px] text-warning">{t('workspaceSettings.accent.tooFaint')}</p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!valid || draft.toLowerCase() === saved.toLowerCase()}
          onClick={() => save(draft)}
        >
          {t('common.save')}
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
            {t('workspaceSettings.accent.reset')}
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
    title: t('workspaceSettings.branch.exampleTitle'),
    username: ws.me.username,
  });
  return (
    <SettingsCard
      title={t('workspaceSettings.branch.title')}
      description={tx('workspaceSettings.branch.description', {
        identifier: <code className="font-mono">{'{identifier}'}</code>,
        title: <code className="font-mono">{'{title}'}</code>,
        username: <code className="font-mono">{'{username}'}</code>,
      })}
    >
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.patch(wsPath(ws.slug, '/'), { settings: { gitBranchFormat: format } });
            qc.invalidateQueries({ queryKey: keys.bootstrap(ws.slug) });
            toast.success(t('common.saved'));
          } catch (err) {
            toast.error(errMsg(err));
          }
        }}
      >
        <input
          className="input w-72 font-mono"
          value={format}
          onChange={(e) => setFormat(e.target.value)}
          aria-label={t('workspaceSettings.branch.formatLabel')}
        />
        <button className="btn btn-primary">{t('common.save')}</button>
      </form>
      <p className="mt-2 font-mono text-[11.5px] text-index">→ {example}</p>
    </SettingsCard>
  );
}

/** Whether people here may use the instance's model, and where their issue text would go. */

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
    <SettingsCard title={t('workspaceSettings.danger.title')}>
      <div className="mb-6">
        <div className="mb-2 text-[13.5px]">{t('workspaceSettings.danger.transferOwnership')}</div>
        <div className="flex flex-wrap gap-2">
          <select className="input w-72" value={heir} onChange={(e) => setHeir(e.target.value)}>
            <option value="">{t('workspaceSettings.danger.chooseMember')}</option>
            {candidates.map((m) => (
              <option key={m.id} value={m.id}>
                {t('workspaceSettings.danger.memberOption', {
                  name: m.name,
                  role: roleLabel(m.role),
                })}
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
                  title: t('workspaceSettings.danger.transferTitle', { name: who ?? '' }),
                  body: t('workspaceSettings.danger.transferBody'),
                  confirmLabel: t('workspaceSettings.danger.transferOwnership'),
                  danger: true,
                }))
              )
                return;
              try {
                await api.post(wsPath(ws.slug, '/transfer-ownership'), {
                  userId: heir,
                  stepDown: true,
                });
                toast.success(
                  t('workspaceSettings.danger.transferred', {
                    name: who ?? '',
                    workspace: ws.workspace.name,
                  }),
                );
                qc.invalidateQueries({ queryKey: keys.bootstrap(ws.slug) });
              } catch (err) {
                toast.error(errMsg(err));
              }
            }}
          >
            {t('workspaceSettings.danger.transfer')}
          </button>
        </div>
      </div>
      <button type="button" className="btn btn-danger" onClick={() => setDeleting(true)}>
        <Trash2 size={13} /> {t('workspaceSettings.danger.deleteWorkspace')}
      </button>
      <Modal
        open={deleting}
        onClose={() => setDeleting(false)}
        width={460}
        label={t('workspaceSettings.danger.deleteWorkspace')}
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
          <div className="section-label mb-4">{t('workspaceSettings.danger.careful')}</div>
          <h2 className="text-lg font-bold tracking-tight">
            {t('workspaceSettings.danger.deleteTitle', { name: ws.workspace.name })}
          </h2>
          <p className="mt-2 text-[13.5px] text-muted">
            {tx('workspaceSettings.danger.deleteBody', {
              slug: ws.slug,
              code: (c) => <span className="font-mono text-text">{c}</span>,
            })}
          </p>
          <input
            className="input mt-4 font-mono"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoFocus
          />
          <div className="mt-6 flex justify-end gap-2">
            <button type="button" className="btn btn-ghost" onClick={() => setDeleting(false)}>
              {t('common.cancel')}
            </button>
            <button className="btn btn-danger" disabled={confirm !== ws.slug}>
              {t('workspaceSettings.danger.deleteForever')}
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
              list.length
                ? t('workspaceSettings.invite.linksCopied', { count: rows.length })
                : t('workspaceSettings.invite.linkCopied'),
            );
          } else toast.success(t('workspaceSettings.invite.invited', { count: rows.length }));
        },
      },
    );
  };

  return (
    <SettingsCard
      title={t('workspaceSettings.invite.title')}
      description={
        emailEnabled
          ? t('workspaceSettings.invite.descriptionEmail')
          : t('workspaceSettings.invite.descriptionNoEmail')
      }
    >
      <form onSubmit={submit}>
        <textarea
          className="input"
          rows={2}
          placeholder={t('workspaceSettings.invite.emailsPlaceholder')}
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            className="input w-32"
            value={role}
            onChange={(e) => setRole(e.target.value as Exclude<MemberRole, 'owner'>)}
            aria-label={t('workspaceSettings.invite.role')}
          >
            {(ws.isAdmin
              ? (['member', 'guest', 'admin'] as const)
              : (['member', 'guest'] as const)
            ).map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
          <Picker
            multi
            placeholder={t('workspaceSettings.invite.addToTeams')}
            options={ws.teams.map((team) => ({ value: team.id, label: team.name, hint: team.key }))}
            selected={teamIds}
            onSelect={(id) =>
              setTeamIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
            }
            trigger={
              <button type="button" className="prop">
                {teamIds.length
                  ? t('workspaceSettings.invite.teamCount', { count: teamIds.length })
                  : t('workspaceSettings.invite.teams')}
              </button>
            }
          />
          <button className="btn btn-primary ml-auto">
            <Mail size={13} />{' '}
            {emails.trim() && emailEnabled
              ? t('workspaceSettings.invite.send')
              : t('workspaceSettings.invite.createLink')}
          </button>
        </div>
        {role === 'guest' && (
          <p className="mt-2 text-[12px] text-index">{t('workspaceSettings.invite.guestHint')}</p>
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
      success: t('workspaceSettings.pending.resent'),
    },
  );
  if (invites.length === 0) return null;
  return (
    <SettingsCard title={t('workspaceSettings.pending.title', { count: invites.length })}>
      {invites.map((i) => (
        <div
          key={i.id}
          className="flex h-11 items-center gap-3 border-b border-border-soft text-[13px]"
        >
          <span className="min-w-0 flex-1 truncate">
            {i.email ?? <span className="text-muted">{t('workspaceSettings.pending.anyone')}</span>}
            {i.teamIds.length > 0 && (
              <span className="ml-2 text-index">
                → {i.teamIds.map((id) => ws.teamById.get(id)?.key ?? '?').join(', ')}
              </span>
            )}
          </span>
          <span className="tag font-mono">{roleLabel(i.role)}</span>
          <span className="hidden font-mono text-[11px] text-index sm:block">
            {i.lastSentAt
              ? t('workspaceSettings.pending.sent', { time: relativeTime(i.lastSentAt) })
              : t('workspaceSettings.pending.expires', { date: shortDate(i.expiresAt) })}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              navigator.clipboard?.writeText(i.url);
              toast.success(t('workspaceSettings.invite.linkCopied'));
            }}
            aria-label={t('workspaceSettings.pending.copyLink')}
          >
            <Copy size={12} />
          </button>
          {i.email && config.data?.emailEnabled && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => resend.mutate(i.id)}
              aria-label={t('workspaceSettings.pending.resend')}
            >
              <RotateCcw size={12} />
            </button>
          )}
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={() => revoke.mutate(i.id)}
            aria-label={t('workspaceSettings.pending.revoke')}
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
      success: t('workspaceSettings.members.removed'),
    },
  );

  // Agents are members too, but they're managed under Settings → Agents.
  const people = ws.members.filter((m) => m.kind !== 'agent');
  return (
    <>
      {canInvite && <InviteForm />}
      {canInvite && <PendingInvites />}
      <SettingsCard title={t('workspaceSettings.members.title', { count: people.length })}>
        {people.map((m) => (
          <div
            key={m.id}
            className={`flex h-12 items-center gap-3 border-b border-border-soft ${m.suspended ? 'opacity-60' : ''}`}
          >
            <Avatar
              name={m.name}
              color={m.avatarColor}
              src={m.avatarUrl}
              size={24}
              status={m.status}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px]">
                {m.name}{' '}
                {m.id === ws.me.id && (
                  <span className="text-index">{t('workspaceSettings.members.you')}</span>
                )}
                {m.suspended && (
                  <span className="chip ml-2 [--chip:var(--color-warning)]">
                    {t('workspaceSettings.members.suspended')}
                  </span>
                )}
              </div>
              <div className="truncate font-mono text-[11px] text-index">
                @{m.username}
                {m.email && ` · ${m.email}`}
              </div>
            </div>
            <span className="hidden font-mono text-[11px] text-index md:block">
              {t('workspaceSettings.members.joined', { time: relativeTime(m.joinedAt) })}
            </span>
            {/* Admins manage roles; only owners can grant or take away ownership. */}
            {isAdmin && (ws.isOwner || m.role !== 'owner') ? (
              <select
                className="h-7 border border-border bg-bg px-2 text-[12px] outline-none focus:border-primary"
                value={m.role}
                onChange={(e) => update.mutate({ userId: m.id, role: e.target.value })}
                aria-label={t('workspaceSettings.members.roleOf', { name: m.name })}
              >
                {MEMBER_ROLES.filter((r) => ws.isOwner || r !== 'owner').map((r) => (
                  <option key={r} value={r}>
                    {roleLabel(r)}
                  </option>
                ))}
              </select>
            ) : (
              <span className="tag font-mono">{roleLabel(m.role)}</span>
            )}
            {isAdmin && m.id !== ws.me.id && (ws.isOwner || m.role !== 'owner') && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => update.mutate({ userId: m.id, suspended: !m.suspended })}
                aria-label={t(
                  m.suspended
                    ? 'workspaceSettings.members.restore'
                    : 'workspaceSettings.members.suspend',
                  { name: m.name },
                )}
                title={
                  m.suspended
                    ? t('workspaceSettings.members.restoreHint')
                    : t('workspaceSettings.members.suspendHint')
                }
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
                    title: self
                      ? t('workspaceSettings.members.leaveTitle')
                      : t('workspaceSettings.members.removeTitle', { name: m.name }),
                    confirmLabel: self ? t('workspaceSettings.members.leave') : t('common.remove'),
                    danger: true,
                  });
                  if (ok) removeMember.mutate(m.id);
                }}
                aria-label={
                  m.id === ws.me.id
                    ? t('workspaceSettings.members.leaveWorkspace')
                    : t('workspaceSettings.members.removeName', { name: m.name })
                }
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
  if (!ws.isAdmin)
    return <p className="text-muted">{t('workspaceSettings.security.adminsOnly')}</p>;
  return (
    <>
      <SettingsCard title={t('workspaceSettings.security.invitations')}>
        <label className="flex items-center justify-between gap-3 py-2 text-[13.5px]">
          <span>
            {t('workspaceSettings.security.whoCanInvite')}
            <span className="block text-[12px] text-index">
              {t('workspaceSettings.security.whoCanInviteHint')}
            </span>
          </span>
          <select
            className="input w-48"
            value={settings.invitePolicy}
            onChange={(e) =>
              save({ invitePolicy: e.target.value as WorkspaceSettings['invitePolicy'] })
            }
          >
            <option value="admins">{t('workspaceSettings.security.adminsOnlyOption')}</option>
            <option value="members">{t('workspaceSettings.security.adminsAndMembers')}</option>
          </select>
        </label>
      </SettingsCard>
      <DomainsCard />
      <SettingsCard
        title={t('workspaceSettings.security.joinByDomain')}
        description={t('workspaceSettings.security.joinByDomainDescription')}
      >
        <label className="flex items-center justify-between gap-3 border-b border-border-soft py-2.5 text-[13.5px]">
          {t('workspaceSettings.security.allowJoin')}
          <input
            type="checkbox"
            className="accent-primary"
            checked={settings.domainAutoJoin}
            onChange={(e) => save({ domainAutoJoin: e.target.checked })}
          />
        </label>
        <label className="flex items-center justify-between gap-3 py-2.5 text-[13.5px]">
          {t('workspaceSettings.security.joinAs')}
          <select
            className="input w-40"
            value={settings.autoJoinRole}
            onChange={(e) =>
              save({ autoJoinRole: e.target.value as WorkspaceSettings['autoJoinRole'] })
            }
          >
            <option value="member">{roleLabel('member')}</option>
            <option value="guest">{roleLabel('guest')}</option>
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
      title={t('workspaceSettings.domains.title')}
      description={t('workspaceSettings.domains.description')}
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
          <Globe size={13} /> {t('common.add')}
        </button>
      </form>
      {domains.map((d) => (
        <div key={d.id} className="border-b border-border-soft py-3">
          <div className="flex items-center gap-3">
            <span className="flex-1 font-mono text-[13px]">{d.domain}</span>
            {d.verified ? (
              <span className="chip [--chip:var(--color-success)]">
                {d.verifiedBy === 'instance_admin'
                  ? t('workspaceSettings.domains.verifiedByAdmin')
                  : t('workspaceSettings.domains.verified')}
              </span>
            ) : (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={async () => {
                  try {
                    await api.post(wsPath(ws.slug, `/domains/${d.id}/verify`));
                    toast.success(
                      t('workspaceSettings.domains.verifiedToast', { domain: d.domain }),
                    );
                    reload();
                  } catch (err) {
                    toast.error(errMsg(err));
                  }
                }}
              >
                <CheckCircle2 size={12} /> {t('workspaceSettings.domains.verify')}
              </button>
            )}
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={async () => {
                await api.del(wsPath(ws.slug, `/domains/${d.id}`));
                reload();
              }}
              aria-label={t('workspaceSettings.domains.remove', { domain: d.domain })}
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
        <p className="font-mono text-[12px] text-index">{t('workspaceSettings.domains.empty')}</p>
      )}
    </SettingsCard>
  );
}

// ─── Audit log ─────────────────────────────────────────────────────────
